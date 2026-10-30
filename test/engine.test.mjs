import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, initialize, readJSON, writeJSON, calendar } from "../storage.mjs";
import { WorkBuddyClient } from "../client.mjs";
import { perform } from "../engine.mjs";

const ok = data => Response.json({ code: 0, data });
function fixture(t, serve) {
  const realm = "cn";
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initialize(dir);
  const account = { id: `${realm}:u1`, realm, name: "fixture", auth: { uid: "u1", access: "secret-token", refresh: "secret-refresh", expires: Date.now() + 86400_000 }, source: "magpie", file: join(dir, "auth.json"), key: `${realm}:u1` };
  writeJSON(account.file, { [account.id]: account.auth });
  const state = readJSON(join(dir, "state.json")), seen = [], logs = [];
  const config = { ...defaults };
  const client = new WorkBuddyClient(account, config, { gap: 0, fetcher: async (url, init = {}) => {
    const path = new URL(url).pathname;
    seen.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers });
    return serve(path, seen.at(-1), seen);
  } });
  const context = { account, config, state, log: message => logs.push(message), checkpoint() {}, pollDelay: 0, signal: new AbortController().signal };
  return { run: action => perform(action, client, context), client, context, state, seen, logs };
}

test("all performs domestic tasks without calling daily check-in", async t => {
  const p = fixture(t, path => {
    if (path === "/v2/report") return ok({});
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [] });
    if (path === "/activity/growth/buddy/travel/status") return ok({ state: "traveling" });
    if (path === "/activity/growth/heatmap") return ok({ cells: [] });
    if (path === "/activity/growth/streak") return ok({ streak: { days: 1 } });
    if (path === "/activity/growth/lottery/summary") return ok({ chances: 0 });
    if (["/billing/meter/claim-gift", "/billing/meter/claim-compensation"].includes(path)) return ok({ credit: 0 });
    throw new Error("unexpected endpoint " + path);
  });
  const result = await p.run("all");
  assert.deepEqual(Object.keys(result), ["activity", "tasks", "travel", "bonus"]);
  assert.ok(p.seen.every(r => !r.path.includes("daily-checkin")));
});

test("an accepted report with zero upstream progress is never claimed", async t => {
  const task = { task_code: "create_canvas", title: "创建设计任务", task_type: "single", accept_status: "not_accepted", progress: { current: 0, target: 1 } };
  const p = fixture(t, path => {
    if (path.endsWith("/tasks")) return ok({ tasks: [task] });
    if (path.endsWith("/accept")) return ok({ results: [{ task_code: task.task_code, status: "accepted" }] });
    if (path === "/v2/report") return ok({});
    throw new Error("unexpected " + path);
  });
  await p.run("tasks"); await p.run("tasks");
  assert.equal(p.seen.filter(r => r.path === "/v2/report").length, 1);
  assert.ok(p.logs.some(s => s.includes("尚未达成，未领奖")));
  assert.ok(!p.seen.some(r => r.path.endsWith("/claim")));
});

test("first_buddy is claimed before accepting tasks that depend on it", async t => {
  let buddy = false, reported = new Set();
  const first = { task_code: "first_buddy", task_type: "auto", accept_status: "not_accepted", progress: { current: 0, target: 1 } };
  const second = { task_code: "create_canvas", task_type: "single", accept_status: "not_accepted", progress: { current: 0, target: 1 } };
  const p = fixture(t, (path, request) => {
    if (path.endsWith("/tasks")) return ok({ tasks: [second, first].map(task => ({ ...task, accept_status: task.task_code === "first_buddy" && buddy ? "claimed" : reported.has(task.task_code) ? "completed" : task.accept_status })) });
    if (path.endsWith("/accept")) { assert.equal(buddy, true); return ok({ results: [{ task_code: "create_canvas", status: "accepted" }] }); }
    if (path === "/v2/report") { reported.add(request.body[0].eventCode === "chat_request_send" ? "first_buddy" : "create_canvas"); return ok({}); }
    if (path.endsWith("/first_buddy/claim")) { buddy = true; return ok({ credit: 300 }); }
    if (path.endsWith("/create_canvas/claim")) return ok({ credit: 300 });
    throw new Error("unexpected " + path);
  });
  await p.run("tasks");
  assert.equal(buddy, true);
  assert.equal(p.seen.filter(r => r.path.endsWith("/claim")).length, 2);
  assert.equal(p.seen.find(r => r.path === "/v2/report").body[0].userId, "u1");
});

test("a partially failed report resumes remaining events without repeating accepted ones", async t => {
  let sent = 0, attempts = 0;
  const p = fixture(t, path => {
    if (path.endsWith("/tasks")) return ok({ tasks: [{ task_code: "template_5", accept_status: sent === 3 ? "completed" : "accepted", task_type: "single", progress: { current: sent, target: 3 } }] });
    if (path === "/v2/report") { if (++attempts === 2) throw new Error("network interrupted"); sent++; return ok({}); }
    if (path.endsWith("/claim")) return ok({ credit: 200 });
    throw new Error(path);
  });
  await assert.rejects(p.run("tasks"), /network interrupted/);
  await p.run("tasks");
  assert.equal(sent, 3);
  assert.equal(attempts, 4);
});

test("completed desktop-only tasks can be claimed, unfinished ones show their required action", async t => {
  const p = fixture(t, path => path.endsWith("/tasks") ? ok({ tasks: [
    { task_code: "Library_read", accept_status: "completed", progress: { current: 1, target: 1 } },
    { task_code: "Buddy_App", accept_status: "accepted", progress: { current: 0, target: 1 } }
  ] }) : ok({ credit: 100 }));
  await p.run("tasks");
  assert.ok(p.seen.some(r => r.path.endsWith("/Library_read/claim")));
  assert.ok(!p.seen.some(r => r.path === "/v2/report"));
  assert.ok(p.logs.some(s => s.includes("需要在桌面端进入")));
  // The job row shows the last line: it must not read as if everything was done.
  assert.equal(p.logs.at(-1), "本次领奖 1 项；1 项需要你手动完成：Buddy_App");
});

test("idle travel with buddy_id=0 departs using the server's destination ID", async t => {
  const p = fixture(t, (path, request) => {
    if (path.endsWith("/status")) return ok({ state: "idle", buddy_id: 0, daily_limit_reached: false });
    if (path.endsWith("/config")) return ok({ locations: [{ id: 42, name: "杭州" }] });
    if (path.endsWith("/tasks")) return ok({ tasks: [{ task_code: "first_buddy", accept_status: "claimed" }] });
    if (path.endsWith("/depart")) { assert.deepEqual(request.body, { location_id: 42 }); return ok({}); }
    throw new Error("unexpected " + path);
  });
  await p.run("travel");
  assert.ok(p.logs.includes("猫猫已出发：杭州"));
});

test("a rejected travel claim is not logged as earned credit", async t => {
  const p = fixture(t, path => path.endsWith("/status") ? ok({ state: "arrived" }) : Response.json({ code: 400, msg: "not arrived" }));
  await assert.rejects(p.run("travel"));
  assert.ok(!p.logs.some(s => s.includes("已领取")));
});

test("zero-day streak after an accepted report remains unconfirmed", async t => {
  const p = fixture(t, path => ok(path.endsWith("/streak") ? { streak: { days: 0 } } : {}));
  await assert.rejects(p.run("activity"), /尚未确认/);
  assert.deepEqual(p.state.daily, {});
});

test("enterprise accounts never hit personal reward endpoints", async t => {
  const p = fixture(t, () => { throw new Error("should not fetch"); });
  p.context.account.enterprise = true;
  assert.equal((await p.run("all")).reason, "enterprise");
  assert.equal(p.seen.length, 0);
});

test("night tasks report at most once per account/day even when their target spans several days", async t => {
  let sent = 0;
  const p = fixture(t, path => {
    if (path.endsWith("/tasks")) return ok({ tasks: [{ task_code: "black_cat", task_type: "single", accept_status: "accepted", progress: { current: sent, target: 3 } }] });
    if (path === "/v2/report") { sent++; return ok({}); }
    throw new Error("unexpected " + path);
  });
  // Put this fixture at hour 02 without changing the machine's clock.
  const offset = (2 - new Date().getUTCHours() + 36) % 24 - 12;
  p.context.config.timezone = `Etc/GMT${offset >= 0 ? "-" : "+"}${Math.abs(offset)}`;
  await p.run("night"); await p.run("night");
  assert.equal(sent, 1);
  assert.ok(!p.seen.some(r => r.path.endsWith("/claim")));
});

test("the day boundary uses the selected timezone", () => {
  assert.equal(calendar(new Date("2026-10-28T16:01:00Z"), "Asia/Shanghai").day, "2026-10-29");
  assert.equal(calendar(new Date("2026-10-28T16:01:00Z"), "UTC").day, "2026-10-28");
});
