import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, initialize, readJSON, calendar } from "../storage.mjs";
import { WorkBuddyClient } from "../client.mjs";
import { perform } from "../engine.mjs";
import { buildEvents, specs } from "../events.mjs";

const ok = data => Response.json({ code: 0, data });
function fixture(t, serve, realm = "cn") {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initialize(dir);
  const account = { id: `${realm}:u1`, realm, name: "fixture", auth: { uid: "u1", access: "secret-token", expires: Date.now() + 86400_000 }, source: "magpie" };
  const state = readJSON(join(dir, "state.json")), seen = [], logs = [];
  const config = { ...defaults };
  const client = new WorkBuddyClient(account, config, { gap: 0, fetcher: async (url, init = {}) => {
    const path = new URL(url).pathname;
    seen.push({ path, host: new URL(url).host, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers, proxy: init.proxy });
    return serve(path, seen.at(-1), seen);
  } });
  const context = { account, config, state, log: message => logs.push(message), checkpoint() {}, pollDelay: 0, pace: 0, signal: new AbortController().signal, web: { poll: 0, sleep: async () => {} } };
  return { run: action => perform(action, client, context), client, context, state, seen, logs };
}

// WorkBuddy AI's web app and an agent sandbox, as webActivity sees them.
const webApp = (status = () => "completed", refuse = new Set()) => (path, request) => {
  if (path === "/console/as/conversations/" && request.body) return refuse.has(request.body.model) ? Response.json({ code: 6004, msg: "额度已用完" }) : ok({ id: "c1", status: "CREATING" });
  if (path === "/console/as/conversations/c1/session") return ok({ link: "https://sandbox.test/acp", token: "sandbox-token", sessionId: "c1", cwd: "/workspace" });
  if (path === "/console/as/conversations/c1") return ok({ status: status() });
  if (/^\/console\/as\/conversations\/c1\/(stop|delete)$/.test(path)) return ok({ id: "c1" });
  if (path === "/acp" && !request.body) return new Response('data: {"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}\n\n', { headers: { "Content-Type": "text/event-stream", "Acp-Connection-Id": "acp-1" } });
  if (path === "/acp") return new Response("", { status: 202 });
};

test("all performs domestic tasks without calling daily check-in", async t => {
  const p = fixture(t, path => {
    if (path === "/v2/report") return ok({});
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [] });
    if (path === "/activity/growth/buddy/travel/status") return ok({ state: "traveling" });
    if (path === "/activity/growth/heatmap") return ok({ cells: [] });
    if (path === "/activity/growth/streak") return ok({ streak: { days: 1 } });
    if (path === "/activity/growth/lottery/summary") return ok({ chances: 0 });
    if (path === "/billing/meter/compensation-status") return ok({ active: false });
    if (["/billing/meter/claim-gift", "/billing/meter/claim-compensation"].includes(path)) return ok({ credit: 0 });
    throw new Error("unexpected endpoint " + path);
  });
  const result = await p.run("all");
  assert.deepEqual(Object.keys(result), ["activity", "tasks", "travel", "bonus"]);
  assert.ok(p.seen.every(r => !r.path.includes("daily-checkin")));
});

test("a growth-task round with completed and failed tasks carries partial counts", async t => {
  const p = fixture(t, path => {
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [
      { task_code: "done", accept_status: "claimed", progress: { current: 1, target: 1 } },
      { task_code: "create_canvas", accept_status: "accepted", progress: null }
    ] });
    if (path === "/activity/growth/heatmap") return ok({ cells: [] });
    throw new Error("unexpected endpoint " + path);
  });
  await assert.rejects(p.run("tasks"), error => {
    assert.equal(error.partial, true);
    assert.deepEqual(error.counts, { succeeded: 1, failed: 1, limited: 0, total: 2 });
    return true;
  });
});

test("a one-task run reports and claims only the task picked from the board", async t => {
  let reported = false;
  const p = fixture(t, path => {
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [
      { task_code: "chat_5", title: "聊天 5 次", accept_status: reported ? "completed" : "accepted", progress: { current: reported ? 1 : 0, target: 1 }, reward_credit: 100 },
      { task_code: "create_canvas", title: "创建画布", accept_status: "accepted", progress: { current: 0, target: 1 }, reward_credit: 100 }
    ] });
    if (path === "/v2/report") { reported = true; return ok({}); }
    if (path === "/activity/growth/tasks/chat_5/claim") return ok({ credit: 100 });
    throw new Error("unexpected endpoint " + path);
  });
  p.context.task = "chat_5";
  const got = await p.run("task");
  assert.deepEqual(got, { task: "chat_5", outcome: "claimed" });
  assert.equal(p.seen.filter(r => r.path === "/v2/report").length, 1);
  assert.deepEqual(p.seen.filter(r => r.path.includes("/claim")).map(r => r.path), ["/activity/growth/tasks/chat_5/claim"]);
  assert.ok(!p.seen.some(r => r.path.includes("create_canvas")));
});

test("an all round with completed and failed actions carries partial counts", async t => {
  const p = fixture(t, path => {
    if (path === "/v2/report") return ok({});
    if (path === "/activity/growth/streak") return ok({ streak: { days: 1 } });
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [] });
    if (path === "/activity/growth/buddy/travel/status") return ok({ state: "traveling" });
    if (path === "/activity/growth/heatmap") return Response.json({ code: 500, msg: "heatmap failed" }, { status: 500 });
    throw new Error("unexpected endpoint " + path);
  });
  await assert.rejects(p.run("all"), error => {
    assert.equal(error.partial, true);
    assert.deepEqual(error.counts, { succeeded: 3, failed: 1, limited: 0, total: 4 });
    return true;
  });
});

test("desktop and web task reports do not require progress fields the upstream omits", async t => {
  const done = new Set();
  const p = fixture(t, (path, request) => {
    if (path.endsWith("/tasks")) return ok({ tasks: request.headers["X-Client-Platform"] ? [] : [
      { task_code: "RichMeow_Chat", title: "桌面端对话", accept_status: done.has("chat_request_response") ? "completed" : "accepted", progress: null },
      { task_code: "Library_read", title: "浏览资料库", accept_status: done.has("web_element_click") ? "completed" : "accepted", progress: null }
    ] });
    if (path === "/v2/report") { for (const event of request.body) done.add(event.eventCode); return ok({}); }
    if (path.endsWith("/claim")) return ok({ credit: 100 });
    throw new Error("unexpected endpoint " + path);
  });
  await p.run("tasks");
  const reports = p.seen.filter(request => request.path === "/v2/report");
  assert.deepEqual(reports.map(request => [request.host, request.body.length, request.body[0].eventCode]), [
    ["copilot.tencent.com", 6, "agent_task_created"],
    ["www.workbuddy.cn", 1, "web_element_click"]
  ]);
  assert.deepEqual(p.seen.filter(request => request.path.endsWith("/claim")).map(request => request.path.split("/").at(-2)), ["RichMeow_Chat", "Library_read"]);
  assert.equal(p.logs.at(-1), "本次领奖 2 项");
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

test("a network failure stops a task round at the first task", async t => {
  let reports = 0;
  const p = fixture(t, path => {
    if (path.endsWith("/tasks")) return ok({ tasks: [
      { task_code: "RichMeow_Chat", accept_status: "accepted", progress: { current: 0, target: 1 } },
      { task_code: "Buddy_App", accept_status: "accepted", progress: { current: 0, target: 1 } }
    ] });
    if (path === "/v2/report") { reports++; throw Object.assign(new Error("ECONNRESET: The socket connection was closed unexpectedly."), { code: "ECONNRESET" }); }
    throw new Error("unexpected " + path);
  });
  await assert.rejects(p.run("tasks"), /ECONNRESET/);
  assert.equal(reports, 1);
});

test("desktop and web tasks are reported as those clients; what nothing here can do is left alone and not listed", async t => {
  const done = new Set();
  const p = fixture(t, (path, request) => {
    if (path.endsWith("/tasks")) return ok({ tasks: request.headers["X-Client-Platform"] ? [] : [
      { task_code: "skill_share", title: "分享技能", accept_status: "completed", progress: null },
      { task_code: "Buddy_App", accept_status: done.has("buddyapp_enter_click") ? "completed" : "accepted", progress: { current: 0, target: 1 } },
      { task_code: "RichMeow_Chat", accept_status: done.has("chat_request_response") ? "completed" : "accepted", progress: { current: 0, target: 1 } },
      { task_code: "Library_read", accept_status: done.has("web_element_click") ? "completed" : "accepted", progress: { current: 0, target: 1 } },
      { task_code: "Expert_Philanthropy", title: "公益捐赠", accept_status: "not_accepted", progress: null },
      { task_code: "wb_wechat_oa_subscribe_task", title: "关注公众号", accept_status: "accepted", progress: { current: 0, target: 1 } }
    ] });
    if (path === "/v2/report") { for (const e of request.body) done.add(e.eventCode); return ok({}); }
    return ok({ credit: 100 });
  });
  await p.run("tasks");
  const reports = p.seen.filter(r => r.path === "/v2/report");
  // The desktop client's five steps into a Buddy app and its six-event chat go to its own host, stamped as that client.
  assert.deepEqual(reports.map(r => [r.host, r.body.length, r.body[0].extName]), [["copilot.tencent.com", 5, "workbuddy-desktop"], ["copilot.tencent.com", 6, "workbuddy-desktop"], ["www.workbuddy.cn", 1, undefined]]);
  assert.deepEqual([reports[0].headers["User-Agent"], reports[0].headers["X-Domain"], reports[0].headers.Origin], ["WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0", "copilot.tencent.com", undefined]);
  assert.equal(reports[0].body[0].machineId, reports[1].body[0].machineId, "one account reads as one machine");
  assert.deepEqual([reports[2].body[0].elementId, reports[2].headers["X-Domain"]], ["library_doc_intro_click", "www.workbuddy.cn"]);
  // A task nothing here does is still claimed once it is complete.
  assert.deepEqual(p.seen.filter(r => r.path.endsWith("/claim")).map(r => r.path.split("/").at(-2)), ["skill_share", "Buddy_App", "RichMeow_Chat", "Library_read"]);
  assert.ok(!p.seen.some(r => r.path.endsWith("/accept")), "the donation is not accepted");
  assert.doesNotMatch(p.logs.join("\n"), /公益捐赠|关注公众号|手动/);
  assert.equal(p.logs.at(-1), "本次领奖 4 项");
});

// The mini program's tasks: its own list, accept and claim, its own reports, at a person's pace.
test("the mini program's tasks are listed, accepted, reported and claimed as a mini-program client, one after another", async t => {
  const state = { Sequential_Tasks_2: "not_accepted", Sequential_Tasks_3: "not_accepted" }, sent = { Sequential_Tasks_2: 0, Sequential_Tasks_3: 0 }, waits = [];
  const p = fixture(t, (path, request) => {
    const mp = request.headers["X-Client-Platform"] === "miniprogram";
    if (path.endsWith("/tasks")) return ok({ tasks: !mp ? [{ task_code: "chat_5", accept_status: "claimed", progress: { current: 5, target: 5 } }] : [
      { task_code: "chat_5", accept_status: "claimed", progress: { current: 5, target: 5 } },
      { task_code: "Sequential_Tasks_3", title: "完成 5 次对话", accept_status: state.Sequential_Tasks_3, progress: state.Sequential_Tasks_3 === "not_accepted" ? null : { current: sent.Sequential_Tasks_3, target: 5 } },
      { task_code: "Sequential_Tasks_2", title: "完成 1 次专家对话", accept_status: state.Sequential_Tasks_2, progress: state.Sequential_Tasks_2 === "not_accepted" ? null : { current: sent.Sequential_Tasks_2, target: 1 } },
      { task_code: "Future_Unsupported_Task", title: "还没适配的", accept_status: "not_accepted", progress: null }
    ] });
    if (path.endsWith("/accept")) {
      assert.equal(mp, true, "accepted as the mini program");
      const [code] = request.body.task_codes;
      // The third opens only once the second is claimed.
      if (code === "Sequential_Tasks_3" && state.Sequential_Tasks_2 !== "claimed") return Response.json({ code: 400, msg: "prerequisite not met" }, { status: 400 });
      state[code] = "accepted";
      return ok({ results: [{ task_code: code, status: "accepted" }] });
    }
    if (path === "/v2/report") { sent[request.body[0].eventCode === "expert_actual_use" ? "Sequential_Tasks_2" : "Sequential_Tasks_3"]++; return ok({}); }
    if (path.endsWith("/claim")) { assert.equal(mp, true); state[path.split("/").at(-2)] = "claimed"; return ok({ credit: 200, energy: 5 }); }
    throw new Error("unexpected " + path);
  });
  await p.run("tasks");
  const reports = p.seen.filter(r => r.path === "/v2/report");
  assert.deepEqual(sent, { Sequential_Tasks_2: 1, Sequential_Tasks_3: 5 }, "the second first, then the third's five chats");
  assert.deepEqual([reports[0].host, reports[0].headers["X-Client-Platform"], reports[0].body[0].ideType, reports[0].body[0].source], ["www.codebuddy.cn", "mp-weixin", "WorkBuddy_MP", "mini_program"]);
  assert.match(reports[0].body[0].id, /^ex_/);
  assert.deepEqual([reports[1].body[0].eventCode, reports[1].body[0].agentName], ["chat_request_send", "mp"]);
  assert.match(p.logs.join("\n"), /完成 5 次对话：要按真人节奏上报/);
  assert.deepEqual(state, { Sequential_Tasks_2: "claimed", Sequential_Tasks_3: "claimed" });
  // A task not known yet is listed for a person, so a new one is seen the day it appears.
  assert.equal(p.logs.at(-1), "本次领奖 2 项；1 项尚未适配：还没适配的");
});

test("a locked mini-program task is skipped until unlocked and can be claimed once completed", async t => {
  const task = { task_code: "Sequential_Tasks_4", title: "创建 1 个定时任务", accept_status: "not_accepted", locked: true };
  const p = fixture(t, (path, request) => {
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: request.headers["X-Client-Platform"] ? [task] : [] });
    if (path.endsWith("/config")) return ok({ config: { in_period: false } });
    if (path === "/activity/growth/tasks/Sequential_Tasks_4/claim") {
      assert.equal(task.accept_status, "completed");
      assert.equal(request.headers["X-Client-Platform"], "miniprogram");
      task.accept_status = "claimed";
      return ok({ credit: 100 });
    }
    throw new Error("unexpected " + path);
  });
  await p.run("tasks");
  assert.doesNotMatch(p.logs.join("\n"), /尚未适配/);
  assert.ok(p.seen.every(request => request.body === undefined));
  task.locked = false;
  task.accept_status = "completed";
  await p.run("tasks");
  await p.run("tasks");
  assert.equal(p.seen.filter(request => request.body !== undefined).length, 1);
  assert.match(p.logs.join("\n"), /创建 1 个定时任务：已领奖，100 积分/);
});

test("a mini-program task that can't be accepted yet waits without failing the run", async t => {
  const p = fixture(t, (path, request) => {
    if (path.endsWith("/tasks")) return ok({ tasks: request.headers["X-Client-Platform"] ? [{ task_code: "Sequential_Tasks_3", title: "完成 5 次对话", accept_status: "not_accepted", progress: null }] : [] });
    if (path.endsWith("/accept")) return Response.json({ code: 400, msg: "task locked until 2026-11-12" }, { status: 400 });
    throw new Error("unexpected " + path);
  });
  await p.run("tasks");
  assert.match(p.logs.join("\n"), /完成 5 次对话：还不能接取（.*task locked until 2026-11-12/);
  assert.ok(!p.seen.some(r => r.path === "/v2/report"));
  assert.equal(p.logs.at(-1), "本次领奖 0 项；1 项未达成");
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

test("travel claim with no unclaimed reward skips without another write", async t => {
  const status = "/activity/growth/buddy/travel/status", claim = "/activity/growth/buddy/travel/claim";
  const p = fixture(t, path => {
    if (path === status) return ok({ state: "arrived" });
    if (path === claim) return Response.json({ code: 403, msg: "no unclaimed travel" }, { status: 403 });
    throw new Error("unexpected endpoint " + path);
  });
  p.context.config.buddyAuto = true;
  assert.equal((await p.run("travel")).skipped, true);
  assert.deepEqual(p.seen.map(({ path, body }) => [path, body]), [[status, undefined], [claim, {}]]);
  assert.match(p.logs.join("\n"), /没有可领取的旅行奖励/);
  assert.ok(!p.logs.some(s => s.includes("已领取")));
});

test("other travel claim refusals still fail and account restrictions stay restricted", async t => {
  for (const [payload, restricted] of [
    [{ code: 403, msg: "permission denied" }, false],
    [{ code: 11140, msg: "no unclaimed travel" }, false],
    [{ code: 11140, msg: "request illegal" }, true]
  ]) {
    const p = fixture(t, path => path.endsWith("/status") ? ok({ state: "arrived" }) : Response.json(payload, { status: 403 }));
    await assert.rejects(p.run("travel"), { status: 403, code: payload.code, restricted });
    assert.ok(!p.logs.some(s => s.includes("没有可领取的旅行奖励")));
  }
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

// WorkBuddy AI: the same growth center on its own site, its check-in claimed
// here while a campaign runs, no Buddy travel, and tasks counted from real use.
test("a WorkBuddy AI account runs on its own site and claims its check-in only while a campaign runs", async t => {
  let campaign = false;
  const web = webApp();
  const p = fixture(t, (path, request, seen) => {
    const w = web(path, request);
    if (w) return w;
    if (path === "/v2/report") return ok({});
    if (path === "/activity/growth/streak") return ok({ streak: { days: 1 } });
    if (path === "/v2/billing/meter/checkin-activity-status") return ok({ active: campaign, today_checked_in: false, daily_credit: 100 });
    if (path === "/v2/billing/meter/daily-checkin") return ok({ credit: 100 });
    if (path === "/activity/growth/heatmap") return ok({ cells: [] });
    if (path === "/activity/growth/lottery/summary") return ok({ chances: 0 });
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [{ code: "first_chat", title: "完成一次对话", status: "available" }] });
    throw new Error("unexpected endpoint " + path);
  }, "intl");
  await p.run("activity");
  assert.equal(p.seen[0].body[0].requestModelId, "deepseek-v4.1-flash-sg");
  assert.equal(p.seen[0].headers.Origin, "https://www.workbuddy.ai");
  assert.match(p.logs.join("\n"), /国际版活跃已生效/);
  assert.ok(!p.seen.some(s => s.path.startsWith("/console")), "the web conversation has its own slot");
  // No Buddy travel there: nothing is asked and nothing logged.
  const before = p.logs.length;
  assert.deepEqual(await p.run("travel"), { skipped: true, reason: "intl" });
  assert.equal(p.logs.length, before);
  assert.ok(!p.seen.some(s => s.path.includes("/buddy/travel")));
  await p.run("bonus");
  assert.ok(!p.seen.some(s => s.path === "/v2/billing/meter/daily-checkin"), "no claim without a campaign");
  assert.ok(!p.seen.some(s => /claim-gift|claim-compensation/.test(s.path)), "China's billing gifts are not asked of WorkBuddy AI");
  assert.match(p.logs.join("\n"), /国际版目前没有签到活动/);
  campaign = true;
  await p.run("bonus");
  assert.ok(p.seen.some(s => s.path === "/v2/billing/meter/daily-checkin"));
  assert.match(p.logs.join("\n"), /国际版签到：\+100 积分/);
  await p.run("tasks");
  assert.equal(p.logs.at(-1), "本次领奖 0 项", "its client-only tasks are neither tried nor listed");
  assert.ok(!p.seen.some(s => s.headers?.["X-Client-Platform"]), "the mini program's list is China's");
  assert.ok(!p.seen.some(s => s.path.includes("/tasks/accept")), "WorkBuddy AI's tasks are not simulated");
});

test("a disabled lottery stops drawing without failing WorkBuddy AI's streak benefits", async t => {
  let message = "lottery disabled";
  const p = fixture(t, path => {
    if (path === "/v2/billing/meter/checkin-activity-status") return ok({ active: false });
    if (path === "/activity/growth/heatmap") return ok({ cells: [] });
    if (path === "/activity/growth/streak") return ok({ streak: { days: 9 } });
    if (path === "/activity/growth/lottery/summary") return ok({ chances: 2 });
    if (path === "/activity/growth/lottery/draw") return Response.json({ msg: message }, { status: 400 });
    throw new Error("unexpected endpoint " + path);
  }, "intl");
  assert.deepEqual(await p.run("bonus"), { days: 9, draws: 0 });
  assert.equal(p.seen.filter(r => r.path.endsWith("/lottery/draw")).length, 1);
  assert.ok(p.logs.includes("成长抽奖未开放，已跳过"));

  message = "invalid client token";
  await assert.rejects(p.run("bonus"), /HTTP 400，invalid client token/);
});

test("lottery results log safe prize details even if compensation later fails", async t => {
  const prizes = [
    { prize_name: "纪念杯", prize_type: "physical", input: "private fixture text" },
    { prize: { name: "冰箱贴" }, need_address: true },
    { name: "胸针", require_address: true },
    { prize: "成长能量", prize_type: "energy" },
    { prize: { id: 1 } }
  ];
  let drawn = 0;
  const p = fixture(t, path => {
    if (path.endsWith("/heatmap")) return ok({ cells: [] });
    if (path.endsWith("/streak")) return ok({ streak: { days: 1 } });
    if (path.endsWith("/lottery/summary")) return ok({ chances: prizes.length });
    if (path.endsWith("/lottery/draw")) return ok(prizes[drawn++]);
    if (path.endsWith("/claim-gift")) return ok({ credit: 0 });
    if (path.endsWith("/compensation-status")) return new Response(null, { status: 502 });
    throw new Error("unexpected endpoint " + path);
  });
  await assert.rejects(p.run("bonus"), /HTTP 502/);
  assert.deepEqual(p.logs.filter(line => line.startsWith("成长抽奖")), [
    "成长抽奖 1/5：纪念杯（实物奖，请到成长中心填写收件信息）",
    "成长抽奖 2/5：冰箱贴（实物奖，请到成长中心填写收件信息）",
    "成长抽奖 3/5：胸针（实物奖，请到成长中心填写收件信息）",
    "成长抽奖 4/5：成长能量",
    "成长抽奖 5/5：奖品名称未返回"
  ]);
  assert.ok(!p.logs.some(line => line.includes("private fixture text")));
});

// The daily reward takes a finished web conversation, run the way the web app does.
test("a WorkBuddy AI account's web conversation runs once a day through its sandbox, on a free model when there is one", async t => {
  let status = "working";
  const refuse = new Set(), web = webApp(() => status, refuse);
  const p = fixture(t, (path, request) => {
    const w = web(path, request);
    if (w) return w;
    if (path === "/v2/report") return ok({});
    if (path === "/activity/growth/streak") return ok({ streak: { days: 2 } });
    throw new Error("unexpected endpoint " + path);
  }, "intl");
  // The daily activity only reports; the conversation is its own action.
  await p.run("activity");
  assert.ok(!p.seen.some(s => s.path.startsWith("/console")));
  // No model list yet: DeepSeek-V4.1-Flash. The turn never finishing fails; the conversation is stopped and deleted.
  p.context.web.wait = 1;
  await assert.rejects(p.run("web"), /没有跑完/);
  assert.deepEqual(p.seen.filter(s => /\/c1\/(stop|delete)$/.test(s.path)).map(s => s.path.split("/").pop()), ["stop", "delete"]);

  // Retried with the list read: Hy3 is free, so it runs there, asked for one word.
  p.seen.length = 0; status = "completed"; p.context.web.wait = 60_000;
  p.context.models = { plan: { paid: false }, models: [{ id: "gpt-6-luna", rate: 0, tier: { exclusive: true } }, { id: "glm-5.2", rate: 0.79, promo: { rate: 0, hours: "23:00–07:50" } }, { id: "hy4free", rate: 0 }, { id: "hy3", rate: 0 }] };
  const got = await p.run("web");
  assert.equal(got.conversation, "c1");
  const create = p.seen.find(s => s.path === "/console/as/conversations/" && s.body);
  assert.deepEqual(create.body, { prompt: "只回复一个字：好", model: "hy3", conversationOrigin: "workbuddy-app", plugins: [{ name: "weixinpay", marketplace: "codebuddy-builtin" }] });
  assert.equal(create.headers.Authorization, "Bearer secret-token");
  assert.equal(create.headers["User-Agent"], "workbuddy-ai/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0");
  assert.deepEqual([create.headers["X-Product"], create.headers["X-Domain"], create.headers.Origin, create.headers.Referer], ["SaaS", "www.workbuddy.ai", undefined, undefined]);
  assert.match(create.headers["X-Request-ID"], /^[0-9a-f-]{36}$/);
  const calls = p.seen.filter(s => s.path === "/acp" && s.body).map(s => s.body.method);
  assert.deepEqual(calls, ["initialize", "session/load", "session/set_model", "session/prompt"]);
  assert.equal(p.seen.find(s => s.body?.method === "session/set_model").body.params.modelId, "hy3");
  assert.ok(p.seen.filter(s => s.path === "/acp" && s.body).every(s => s.headers["Acp-Connection-Id"] === "acp-1" && s.headers.Authorization === "Bearer sandbox-token"));
  assert.ok(p.seen.every(s => s.proxy === false), "direct also disables environment proxies on the sandbox stream and RPCs");
  assert.deepEqual(p.seen.filter(s => /\/c1\/(stop|delete)$/.test(s.path)).map(s => s.path.split("/").pop()), ["stop"], "a finished one is kept, only stopped");
  assert.match(p.logs.at(-1), /国际版网页会话已跑完（hy3，当前免费，\d+ 秒）/);

  // Done for the day.
  p.seen.length = 0;
  await p.run("web");
  assert.ok(!p.seen.some(s => s.path.startsWith("/console")));
  assert.equal(p.logs.at(-1), "国际版网页会话：今天已完成");

  // The free model turning it down: DeepSeek-V4.1-Flash runs it the same day.
  delete p.state.daily["intl:u1:web"]; refuse.add("hy3"); p.seen.length = 0;
  await p.run("web");
  assert.deepEqual(p.seen.filter(s => s.path === "/console/as/conversations/" && s.body).map(s => s.body.model), ["hy3", "deepseek-v4.1-flash"]);
  assert.match(p.logs.join("\n"), /用 hy3 没跑完（网页会话：HTTP 200，额度已用完），改用 deepseek-v4.1-flash[\s\S]*已跑完（deepseek-v4.1-flash，备用/);

  // A model set in the settings is used as it is; switched off, no web turn at all.
  delete p.state.daily["intl:u1:web"]; refuse.clear(); p.seen.length = 0; p.context.config.intlWebModel = "kimi-k3";
  await p.run("web");
  assert.equal(p.seen.find(s => s.path === "/console/as/conversations/" && s.body).body.model, "kimi-k3");
  assert.match(p.logs.at(-1), /kimi-k3，设置指定/);
  delete p.state.daily["intl:u1:web"]; p.context.config.intlWeb = false; p.seen.length = 0;
  assert.deepEqual(await p.run("web"), { skipped: true, reason: "off" });
  assert.ok(!p.seen.some(s => s.path.startsWith("/console")), "intlWeb: false skips the web turn");
});

test("a 10034 web refusal explains that OAuth is not an API key", async t => {
  const p = fixture(t, (path, request) => {
    if (path === "/console/as/conversations/" && request.body) return Response.json({ code: 10034, msg: "CODEBUDDY_API_KEY required" });
    throw new Error("unexpected endpoint " + path);
  }, "intl");
  await assert.rejects(p.run("web"), /网页会话：需要可用的 CODEBUDDY_API_KEY。当前 OAuth 登录没有提供该 Key，免费账号也无法创建个人 API Key；请使用已有 Key 的付费账号/);
  assert.deepEqual(p.seen.map(request => request.path), ["/console/as/conversations/"]);
  assert.equal(p.state.webPaused["intl:u1"].day, calendar(new Date(), p.context.config.timezone).day);
  p.seen.length = 0;
  assert.deepEqual(await p.run("web"), { skipped: true, reason: "paused" });
  assert.equal(p.seen.length, 0, "a paused web turn does not retry the same day");
});

test("a 10034 from the fallback model also pauses the web turn for the day", async t => {
  const p = fixture(t, (path, request) => {
    if (path === "/console/as/conversations/" && request.body) {
      return request.body.model === "deepseek-v4.1-flash"
        ? Response.json({ code: 10034, msg: "CODEBUDDY_API_KEY required" })
        : Response.json({ code: 6004, msg: "额度已用完" });
    }
    throw new Error("unexpected endpoint " + path);
  }, "intl");
  p.context.models = { plan: { paid: false }, models: [{ id: "hy3", rate: 0 }] };
  await assert.rejects(p.run("web"), /网页会话：需要可用的 CODEBUDDY_API_KEY/);
  assert.deepEqual(p.seen.filter(r => r.path === "/console/as/conversations/" && r.body).map(r => r.body.model), ["hy3", "deepseek-v4.1-flash"]);
  assert.equal(p.state.webPaused["intl:u1"].day, calendar(new Date(), p.context.config.timezone).day);
  p.seen.length = 0;
  assert.deepEqual(await p.run("web"), { skipped: true, reason: "paused" });
  assert.equal(p.seen.length, 0);
});

// Sharing a skill uses an actual share channel; the task
// has no progress until the channel exists. The channel is reused on a retry.
test("skill_share creates one real share channel, reports its actions and claims", async t => {
  let accepted = false, reported = false, claimed = false, channels = 0;
  const p = fixture(t, (path, request) => {
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [{
      task_code: "skill_share", title: "分享一个技能给好友", task_type: "single",
      accept_status: claimed ? "claimed" : reported ? "completed" : accepted ? "accepted" : "not_accepted",
      progress: reported ? { current: 1, target: 1 } : null, reward_credit: 50
    }] });
    if (path === "/v2/activity/growth/tasks/accept") { accepted = true; return ok({ results: [{ task_code: "skill_share", status: "accepted" }] }); }
    if (path === "/v2/operation-platform/market/skill/list") return ok({ skills: [{ skill_id: "skill_2097350077599879168", name: "pptx" }] });
    if (path === "/api/v2/open-platform/asset-shares/c2c/channels") {
      channels++;
      return ok({ channel_id: "channel-1", share_code: "share-1", ways: [{ share_way: "link", resource_ref: "https://example.test/share" }] });
    }
    if (path === "/v2/report") { reported = true; return ok({}); }
    if (path === "/activity/growth/tasks/skill_share/claim") { claimed = true; return ok({ credit: 50 }); }
    if (path === "/portal/activity/config") return ok({ config: { in_period: false } });
    throw new Error("unexpected " + path);
  });
  const key = `cn:u1:skill_share:${calendar(new Date(), p.context.config.timezone).day}`;
  p.state.shares = { [key]: { shareCode: "legacy-only", skillId: "stale", skillName: "stale" } };
  await p.run("tasks");
  const market = p.seen.find(r => r.path === "/v2/operation-platform/market/skill/list");
  const channel = p.seen.find(r => r.path === "/api/v2/open-platform/asset-shares/c2c/channels");
  const report = p.seen.find(r => r.path === "/v2/report");
  assert.deepEqual([market.host, channel.host, report.host], ["www.codebuddy.cn", "open.workbuddy.cn", "copilot.tencent.com"]);
  assert.deepEqual(report.body.map(e => [e.eventCode, e.id, e.skillId, e.action, e.panelAction, e.panelType, e.skillSource, e.entry, e.status, e.actionSuccessful]),
    [["skill_share_channel_action", "channel-1", "skill_2097350077599879168", "wechat", "success", "mini_program_card", "market", "skill_detail", "safe", true]]);
  assert.ok(p.seen.some(r => r.path === "/activity/growth/tasks/skill_share/claim"));
  assert.equal(channels, 1);

  await p.run("tasks");
  assert.equal(channels, 1, "a claimed task does not create another channel");

  // Off for bulk runs, but the task center's one-task button is an explicit
  // request: it still creates the channel.
  accepted = reported = claimed = false;
  channels = 0;
  p.state.shares = {};
  p.context.config.skillShare = false;
  p.context.task = "skill_share";
  assert.deepEqual(await p.run("task"), { task: "skill_share", outcome: "claimed" });
  assert.equal(channels, 1);
});

test("skill_share neither reports nor claims without a share channel id and link", async t => {
  for (const payload of [
    { share_code: "link-only", ways: [{ share_way: "link", resource_ref: "https://example.test/share" }] },
    { share_code: "link-only", channel_id: "channel-1", ways: [{ share_way: "wxacode", resource_ref: "example-code" }] }
  ]) {
    const p = fixture(t, path => {
      if (path === "/v2/activity/growth/tasks") return ok({ tasks: [{ task_code: "skill_share", accept_status: "accepted", progress: null }] });
      if (path === "/v2/operation-platform/market/skill/list") return ok({ skills: [{ skill_id: "fixture", name: "demo" }] });
      if (path === "/api/v2/open-platform/asset-shares/c2c/channels") return ok(payload);
      throw new Error("unexpected " + path);
    });
    p.context.task = "skill_share";
    await assert.rejects(p.run("task"), /分享渠道回执缺少/);
    assert.equal(p.seen.filter(r => r.path.includes("asset-shares")).length, 1);
    assert(!p.seen.some(r => r.path === "/v2/report" || r.path.endsWith("/claim")));
    assert.deepEqual(p.state.shares || {}, {});
  }
});

test("skill_share reuses a channel but never claims on an accepted report without upstream progress", async t => {
  const p = fixture(t, path => {
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [{ task_code: "skill_share", accept_status: "accepted", progress: { current: 0, target: 1 } }] });
    if (path === "/v2/operation-platform/market/skill/list") return ok({ skills: [{ skill_id: "fixture", name: "demo" }] });
    if (path === "/api/v2/open-platform/asset-shares/c2c/channels") return ok({ share_code: "link-only", channel_id: "channel-1", ways: [{ share_way: "link", resource_ref: "https://example.test/share" }] });
    if (path === "/v2/report") return ok({});
    throw new Error("unexpected " + path);
  });
  p.context.task = "skill_share";
  for (let i = 0; i < 2; i++) assert.deepEqual(await p.run("task"), { task: "skill_share", outcome: "open" });
  assert.equal(p.seen.filter(r => r.path.includes("asset-shares")).length, 1);
  assert.deepEqual(p.seen.filter(r => r.path === "/v2/report").map(r => r.body.map(e => e.id)), [["channel-1"], ["channel-1"]]);
  assert(!p.seen.some(r => r.path.endsWith("/claim")));
});

test("turning automatic skill sharing off leaves the task untouched in a task round", async t => {
  const p = fixture(t, path => {
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [{
      task_code: "skill_share", title: "分享一个技能给好友", task_type: "single",
      accept_status: "not_accepted", progress: null, reward_credit: 50
    }] });
    if (path === "/portal/activity/config") return ok({ config: { in_period: false } });
    throw new Error("unexpected " + path);
  });
  p.context.config.skillShare = false;
  await p.run("tasks");
  assert.ok(!p.seen.some(r => /skill|report|claim|asset-shares/.test(r.path)), JSON.stringify(p.seen.map(r => r.path)));
  assert.match(p.logs.join("\n"), /自动分享技能已关闭/);
});

// The server drops a buddyapp_enter_click whose isFirstPage is the string "1"
// ("dropped=1 events by format validation"), so Buddy_App stays at 0/1.
test("the Buddy app entry reports isFirstPage as a boolean", async () => {
  const { buildEvents, specs } = await import("../events.mjs");
  const events = buildEvents({ auth: { uid: "u1" } }, specs.Buddy_App);
  assert.equal(events.length, 5);
  assert.equal(events.find(e => e.eventCode === "buddyapp_enter_click").isFirstPage, true);
});

// A report rejected for its format is retried, but after three days the task
// is paused for scheduled runs; a manual run still tries it and clears it.
test("a task whose report keeps failing for its format pauses after three days, until a manual run", async t => {
  let failing = true;
  const task = () => ({ task_code: "Buddy_App", title: "进入 Buddy 应用", accept_status: "accepted", task_type: "single", progress: failing ? { current: 0, target: 1 } : { current: 1, target: 1 } });
  const p = fixture(t, path => {
    if (path.endsWith("/tasks")) return ok({ tasks: [task()] });
    if (path === "/v2/report") return failing ? Response.json({ code: 1, msg: "partial success: dropped=1 events by format validation" }, { status: 400 }) : ok({});
    if (path.endsWith("/claim")) return ok({ credit: 100 });
    throw new Error("unexpected " + path);
  });
  p.context.trigger = "schedule:daily";
  p.state.taskStops = { "cn:u1:Buddy_App": { days: 2, last: calendar(new Date(Date.now() - 86400_000), p.context.config.timezone).day, error: "HTTP 400" } };

  await assert.rejects(p.run("tasks"), /partial success/);
  assert.equal(p.state.taskStops["cn:u1:Buddy_App"].days, 3);

  const reports = p.seen.filter(r => r.path === "/v2/report").length;
  await p.run("tasks");
  assert.equal(p.seen.filter(r => r.path === "/v2/report").length, reports, "the scheduled run does not report again");
  assert.match(p.logs.join("\n"), /连续 3 天上报失败，已暂停自动上报/);

  failing = false;
  p.context.trigger = "manual";
  await p.run("tasks");
  assert.equal(p.state.taskStops["cn:u1:Buddy_App"], undefined, "a manual run clears the pause");
  assert.ok(p.seen.some(r => r.path.endsWith("/claim")));
});

test("sweep accepts pending tasks and claims reached rewards without reporting any events", async t => {
  const accepted = [], claimed = [];
  const p = fixture(t, (path, request) => {
    const mp = request.headers["X-Client-Platform"] === "miniprogram";
    if (path === "/v2/activity/growth/tasks") {
      if (mp) return ok({ tasks: [
        { task_code: "Sequential_Tasks_2", title: "完成 1 次专家对话", task_type: "single", accept_status: "not_accepted", progress: null }
      ] });
      return ok({ tasks: [
        { task_code: "done", title: "已完成", task_type: "single", accept_status: "completed", progress: { current: 1, target: 1 } },
        { task_code: "pending", title: "待接取", task_type: "single", accept_status: "not_accepted", progress: { current: 0, target: 3 } },
        { task_code: "locked", title: "未解锁", task_type: "single", accept_status: "completed", locked: true, progress: { current: 1, target: 1 } },
        { task_code: "claimed", title: "已领取", task_type: "single", accept_status: "claimed", progress: { current: 1, target: 1 } }
      ] });
    }
    if (path === "/v2/activity/growth/tasks/accept") {
      accepted.push({ code: request.body.task_codes[0], mp });
      return ok({ results: [{ task_code: request.body.task_codes[0], status: "accepted" }] });
    }
    if (path.endsWith("/claim")) {
      claimed.push(path.split("/").at(-2));
      return ok({ credit: 100, energy: 5 });
    }
    if (path === "/portal/activity/config") return ok({ config: { in_period: false } });
    throw new Error("unexpected endpoint " + path);
  });
  const result = await p.run("sweep");
  assert.deepEqual(result, { accepted: 2, claimed: 1, credit: 100, energy: 5 });
  assert.deepEqual(accepted, [{ code: "pending", mp: false }, { code: "Sequential_Tasks_2", mp: true }]);
  assert.deepEqual(claimed, ["done"]);
  assert.ok(!p.seen.some(request => request.path === "/v2/report"));
  assert.equal(p.logs.at(-1), "补领：接取 2 项；领取 1 项 +100 积分 / 5 能量");
});

test("growth rounds and scheduled sweeps claim a manually completed subscription without faking the follow", async t => {
  for (const action of ["tasks", "sweep"]) {
    await t.test(action, async t => {
      let status = "accepted", claims = 0;
      const p = fixture(t, (path, request) => {
        if (path === "/v2/activity/growth/tasks") return ok({ tasks: request.headers["X-Client-Platform"] ? [{
          task_code: "wb_wechat_oa_subscribe_task", title: "关注公众号", task_type: "single",
          accept_status: status, progress: { current: status === "accepted" ? 0 : 1, target: 1 }
        }] : [] });
        if (path === "/activity/growth/tasks/wb_wechat_oa_subscribe_task/claim") {
          assert.equal(request.headers["X-Client-Platform"], "miniprogram");
          claims++;
          status = "claimed";
          return ok({ credit: 50, energy: 5 });
        }
        if (path === "/portal/activity/config") return ok({ config: { in_period: false } });
        throw new Error("unexpected endpoint " + path);
      });
      p.context.trigger = "schedule";
      await p.run(action);
      assert.equal(claims, 0, "a follow not confirmed by upstream is not claimed");
      status = "completed";
      await p.run(action);
      assert.equal(claims, 1, "the next scheduled round claims the confirmed reward");
      await p.run(action);
      assert.equal(claims, 1, "an already claimed task is not claimed again");
      assert.ok(!p.seen.some(r => /report|accept/.test(r.path)), "no follow, chat or accept is simulated");
      assert.match(p.logs.join("\n"), /已领奖，50 积分 \/ 5 能量/);
    });
  }
});

test("sequential tasks 4-7 build the mini and desktop event shapes upstream counts", () => {
  const account = { auth: { uid: "u1" } };
  const four = buildEvents(account, specs.Sequential_Tasks_4);
  assert.deepEqual(four.map(event => [event.eventCode, event.mode, event.scheduleType]), [["automated_task_create_suc", "CLOUD", "daily"]]);
  const five = buildEvents(account, specs.Sequential_Tasks_5);
  assert.deepEqual(five.map(event => [event.eventCode, event.requestModelId, event.requestModelName]), [["chat_request_send", "glm-5.2", "GLM-5.2"]]);
  assert.deepEqual([specs.Sequential_Tasks_6.target, specs.Sequential_Tasks_6.pace], [10, 45_000]);
  const seven = buildEvents(account, specs.Sequential_Tasks_7);
  assert.deepEqual(seven.map(event => event.eventCode), [
    "agent_task_created", "chat_message_send", "chat_request_send", "chat_message_response", "chat_message_status", "chat_request_response", "playbook_cta_click", "playbook_prompt_send"
  ]);
  assert.equal(seven[7].id, "01-ProductDesign");
  assert.equal(seven[7].conversationId, seven[0].conversationId);
});

test("mini automation and the PC playbook task are accepted, reported and claimed", async t => {
  const state = { Sequential_Tasks_4: "not_accepted", Sequential_Tasks_7: "not_accepted" }, reported = {};
  const p = fixture(t, (path, request) => {
    const mini = request.headers["X-Client-Platform"] === "miniprogram";
    if (path === "/v2/activity/growth/tasks") {
      if (mini) return ok({ tasks: [{
        task_code: "Sequential_Tasks_4", title: "创建 1 个定时任务", task_type: "single",
        accept_status: state.Sequential_Tasks_4, progress: reported.Sequential_Tasks_4 ? { current: 1, target: 1 } : null
      }] });
      return ok({ tasks: [{
        task_code: "Sequential_Tasks_7", title: "体验灵感功能", task_type: "single",
        accept_status: state.Sequential_Tasks_7, progress: reported.Sequential_Tasks_7 ? { current: 1, target: 1 } : { current: 0, target: 1 }
      }] });
    }
    if (path === "/v2/activity/growth/tasks/accept") {
      const code = request.body.task_codes[0];
      state[code] = "accepted";
      return ok({ results: [{ task_code: code, status: "accepted" }] });
    }
    if (path === "/v2/report") {
      if (request.host === "copilot.tencent.com") {
        assert.deepEqual(request.body.slice(-2).map(event => event.eventCode), ["playbook_cta_click", "playbook_prompt_send"]);
        reported.Sequential_Tasks_7 = true;
      } else {
        assert.deepEqual(request.body.map(event => event.eventCode), ["automated_task_create_suc"]);
        reported.Sequential_Tasks_4 = true;
      }
      return ok({});
    }
    if (path.endsWith("/claim")) {
      const code = path.split("/").at(-2);
      state[code] = "claimed";
      return ok({ credit: 100, energy: 5 });
    }
    if (path === "/portal/activity/config") return ok({ config: { in_period: false } });
    throw new Error("unexpected endpoint " + path);
  });
  p.context.pace = 0;
  assert.deepEqual(await p.run("tasks"), { checked: 2 });
  assert.deepEqual(state, { Sequential_Tasks_4: "claimed", Sequential_Tasks_7: "claimed" });
  assert.equal(p.logs.at(-1), "本次领奖 2 项");
});

test("official compensation is queried first; only an unclaimed active grant is claimed", async t => {
  let claims = 0;
  const p = fixture(t, path => {
    if (path === "/billing/meter/compensation-status") return ok({ active: true, claimed: false, credit_num: 500, end_time: "2026-11-22 23:59:59" });
    if (path === "/billing/meter/claim-compensation") { claims++; return ok({ credit: 500 }); }
    throw new Error("unexpected endpoint " + path);
  });
  assert.deepEqual(await p.run("compensation"), { active: true, claimed: true, credit: 500 });
  assert.equal(claims, 1);
  assert.ok(p.logs.some(line => /官方补偿：已领取 500 积分/.test(line)));
});

test("no active or already-claimed compensation never calls the claim endpoint", async t => {
  for (const status of [{ active: false }, { active: true, claimed: true }]) {
    let claims = 0;
    const p = fixture(t, path => {
      if (path === "/billing/meter/compensation-status") return ok(status);
      if (path === "/billing/meter/claim-compensation") { claims++; return ok({ credit: 500 }); }
      throw new Error("unexpected endpoint " + path);
    });
    const got = await p.run("compensation");
    assert.equal(claims, 0);
    assert.equal(got.active, status.active);
  }
});

test("a failed compensation status query stays an error, not a claim", async t => {
  const p = fixture(t, path => {
    if (path === "/billing/meter/compensation-status") return Response.json({ code: 500, msg: "down" }, { status: 502 });
    throw new Error("unexpected endpoint " + path);
  });
  await assert.rejects(p.run("compensation"), /HTTP 502/);
});

test("buddy opens at most the single-open cap and uses a fresh client token", async t => {
  const opened = [];
  const p = fixture(t, (path, request) => {
    if (path.endsWith("/travel/status")) return ok({ state: "idle" });
    if (path === "/v2/activity/growth/buddy/quota") return ok({ affordable: 3, max_open_count: 2 });
    if (path === "/v2/activity/growth/buddy/open") { opened.push(request.body); return ok({ buddy: "薄荷团子" }); }
    throw new Error("unexpected endpoint " + path);
  });
  assert.deepEqual(await p.run("buddy"), { opened: 2, name: "薄荷团子" });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].count, 2);
  assert.equal(typeof opened[0].client_token, "string");
  assert.ok(opened[0].client_token.length > 10);
  assert.ok(p.seen[0].path.endsWith("/travel/status"));
});

test("buddy does not send an open request when energy is short", async t => {
  let opens = 0;
  const p = fixture(t, path => {
    if (path.endsWith("/travel/status")) return ok({ state: "idle" });
    if (path === "/v2/activity/growth/buddy/quota") return ok({ affordable: 0, max_open_count: 5 });
    if (path === "/v2/activity/growth/buddy/open") { opens++; return ok({}); }
    throw new Error("unexpected endpoint " + path);
  });
  assert.deepEqual(await p.run("buddy"), { opened: 0 });
  assert.equal(opens, 0);
  assert.ok(p.logs.some(line => /成长能量不足/.test(line)));
});

test("manual Buddy opening requires a safe travel state", async t => {
  const cases = [
    { state: "traveling", message: /正在旅行/ },
    { state: "arrived", message: /奖励待领取/ },
    { state: "new-state", message: /旅行状态无法确认/ },
    { state: "", info: { buddy: { name: "团子" } }, message: /旅行状态无法确认/ },
    { state: "", info: {}, message: /旅行状态无法确认/ }
  ];
  for (const { state, info, message } of cases) {
    const p = fixture(t, path => {
      if (path.endsWith("/travel/status")) return ok({ state });
      if (path.endsWith("/buddy/info")) return ok(info);
      if (path.endsWith("/buddy/quota")) return ok({ affordable: 1, max_open_count: 1 });
      if (path.endsWith("/buddy/open")) return ok({ buddy: "芝麻" });
      throw new Error("unexpected endpoint " + path);
    });
    assert.equal((await p.run("buddy")).skipped, true, state);
    assert.match(p.logs.at(-1), message);
    assert.deepEqual(p.seen.map(({ path }) => path), [
      "/activity/growth/buddy/travel/status", ...(info ? ["/activity/growth/buddy/info"] : [])
    ]);
  }
});

test("a failed travel status query prevents Buddy opening", async t => {
  const p = fixture(t, path => {
    if (path.endsWith("/travel/status")) return new Response(null, { status: 502 });
    if (path.endsWith("/buddy/quota")) return ok({ affordable: 1, max_open_count: 1 });
    if (path.endsWith("/buddy/open")) return ok({ buddy: "芝麻" });
    throw new Error("unexpected endpoint " + path);
  });
  await assert.rejects(p.run("buddy"), /HTTP 502/);
  assert.deepEqual(p.seen.map(({ path }) => path), ["/activity/growth/buddy/travel/status"]);
});

test("buddy skips WorkBuddy AI and enterprise accounts", async t => {
  const intl = fixture(t, path => { throw new Error("unexpected endpoint " + path); }, "intl");
  assert.deepEqual(await intl.run("buddy"), { skipped: true, reason: "intl" });
  const cn = fixture(t, path => { throw new Error("unexpected endpoint " + path); });
  cn.context.account.enterprise = true;
  assert.deepEqual(await cn.run("buddy"), { skipped: true, reason: "enterprise" });
});

test("a new expert task is read from its jump_url and completed", async t => {
  let report = null, completed = false;
  const jump = `workbuddy://chat?deeplink=${encodeURIComponent("workbuddy://expert?expertId=ex_Abc123")}`;
  const p = fixture(t, (path, request) => {
    if (path === "/v2/activity/growth/tasks") return ok({ tasks: [{
      task_code: "expert_use_new", title: "新专家", accept_status: completed ? "completed" : "accepted",
      progress: { current: completed ? 1 : 0, target: 1 }, jump_url: jump, reward_credit: 100
    }] });
    if (path === "/v2/report") { report = request.body[0]; completed = true; return ok({}); }
    if (path === "/activity/growth/tasks/expert_use_new/claim") return ok({ credit: 100 });
    throw new Error("unexpected endpoint " + path);
  });
  p.context.task = "expert_use_new";
  assert.deepEqual(await p.run("task"), { task: "expert_use_new", outcome: "claimed" });
  assert.equal(report.eventCode, "expert_actual_use");
  assert.equal(report.id, "ex_Abc123");
  assert.ok(p.logs.some(line => /已识别为专家任务/.test(line)));
});

test("the workstation expert task is a static expert task", () => {
  assert.deepEqual(specs.workstation_expert, { kind: "expert", expert: ["WorkspaceBuilder", "工作台搭建师"] });
});

test('automatic blind boxes refresh travel state before departing', async t => {
  let opened = false, statuses = 0;
  const p = fixture(t, path => {
    if (path.endsWith('/status')) { statuses++; return ok({ state: opened ? 'traveling' : 'idle' }); }
    if (path.endsWith('/quota')) return ok({ affordable: 1, max_open_count: 1 });
    if (path.endsWith('/open')) { opened = true; return ok({ buddy: '团子' }); }
    throw new Error('unexpected request ' + path);
  });
  p.context.config.buddyAuto = true;
  await p.run('travel');
  assert.equal(statuses, 2);
  assert.ok(p.seen.some(r => r.path.endsWith('/open')));
  assert.ok(!p.seen.some(r => r.path.endsWith('/depart')));
});

test("automatic Buddy opening skips an empty travel state for an existing Buddy", async t => {
  const p = fixture(t, path => {
    if (path.endsWith("/travel/status")) return ok({ state: "" });
    if (path.endsWith("/buddy/info")) return ok({ buddy: { name: "团子" } });
    throw new Error("unexpected endpoint " + path);
  });
  p.context.config.buddyAuto = true;
  assert.equal((await p.run("travel")).skipped, true);
  assert.match(p.logs.at(-1), /旅行状态无法确认/);
  assert.deepEqual(p.seen.map(({ path }) => path), ["/activity/growth/buddy/travel/status", "/activity/growth/buddy/info"]);
});

test('opening the first Buddy happens once and logs the returned names before travel', async t => {
  let opened = 0;
  const p = fixture(t, path => {
    if (path.endsWith('/status')) return ok({ state: opened ? 'idle' : '', daily_limit_reached: false });
    if (path.endsWith('/buddy/info')) return ok({ buddy: {} });
    if (path.endsWith('/quota')) return ok({ affordable: 2, max_open_count: 2 });
    if (path.endsWith('/open')) { opened++; return ok({ buddies: [{ name: '团子' }, { name: '芝麻' }] }); }
    if (path.endsWith('/config')) return ok({ locations: [{ id: 42, name: '杭州' }] });
    if (path.endsWith('/tasks')) return ok({ tasks: [] });
    if (path.endsWith('/depart')) return ok({});
    throw new Error('unexpected request ' + path);
  });
  p.context.config.buddyAuto = true;
  await p.run('travel');
  assert.equal(opened, 1);
  assert.ok(p.logs.some(l => l.includes('团子、芝麻')));
  assert.equal(p.seen[1].path, '/activity/growth/buddy/info');
  assert.ok(p.seen.findIndex(r => r.path.endsWith('/open')) < p.seen.findIndex(r => r.path.endsWith('/depart')));
});

test("international web tasks do not switch models on account refusals or after a turn was submitted", async t => {
  for (const reason of [14220, 10105, "restricted", "turn", "set_model", "rpc-refused"]) {
    const agent = webApp(() => "failed");
    const p = fixture(t, (path, request) => {
      if (typeof reason === "number" && path === "/console/as/conversations/") return Response.json({ code: reason, msg: "refused" });
      if (reason === "restricted" && path === "/console/as/conversations/") return Response.json({ code: 6004, msg: "account is restricted" });
      if (reason === "set_model" && request.body?.method === "session/set_model") return new Response("", { status: 400 });
      if (reason === "rpc-refused" && request.body?.method === "session/set_model") return Response.json({ jsonrpc: "2.0", id: 3, error: { code: -1, message: "model unavailable" } });
      return agent(path, request);
    }, "intl");
    p.context.models = { models: [{ id: "hy3", rate: 0 }] };
    await assert.rejects(p.run("web"));
    assert.equal(p.seen.filter(x => x.path === "/console/as/conversations/" && x.body).length, 1, String(reason));
    assert.equal(p.seen.filter(x => x.body?.method === "session/prompt").length, reason === "turn" ? 1 : 0);
  }
});
