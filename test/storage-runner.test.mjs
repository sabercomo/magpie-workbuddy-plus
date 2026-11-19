import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaults, accounts, calendar, initialize, intlSchedules, legacySchedules, plan, readJSON, settle, validateConfig, writeJSON } from "../storage.mjs";
import { WorkBuddyClient, isRestricted } from "../client.mjs";
import { dropped } from "../network.mjs";
import { EventEmitter } from "node:events";
import { Runner, jobOutcome, magpieBin, shifted } from "../runner.mjs";
import { createService, answering } from "../server.mjs";
import { WorkBuddyPlusPlugin, portOf, handoff } from "../index.mjs";
import { actions } from "../engine.mjs";
import { newer, version } from "../storage.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initialize(dir); mkdirSync(join(dir, "magpie"));
  const auth = { type: "oauth", uid: "u1", accountId: "fixture@example.test", access: "private-access", refresh: "private-refresh", expires: Date.now() + 86400_000 };
  const magpieDir = join(dir, "magpie");
  writeJSON(join(magpieDir, "plugin-auth.json"), { "workbuddy#u1": auth, other: { type: "api", key: "unrelated-secret" } });
  // Slots fire on their set minute here; the ±spread moment has its own test.
  writeJSON(join(dir, "config.json"), { ...defaults, spread: 0, magpieDir, schedules: Object.fromEntries(Object.keys(defaults.schedules).map(key => [key, []])), intlSchedules: Object.fromEntries(Object.keys(defaults.intlSchedules).map(key => [key, []])) });
  return { dir, auth, magpieDir, config: () => readJSON(join(dir, "config.json")) };
}
async function settled(runner) {
  for (let i = 0; i < 50; i++) {
    if (runner.state.jobs.every(j => !["running", "queued"].includes(j.status))) return;
    await delay(5);
  }
  throw new Error("fixture job did not settle");
}

test("0.7.2 defaults start at minute 01 and only untouched old defaults move", t => {
  const p = fixture(t), file = join(p.dir, "config.json");
  assert.deepEqual(defaults.schedules, { daily: ["09:01", "21:01"], tasks: ["09:11", "21:11"], sweep: ["10:01", "22:11"], night: ["01:01"] });
  assert.deepEqual(defaults.intlSchedules, { daily: ["09:01", "21:01"], web: ["10:31"] });
  assert.equal(defaults.campaignApp, false);
  assert.equal(defaults.buddyAuto, false);
  assert.deepEqual(defaults.pausedAccounts, []);
  const { scheduleDefaults: _, ...oldDefaults } = defaults;
  writeJSON(file, { ...oldDefaults, schedules: { ...legacySchedules.schedules, keepalive: ["22:00"] }, intlSchedules: { ...legacySchedules.intlSchedules, keepalive: ["22:00"] } });
  initialize(p.dir);
  assert.deepEqual([readJSON(file).schedules, readJSON(file).intlSchedules, readJSON(file).scheduleDefaults], [defaults.schedules, defaults.intlSchedules, 2]);
  const custom = { ...legacySchedules.schedules, daily: ["08:07"] };
  writeJSON(file, { ...oldDefaults, schedules: custom, intlSchedules: legacySchedules.intlSchedules });
  initialize(p.dir);
  assert.deepEqual([readJSON(file).schedules.daily, readJSON(file).intlSchedules, readJSON(file).scheduleDefaults], [["08:07"], defaults.intlSchedules, 2]);
});

test("China and WorkBuddy AI logins are read, each build's schedule on its own switch; status never reveals credentials", t => {
  const p = fixture(t);
  const authFile = join(p.magpieDir, "plugin-auth.json");
  const auths = readJSON(authFile);
  auths["workbuddy-ai"] = { ...p.auth, uid: "u2", access: "private-international" };
  writeJSON(authFile, auths);
  assert.deepEqual(accounts(p.config()).map(a => [a.id, a.realm, a.enabled]), [["cn:u1", "cn", true], ["intl:u2", "intl", true]]);
  assert.equal(accounts(p.config(), p.dir)[0].auth.access, "private-access");
  // The old whole-build switch only pauses WorkBuddy AI's schedule now; its accounts stay usable by hand.
  assert.deepEqual(accounts({ ...p.config(), intl: false }).map(a => [a.id, a.enabled]), [["cn:u1", true], ["intl:u2", true]]);
  const { intlEnabled: _, ...before } = { ...p.config(), enabled: true };
  assert.deepEqual([settle(before).intlEnabled, settle({ ...before, intl: false }).intlEnabled, settle({ ...before, enabled: false }).intlEnabled, "intl" in settle({ ...before, intl: false })], [true, false, false, false]);
  assert.deepEqual(plan({ ...before, intlEnabled: false }).map(s => s.on), [true, true, true, true, false, false]);
  const runner = new Runner(p.dir);
  const status = JSON.stringify(runner.status());
  assert.ok(!/private-access|private-refresh|unrelated-secret|private-international/.test(status));
  // Windows has no POSIX modes; its files report 0o666 whatever was asked.
  if (process.platform !== "win32") assert.equal(statSync(authFile).mode & 0o777, 0o600);
});

test("personal logins come first and enterprise logins last, whatever the login file order", t => {
  const p = fixture(t), file = join(p.magpieDir, "plugin-auth.json");
  writeJSON(file, {
    "workbuddy#ent": { ...p.auth, uid: "u3", enterpriseId: "ent-1" },
    "workbuddy#u1": p.auth,
    "workbuddy-ai": { ...p.auth, uid: "u2" }
  });
  assert.deepEqual(accounts(p.config()).map(a => [a.id, a.enterprise]), [["cn:u1", false], ["cn:u3", true], ["intl:u2", false]]);
});

test("requests use Magpie's saved login without renewing it or changing the auth file", async t => {
  const p = fixture(t), file = join(p.magpieDir, "plugin-auth.json");
  const saved = { ...readJSON(file), "workbuddy#u1": { ...p.auth, access: "magpie-access", expires: Date.now() + 30_000 } };
  writeJSON(file, saved);
  const seen = [];
  const client = new WorkBuddyClient(accounts(p.config())[0], p.config(), { gap: 0, fetcher: async (url, { headers }) => {
    seen.push([new URL(url).pathname, headers.Authorization]);
    return Response.json({ code: 0, data: { ready: true } });
  } });
  assert.deepEqual(await client.request("/v3/config"), { ready: true });
  assert.deepEqual(seen, [["/v3/config", "Bearer magpie-access"]]);
  assert.deepEqual(readJSON(file), saved);
});

test("retired renewal slots disappear from saved config and old renewals stay out of the board", t => {
  const p = fixture(t), config = p.config();
  config.schedules.keepalive = ["09:22"];
  config.schedules.tasks = ["09:11"];
  config.intlSchedules.keepalive = ["10:22"];
  config.intlSchedules.web = ["12:50"];
  const file = join(p.dir, "config.json");
  writeJSON(file, config);
  const runner = new Runner(p.dir), now = new Date().toISOString();
  runner.state.jobs.push({ actions: ["keepalive"], status: "succeeded", created: now, logs: [] });
  const saved = readJSON(file);
  assert.deepEqual(saved.schedules, { daily: [], tasks: ["09:11"], sweep: [], night: [] });
  assert.deepEqual(saved.intlSchedules, { daily: [], web: ["12:50"] });
  assert.deepEqual(runner.status().jobs, []);
  assert.deepEqual(runner.boardView().jobs, []);
  assert.throws(() => runner.submit(["keepalive"], ["cn:u1"]), /无效的操作/);
});

test("timer slots survive restart and do not run twice at the same minute", async t => {
  const p = fixture(t), config = p.config();
  config.enabled = true; config.schedules.tasks = ["09:00"];
  writeJSON(join(p.dir, "config.json"), config);
  const runner = new Runner(p.dir, { gap: 0, fetcher: async () => Response.json({ code: 0, data: { tasks: [] } }) });
  runner.tick(new Date("2026-10-29T00:59:00Z")); assert.equal(runner.state.jobs.length, 0);
  runner.tick(new Date("2026-10-29T01:00:00Z")); await settled(runner);
  assert.equal(runner.state.jobs.length, 1);
  assert.equal(runner.state.jobs[0].status, "succeeded");
  new Runner(p.dir).tick(new Date("2026-10-29T01:00:30Z"));
  assert.equal(readJSON(join(p.dir, "state.json")).jobs.length, 1);
});

test("the sweep slot runs its claim-only action without reporting events", async t => {
  const p = fixture(t), config = p.config(), paths = [];
  config.enabled = true; config.schedules.sweep = ["09:30"];
  writeJSON(join(p.dir, "config.json"), config);
  const runner = new Runner(p.dir, { gap: 0, fetcher: async url => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/v2/activity/growth/tasks") return Response.json({ code: 0, data: { tasks: [] } });
    if (path === "/portal/activity/config") return Response.json({ code: 0, data: { config: { in_period: false } } });
    throw new Error("unexpected endpoint " + path);
  } });
  runner.tick(new Date("2026-10-29T01:30:00Z")); await settled(runner);
  assert.deepEqual(runner.state.jobs.map(j => [j.trigger, j.actions, j.status]), [["schedule:sweep:09:30", ["sweep"], "succeeded"]]);
  assert.ok(!paths.includes("/v2/report"));
});

test("each build runs its own slots; settings from before the split carry on from China's", async t => {
  const p = fixture(t), authFile = join(p.magpieDir, "plugin-auth.json"), auths = readJSON(authFile);
  auths["workbuddy-ai"] = { type: "oauth", uid: "u9", accountId: "abroad", access: "intl-access", expires: Date.now() + 86400_000 };
  writeJSON(authFile, auths);
  // Saved by 0.5.6: no intlSchedules. WorkBuddy AI takes China's times, its web conversation at the new 10:31 default.
  const { intlSchedules: _, intlEnabled: __, ...old } = { ...p.config(), enabled: true, schedules: { daily: ["09:00"], tasks: [], night: [], keepalive: ["22:00"] } };
  writeJSON(join(p.dir, "config.json"), old);
  assert.deepEqual(intlSchedules(old), { daily: ["09:00"], web: ["10:31"] });
  // Saved by 0.5.7 or 0.5.8: WorkBuddy AI's growth-task slot is dropped, the rest kept.
  assert.deepEqual(intlSchedules({ intlSchedules: { daily: ["08:00"], tasks: ["09:10"], web: [], keepalive: ["22:00"] } }), { daily: ["08:00"], web: [] });
  assert.ok(!plan({ ...old, intlSchedules: { daily: [], tasks: ["09:10"], web: [], keepalive: [] } }).some(s => s.kind === "intl-tasks"));
  assert.deepEqual(plan(settle(old)).map(s => `${s.kind}:${s.actions.join("+")}`), ["daily:activity+travel+bonus", "tasks:tasks", "sweep:sweep", "night:night", "intl-daily:activity+bonus", "intl-web:web"]);
  assert.equal(intlSchedules({ schedules: { ...old.schedules, daily: [] } }).web.length, 0, "activity off before, no web conversation now");
  assert.ok(!plan({ ...old, intlWeb: false }).some(s => s.kind === "intl-web"));

  const runner = new Runner(p.dir, { gap: 0, fetcher: async () => Response.json({ code: 0, data: {} }) }, { pace: () => 0 });
  runner.tick(new Date("2026-10-29T01:00:00Z")); await settled(runner);
  runner.tick(new Date("2026-10-29T01:00:30Z")); await settled(runner);
  const jobs = () => runner.state.jobs.map(j => `${j.trigger}=${j.accounts.join(",")}:${j.actions.join("+")}`).sort();
  assert.deepEqual(jobs(), ["schedule:daily:09:00=cn:u1:activity+travel+bonus", "schedule:intl-daily:09:00=intl:u9:activity+bonus"]);
  runner.tick(new Date("2026-10-29T02:31:00Z")); await settled(runner);
  assert.ok(jobs().includes("schedule:intl-web:10:31=intl:u9:web"));
  assert.equal(runner.state.jobs.length, 4);
  assert.deepEqual(runner.today(runner.config(), new Date("2026-10-29T03:00:00Z")).slots.map(s => s.kind), ["daily", "intl-daily", "sweep", "intl-web", "sweep"]);

  // WorkBuddy AI paused from the page: its slots wait as paused, China's run on.
  runner.pageRequest({ id: "p1", action: "intl-off", at: Date.now() });
  assert.deepEqual([runner.config().enabled, runner.config().intlEnabled], [true, false]);
  const today = runner.today(runner.config(), new Date("2026-10-29T03:00:00Z"));
  assert.deepEqual(today.slots.filter(s => s.paused).map(s => s.kind), ["intl-daily", "intl-web"]);
  assert.deepEqual([today.next.kind, today.next.at], ["sweep", "22:11"], "the next slot is one that runs");
  const intlBefore = jobs().filter(j => j.startsWith("schedule:intl-"));
  runner.tick(new Date("2026-10-29T14:11:00Z")); await settled(runner);
  assert.deepEqual(jobs().filter(j => j.startsWith("schedule:intl-")), intlBefore);
  assert.equal(runner.boardView().intlEnabled, false);
});

test("paused schedules, paused tasks and disabled accounts make no jobs", t => {
  const p = fixture(t), config = p.config();
  config.schedules.tasks = ["09:00"];
  writeJSON(join(p.dir, "config.json"), config);
  const runner = new Runner(p.dir); runner.tick(new Date("2026-10-29T02:00:00Z"));
  assert.equal(runner.state.jobs.length, 0);
  config.enabled = true; config.disabledAccounts = ["cn:u1"];
  writeJSON(join(p.dir, "config.json"), config); runner.tick(new Date("2026-10-29T02:00:00Z"));
  assert.equal(runner.state.jobs.length, 0);
  assert.throws(() => runner.submit(["all"], ["cn:u1"]), /停用/);
  config.disabledAccounts = []; config.pausedAccounts = ["cn:u1"];
  writeJSON(join(p.dir, "config.json"), config);
  assert.equal(runner.status().accounts[0].paused, true);
  runner.tick(new Date("2026-10-29T02:00:00Z"));
  assert.equal(runner.state.jobs.length, 0);
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

// After a plugin update the running service still has the old code; the
// newer plugin asks it to step aside, never while a job runs.
test("an older service steps aside for a newer plugin, never mid-job; the same or an older plugin leaves it be", async t => {
  assert.ok(newer("0.5.10", "0.5.9") && newer("1.0.0", "0.9.9") && !newer("0.5.4", "0.5.4") && !newer("0.5.3", "0.5.4") && newer("0.5.5", undefined));
  const p = fixture(t);
  let stopped = 0;
  const { server, runner } = createService({ dir: p.dir, stop: () => { stopped++; } });
  server.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = v => fetch(base + "/api/handoff", { method: "POST", headers: { "Content-Type": "application/json", "X-WorkBuddy-Plus": "1" }, body: JSON.stringify({ version: v }) });
  assert.equal((await (await fetch(base + "/api/status")).json()).version, version);
  assert.equal((await ask(version)).status, 409);
  runner.state.jobs.unshift({ id: "j", actions: ["tasks"], accounts: [], status: "running", logs: [] });
  const busy = await ask("999.0.0");
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).busy, true);
  assert.equal(stopped, 0);
  runner.state.jobs[0].status = "succeeded";
  assert.equal((await ask("999.0.0")).status, 202);
  assert.equal(stopped, 1);

  // The plugin side: asks only a service older than itself, then waits for it to go.
  const calls = [];
  let gone = false;
  const fetcher = async (url, init = {}) => {
    calls.push(new URL(url).pathname);
    if (gone) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    if (url.endsWith("/api/status")) return Response.json({ config: {}, version: "0.5.4" });
    gone = true;
    return Response.json({ stopping: true }, { status: 202 });
  };
  assert.equal(await handoff({ fetcher, wait: async () => {}, mine: "0.5.4" }), "current");
  assert.equal(await handoff({ fetcher, wait: async () => {}, mine: "0.5.5" }), "stopped");
  assert.deepEqual(calls, ["/api/status", "/api/status", "/api/handoff", "/api/status"]);
  // A busy service is asked again a minute later.
  const later = [];
  const busyFetcher = async url => url.endsWith("/api/status") ? Response.json({ config: {}, version: "0.5.4" }) : Response.json({ busy: true }, { status: 409 });
  assert.equal(await handoff({ fetcher: busyFetcher, wait: async () => {}, mine: "0.5.5", retry: (f, ms) => later.push(ms) }), "busy");
  assert.deepEqual(later, [60_000]);
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

test("an upstream restriction pauses that account's automatic runs for the day", async t => {
  assert.ok(isRestricted(403, { code: 11140, msg: "request illegal" }));
  assert.ok(isRestricted(400, { msg: "11-128 Illegal API invocation from an unapproved channel" }));
  assert.ok(!isRestricted(403, { msg: "permission denied" }));

  const p = fixture(t), config = p.config();
  config.enabled = true; config.schedules.tasks = ["09:10", "21:10"];
  writeJSON(join(p.dir, "config.json"), config);
  const runner = new Runner(p.dir, { gap: 0, fetcher: async () => Response.json({ code: 11140, msg: "request illegal" }, { status: 403 }) });
  runner.tick(new Date("2026-10-29T01:10:00Z")); await settled(runner);
  assert.equal(runner.state.jobs.length, 1);
  assert.equal(runner.state.jobs[0].status, "failed", JSON.stringify(runner.state.jobs[0].logs));
  assert.equal(runner.state.restricted["cn:u1"].day, "2026-10-29");
  assert.match(runner.state.jobs[0].logs.at(-1).message, /今天暂停这个账号的自动任务/);

  runner.tick(new Date("2026-10-29T13:10:00Z")); await settled(runner);
  assert.equal(runner.state.jobs.length, 1, "the later slot does not retry a restricted account");

  runner.clientOptions = { gap: 0, fetcher: async () => Response.json({ code: 0, data: { tasks: [] } }) };
  runner.submit(["tasks"], ["cn:u1"], "manual"); await settled(runner);
  assert.equal(runner.state.restricted["cn:u1"], undefined);
});

test("a one-task job carries its code to the engine and rejects a missing task", async t => {
  const p = fixture(t);
  let reported = false;
  const fetcher = async url => {
    const path = new URL(url).pathname;
    if (path === "/v2/activity/growth/tasks") return Response.json({ code: 0, data: { tasks: [
      { task_code: "chat_5", title: "聊天 5 次", accept_status: reported ? "completed" : "accepted", progress: { current: reported ? 1 : 0, target: 1 }, reward_credit: 100 }
    ] } });
    if (path === "/v2/report") { reported = true; return Response.json({ code: 0, data: {} }); }
    if (path === "/activity/growth/tasks/chat_5/claim") return Response.json({ code: 0, data: { credit: 100 } });
    throw new Error("unexpected endpoint " + path);
  };
  const runner = new Runner(p.dir, { gap: 0, fetcher });
  assert.throws(() => runner.submit(["task"], ["cn:u1"], "manual", {}), /无效的任务/);
  const job = runner.submit(["task"], ["cn:u1"], "manual", { task: "chat_5" });
  assert.equal(job.task, "chat_5");
  await settled(runner);
  assert.equal(job.status, "succeeded", JSON.stringify(job.logs));
  assert.deepEqual(job.results.map(r => [r.action, r.data]), [["task", { task: "chat_5", outcome: "claimed" }]]);

  // Magpie's sandboxed page hands the account and task code back through its
  // saved request.
  runner.clientOptions = { gap: 0, fetcher: async url => {
    if (new URL(url).pathname === "/v2/activity/growth/tasks") return Response.json({ code: 0, data: { tasks: [
      { task_code: "first_buddy", title: "领取一只 Buddy", accept_status: "claimed", progress: { current: 1, target: 1 } }
    ] } });
    throw new Error("unexpected endpoint " + new URL(url).pathname);
  } };
  const note = runner.pageRequest({ id: "page-task", action: "task", at: Date.now(), accounts: ["cn:u1"], task: "first_buddy" });
  assert.equal(note.ok, true, note.error);
  const pageJob = runner.state.jobs.find(j => j.id === note.job);
  assert.deepEqual([pageJob.actions, pageJob.task, pageJob.accounts], [["task"], "first_buddy", ["cn:u1"]]);
  await settled(runner);
  assert.equal(pageJob.status, "succeeded", JSON.stringify(pageJob.logs));
});

test("consecutive network failures pause scheduled runs; a manual success clears the pause", async t => {
  const reset = () => Object.assign(new Error("ECONNRESET: The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
  assert.ok(dropped(reset()));
  assert.ok(dropped(new Error("The operation timed out.")));
  assert.ok(!dropped(Object.assign(new Error("HTTP 403，denied"), { status: 403 })));

  const p = fixture(t), config = p.config();
  config.enabled = true; config.schedules.tasks = ["09:10", "21:10"];
  writeJSON(join(p.dir, "config.json"), config);
  let calls = 0;
  const runner = new Runner(p.dir, { gap: 0, fetcher: async () => { calls++; throw reset(); } });
  for (let i = 0; i < 3; i++) { runner.submit(["tasks"], ["cn:u1"], `schedule:test:${i}`); await settled(runner); }
  assert.equal(calls, 3, "each failed job stops at its first network request");
  assert.equal(runner.state.jobs.length, 3);
  assert.ok(runner.state.network.pausedUntil > Date.now());
  assert.match(runner.state.jobs[0].logs.at(-1).message, /网络\/代理连续失败 3 次/);
  assert.ok(runner.boardView().networkPaused?.until > Date.now());

  // Scheduled runs wait out the pause; a manual run can still test recovery.
  const before = runner.state.jobs.length;
  runner.tick(new Date("2026-10-29T01:10:00Z")); await settled(runner);
  assert.equal(runner.state.jobs.length, before);
  runner.clientOptions = { gap: 0, fetcher: async () => Response.json({ code: 0, data: { tasks: [] } }) };
  runner.submit(["tasks"], ["cn:u1"], "manual"); await settled(runner);
  assert.equal(runner.state.network.pausedUntil, undefined);
  assert.equal(runner.state.network.failures, 0);
  assert.match(runner.state.jobs[0].logs.map(l => l.message).join("\n"), /网络\/代理已恢复/);
});

test("the board lists today's slots with how each went and which is next", async t => {
  const p = fixture(t), config = p.config();
  config.enabled = true; config.schedules = { ...config.schedules, tasks: ["09:00", "21:00"], night: ["01:00"] };
  writeJSON(join(p.dir, "config.json"), config);
  const runner = new Runner(p.dir, { gap: 0, fetcher: async () => Response.json({ code: 0, data: { tasks: [] } }) });
  runner.tick(new Date("2026-10-29T01:00:00Z")); await settled(runner);
  const today = runner.today(runner.config(), new Date("2026-10-29T02:00:00Z"));
  assert.deepEqual(today.slots.map(s => [s.at, s.kind, s.status]), [["01:00", "night", "missed"], ["09:00", "tasks", "succeeded"], ["21:00", "tasks", "upcoming"]]);
  assert.deepEqual([today.next.at, today.next.kind], ["21:00", "tasks"]);
  config.enabled = false; writeJSON(join(p.dir, "config.json"), config);
  assert.equal(runner.today(runner.config(), new Date("2026-10-29T02:00:00Z")).next, null);
});

test("the page lists every job from today with each log line", t => {
  const p = fixture(t), runner = new Runner(p.dir), now = new Date().toISOString();
  runner.state.jobs = [
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `today-${i}`, actions: ["tasks"], trigger: "page", status: "succeeded", created: now, finished: now,
      logs: [{ at: now, account: "cn:u1", message: `今天第 ${i + 1} 条` }], results: []
    })),
    { id: "yesterday", actions: ["tasks"], trigger: "page", status: "succeeded", created: new Date(Date.now() - 86400_000).toISOString(), finished: new Date(Date.now() - 86400_000).toISOString(), logs: [], results: [] }
  ];
  const jobs = runner.boardView().jobs;
  assert.equal(jobs.length, 7, "more than the old six-row limit");
  assert.ok(jobs.every(job => job.id !== "yesterday"));
  assert.deepEqual(jobs[0].logs, [{ at: now, account: "cn:u1", message: "今天第 1 条" }]);
});

test("the board recalls real prize logs across days without adding old jobs to the queue", t => {
  const p = fixture(t), runner = new Runner(p.dir), now = new Date().toISOString(), yesterday = new Date(Date.now() - 86400_000).toISOString();
  const physical = "成长抽奖 1/1：纪念杯（实物奖，请到成长中心填写收件信息）";
  runner.board.accounts = [{ id: "cn:u1", name: "主力号", realm: "cn", errors: {} }];
  runner.state.jobs = [
    { id: "today", actions: ["bonus"], accounts: ["cn:u1"], status: "succeeded", created: now, logs: [
      { at: now, account: "cn:u1", action: "bonus", message: "成长抽奖 1/1：100 积分" },
      { at: now, account: "cn:removed", action: "bonus", message: physical },
      { at: now, account: "cn:u1", action: "tasks", message: physical }
    ] },
    { id: "past-prize", actions: ["all"], accounts: ["cn:u1"], status: "partial", created: yesterday, logs: [
      { at: yesterday, account: "cn:u1", action: "all", message: physical },
      { at: yesterday, account: "cn:u1", action: "all", message: "官方补偿查询失败" }
    ] },
    { id: "other-past", actions: ["bonus"], accounts: ["cn:u1"], status: "failed", created: yesterday, logs: [] }
  ];
  const view = runner.boardView();
  assert.deepEqual(view.prizeReminders, [{ job: "past-prize", account: "cn:u1", at: yesterday, prize: "纪念杯" }]);
  assert.deepEqual(view.jobs.map(job => job.id), ["today"]);
  assert.deepEqual(view.pastPrizeJobs.map(job => job.id), ["past-prize"]);
  assert.equal(view.pastPrizeJobs[0].logs[1].message, "官方补偿查询失败");
});

test("a job with completed work and failures is partial and reports both counts", () => {
  const outcome = jobOutcome([
    { ok: true },
    { ok: false },
    { ok: false, partial: true, counts: { succeeded: 2, failed: 2, limited: 0, total: 4 } }
  ]);
  assert.deepEqual(outcome, {
    status: "partial",
    counts: { succeeded: 3, failed: 3, limited: 0, total: 6 }
  });
  assert.equal(jobOutcome([{ ok: false, limited: true }, { ok: false, limited: true }]).status, "deferred");
  assert.equal(jobOutcome([{ ok: false }]).status, "failed");
});

test("add account runs Magpie's own browser sign-in once and reports how it went", async t => {
  const p = fixture(t), spawned = [];
  const spawner = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    spawned.push({ bin, args, child });
    return child;
  };
  const runner = new Runner(p.dir, { gap: 0, fetcher: async () => Response.json({ code: 0, data: {} }) }, { spawner, magpie: () => "/fake/magpie" });
  assert.equal(runner.login().status, "waiting");
  assert.equal(runner.login().status, "waiting", "a second click while waiting starts nothing");
  assert.equal(spawned.length, 1);
  assert.deepEqual([spawned[0].bin, spawned[0].args], ["/fake/magpie", ["plugin", "login", "workbuddy", "1"]]);
  spawned[0].child.stdout.emit("data", "Sign in in your browser. If it didn't open, go to:\n\x1b[2mhttps://www.workbuddy.cn/login?state=abc\x1b[0m\n");
  assert.equal(runner.boardView().signin.url, "https://www.workbuddy.cn/login?state=abc");
  spawned[0].child.emit("exit", 0);
  assert.equal(runner.signin.status, "done");
  assert.ok(runner.boarding, "a finished sign-in refreshes the board");
  await runner.boarding;

  runner.login();
  spawned[1].child.stderr.emit("data", "Error: sign-in timed out\n");
  spawned[1].child.emit("exit", 1);
  assert.deepEqual([runner.signin.status, runner.signin.message], ["failed", "Error: sign-in timed out"]);

  const none = new Runner(p.dir, {}, { spawner, magpie: () => "" });
  assert.throws(() => none.login(), /找不到 magpie/);
  const page = new Runner(p.dir, {}, { spawner, magpie: () => "/fake/magpie" });
  assert.equal(page.pageRequest({ id: "l1", action: "login", at: Date.now() }).ok, true);
  assert.equal(spawned.length, 3);

  // 国际版 points to the same plugin's WorkBuddy AI sign-in.
  const abroad = new Runner(p.dir, {}, { spawner, magpie: () => "/fake/magpie" });
  assert.equal(abroad.pageRequest({ id: "l2", action: "login-intl", at: Date.now() }).ok, true);
  assert.deepEqual(spawned[3].args, ["plugin", "login", "workbuddy-ai", "1"]);
  assert.equal(abroad.boardView().signin.realm, "intl");
  assert.throws(() => new Runner(p.dir, {}, { spawner, magpie: () => "/fake/magpie" }).login("moon"), /未知的登录版本/);
});

test("the magpie command is found outside a LaunchAgent's bare PATH", t => {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-bin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = process.platform === "win32" ? "magpie.com" : "magpie";
  writeJSON(join(dir, name), {});
  assert.equal(magpieBin({ PATH: ["/usr/bin", dir].join(delimiter) }), join(dir, name));
  assert.equal(magpieBin({ WORKBUDDY_PLUS_MAGPIE_BIN: join(dir, name), PATH: "" }), join(dir, name));
});

test("Windows finds default, portable and custom Magpie installs without PATH", t => {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-win-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const programs = join(dir, "local", "Programs", "Magpie");
  mkdirSync(programs, { recursive: true });
  writeFileSync(join(programs, "magpie.com"), "");
  assert.equal(magpieBin({ LOCALAPPDATA: join(dir, "local") }, "win32", () => assert.fail("default install already found")), join(programs, "magpie.com"));

  const data = join(dir, "data"), portable = join(dir, "magpie-windows-amd64.exe");
  writeFileSync(portable, "");
  assert.equal(magpieBin({ WORKBUDDY_PLUS_HOST_CONFIG: data }, "win32", () => assert.fail("portable copy already found")), portable);

  const custom = join(dir, "custom install"), cli = join(custom, "magpie.com");
  mkdirSync(custom);
  writeFileSync(cli, "");
  assert.equal(magpieBin({}, "win32", (command, args) => {
    assert.deepEqual([command, ...args], ["reg.exe", "query", "HKCU\\Software\\magpie", "/v", "InstallLocation"]);
    return { stdout: `\r\n    InstallLocation    REG_SZ    ${custom}\r\n` };
  }), cli);
});

test("Magpie's active data folder supplies accounts when the Plus config still uses the default", t => {
  const p = fixture(t), custom = join(p.dir, "manual");
  writeJSON(join(p.dir, "config.json"), defaults);
  const runner = new Runner(p.dir, {}, { hostConfig: p.magpieDir });
  assert.deepEqual(runner.list().map(a => a.id), ["cn:u1"]);
  writeJSON(join(p.dir, "config.json"), { ...defaults, magpieDir: custom });
  assert.equal(runner.config().magpieDir, custom);
});

test("the board carries today's check-in from Magpie's own record, never the login key", t => {
  const p = fixture(t), runner = new Runner(p.dir), day = calendar(new Date(), "Asia/Shanghai").day;
  runner.board = { at: Date.now(), accounts: [{ id: "cn:u1", name: "a", key: "workbuddy#u1", errors: {} }, { id: "cn:u2", name: "b", key: "workbuddy#u2", errors: {} }] };
  const view = () => runner.boardView().accounts.map(a => a.checkin);
  assert.deepEqual(view().map(c => c.outcome), ["off", "off"]);
  writeJSON(join(p.magpieDir, "settings.json"), { pluginCheckins: { workbuddy: true } });
  writeJSON(join(p.magpieDir, "plugin-checkin.json"), {
    "workbuddy|workbuddy#u1": { day, at: `${day}T00:00:18+08:00`, claimed: `${day}T00:00:18+08:00`, outcome: "claimed", credit: 100, streak: 11 },
    "workbuddy|workbuddy#u2": { day: "2000-01-01", outcome: "claimed", credit: 100 }
  });
  assert.deepEqual(view(), [{ outcome: "claimed", credit: 100, streak: 11, at: Date.parse(`${day}T00:00:18+08:00`), source: "magpie" }, { outcome: "waiting", source: "magpie" }]);
  assert.ok(!JSON.stringify(runner.boardView()).includes("workbuddy#u1"));
});

test("a board refresh reads both builds' model lists, each failing alone", async t => {
  const p = fixture(t), authFile = join(p.magpieDir, "plugin-auth.json"), auths = readJSON(authFile);
  auths["workbuddy-ai"] = { type: "oauth", uid: "u9", accountId: "abroad@example.test", access: "intl-access", expires: Date.now() + 86400_000 };
  writeJSON(authFile, auths);
  const cfg = { agents: [{ name: "cli", models: ["hy3"] }], models: [{ id: "hy3", name: "Hy3", credits: "x0.00" }] };
  const runner = new Runner(p.dir, { gap: 0, fetcher: async url => {
    const { host, pathname } = new URL(url);
    if (host === "www.workbuddy.ai") return pathname === "/v3/config" ? Response.json({ code: 0, data: cfg }) : Response.json({ code: 5, msg: "billing down" }, { status: 500 });
    if (pathname === "/v3/config") return Response.json({ code: 0, data: cfg });
    if (pathname === "/billing/meter/get-user-resource-summary") return Response.json({ code: 0, data: { SubscriptionPackageName: "体验版", IsPaidUser: false } });
    return Response.json({ code: 0, data: {} });
  } });
  await runner.refreshBoard();
  const { models } = runner.boardView();
  assert.deepEqual([models.cn.account, models.cn.plan.name, models.cn.models.map(m => m.id)], ["fixture@example.test", "体验版", ["hy3"]]);
  assert.match(models.intl.error, /billing down/);
  assert.equal(models.ent, undefined, "no enterprise login, no enterprise list");
  assert.ok(!JSON.stringify(runner.boardView()).includes("intl-access"));

  // An enterprise login reads its enterprise's own list with its own token.
  auths["workbuddy#e1"] = { type: "oauth", uid: "e1", accountId: "firm", access: "ent-access", enterpriseId: "corp", expires: Date.now() + 86400_000 };
  writeJSON(authFile, auths);
  const firmCfg = { agents: [{ name: "cli", models: ["kimi-k3.1-pro"] }], models: [{ id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", credits: "x0.97", reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high", "max"] } }] };
  const tokens = [];
  const both = new Runner(p.dir, { gap: 0, fetcher: async (url, init) => {
    const { host, pathname } = new URL(url);
    if (pathname === "/v3/config") { tokens.push(init.headers.Authorization); return Response.json({ code: 0, data: init.headers.Authorization === "Bearer ent-access" ? firmCfg : cfg }); }
    if (pathname === "/billing/meter/get-user-resource-summary") return Response.json({ code: 0, data: { SubscriptionPackageName: "体验版", IsPaidUser: false } });
    return Response.json({ code: 0, data: {} });
  } });
  await both.refreshBoard();
  const firm = both.boardView().models.ent;
  assert.deepEqual([firm.account, firm.plan.name, firm.models.map(m => [m.id, m.reasoning.levels.join("/")])], ["firm", "企业", [["kimi-k3.1-pro", "low/high/max"]]]);
  assert.deepEqual(both.boardView().models.cn.models.map(m => m.id), ["hy3"], "China's list still comes from the personal login");
  assert.ok(tokens.includes("Bearer ent-access"));
});

test("a login added in Magpie itself refreshes the board at the next beat, not when it is next due", async t => {
  const p = fixture(t), authFile = join(p.magpieDir, "plugin-auth.json");
  const runner = new Runner(p.dir, { gap: 0, fetcher: async () => Response.json({ code: 0, data: {} }) });
  await runner.refreshBoard();
  const at = runner.board.at;
  assert.equal(await runner.refreshBoard(10 * 60_000), runner.board);
  assert.equal(runner.board.at, at);
  const auths = readJSON(authFile);
  auths["workbuddy#u2"] = { ...p.auth, uid: "u2", accountId: "second@example.test" };
  writeJSON(authFile, auths);
  await runner.refreshBoard(10 * 60_000);
  assert.deepEqual(runner.board.accounts.map(a => a.id), ["cn:u1", "cn:u2"]);
});

test("the service port comes from the plugin option, then the environment, then 3439", () => {
  assert.equal(portOf({ port: 4389 }, { WORKBUDDY_PLUS_PORT: "5000" }), 4389);
  assert.equal(portOf({ port: "nope" }, { WORKBUDDY_PLUS_PORT: "5000" }), 5000);
  assert.equal(portOf(undefined, {}), 3439);
  assert.equal(portOf({ port: 70000 }, {}), 3439);
});

test("the Magpie run tool advertises every backend action", async t => {
  const { promise: ready, resolve } = Promise.withResolvers();
  const server = createServer((request, response) => {
    response.end(JSON.stringify({ config: {}, version }));
    if (request.url === "/api/page-target") resolve();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { tool } = await WorkBuddyPlusPlugin({}, { port: server.address().port });
  await ready;
  assert.deepEqual(tool.run.args.properties.action.enum, actions);
});

test("only a WorkBuddy Plus answering on the port counts as one running", async () => {
  assert.equal(await answering(1, async () => Response.json({ config: {} })), true);
  assert.equal(await answering(1, async () => Response.json({ hello: 1 })), false);
  assert.equal(await answering(1, async () => { throw new Error("ECONNREFUSED"); }), false);
});

// Windows reserves port ranges (netsh excludedportrange) with nothing
// listening; a port held by anything but a WorkBuddy Plus must not leave the
// service waiting for a takeover that never comes.
test("a port held by another program makes the service exit and say why; a WorkBuddy Plus there makes it wait", async t => {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-port-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const start = async answer => {
    const other = createServer((request, response) => response.end(JSON.stringify(answer)));
    await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
      env: { ...process.env, WORKBUDDY_PLUS_DIR: dir, WORKBUDDY_PLUS_MAGPIE_DIR: join(dir, "magpie"), WORKBUDDY_PLUS_PORT: String(other.address().port) }, stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    const code = await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(2500).then(() => "running")]);
    child.kill();
    other.close();
    return { code, out };
  };
  const blocked = await start({ hello: "not workbuddy" });
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /无法使用（EADDRINUSE）[\s\S]*excludedportrange[\s\S]*"port":4389/);
  const taken = await start({ config: {} });
  assert.equal(taken.code, "running");
  assert.match(taken.out, /已有 WorkBuddy Plus 在运行，本进程待命/);
});

// Windows' http.sys answers on some ports with nothing of ours there; the
// plugin must not take its replies for the service's, and says why in the log.
test("the plugin reports a port answered by another program instead of reading its reply", async t => {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-foreign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const other = createServer((request, response) => { response.statusCode = 404; response.end("Not Found"); });
  await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
  t.after(() => other.close());
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, `const { WorkBuddyPlusPlugin } = await import(${JSON.stringify(new URL("../index.mjs", import.meta.url).href)});
const { tool } = await WorkBuddyPlusPlugin({}, { port: ${other.address().port} });
try { await tool.status.execute({}); console.log("no error"); } catch (e) { console.log(e.message); }\n`);
  const child = spawn(process.execPath, [probe], { env: { ...process.env, WORKBUDDY_PLUS_DIR: dir, WORKBUDDY_PLUS_MAGPIE_DIR: join(dir, "magpie") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  const code = await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(10000).then(() => "running")]);
  child.kill();
  assert.equal(code, 0);
  assert.match(out, /端口 \d+ 无法使用（HTTP 404）[\s\S]*"port":4389/);
  assert.match(readFileSync(join(dir, "service.log"), "utf8"), /无法使用（HTTP 404）/);
});

test("a slot moves within ±spread minutes, the same all day, differently each day, the night task kept to its window", t => {
  const days = ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"];
  const at = days.map(day => shifted(day, "daily", "09:00", 10, "salt"));
  for (const runAt of at) assert.ok(runAt >= "08:50" && runAt <= "09:10", runAt);
  assert.equal(shifted("2026-11-07", "daily", "09:00", 10, "salt"), at[0], "stable within a day");
  assert.ok(new Set(at).size > 1, "varies across days");
  assert.notEqual(days.map(day => shifted(day, "daily", "09:00", 10, "other")).join(), at.join(), "varies across installs");
  assert.equal(shifted("2026-11-07", "daily", "09:00", 0, "salt"), "09:00");
  for (const day of days) {
    assert.ok(shifted(day, "night", "07:55", 30, "salt") <= "07:59");
    assert.ok(shifted(day, "night", "23:05", 30, "salt") >= "23:00");
    assert.ok(shifted(day, "tasks", "23:55", 30, "salt") <= "23:59");
  }
  // The board says when each slot runs today; a scheduled run waits between accounts.
  const p = fixture(t), config = p.config();
  config.spread = 10; config.schedules.daily = ["09:00"];
  writeJSON(join(p.dir, "config.json"), config);
  const runner = new Runner(p.dir);
  const slot = runner.today(runner.config(), new Date("2026-11-07T00:00:00Z")).slots[0];
  assert.equal(slot.runAt, shifted("2026-11-07", "daily", "09:00", 10, runner.state.salt));
});

test("the page saves the web conversation switch; anything but a boolean is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "wbplus-switches-"));
  try {
    initialize(dir);
    const runner = new Runner(dir);
    assert.equal(runner.pageRequest({ id: "s1", action: "config", at: Date.now(), config: { intlWeb: false } }).ok, true);
    assert.equal(runner.pageRequest({ id: "s2", action: "config", at: Date.now(), config: { campaignApp: true, skillShare: false, buddyAuto: true } }).ok, true);
    const saved = readJSON(join(dir, "config.json"));
    assert.deepEqual([saved.intlWeb, saved.campaignApp, saved.skillShare, saved.buddyAuto], [false, true, false, true]);
    assert.equal(runner.boardView().settings.skillShare, false);
    assert.equal(runner.boardView().settings.buddyAuto, true);
    assert.throws(() => validateConfig({ ...defaults, intlWeb: "no" }), /国际版网页会话开关无效/);
    assert.throws(() => validateConfig({ ...defaults, skillShare: "no" }), /自动分享技能开关无效/);
    assert.throws(() => validateConfig({ ...defaults, buddyAuto: "no" }), /自动开盲盒开关无效/);
    assert.throws(() => validateConfig({ ...defaults, pausedAccounts: "no" }), /暂停任务列表无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
