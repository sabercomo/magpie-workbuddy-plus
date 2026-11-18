import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Runner } from '../runner.mjs';
import { WorkBuddyClient } from '../client.mjs';
import { defaults, initialize, settle, validateConfig, writeJSON } from '../storage.mjs';

function fixture(t, concurrency = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initialize(dir);
  const config = { ...defaults, magpieDir: join(dir, 'magpie'), spread: 0, concurrency };
  writeJSON(join(dir, 'config.json'), config);
  writeJSON(join(config.magpieDir, 'plugin-auth.json'), Object.fromEntries([1,2,3].map(i => [`workbuddy#u${i}`, { type: 'oauth', uid: `u${i}`, access: `secret-${i}`, refresh: 'never-show', accountId: `Example ${i}` }])));
  return { dir, config };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await setImmediate(); }
  assert.fail('queue did not reach expected state');
}
const done = job => !['running', 'queued'].includes(job.status);
function blocked(t) {
  const entered = [], release = new Map();
  t.after(() => { for (const resolve of release.values()) resolve(); });
  return { entered, release, fetcher: async (url, { headers, signal }) => {
    const uid = headers['X-User-Id'];
    if (!entered.includes(uid)) {
      entered.push(uid);
      await new Promise((resolve, reject) => { release.set(uid, resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    }
    return Response.json({ code: 0, data: { tasks: [] } });
  } };
}

test('global account concurrency applies across jobs; queued cancellation never sends a request', async t => {
  const p = fixture(t), gate = blocked(t), runner = new Runner(p.dir, { gap: 0, fetcher: gate.fetcher });
  const first = runner.submit(['tasks'], ['cn:u1']);
  const second = runner.submit(['tasks'], ['cn:u2']);
  await until(() => gate.entered.length === 1);
  await setImmediate();
  assert.deepEqual(gate.entered, ['u1']);
  assert.equal(second.status, 'queued');
  assert.throws(() => runner.submit(['tasks'], ['cn:u2']), /正在执行或排队/);
  runner.cancel(second.id);
  await until(() => done(second));
  assert.equal(second.status, 'cancelled');
  gate.release.get('u1')();
  await until(() => done(first));
  assert.deepEqual(gate.entered, ['u1']);
});

test('two account slots run within one job and increasing the limit wakes the waiting account', async t => {
  const p = fixture(t, 2), gate = blocked(t), runner = new Runner(p.dir, { gap: 0, fetcher: gate.fetcher });
  const job = runner.submit(['tasks']);
  await until(() => gate.entered.length === 2);
  assert.equal(runner.boardView().jobs[0].status, 'running');
  writeJSON(join(p.dir, 'config.json'), { ...p.config, concurrency: 3 });
  runner.wake();
  await until(() => gate.entered.length === 3);
  for (const release of gate.release.values()) release();
  await until(() => done(job));
  assert.equal(job.status, 'succeeded');
  assert.equal(job.queue.length, 3);
  assert.ok(job.queue.every(row => row.status === 'succeeded' && row.completed === 1));
  assert.ok(!/secret-|never-show/.test(JSON.stringify(runner.boardView())));
});

test('pausing a waiting account skips its tasks while its board account remains available', async t => {
  const p = fixture(t), gate = blocked(t), runner = new Runner(p.dir, { gap: 0, fetcher: gate.fetcher });
  const job = runner.submit(['tasks']);
  await until(() => gate.entered.length === 1);
  writeJSON(join(p.dir, 'config.json'), { ...p.config, pausedAccounts: ['cn:u2'] });
  gate.release.get('u1')();
  await until(() => gate.entered.includes('u3'));
  gate.release.get('u3')();
  await until(() => done(job));
  assert.deepEqual(gate.entered, ['u1', 'u3']);
  assert.equal(job.queue.find(row => row.account === 'cn:u2').status, 'paused');
  assert.equal(runner.list().length, 3);
});

test('retry targets failed actions only and records request retry times without request bodies', async t => {
  const p = fixture(t); let refuse = true;
  const runner = new Runner(p.dir, { gap: 0, wait: async () => {}, fetcher: async url => {
    if (refuse && new URL(url).pathname.endsWith('/tasks')) return Response.json({ message: 'rate limit' }, { status: 429 });
    return Response.json({ code: 0, data: { tasks: [] } });
  } });
  const first = runner.submit(['tasks'], ['cn:u1']);
  await until(() => done(first));
  assert.equal(first.status, 'deferred');
  assert.deepEqual(first.retries.map(r => [r.attempt, r.status, r.waitMs]), [[1,429,5000],[2,429,20000],[3,429,0]]);
  assert.ok(first.retries.every(r => r.at && r.path && !r.body));
  refuse = false;
  const retry = runner.retry(first.id);
  await until(() => done(retry));
  assert.equal(retry.status, 'succeeded');
  assert.equal(retry.retryOf, first.id);
  assert.throws(() => runner.retry(retry.id), /没有需要重试/);
  assert.ok(!/secret-|never-show/.test(JSON.stringify(runner.boardView())));
});

test('queue settings migrate with defaults and reject invalid user values', () => {
  const config = settle({ ...defaults, concurrency: undefined, tasksCacheTtl: undefined, progressCacheHours: undefined });
  assert.equal(config.concurrency, 1);
  assert.equal(config.tasksCacheTtl, 20);
  assert.equal(config.progressCacheHours, 6);
  for (const concurrency of [0,4,1.5,'2']) assert.throws(() => validateConfig({ ...defaults, concurrency }), /并发/);
  assert.throws(() => validateConfig({ ...defaults, tasksCacheTtl: -1 }), /缓存/);
});

test('task list cache separates accounts and client channels, expires and invalidates after writes', async () => {
  const cache = new Map(); let calls = 0;
  const config = { ...defaults, tasksCacheTtl: 20 };
  const options = { taskCache: cache, gap: 0, fetcher: async () => Response.json({ code: 0, data: { tasks: [], count: ++calls } }) };
  const a = new WorkBuddyClient({ id: 'cn:a', auth: { access: 'secret', uid: 'a' } }, config, options);
  const b = new WorkBuddyClient({ id: 'cn:b', auth: { uid: 'b' } }, config, options);
  const path = '/v2/activity/growth/tasks';
  const first = await a.request(path); first.tasks.push({ task_code: 'do-not-mutate-cache' });
  assert.deepEqual((await a.request(path)).tasks, []);
  assert.equal(calls, 1);
  await a.request(path, { extra: { 'X-IDE-Type': 'mini' } });
  await b.request(path);
  assert.equal(calls, 3);
  await a.request('/v2/report', { base: 'https://copilot.tencent.com', body: [{ content: 'private prompt' }] });
  await a.request(path);
  assert.equal(calls, 5);
  for (const entry of cache.values()) entry.at -= 21_000;
  await a.request(path);
  assert.equal(calls, 6);
  assert.ok(!JSON.stringify([...cache]).includes('private prompt'));
});

test('partial job retries only failed account/actions and keeps live status after the first result', async t => {
  const p = fixture(t, 2); let fail = true;
  const runner = new Runner(p.dir, { gap: 0, fetcher: async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/tasks')) return fail && init.headers['X-User-Id'] === 'u2' ? Response.json({ msg: 'unavailable' }, { status: 503 }) : Response.json({ code: 0, data: { tasks: [] } });
    if (path.endsWith('/compensation-status')) return Response.json({ code: 0, data: { active: false } });
    throw new Error('unexpected request ' + path);
  } });
  const job = runner.submit(['tasks', 'compensation'], ['cn:u1', 'cn:u2']);
  await until(() => done(job));
  assert.equal(job.status, 'partial');
  fail = false;
  const retry = runner.retry(job.id);
  await until(() => done(retry));
  assert.deepEqual(retry.accounts, ['cn:u2']);
  assert.deepEqual(retry.actions, ['tasks']);
  assert.equal(retry.status, 'succeeded');
});

test('a successful task read is retained for display on failure, expires, and never masks the error', async t => {
  const p = fixture(t); let fail = false;
  const seen = [];
  const runner = new Runner(p.dir, { gap: 0, fetcher: async (url, init) => {
    const path = new URL(url).pathname; seen.push([path, init.headers['X-User-Id']]);
    if (path.endsWith('/tasks')) return fail ? Response.json({ msg: 'down' }, { status: 503 }) : Response.json({ code: 0, data: { tasks: [] } });
    return Response.json({ code: 0, data: {} });
  } });
  await runner.refreshBoard(0, ['cn:u1']);
  fail = true; runner.taskCache.clear(); seen.length = 0;
  await runner.refreshBoard(0, ['cn:u1']);
  const row = runner.board.accounts[0];
  assert.ok(row.errors.tasks.includes('503'));
  assert.ok(row.tasks.cachedAt);
  assert.ok(seen.filter(([path]) => path.endsWith('/tasks')).every(([, uid]) => uid === 'u1'));
  runner.state.taskSnapshots['cn:u1'].at -= 7 * 3600_000;
  runner.taskCache.clear();
  await runner.refreshBoard(0, ['cn:u1']);
  assert.equal(runner.board.accounts[0].tasks, undefined);
  const job = runner.submit(['tasks'], ['cn:u1']);
  await until(() => done(job));
  assert.equal(job.status, 'failed', 'display cache cannot turn an execution failure into success');
});

test('an in-flight read cannot repopulate task cache after a mutation', async () => {
  let release; let reads = 0;
  const cache = new Map(), client = new WorkBuddyClient({ id: 'cn:a', auth: {} }, defaults, { gap: 0, taskCache: cache, fetcher: async (url, init) => {
    if (init.method === 'GET' && ++reads === 1) await new Promise(resolve => { release = resolve; });
    return Response.json({ code: 0, data: { tasks: [] } });
  } });
  const read = client.request('/v2/activity/growth/tasks');
  await client.request('/v2/report', { body: [] });
  release(); await read;
  await client.request('/v2/activity/growth/tasks');
  assert.equal(reads, 2);
});

test('account health and batch pause remain read-only for Magpie logins', t => {
  const p = fixture(t), runner = new Runner(p.dir), at = new Date().toISOString();
  runner.board.accounts = [{ id: 'cn:u1', name: 'Example', key: 'workbuddy#u1' }];
  runner.state.jobs = [0,1,2].map(i => ({ id: String(i), accounts: ['cn:u1'], actions: ['tasks'], created: at, finished: at, status: 'failed', results: [{ account: 'cn:u1', action: 'tasks', ok: false }], logs: [] }));
  assert.deepEqual([runner.boardView().accounts[0].health.state, runner.boardView().accounts[0].health.failures], ['failed',3]);
  const result = runner.pageRequest({ id: 'pause-both', at: Date.now(), action: 'pause-tasks', accounts: ['cn:u1','cn:u2'] });
  assert.equal(result.ok, true);
  assert.deepEqual(runner.config().pausedAccounts, ['cn:u1','cn:u2']);
  assert.equal(runner.boardView().accounts[0].health.state, 'paused');
});

test('lowering concurrency lets active accounts finish and live status stays running after a result', async t => {
  const p = fixture(t, 2), gate = blocked(t), runner = new Runner(p.dir, { gap: 0, fetcher: gate.fetcher });
  const job = runner.submit(['tasks']);
  await until(() => gate.entered.length === 2);
  writeJSON(join(p.dir, 'config.json'), { ...p.config, concurrency: 1 }); runner.wake();
  gate.release.get('u1')();
  await until(() => job.results.length === 1);
  assert.equal(runner.boardView().jobs[0].status, 'running');
  assert.deepEqual(gate.entered, ['u1','u2']);
  gate.release.get('u2')();
  await until(() => gate.entered.includes('u3'));
  gate.release.get('u3')();
  await until(() => done(job));
  assert.equal(job.status, 'succeeded');
});

test('restart marks persisted per-account queue entries interrupted', t => {
  const p = fixture(t), now = new Date().toISOString();
  writeJSON(join(p.dir, 'state.json'), { daily: {}, slots: {}, reports: {}, jobs: [{ id: 'prior', actions: ['tasks'], accounts: ['cn:u1'], status: 'running', created: now, logs: [], results: [], queue: [{ account: 'cn:u1', status: 'running', completed: 0, total: 1, actions: ['tasks'] }] }] });
  const runner = new Runner(p.dir);
  assert.equal(runner.boardView().jobs[0].status, 'interrupted');
  assert.equal(runner.boardView().jobs[0].queue[0].status, 'interrupted');
});

test('HTTP and sandbox config bridges expose real settings and reject unsafe retry requests', async t => {
  const { createService } = await import('../server.mjs');
  const p = fixture(t), runner = new Runner(p.dir);
  const { server } = createService({ dir: p.dir, runner });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, header = true) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(header ? {'X-WorkBuddy-Plus': '1'} : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('/api/retry', { id: 'missing' }, false)).status, 403);
  const missing = await post('/api/retry', { id: 'missing' });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /没有需要重试/);
  const saved = await post('/api/page', { id: 'queue-config', action: 'config', at: Date.now(), config: { concurrency: 3, tasksCacheTtl: 12, progressCacheHours: 4 } });
  assert.equal((await saved.json()).ok, true);
  assert.deepEqual([runner.config().concurrency, runner.config().tasksCacheTtl, runner.config().progressCacheHours], [3,12,4]);
  const invalid = await post('/api/config', { ...p.config, concurrency: 10 });
  assert.equal(invalid.status, 400);
  assert.equal(runner.config().concurrency, 3);
  assert.ok(!/secret-|never-show/.test(JSON.stringify(await (await fetch(base + '/api/board')).json())));
});
