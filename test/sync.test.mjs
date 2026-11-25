import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "../runner.mjs";
import { defaults, readJSON, writeJSON } from "../storage.mjs";
import { openData, sealData } from "../sync/crypto.mjs";
import { acquireEngineLock } from "../sync/engine-lock.mjs";
import { GitHubContents } from "../sync/github.mjs";
import { hostTick } from "../sync/host.mjs";
import { configPath, marker, syncConfig, syncView } from "../sync/view.mjs";

const password = "fake_github_token_for_test", passphrase = "fixture passphrase";
const auth = (uid, access = `fixture-access-${uid}`) => ({ type: "oauth", uid, access, refresh: `fixture-refresh-${uid}`, expires: 2000000000000 });
const authFile = dir => join(dir, "plugin-auth.json");
const setup = (t, initial = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeJSON(authFile(dir), initial);
  writeJSON(join(dir, "sync.json"), { url: "github://example/private-sync/fixture", branch: "test", password, passphrase, followServer: true });
  return dir;
};
const change = (dir, at, role, picks = []) => ({ id: randomUUID(), at, target: syncConfig(dir).machine, role, picks });

// Offline replica for the reused Contents API adapter, including conditional writes.
function github({ isPrivate = true } = {}) {
  let file;
  const calls = [];
  const fetcher = async (input, options) => {
    const url = new URL(input), { method } = options;
    calls.push({ method, path: url.pathname, query: url.search });
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${password}`);
    assert(options.signal instanceof AbortSignal);
    if (url.pathname === "/repos/example/private-sync") return Response.json({ private: isPrivate });
    assert.equal(url.pathname, "/repos/example/private-sync/contents/fixture/workbuddy-plus/accounts-v1.magpie-data");
    if (method === "GET") {
      assert.equal(url.searchParams.get("ref"), "test");
      return file ? Response.json({ type: "file", encoding: "base64", sha: file.sha, content: file.data.toString("base64") }) : new Response(null, { status: 404 });
    }
    assert.equal(method, "PUT");
    const body = JSON.parse(options.body);
    assert.equal(body.branch, "test");
    if (body.sha !== file?.sha) return new Response(null, { status: 409 });
    const data = Buffer.from(body.content, "base64");
    file = { data, sha: createHash("sha1").update(data).digest("hex") };
    return Response.json({ content: { sha: file.sha } });
  };
  return { calls, file: () => file, replace: value => { file = value; }, storeFactory: (config, signal) => new GitHubContents({ ...config, signal, fetcher }) };
}

test("account sync only starts when this machine accepts an explicit, new settings request", async t => {
  const a = setup(t), b = setup(t), now = Date.now();
  const guard = () => assert.fail("an off machine must not open the GitHub store");
  assert.equal(await hostTick(a, null, { storeFactory: guard }), "off");
  assert.equal(await hostTick(b, null, { storeFactory: guard }), "off");
  const cmd = change(a, now, "follower");
  assert.equal(await hostTick(b, cmd, { storeFactory: guard, now: () => now }), "off");
  assert.equal(await hostTick(a, { ...cmd, at: now - 600_000 }, { storeFactory: guard, now: () => now }), "off");
  assert.equal(await hostTick(a, { ...cmd, role: "master" }, { storeFactory: guard, now: () => now }), "off");
  assert.equal(syncView(a).reply.error, "empty");
  const off = change(a, now + 1, "off");
  await hostTick(a, off, { storeFactory: guard, now: () => now + 1 });
  assert.equal(await hostTick(a, cmd, { storeFactory: guard, now: () => now + 2 }), "off");
  assert.equal(syncView(a).reply.id, off.id);
});

test("the vendored sync chain sends access only, refreshes imported entries, and preserves all local logins", async t => {
  const source = {
    workbuddy: auth("primary"),
    "workbuddy#desktop": { ...auth("desktop"), source: "desktop" },
    "workbuddy#api": { type: "api", key: "fixture-api-key" },
    "workbuddy#enterprise": { ...auth("enterprise"), enterpriseId: "fixture-company" },
    "workbuddy#excluded": auth("excluded"),
    "workbuddy#conflict": auth("same"),
    "workbuddy-ai": auth("ai"),
    unrelated: auth("other")
  };
  const local = { "workbuddy#own": auth("same"), "workbuddy#local": auth("local"), unrelated: auth("unrelated") };
  const a = setup(t, source), b = setup(t, local), c = setup(t, { workbuddy: auth("contender") });
  let clock = Date.now();
  const repo = github(), services = { now: () => clock, storeFactory: repo.storeFactory };
  for (const dir of [a, b, c]) await hostTick(dir, null, services);
  assert.equal(await hostTick(a, change(a, clock - 1, "master", ["cn:enterprise", "cn:desktop"]), services), "off");
  assert.equal(syncView(a).reply.error, "unavailable");
  assert.equal(repo.calls.length, 0);
  const master = change(a, clock, "master", ["cn:primary", "cn:same", "intl:ai"]);
  const follower = change(b, clock, "follower");
  assert.equal(await hostTick(a, master, services), "published");
  assert.deepEqual(readJSON(authFile(a)), source, "the publisher never writes the auth file");
  const snapshot = await openData(repo.file().data, passphrase);
  assert.deepEqual(Object.keys(snapshot.accounts), ["workbuddy", "workbuddy-ai", "workbuddy#conflict"].sort((x, y) => x.localeCompare(y)));
  assert.match(JSON.stringify(snapshot), /fixture-access-primary/);
  assert.doesNotMatch(JSON.stringify(snapshot), /refresh|fixture-api-key|excluded|desktop|enterprise|unrelated|expires/);
  assert(!repo.file().data.includes("fixture-access-primary"));
  assert.equal(await hostTick(c, change(c, clock, "master", ["cn:contender"]), services), "other-master");
  assert.equal(syncView(c, clock).paused, true);
  assert.equal(await hostTick(b, follower, services), "received");
  const after = readJSON(authFile(b));
  for (const [key, value] of Object.entries(local)) assert.deepEqual(after[key], value);
  assert.equal(after["workbuddy#conflict"], undefined);
  assert.deepEqual(after.workbuddy, { type: "oauth", access: "fixture-access-primary", uid: "primary", expires: 0, [marker]: syncConfig(b).machine });
  assert.equal(after["workbuddy-ai"].access, "fixture-access-ai");
  assert.equal(syncView(b, clock).skipped, 1);
  const old = repo.file();
  clock += 30_000;
  writeJSON(authFile(a), { ...source, workbuddy: auth("primary", "fixture-rotated-access") });
  assert.equal(await hostTick(a, master, services), "published");
  assert.equal(await hostTick(b, follower, services), "received");
  assert.equal(readJSON(authFile(b)).workbuddy.access, "fixture-rotated-access");
  const good = repo.file();
  repo.replace(old);
  clock += 30_000;
  assert.equal(await hostTick(b, follower, services), "waiting");
  assert.equal(readJSON(authFile(b)).workbuddy.access, "fixture-rotated-access");
  const malicious = { ...snapshot, accounts: { workbuddy: auth("invalid") } };
  repo.replace({ ...good, data: await sealData(malicious, passphrase) });
  clock += 30_000;
  const beforeFailure = readFileSync(authFile(b), "utf8");
  assert.equal(await hostTick(b, follower, services), "failed");
  assert.equal(readFileSync(authFile(b), "utf8"), beforeFailure);
  assert.doesNotMatch(JSON.stringify(syncView(b, clock)), /fixture-access|fixture-refresh|fake_github_token|fixture passphrase/);
  repo.replace(good);
  clock += 30_000;
  const localLogin = { ...readJSON(authFile(b)), workbuddy: auth("primary", "new-local-login") };
  writeJSON(authFile(b), localLogin);
  assert.equal(await hostTick(b, follower, services), "received");
  assert.deepEqual(readJSON(authFile(b)).workbuddy, localLogin.workbuddy);
  const narrowed = change(a, clock, "master", ["cn:primary"]);
  assert.equal(await hostTick(a, narrowed, services), "published");
  clock += 30_000;
  assert.equal(await hostTick(b, follower, services), "received");
  assert.equal(readJSON(authFile(b))["workbuddy-ai"], undefined, "unsharing removes only the sync-owned entry");
  assert.deepEqual(readJSON(authFile(b)).workbuddy, localLogin.workbuddy);
});

test("untrusted or unavailable remote leaves the live auth file and backup untouched", async t => {
  const dir = setup(t, { workbuddy: auth("local") }), backup = authFile(dir) + ".bak";
  const repo = github({ isPrivate: false });
  const now = Date.now();
  writeFileSync(backup, "backup owned by Magpie");
  await hostTick(dir, null);
  const previous = readFileSync(authFile(dir), "utf8");
  assert.equal(await hostTick(dir, change(dir, now, "follower"), { storeFactory: repo.storeFactory, now: () => now }), "failed");
  assert.deepEqual(repo.calls.map(call => call.method), ["GET"]);
  assert.equal(readFileSync(authFile(dir), "utf8"), previous);
  assert.equal(readFileSync(backup, "utf8"), "backup owned by Magpie");
});

test("an old lock with a live holder is not taken over", async t => {
  const dir = setup(t), deadline = new Date(Date.now() - 3 * 60 * 60_000);
  const file = join(dir, "workbuddy-sync.lock");
  const original = JSON.stringify({ pid: process.pid, host: hostname(), at: +deadline });
  writeFileSync(file, original);
  utimesSync(file, deadline, deadline);
  assert.equal(await acquireEngineLock(dir), null);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("both schedules pause on the follower, without changing saved switches or hiding accounts", t => {
  const magpieDir = setup(t, { workbuddy: auth("cn"), "workbuddy-ai": auth("intl") }), dir = setup(t);
  const runner = new Runner(dir);
  writeJSON(join(dir, "config.json"), { ...defaults, magpieDir, enabled: true, intlEnabled: true, spread: 0 });
  let submissions = [];
  runner.submit = (actions, ids, trigger) => { submissions.push({ ids, trigger }); return { id: randomUUID() }; };
  const now = new Date("2026-11-25T10:32:00+08:00");
  const machine = randomUUID();
  writeJSON(configPath(magpieDir), { machine, role: "follower", picks: [] });
  runner.tick(now);
  assert.deepEqual(submissions, []);
  const view = runner.boardView();
  assert.equal(view.enabled, false);
  assert.equal(view.intlEnabled, false);
  assert(view.today.slots.length > 0 && view.today.slots.every(slot => slot.paused));
  assert.equal(runner.status().accounts.length, 2);
  assert(runner.config().enabled && runner.config().intlEnabled);
  assert.doesNotMatch(JSON.stringify(view), /fixture-access|fixture-refresh|fake_github_token|fixture passphrase/);
  writeJSON(configPath(magpieDir), { machine, role: "off", picks: [] });
  runner.tick(now);
  assert(submissions.some(({ ids }) => ids.includes("cn:cn")));
  assert(submissions.some(({ ids }) => ids.includes("intl:intl")));
});
