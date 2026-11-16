import { test } from "node:test";
import assert from "node:assert/strict";
import { campaign, campaignStatus } from "../campaign.mjs";

const client = (handler, reports = [], fetcher = async () => { throw new Error("unexpected fetch"); }) => {
  const calls = [];
  return {
    calls, reports, account: { auth: { access: "token", uid: "u1" } },
    request: async (path, options = {}) => { calls.push({ path, ...options }); return handler(path, options); },
    report: async (events, via) => { reports.push({ events, via }); return handler("/v2/report", { body: events, via }); },
    fetch: async (url, init = {}, timeout) => { calls.push({ path: new URL(url).pathname, url, ...init, timeout }); return fetcher(url, init, timeout); }
  };
};

test("a claim-only campaign run claims tasks already earned, viewed first", async () => {
  const c = client(path => {
    if (path.startsWith("/portal/activity/config?activity_code=campaign_starbucks")) return { config: { in_period: true } };
    if (path.startsWith("/portal/activity/config?")) return { config: { in_period: false } };
    if (path.startsWith("/portal/activity/tasks?")) return {
      tasks: [
        { task_code: "ai_chat", target_count: 3, enabled: 1 },
        { task_code: "expert", target_count: 1, enabled: 1 },
        { task_code: "done", target_count: 1, enabled: 1, status: "claimed" }
      ],
      progress: [{ task_code: "ai_chat", progress: 3 }, { task_code: "expert", progress: 0 }, { task_code: "done", progress: 1 }]
    };
    return {};
  });
  assert.deepEqual(await campaign(c, { execute: false }), { tasks: 3, ready: 1, claimed: 1, earned: 100, manual: 0, skipped: 1, pending: 0, errors: [] });
  assert.ok(c.calls.some(x => x.path.includes("/ai_chat/viewed?")));
  assert.ok(c.calls.some(x => x.path.includes("/ai_chat/claim?")));
  assert.ok(c.calls.some(x => x.path.includes("campaign_reporter_2026")));
  assert.ok(!c.calls.some(x => x.path.includes("/expert/viewed")));
});

test("an out-of-period campaign does not read tasks", async () => {
  const c = client(() => ({ config: { in_period: false } }));
  assert.deepEqual(await campaign(c), { tasks: 0, ready: 0, claimed: 0, earned: 0, manual: 0, skipped: 2, pending: 0, errors: [] });
  assert.equal(c.calls.filter(x => x.path.includes("/config?")).length, 2);
  assert.equal(c.calls.filter(x => x.path.includes("/tasks?")).length, 0);
});

test("a restricted campaign response is rethrown so the scheduler can pause the account", async () => {
  const c = client(path => {
    if (path.startsWith("/portal/activity/config?")) throw Object.assign(new Error("request illegal"), { restricted: true });
    throw new Error(`unexpected ${path}`);
  });
  await assert.rejects(campaign(c), error => {
    assert.equal(error.restricted, true);
    return true;
  });
});

test("a network failure is rethrown from campaign execution", async () => {
  const c = client(path => {
    if (path.startsWith("/portal/activity/config?activity_code=campaign_starbucks")) return { config: { in_period: true } };
    if (path.startsWith("/portal/activity/config?")) return { config: { in_period: false } };
    if (path.startsWith("/portal/activity/tasks?")) return { tasks: [{ task_code: "ai_chat", target_count: 1, need_view: false }], progress: [] };
    if (path === "/v2/report") throw Object.assign(new Error("ECONNRESET: The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
    throw new Error(`unexpected ${path}`);
  });
  await assert.rejects(campaign(c, { poll: 0, sleep: async () => {} }), /ECONNRESET/);
});

test("campaign status is read without viewing, reporting or claiming", async () => {
  const c = client(path => {
    if (path.startsWith("/portal/activity/config?activity_code=campaign_starbucks")) return { config: { in_period: true } };
    if (path.startsWith("/portal/activity/config?")) return { config: { in_period: false } };
    if (path.startsWith("/portal/activity/tasks?")) return {
      tasks: [
        { task_code: "ai_chat", target_count: 3, reward_credit: 100 },
        { task_code: "app", target_count: 1, reward_credit: 100 }
      ],
      progress: [{ task_code: "ai_chat", progress: 1 }]
    };
    throw new Error(`unexpected ${path}`);
  });
  assert.deepEqual(await campaignStatus(c), [{
    code: "campaign_starbucks_2026", label: "星巴克协作",
    tasks: [
      { code: "ai_chat", label: "与 AI 对话 3 次", progress: 1, target: 3, credit: 100, done: false, claimed: false, manual: false },
      { code: "app", label: "解锁 App 强大能力", progress: 0, target: 1, credit: 100, done: false, claimed: false, manual: false }
    ]
  }]);
  assert.ok(!c.calls.some(x => /viewed|claim|\/v2\/report/.test(x.path)));
});

test("a campaign task without a target is not treated as already complete", async () => {
  const c = client(path => {
    if (path.startsWith("/portal/activity/config?activity_code=campaign_starbucks")) return { config: { in_period: true } };
    if (path.startsWith("/portal/activity/config?")) return { config: { in_period: false } };
    if (path.startsWith("/portal/activity/tasks?")) return { tasks: [{ task_code: "invite", reward_credit: 0, need_view: true }], progress: [] };
    throw new Error(`unexpected ${path}`);
  });
  const result = await campaign(c);
  assert.deepEqual([result.ready, result.claimed, result.manual, result.errors], [0, 0, 1, []]);
  assert.ok(!c.calls.some(x => x.path.includes("/invite/")));
});

test("12304 means the task was not actually ready; other claim errors are reported and the rest still run", async () => {
  const c = client(path => {
    if (path.startsWith("/portal/activity/config?activity_code=campaign_starbucks")) return { config: { in_period: true } };
    if (path.startsWith("/portal/activity/config?")) return { config: { in_period: false } };
    if (path.startsWith("/portal/activity/tasks?")) return {
      tasks: [{ task_code: "ai_chat", target_count: 1 }, { task_code: "expert", target_count: 1 }],
      progress: [{ task_code: "ai_chat", progress: 1 }, { task_code: "expert", progress: 1 }]
    };
    if (path.includes("/ai_chat/claim")) throw Object.assign(new Error("条件不满足"), { code: 12304 });
    if (path.includes("/expert/claim")) throw new Error("HTTP 500");
    return {};
  });
  const result = await campaign(c, { execute: false });
  assert.deepEqual([result.tasks, result.ready, result.claimed, result.errors.length], [2, 2, 0, 1]);
  assert.match(result.errors[0], /召唤专家并对话：HTTP 500/);
  assert.ok(c.calls.some(x => x.path.includes("/expert/viewed")), "the second task is still tried");
});

test("campaign tasks are advanced with the client events the mini program sends, then claimed", async () => {
  const rows = {
    campaign_starbucks_2026: {
      tasks: [
        { task_code: "ai_chat", target_count: 3, reward_credit: 100, need_view: true },
        { task_code: "expert", target_count: 1, reward_credit: 100, need_view: true },
        { task_code: "app", target_count: 1, reward_credit: 100, need_view: true },
        { task_code: "invite", target_count: 1, reward_credit: 0, need_view: true }
      ],
      progress: {}
    },
    campaign_reporter_2026: {
      tasks: [
        { task_code: "expert_chat", target_count: 1, reward_credit: 50, need_view: true },
        { task_code: "skill_use", target_count: 1, reward_credit: 50, need_view: true },
        { task_code: "desktop_same", target_count: 1, reward_credit: 100, need_view: true }
      ],
      progress: {}
    }
  };
  const reports = [], bootstraps = [];
  let bootstrapCancelled = false;
  const c = client((path, options = {}) => {
    const campaign = path.match(/activity_code=([^&]+)/)?.[1];
    if (path.startsWith("/portal/activity/config?")) return { config: { in_period: true } };
    if (path.startsWith("/portal/activity/tasks?")) {
      const state = rows[campaign];
      return { tasks: state.tasks, progress: Object.entries(state.progress).map(([task_code, progress]) => ({ task_code, progress,
        ...(progress >= (state.tasks.find(t => t.task_code === task_code)?.target_count || 1) ? { completed_at: "2026-11-16T00:00:00+08:00" } : {}),
        ...(state.claimed?.[task_code] ? { claimed_at: "2026-11-16T00:01:00+08:00" } : {}) })) };
    }
    if (path.includes("/viewed?")) return {};
    if (path === "/v2/as/conversations/") return { session: { boxUrl: "https://box.workbuddy.agentos-worker.net/session", token: "sandbox-token" } };
    if (path.includes("/claim?")) {
      const code = path.split("/tasks/")[1].split("/")[0];
      const state = rows[campaign];
      const row = state.progress[code] = state.progress[code] || 0;
      state.progress[code] = row;
      state.claimed ||= {};
      state.claimed[code] = true;
      return {};
    }
    if (path === "/v2/report") {
      const events = options.body || [];
      const codes = new Set(events.map(e => e.eventCode));
      if (options.via === "desktop" && codes.has("playbook_prompt_send")) rows.campaign_reporter_2026.progress.desktop_same = 1;
      if (codes.has("expert_actual_use")) {
        const id = events.find(e => e.expertId)?.expertId;
        if (id === "ex_NaiDbO06Adf3") rows.campaign_reporter_2026.progress.expert_chat = 1;
        else rows.campaign_starbucks_2026.progress.expert = 1;
      }
      if (codes.has("skill_info")) rows.campaign_reporter_2026.progress.skill_use = 1;
      if (codes.has("chat_request_send") && !events.some(e => e.skillId || e.expertId)) {
        rows.campaign_starbucks_2026.progress.ai_chat = (rows.campaign_starbucks_2026.progress.ai_chat || 0) + 1;
      }
      return {};
    }
    throw new Error(`unexpected ${path}`);
  }, reports, async (url, init, timeout) => {
    bootstraps.push({ url, init, timeout });
    rows.campaign_starbucks_2026.progress.app = 1;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: message\ndata: {"result":{"stopReason":"end_turn"}}\n\n')); },
      cancel() { bootstrapCancelled = true; }
    });
    return new Response(body, { headers: { "Acp-Connection-Id": "acp-1" } });
  });
  const result = await campaign(c, { poll: 0, sleep: async () => {} });
  assert.deepEqual([result.tasks, result.ready, result.claimed, result.earned, result.manual, result.pending, result.errors], [7, 6, 6, 500, 1, 0, []]);
  assert.equal(reports.filter(r => r.via === "mp" && r.events.some(e => e.eventCode === "chat_request_send" && !e.skillId && !e.expertId)).length, 3);
  assert.equal(reports.filter(r => r.events.some(e => e.eventCode === "expert_actual_use")).length, 2);
  assert.equal(reports.filter(r => r.events.some(e => e.eventCode === "skill_info")).length, 1);
  assert.equal(reports.filter(r => r.via === "desktop" && r.events.some(e => e.eventCode === "playbook_prompt_send")).length, 1);
  assert.equal(bootstraps.length, 1);
  assert.equal(bootstraps[0].url, "https://box.workbuddy.agentos-worker.net/session/acp/bootstrap?includeUserEcho=true");
  assert.equal(bootstraps[0].init.headers["X-Client-Product"], "workbuddy-app");
  assert.equal(bootstraps[0].timeout, 120_000);
  assert.equal(bootstrapCancelled, true, "the SSE stream is closed as soon as end_turn arrives");
  assert.ok(!c.calls.some(x => x.path.includes("/invite/")));

  // Claimed tasks are not fired again on the next round.
  const before = reports.length;
  const again = await campaign(c, { poll: 0, sleep: async () => {} });
  assert.deepEqual([again.claimed, again.earned, again.ready, reports.length], [0, 0, 0, before]);
});

test("the app campaign never sends its sandbox token to a non-official host", async () => {
  const c = client(path => {
    if (path.startsWith("/portal/activity/config?activity_code=campaign_starbucks")) return { config: { in_period: true } };
    if (path.startsWith("/portal/activity/config?")) return { config: { in_period: false } };
    if (path.startsWith("/portal/activity/tasks?")) return {
      tasks: [{ task_code: "app", target_count: 1, reward_credit: 100, need_view: false }], progress: []
    };
    if (path === "/v2/as/conversations/") return { session: { boxUrl: "https://attacker.example/session", token: "sandbox-token" } };
    throw new Error(`unexpected ${path}`);
  }, [], async () => { throw new Error("must not fetch an untrusted host"); });
  const result = await campaign(c, { poll: 0, sleep: async () => {} });
  assert.equal(result.claimed, 0);
  assert.match(result.errors.join("\n"), /不受信任的 boxUrl/);
  assert.ok(!c.calls.some(call => call.path === "/acp/bootstrap"));
});
