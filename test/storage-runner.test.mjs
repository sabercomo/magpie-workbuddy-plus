import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaults, accounts, calendar, initialize, intlSchedules, plan, readJSON, settle, validateConfig, writeJSON } from "../storage.mjs";
import { WorkBuddyClient } from "../client.mjs";
import { EventEmitter } from "node:events";
import { Runner, magpieBin, shifted } from "../runner.mjs";
import { createService, answering } from "../server.mjs";
import { portOf, handoff } from "../index.mjs";
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
  assert.deepEqual(plan({ ...before, intlEnabled: false }).map(s => s.on), [true, true, true, true, false, false, false]);
  const runner = new Runner(p.dir);
  const status = JSON.stringify(runner.status());
  assert.ok(!/private-access|private-refresh|unrelated-secret|private-international/.test(status));
  // Windows has no POSIX modes; its files report 0o666 whatever was asked.
  if (process.platform !== "win32") assert.equal(statSync(authFile).mode & 0o777, 0o600);
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

test("each build runs its own slots; settings from before the split carry on from China's", async t => {
  const p = fixture(t), authFile = join(p.magpieDir, "plugin-auth.json"), auths = readJSON(authFile);
  auths["workbuddy-ai"] = { type: "oauth", uid: "u9", accountId: "abroad", access: "intl-access", expires: Date.now() + 86400_000 };
  writeJSON(authFile, auths);
  // Saved by 0.5.6: no intlSchedules. WorkBuddy AI takes China's times, its web conversation at 10:30.
  const { intlSchedules: _, intlEnabled: __, ...old } = { ...p.config(), enabled: true, schedules: { daily: ["09:00"], tasks: [], night: [], keepalive: ["22:00"] } };
  writeJSON(join(p.dir, "config.json"), old);
  assert.deepEqual(intlSchedules(old), { daily: ["09:00"], web: ["10:30"], keepalive: ["22:00"] });
  // Saved by 0.5.7 or 0.5.8: WorkBuddy AI's growth-task slot is dropped, the rest kept.
  assert.deepEqual(intlSchedules({ intlSchedules: { daily: ["08:00"], tasks: ["09:10"], web: [], keepalive: ["22:00"] } }), { daily: ["08:00"], web: [], keepalive: ["22:00"] });
  assert.ok(!plan({ ...old, intlSchedules: { daily: [], tasks: ["09:10"], web: [], keepalive: [] } }).some(s => s.kind === "intl-tasks"));
  assert.deepEqual(plan(old).map(s => `${s.kind}:${s.actions.join("+")}`), ["daily:activity+travel+bonus", "tasks:tasks", "night:night", "keepalive:keepalive", "intl-daily:activity+bonus", "intl-web:web", "intl-keepalive:keepalive"]);
  assert.equal(intlSchedules({ schedules: { ...old.schedules, daily: [] } }).web.length, 0, "activity off before, no web conversation now");
  assert.ok(!plan({ ...old, intlWeb: false }).some(s => s.kind === "intl-web"));

  const runner = new Runner(p.dir, { gap: 0, fetcher: async () => Response.json({ code: 0, data: {} }) }, { pace: () => 0 });
  runner.tick(new Date("2026-10-29T01:00:00Z")); await settled(runner);
  runner.tick(new Date("2026-10-29T01:00:30Z")); await settled(runner);
  const jobs = () => runner.state.jobs.map(j => `${j.trigger}=${j.accounts.join(",")}:${j.actions.join("+")}`).sort();
  assert.deepEqual(jobs(), ["schedule:daily:09:00=cn:u1:activity+travel+bonus", "schedule:intl-daily:09:00=intl:u9:activity+bonus"]);
  runner.tick(new Date("2026-10-29T02:30:00Z")); await settled(runner);
  assert.ok(jobs().includes("schedule:intl-web:10:30=intl:u9:web"));
  assert.equal(runner.state.jobs.length, 3);
  assert.deepEqual(runner.today(runner.config(), new Date("2026-10-29T03:00:00Z")).slots.map(s => s.kind), ["daily", "intl-daily", "intl-web", "intl-keepalive", "keepalive"]);

  // WorkBuddy AI paused from the page: its slots wait as paused, China's run on.
  runner.pageRequest({ id: "p1", action: "intl-off", at: Date.now() });
  assert.deepEqual([runner.config().enabled, runner.config().intlEnabled], [true, false]);
  const today = runner.today(runner.config(), new Date("2026-10-29T03:00:00Z"));
  assert.deepEqual(today.slots.filter(s => s.paused).map(s => s.kind), ["intl-daily", "intl-web", "intl-keepalive"]);
  assert.equal(today.next.kind, "keepalive", "the next slot is one that runs");
  runner.tick(new Date("2026-10-29T14:00:00Z")); await settled(runner);
  assert.ok(!jobs().some(j => j.startsWith("schedule:intl-keepalive")));
  assert.ok(jobs().includes("schedule:keepalive:22:00=cn:u1:keepalive"));
  assert.equal(runner.boardView().intlEnabled, false);
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
  // Magpie's Windows installer leaves its folder off the PATH.
  const programs = join(dir, "local", "Programs", "Magpie");
  mkdirSync(programs, { recursive: true });
  writeJSON(join(programs, name), {});
  // A machine with Magpie in one of the usual places (~/.local/bin) finds it there first.
  assert.equal(magpieBin({ PATH: "", LOCALAPPDATA: join(dir, "local") }), magpieBin({ PATH: "" }) || join(programs, name));
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
  assert.deepEqual(view(), [{ outcome: "claimed", credit: 100, streak: 11, at: Date.parse(`${day}T00:00:18+08:00`) }, { outcome: "waiting" }]);
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
    assert.ok(shifted(day, "keepalive", "23:55", 30, "salt") <= "23:59");
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
    const saved = readJSON(join(dir, "config.json"));
    assert.equal(saved.intlWeb, false);
    assert.throws(() => validateConfig({ ...defaults, intlWeb: "no" }), /国际版网页会话开关无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
