import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaults, accounts, initialize, readJSON, writeJSON } from "../storage.mjs";
import { WorkBuddyClient } from "../client.mjs";
import { Runner } from "../runner.mjs";
import { createService } from "../server.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initialize(dir); mkdirSync(join(dir, "magpie"));
  const auth = { type: "oauth", uid: "u1", accountId: "fixture@example.test", access: "private-access", refresh: "private-refresh", expires: Date.now() + 86400_000 };
  const magpieDir = join(dir, "magpie");
  writeJSON(join(magpieDir, "plugin-auth.json"), { "workbuddy#u1": auth, other: { type: "api", key: "unrelated-secret" } });
  writeJSON(join(dir, "config.json"), { ...defaults, magpieDir, schedules: Object.fromEntries(Object.keys(defaults.schedules).map(key => [key, []])) });
  return { dir, auth, magpieDir, config: () => readJSON(join(dir, "config.json")) };
}
async function settled(runner) {
  for (let i = 0; i < 50; i++) {
    if (runner.state.jobs.every(j => !["running", "queued"].includes(j.status))) return;
    await delay(5);
  }
  throw new Error("fixture job did not settle");
}

test("only domestic Magpie logins are read; status never reveals credentials", t => {
  const p = fixture(t);
  const authFile = join(p.magpieDir, "plugin-auth.json");
  const auths = readJSON(authFile);
  auths["workbuddy-ai#u2"] = { ...p.auth, uid: "u2", access: "excluded-international" };
  writeJSON(authFile, auths);
  assert.equal(accounts(p.config()).length, 1);
  assert.equal(accounts(p.config(), p.dir)[0].auth.access, "private-access");
  const runner = new Runner(p.dir);
  const status = JSON.stringify(runner.status());
  assert.ok(!/private-access|private-refresh|unrelated-secret|excluded-international/.test(status));
  assert.equal(statSync(authFile).mode & 0o777, 0o600);
});

test("concurrent refreshes spend one token and preserve unrelated Magpie logins", async t => {
  const p = fixture(t), file = join(p.magpieDir, "plugin-auth.json");
  writeJSON(file, { "workbuddy#u1": { ...p.auth, expires: Date.now() - 1000 }, other: { key: "unrelated-secret" } });
  let calls = 0;
  const fetcher = async () => { calls++; await delay(20); return Response.json({ code: 0, data: { accessToken: "renewed-access", refreshToken: "renewed-refresh", expiresIn: 86400 } }); };
  const a = accounts(p.config(), p.dir)[0], b = accounts(p.config(), p.dir)[0];
  const one = new WorkBuddyClient(a, p.config(), { fetcher, gap: 0 }), two = new WorkBuddyClient(b, p.config(), { fetcher, gap: 0 });
  await Promise.all([one.refresh(), two.refresh()]);
  assert.equal(calls, 1);
  assert.equal(readJSON(file).other.key, "unrelated-secret");
  assert.equal(readJSON(file)["workbuddy#u1"].refresh, "renewed-refresh");
  assert.equal(b.auth.access, "renewed-access");
});

test("a failed refresh is visible and leaves saved tokens intact", async t => {
  const p = fixture(t), file = join(p.magpieDir, "plugin-auth.json");
  writeJSON(file, { "workbuddy#u1": { ...p.auth, expires: 1 } });
  const client = new WorkBuddyClient(accounts(p.config(), p.dir)[0], p.config(), { gap: 0, fetcher: async () => Response.json({ code: 401, msg: "refresh expired" }, { status: 401 }) });
  await assert.rejects(client.refresh(), /refresh expired/);
  assert.equal(readJSON(file)["workbuddy#u1"].refresh, "private-refresh");
});

test("timer slots survive restart and do not run twice at the same minute", async t => {
  const p = fixture(t), config = p.config();
  config.enabled = true; config.schedules.keepalive = ["09:00"];
  writeJSON(join(p.dir, "config.json"), config);
  const runner = new Runner(p.dir);
  runner.tick(new Date("2026-10-29T00:59:00Z")); assert.equal(runner.state.jobs.length, 0);
  runner.tick(new Date("2026-10-29T01:00:00Z")); await settled(runner);
  assert.equal(runner.state.jobs.length, 1);
  assert.equal(runner.state.jobs[0].status, "succeeded");
  new Runner(p.dir).tick(new Date("2026-10-29T01:00:30Z"));
  assert.equal(readJSON(join(p.dir, "state.json")).jobs.length, 1);
});

test("paused schedules and disabled accounts make no jobs", t => {
  const p = fixture(t), config = p.config();
  config.schedules.keepalive = ["09:00"];
  writeJSON(join(p.dir, "config.json"), config);
  const runner = new Runner(p.dir); runner.tick(new Date("2026-10-29T02:00:00Z"));
  assert.equal(runner.state.jobs.length, 0);
  config.enabled = true; config.disabledAccounts = ["cn:u1"];
  writeJSON(join(p.dir, "config.json"), config); runner.tick(new Date("2026-10-29T02:00:00Z"));
  assert.equal(runner.state.jobs.length, 0);
  assert.throws(() => runner.submit(["all"], ["cn:u1"]), /停用/);
});

test("restarting an unfinished job records interruption instead of success", t => {
  const p = fixture(t), state = readJSON(join(p.dir, "state.json"));
  state.jobs.push({ id: "before-crash", status: "running", logs: [], results: [] });
  writeJSON(join(p.dir, "state.json"), state);
  const runner = new Runner(p.dir);
  assert.equal(runner.state.jobs[0].status, "interrupted");
  assert.match(runner.state.jobs[0].logs[0].message, /重启/);
});

test("HTTP service serves the panel, rejects cross-site mutations, and validates schedule inputs", async t => {
  const p = fixture(t), { server } = createService({ dir: p.dir });
  server.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const panel = await fetch(base); assert.equal(panel.status, 200); assert.match(await panel.text(), /猫猫旅行/);
  const denied = await fetch(base + "/api/run", { method: "POST", headers: { Origin: "https://unrelated.example", "Content-Type": "application/json", "X-WorkBuddy-Plus": "1" }, body: JSON.stringify({ action: "all" }) });
  assert.equal(denied.status, 403);
  const malformed = await fetch(base + "/api/config", { method: "POST", headers: { "Content-Type": "application/json", "X-WorkBuddy-Plus": "1" }, body: JSON.stringify({ ...p.config(), schedules: { ...p.config().schedules, daily: ["25:00"] } }) });
  assert.equal(malformed.status, 400);
  const checkin = await fetch(base + "/api/run", { method: "POST", headers: { "Content-Type": "application/json", "X-WorkBuddy-Plus": "1" }, body: JSON.stringify({ action: "checkin" }) });
  assert.equal(checkin.status, 400);
  assert.match((await checkin.json()).error, /无效的操作/);
  const status = await (await fetch(base + "/api/status")).text(); assert.ok(!status.includes("private-access"));
});

test("a rate limit is retried, then defers the slot instead of failing it", async t => {
  const p = fixture(t), config = p.config();
  config.enabled = true; config.schedules.tasks = ["09:10"];
  writeJSON(join(p.dir, "config.json"), config);
  let calls = 0, limited = true;
  const waits = [];
  const fetcher = async () => { calls++; return limited ? new Response("{}", { status: 429, headers: { "Retry-After": "2" } }) : Response.json({ code: 0, data: { tasks: [] } }); };
  const runner = new Runner(p.dir, { gap: 0, fetcher, wait: async ms => { waits.push(ms); } });
  runner.tick(new Date("2026-10-29T01:10:00Z")); await settled(runner);
  const first = runner.state.jobs[0];
  assert.equal(first.status, "deferred");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);
  assert.match(first.logs.at(-1).message, /被限流/);
  // Once the limit lifts, the slot's next retry runs and goes through.
  limited = false;
  first.finished = new Date("2026-10-29T01:10:30Z").toISOString();
  runner.tick(new Date("2026-10-29T01:26:00Z")); await settled(runner);
  assert.equal(runner.state.jobs.length, 2);
  assert.ok(runner.state.jobs.some(j => j.status === "succeeded"));
});

test("the board lists today's slots with how each went and which is next", async t => {
  const p = fixture(t), config = p.config();
  config.enabled = true; config.schedules = { ...config.schedules, keepalive: ["09:00", "21:00"], night: ["01:00"] };
  writeJSON(join(p.dir, "config.json"), config);
  const runner = new Runner(p.dir, { gap: 0, fetcher: async () => Response.json({ code: 0, data: {} }) });
  runner.tick(new Date("2026-10-29T01:00:00Z")); await settled(runner);
  const today = runner.today(runner.config(), new Date("2026-10-29T02:00:00Z"));
  assert.deepEqual(today.slots.map(s => [s.at, s.kind, s.status]), [["01:00", "night", "missed"], ["09:00", "keepalive", "succeeded"], ["21:00", "keepalive", "upcoming"]]);
  assert.deepEqual([today.next.at, today.next.kind], ["21:00", "keepalive"]);
  config.enabled = false; writeJSON(join(p.dir, "config.json"), config);
  assert.equal(runner.today(runner.config(), new Date("2026-10-29T02:00:00Z")).next, null);
});
