import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "../runner.mjs";
import { accounts, defaults, readJSON, writeJSON } from "../storage.mjs";
import { openData, sealData } from "../sync/crypto.mjs";
import { acquireEngineLock } from "../sync/engine-lock.mjs";
import { GitHubContents } from "../sync/github.mjs";
import { hostTick } from "../sync/host.mjs";
import { configPath, marker, syncChoices, syncConfig, syncView } from "../sync/view.mjs";

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
  const path = "/repos/example/private-sync/contents/fixture/workbuddy-plus", snapshot = path + "/accounts-v1.magpie-data";
  const files = new Map(), followers = path + "/followers";
  let failPresence = false;
  const calls = [];
  const fetcher = async (input, options) => {
    const url = new URL(input), { method } = options;
    calls.push({ method, path: url.pathname, query: url.search });
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${password}`);
    assert(options.signal instanceof AbortSignal);
    if (url.pathname === "/repos/example/private-sync") return Response.json({ private: isPrivate });
    if (url.pathname === followers) {
      assert.equal(method, "GET");
      assert.equal(url.searchParams.get("ref"), "test");
      if (failPresence) return new Response(null, { status: 403 });
      return Response.json([...files.keys()].filter(key => key.startsWith(followers + "/")).map(key => ({
        type: "file", name: key.slice(followers.length + 1), path: key, size: files.get(key).data.length
      })));
    }
    assert(url.pathname === snapshot || url.pathname.startsWith(followers + "/"));
    if (url.pathname !== snapshot && failPresence) return new Response(null, { status: 403 });
    const file = files.get(url.pathname);
    if (method === "GET") {
      assert.equal(url.searchParams.get("ref"), "test");
      return file ? Response.json({ type: "file", encoding: "base64", sha: file.sha, content: file.data.toString("base64") }) : new Response(null, { status: 404 });
    }
    assert.equal(method, "PUT");
    const body = JSON.parse(options.body);
    assert.equal(body.branch, "test");
    if (body.sha !== file?.sha) return new Response(null, { status: 409 });
    const data = Buffer.from(body.content, "base64");
    const sha = createHash("sha1").update(data).digest("hex");
    files.set(url.pathname, { data, sha });
    return Response.json({ content: { sha } });
  };
  return { calls, files, file: () => files.get(snapshot), replace: value => files.set(snapshot, value), failPresence: () => { failPresence = true; },
    storeFactory: (config, signal) => new GitHubContents({ ...config, signal, fetcher }) };
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

test("changing storage cannot preserve authority from the old target's lease", async t => {
  const dir = setup(t, { workbuddy: auth("master") });
  const repo = github(); let now = Date.now();
  const service = { storeFactory: repo.storeFactory, now: () => now };
  await hostTick(dir, null);
  assert.equal(await hostTick(dir, change(dir, now, "master", ["cn:master"]), service), "published");
  assert.equal(syncView(dir, now).paused, false);
  writeJSON(join(dir, "sync.json"), { url: "https://dav.example.test/", user: "fixture", password, passphrase });
  now += 30_000;
  assert.equal(await hostTick(dir, null, { ...service, storeFactory: () => { throw new Error("offline"); } }), "failed");
  assert.equal(syncView(dir, now).paused, true);
});

test("explicit enterprise and API selections sync for Magpie without exposing keys or replacing local sign-ins", async t => {
  const personal = auth("same-user"), enterprise = { ...auth("same-user", "enterprise-access"), enterpriseId: "tenant-one" };
  const api = { type: "api", key: "fixture-api-key" };
  const source = { workbuddy: personal, "workbuddy#enterprise": enterprise, "workbuddy-ai#manual": api };
  const choices = syncChoices(source);
  assert.deepEqual(choices.map(a => a.kind), ["personal", "enterprise", "api"]);
  assert.equal(new Set(choices.map(a => a.id)).size, 3);
  assert.doesNotMatch(JSON.stringify(choices), /fixture-api-key|enterprise-access|fixture-refresh/);
  const a = setup(t, source), b = setup(t, { "workbuddy#local": personal }), c = setup(t, { "workbuddy-ai#manual": { type: "api", key: "local-api-key" } });
  let clock = Date.now();
  const repo = github(), services = { now: () => clock, storeFactory: repo.storeFactory };
  for (const dir of [a, b, c]) await hostTick(dir, null, services);
  assert.equal(await hostTick(a, change(a, clock, "master", choices.map(x => x.id)), services), "published");
  const snapshot = await openData(repo.file().data, passphrase);
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.accounts["workbuddy-ai#manual"], api);
  assert.equal(snapshot.accounts["workbuddy#enterprise"].enterpriseId, enterprise.enterpriseId);
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-refresh/);
  assert.equal(await hostTick(b, change(b, clock, "follower"), services), "received");
  assert.equal(await hostTick(c, change(c, clock, "follower"), services), "received");
  const imported = readJSON(authFile(b));
  assert.deepEqual(imported["workbuddy#local"], personal);
  assert.equal(imported["workbuddy#enterprise"].enterpriseId, enterprise.enterpriseId);
  assert.deepEqual(imported["workbuddy-ai#manual"], { ...api, [marker]: syncConfig(b).machine });
  const boardAccounts = accounts({ ...defaults, magpieDir: b });
  assert.deepEqual(boardAccounts.map(({ enterprise }) => enterprise), [false, true], "the board keeps personal and enterprise rows but excludes API keys");
  assert.equal(boardAccounts[0].id, "cn:same-user");
  assert.notEqual(boardAccounts[1].id, boardAccounts[0].id);
  assert.equal(readJSON(authFile(c))["workbuddy-ai#manual"].key, "local-api-key");
  assert.doesNotMatch(JSON.stringify(new Runner(b, {}, { hostConfig: b }).boardView().sync), /fixture-api-key|enterprise-access|fixture-refresh/);
  clock += 30_000;
  assert.equal(await hostTick(a, change(a, clock, "master", [choices[0].id]), services), "published");
  assert.equal((await openData(repo.file().data, passphrase)).version, 1, "personal-only sharing still uses the old format");
  assert.equal(await hostTick(b, null, services), "received");
  assert.equal(readJSON(authFile(b))["workbuddy-ai#manual"], undefined);
  assert.equal(readJSON(authFile(b))["workbuddy#enterprise"], undefined);
  assert.deepEqual(readJSON(authFile(b))["workbuddy#local"], personal);
});

test("a synced API key can be selected on the next master without offering imported OAuth", async t => {
  const source = { workbuddy: auth("main"), "workbuddy-ai#api": { type: "api", key: "fixture-api-key" } };
  const a = setup(t, source), b = setup(t), repo = github();
  let clock = Date.now();
  const services = { now: () => clock, storeFactory: repo.storeFactory };
  await hostTick(a, null, services);
  await hostTick(b, null, services);
  assert.equal(await hostTick(a, change(a, clock, "master", syncChoices(source).map(a => a.id)), services), "published");
  assert.equal(await hostTick(b, change(b, clock, "follower"), services), "received");
  const imported = readJSON(authFile(b));
  assert.equal(syncChoices(imported, syncConfig(a).machine).length, 0);
  const eligible = syncChoices(imported, syncConfig(b).machine);
  assert.deepEqual(eligible.map(a => a.kind), ["api"]);

  clock += 1;
  assert.equal(await hostTick(a, change(a, clock, "off"), services), "off");
  assert.equal(await hostTick(b, change(b, clock, "master", eligible.map(a => a.id)), services), "other-master");
  clock += 10 * 60_000;
  assert.equal(await hostTick(b, null, services), "published");
  const next = await openData(repo.file().data, passphrase);
  assert.equal(next.lease.owner, syncConfig(b).machine);
  assert.deepEqual(next.accounts, { "workbuddy-ai#api": source["workbuddy-ai#api"] });
});

test("a follower with new Magpie-managed OAuth sign-ins can take over without sharing refresh credentials", async t => {
  const original = {
    workbuddy: auth("cn"),
    "workbuddy#enterprise": { ...auth("firm"), enterpriseId: "fixture-company" },
    "workbuddy-ai": auth("intl")
  };
  const own = { "workbuddy#local": auth("local") };
  const a = setup(t, original), b = setup(t, own), repo = github();
  let clock = Date.now();
  const services = { now: () => clock, storeFactory: repo.storeFactory };
  for (const dir of [a, b]) await hostTick(dir, null, services);
  const picks = syncChoices(original).map(choice => choice.id);
  assert.equal(await hostTick(a, change(a, clock, "master", picks), services), "published");
  assert.equal(await hostTick(b, change(b, clock, "follower"), services), "received");
  assert.deepEqual(syncChoices(readJSON(authFile(b)), syncConfig(b).machine).map(choice => choice.id), ["cn:local"]);
  const prior = repo.file().sha;
  clock++;
  assert.equal(await hostTick(b, change(b, clock, "master", picks), services), "idle");
  assert.equal(syncConfig(b).role, "follower");
  assert.equal(syncView(b, clock).reply.error, "unavailable");
  assert.equal(repo.file().sha, prior);

  // Only model the sign-ins Magpie would save after an official import succeeds.
  // The real vendor import and refresh-token rotation are not part of this test.
  const native = Object.fromEntries(Object.entries(original).map(([key, item]) => [
    key, { ...item, access: `new-access-${item.uid}`, refresh: `new-refresh-${item.uid}` }
  ]));
  assert.equal(await hostTick(a, change(a, ++clock, "off"), services), "off");
  writeJSON(authFile(b), { ...own, ...native });
  assert.equal(await hostTick(b, change(b, ++clock, "master", picks), services), "other-master");
  assert.equal(syncView(b, clock).paused, true);
  assert.equal(repo.file().sha, prior);
  clock += 10 * 60_000;
  assert.equal(await hostTick(b, null, services), "published");
  assert.equal(syncView(b, clock).paused, false);
  const next = await openData(repo.file().data, passphrase);
  assert.equal(next.version, 2);
  assert.equal(next.lease.owner, syncConfig(b).machine);
  assert.deepEqual(next.accounts, Object.fromEntries(Object.entries(native).map(([key, { refresh, expires, ...portable }]) => [key, portable])));
  assert.deepEqual(readJSON(authFile(a)), original);
  assert.deepEqual(readJSON(authFile(b)), { ...own, ...native });
});

test("a manual synchronization polls immediately without enabling an off machine", async t => {
  const dir = setup(t, { workbuddy: auth("main") }), repo = github(), now = Date.now();
  let clock = now;
  const services = { storeFactory: repo.storeFactory, now: () => clock };
  assert.equal(await hostTick(dir, null, { ...services, force: true }), "off");
  assert.equal(repo.calls.length, 0);
  assert.equal(await hostTick(dir, change(dir, clock, "master", ["cn:main"]), services), "published");
  writeJSON(authFile(dir), { workbuddy: auth("main", "new-access") });
  clock += 1000;
  assert.equal(await hostTick(dir, null, services), "idle");
  assert.equal(await hostTick(dir, null, { ...services, force: true }), "published");
  assert.equal((await openData(repo.file().data, passphrase)).accounts.workbuddy.access, "new-access");
});

test("sync diagnostics identify the lease holder and age credential-free follower heartbeats", async t => {
  const a = setup(t, { workbuddy: auth("primary") }), b = setup(t);
  let clock = Date.now();
  const repo = github(), service = { now: () => clock, storeFactory: repo.storeFactory };
  await hostTick(a, null, service);
  await hostTick(b, null, service);
  assert.equal(await hostTick(a, change(a, clock, "master", ["cn:primary"]), service), "published");
  assert.equal(await hostTick(b, change(b, clock, "follower"), service), "received");
  const presence = [...repo.files].find(([path]) => path.includes("/followers/"));
  assert.ok(presence);
  assert.deepEqual(JSON.parse(presence[1].data), { version: 1, seen: clock, generation: 1 });
  const fromFollower = syncView(b, clock);
  assert.equal(fromFollower.snapshot.generation, 1);
  assert.equal(fromFollower.snapshot.local, false);
  assert.equal(fromFollower.applied, 1);
  assert.deepEqual(fromFollower.devices.map(({ role, local, online }) => [role, local, online]),
    [["master", false, true], ["follower", true, true]]);
  clock += 120_000;
  assert.equal(await hostTick(a, null, service), "published");
  assert.equal(await hostTick(b, null, service), "received");
  assert.equal(repo.calls.filter(({ path, method }) => path.includes("/followers/") && method === "PUT").length, 1, "polls do not commit every time");
  const fromMaster = syncView(a, clock);
  assert.equal(fromMaster.snapshot.local, true);
  assert.deepEqual(fromMaster.devices.map(({ role, local, online }) => [role, local, online]),
    [["master", true, true], ["follower", false, true]]);
  assert.doesNotMatch(JSON.stringify(fromMaster.devices), /fixture-access|fixture-refresh|fake_github_token|fixture passphrase/);

  clock += 31 * 60_000;
  assert.equal(await hostTick(a, null, service), "published");
  const later = syncView(a, clock);
  assert.equal(later.snapshot.generation, 2);
  assert.equal(later.devices[1].online, false);
  assert.equal(later.devices[1].generation, 1, "online state and last applied generation are independent");
  repo.failPresence();
  clock += 120_000;
  assert.equal(await hostTick(b, null, service), "received", "presence cannot veto a valid apply");
  const affected = syncView(b, clock);
  assert.equal(affected.applied, 2);
  assert.equal(affected.devicesUnavailable, true);
  assert.equal(affected.heartbeatFailed, true);
});

test("a reachable follower heartbeats while waiting, without applying missing or expired snapshots", async t => {
  const a = setup(t, { workbuddy: auth("primary") }), b = setup(t), repo = github();
  const start = Date.now();
  let clock = start;
  const services = { now: () => clock, storeFactory: repo.storeFactory };
  await hostTick(a, null, services);
  await hostTick(b, null, services);
  const local = () => syncView(b, clock).devices.find(device => device.local);
  assert.equal(await hostTick(b, change(b, clock, "follower"), services), "waiting");
  assert.equal(local()?.online, true, "a new follower is online before its first snapshot");
  assert.equal(local().generation, 0);
  assert.deepEqual(readJSON(authFile(b)), {});

  assert.equal(await hostTick(a, change(a, clock, "master", ["cn:primary"]), services), "published");
  clock += 30_000;
  assert.equal(await hostTick(b, null, services), "received");
  const savedAuth = readFileSync(authFile(b), "utf8");
  for (const minute of [11, 21, 31]) {
    clock = start + minute * 60_000;
    assert.equal(await hostTick(b, null, services), "waiting");
    assert.equal(local()?.online, true);
    assert.equal(local().seen, clock);
    assert.equal(syncView(b, clock).applied, 1, "renewing a heartbeat does not pretend to apply a snapshot");
  }
  assert.equal(readFileSync(authFile(b), "utf8"), savedAuth);
  const heartbeat = [...repo.files].find(([path]) => path.includes("/followers/"));
  assert.deepEqual(JSON.parse(heartbeat[1].data), { version: 1, seen: clock, generation: 1 });
  clock += 31 * 60_000;
  assert.equal(local()?.online, false, "a follower that actually stops polling becomes offline");
  assert.equal(await hostTick(a, null, services), "published");
  writeFileSync(authFile(b), "corrupt auth fixture");
  assert.equal(await hostTick(b, null, services), "failed");
  assert.equal(local()?.online, true, "local apply errors do not suppress an otherwise reachable heartbeat");
  assert.equal(syncView(b, clock).applied, 1);
  assert.equal(readFileSync(authFile(b), "utf8"), "corrupt auth fixture");
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

test("clearing shared accounts publishes an empty snapshot and removes only imported entries", async t => {
  const local = { "workbuddy#own": auth("own"), unrelated: auth("other") };
  const a = setup(t, { workbuddy: auth("primary"), "workbuddy-ai": auth("intl") }), b = setup(t, local);
  let clock = Date.now();
  const repo = github(), services = { now: () => clock, storeFactory: repo.storeFactory };
  for (const dir of [a, b]) await hostTick(dir, null, services);
  assert.equal(await hostTick(a, change(a, clock, "master", ["cn:primary", "intl:intl"]), services), "published");
  assert.equal(await hostTick(b, change(b, clock, "follower"), services), "received");
  assert.equal(readJSON(authFile(b)).workbuddy.access, "fixture-access-primary");

  clock += 1;
  // Magpie may have renewed a locally signed-in entry that still has the old marker.
  const signedIn = { ...auth("signed-in", "new-local-access"), [marker]: syncConfig(b).machine };
  const files = readJSON(authFile(b));
  writeJSON(authFile(b), { ...files, "workbuddy#signed-in": signedIn });
  const clear = { ...change(a, clock, "master", []), clear: true };
  assert.equal(await hostTick(a, clear, services), "cleared");
  const snapshot = await openData(repo.file().data, passphrase);
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.cleared, true);
  assert.deepEqual(snapshot.accounts, {});
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-access|fixture-refresh|fixture-api-key/);
  assert.equal(syncView(a, clock).code, "cleared");
  assert.deepEqual(syncView(a, clock).picks, []);
  assert.deepEqual(syncView(a, clock).actions, { clear: true, now: true });
  assert.equal(syncView(a, clock).paused, false, "a valid clear lease keeps the master's schedules running");

  clock += 30_000;
  assert.equal(await hostTick(b, null, services), "cleared");
  const after = readJSON(authFile(b));
  assert.equal(after.workbuddy, undefined);
  assert.equal(after["workbuddy-ai"], undefined);
  assert.deepEqual(after["workbuddy#signed-in"], signedIn);
  assert.deepEqual(after["workbuddy#own"], local["workbuddy#own"]);
  assert.deepEqual(after.unrelated, local.unrelated);
  assert.equal(syncView(b, clock).code, "cleared");

  clock += 30_000;
  assert.equal(await hostTick(a, null, services), "cleared", "the master keeps renewing the clear lease");
  clock += 1;
  assert.equal(await hostTick(a, change(a, clock, "master", ["cn:primary"]), services), "published");
  clock += 30_000;
  assert.equal(await hostTick(b, null, services), "received");
  assert.equal(readJSON(authFile(b)).workbuddy.access, "fixture-access-primary");
});

test("empty master picks without an explicit clear never revoke follower accounts", async t => {
  const dir = setup(t, { workbuddy: auth("main") }), repo = github(), clock = Date.now();
  const services = { storeFactory: repo.storeFactory, now: () => clock };
  await hostTick(dir, null, services);
  assert.equal(await hostTick(dir, change(dir, clock, "master", ["cn:main"]), services), "published");
  const original = repo.file();
  writeJSON(configPath(dir), { ...syncConfig(dir), picks: [] });
  assert.equal(await hostTick(dir, null, { ...services, force: true }), "missing");
  assert.equal(repo.file().sha, original.sha);
});

test("a missing selected account never turns into a clear", async t => {
  const dir = setup(t, { workbuddy: auth("primary") });
  let clock = Date.now();
  const repo = github(), services = { now: () => clock, storeFactory: repo.storeFactory };
  await hostTick(dir, null, services);
  assert.equal(await hostTick(dir, change(dir, clock, "master", ["cn:primary"]), services), "published");
  const good = repo.file();
  writeJSON(authFile(dir), {});
  clock += 30_000;
  assert.equal(await hostTick(dir, null, services), "missing");
  assert.equal(repo.file().sha, good.sha, "the published snapshot is untouched");
  assert.equal((await openData(repo.file().data, passphrase)).version, 1);
});

test("a page request can force one poll without changing the saved role", async t => {
  const dir = setup(t, { workbuddy: auth("main") }), repo = github();
  let clock = Date.now();
  const services = { storeFactory: repo.storeFactory, now: () => clock };
  await hostTick(dir, null, services);
  assert.equal(await hostTick(dir, change(dir, clock, "master", ["cn:main"]), services), "published");
  const saved = syncConfig(dir);
  writeJSON(authFile(dir), { workbuddy: auth("main", "new-access") });
  clock += 1000;
  assert.equal(await hostTick(dir, null, services), "idle");
  const request = { id: randomUUID(), at: clock, target: saved.machine, now: true };
  assert.equal(await hostTick(dir, request, services), "published");
  assert.equal((await openData(repo.file().data, passphrase)).accounts.workbuddy.access, "new-access");
  const after = syncConfig(dir);
  assert.equal(after.role, "master");
  assert.deepEqual(after.picks, ["cn:main"]);
  assert.equal(after.reply.id, request.id);
  assert.equal(syncView(dir, clock).reply.id, request.id);
  const calls = repo.calls.length;
  for (const repeated of [request, { ...request, id: randomUUID(), target: randomUUID() }]) {
    assert.equal(await hostTick(dir, repeated, services), "idle");
  }
  assert.equal(repo.calls.length, calls, "replayed or foreign requests do not bypass the poll interval");
});

test("a page request cannot enable an off machine", async t => {
  const dir = setup(t), repo = github(), now = Date.now();
  await hostTick(dir, null, { storeFactory: repo.storeFactory, now: () => now });
  const config = syncConfig(dir);
  const request = { id: randomUUID(), at: now, target: config.machine, now: true };
  assert.equal(await hostTick(dir, request, { storeFactory: repo.storeFactory, now: () => now }), "off");
  assert.equal(syncConfig(dir).role, "off");
  assert.equal(repo.calls.length, 0);
  assert.equal(syncView(dir, now).reply.id, request.id);
});

test("clear requests need the master role and an empty selection", async t => {
  const dir = setup(t, { workbuddy: auth("main") }), repo = github(), start = Date.now();
  let clock = start;
  const services = { storeFactory: repo.storeFactory, now: () => clock };
  await hostTick(dir, null, services);
  const base = { at: start, target: syncConfig(dir).machine };
  assert.equal(await hostTick(dir, { ...base, id: randomUUID(), role: "follower", picks: [], clear: true }, services), "off");
  assert.equal(syncView(dir, clock).reply.error, "invalid");
  clock += 1;
  assert.equal(await hostTick(dir, { ...base, at: clock, id: randomUUID(), role: "master", picks: ["cn:main"], clear: true }, services), "off");
  assert.equal(syncView(dir, clock).reply.error, "invalid");
  assert.equal(repo.calls.length, 0);
});

test("an empty snapshot without the clear marker is rejected", async t => {
  const a = setup(t, { workbuddy: auth("primary") }), b = setup(t);
  let clock = Date.now();
  const repo = github(), services = { now: () => clock, storeFactory: repo.storeFactory };
  for (const dir of [a, b]) await hostTick(dir, null, services);
  assert.equal(await hostTick(a, change(a, clock, "master", ["cn:primary"]), services), "published");
  assert.equal(await hostTick(b, change(b, clock, "follower"), services), "received");
  const before = readFileSync(authFile(b), "utf8");
  const bad = { version: 3, generation: 2, lease: { owner: syncConfig(a).machine, until: clock + 600_000 }, accounts: {} };
  repo.replace({ data: await sealData(bad, passphrase), sha: "bad" });
  clock += 30_000;
  assert.equal(await hostTick(b, null, services), "failed");
  assert.equal(readFileSync(authFile(b), "utf8"), before);
});
