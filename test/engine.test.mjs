import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, initialize, readJSON, writeJSON, calendar } from "../storage.mjs";
import { WorkBuddyClient } from "../client.mjs";
import { perform } from "../engine.mjs";

const ok = data => Response.json({ code: 0, data });
function fixture(t, serve, realm = "cn") {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initialize(dir);
  const account = { id: `${realm}:u1`, realm, name: "fixture", auth: { uid: "u1", access: "secret-token", refresh: "secret-refresh", expires: Date.now() + 86400_000 }, source: "magpie", file: join(dir, "auth.json"), key: `${realm}:u1` };
  writeJSON(account.file, { [account.id]: account.auth });
  const state = readJSON(join(dir, "state.json")), seen = [], logs = [];
  const config = { ...defaults };
  const client = new WorkBuddyClient(account, config, { gap: 0, fetcher: async (url, init = {}) => {
    const path = new URL(url).pathname;
    seen.push({ path, host: new URL(url).host, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers });
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
      { task_code: "Sequential_Tasks_4", title: "还没适配的", accept_status: "not_accepted", progress: null }
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

// A WorkBuddy AI login is renewed like China's, on its own site, so the
// keep-alive slot keeps it alive though nothing chats on it.
test("keepalive renews a WorkBuddy AI login on www.workbuddy.ai", async t => {
  const p = fixture(t, path => {
    if (path === "/v2/plugin/auth/token/refresh") return ok({ accessToken: "renewed-access", refreshToken: "renewed-refresh", expiresIn: 5184000 });
    throw new Error("unexpected endpoint " + path);
  }, "intl");
  p.context.account.auth.expires = Date.now() + 60_000;
  writeJSON(p.context.account.file, { [p.context.account.key]: p.context.account.auth });
  const got = await p.run("keepalive");
  assert.equal(got.renewed, true);
  assert.equal(p.seen[0].headers.Origin, "https://www.workbuddy.ai");
  assert.equal(readJSON(p.context.account.file)[p.context.account.key].access, "renewed-access");
  assert.match(p.logs.at(-1), /国际版登录已续期/);
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
  assert.equal(create.headers["X-IDE-Type"], undefined, "the web app sends no desktop fingerprint");
  const calls = p.seen.filter(s => s.path === "/acp" && s.body).map(s => s.body.method);
  assert.deepEqual(calls, ["initialize", "session/load", "session/set_model", "session/prompt"]);
  assert.equal(p.seen.find(s => s.body?.method === "session/set_model").body.params.modelId, "hy3");
  assert.ok(p.seen.filter(s => s.path === "/acp" && s.body).every(s => s.headers["Acp-Connection-Id"] === "acp-1" && s.headers.Authorization === "Bearer sandbox-token"));
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
