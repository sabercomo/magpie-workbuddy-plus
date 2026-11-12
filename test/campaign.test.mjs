import { test } from "node:test";
import assert from "node:assert/strict";
import { campaign } from "../campaign.mjs";

const client = handler => {
  const calls = [];
  return { calls, account: { auth: { access: "token", uid: "u1" } }, request: async (path, options = {}) => { calls.push({ path, ...options }); return handler(path, options); } };
};

test("the campaign claims only tasks already earned, viewed first", async () => {
  const c = client(path => {
    if (path.startsWith("/portal/activity/campaign/config")) return { config: { in_period: true } };
    if (path.startsWith("/portal/activity/campaign/tasks?")) return {
      tasks: [
        { task_code: "ai_chat", target_count: 3, enabled: 1 },
        { task_code: "expert", target_count: 1, enabled: 1 },
        { task_code: "done", target_count: 1, enabled: 1, status: "claimed" }
      ],
      progress: [{ task_code: "ai_chat", progress: 3 }, { task_code: "expert", progress: 0 }, { task_code: "done", progress: 1 }]
    };
    return {};
  });
  assert.deepEqual(await campaign(c), { tasks: 3, ready: 1, claimed: 1, errors: [] });
  assert.deepEqual(c.calls.map(x => x.path.split("?")[0]), [
    "/portal/activity/campaign/config",
    "/portal/activity/campaign/tasks",
    "/portal/activity/campaign/tasks/ai_chat/viewed",
    "/portal/activity/campaign/tasks/ai_chat/claim"
  ]);
  // Claims are POSTs without a body, as the mini program sends them.
  for (const call of c.calls.slice(2)) assert.deepEqual([call.body, call.headers()["X-Client-Platform"]], [{}, "miniprogram"]);
});

test("an out-of-period campaign does not read tasks", async () => {
  const c = client(() => ({ config: { in_period: false } }));
  assert.deepEqual(await campaign(c), { skipped: true, reason: "out-of-period" });
  assert.equal(c.calls.length, 1);
});

test("12304 means the task was not actually ready; other claim errors are reported and the rest still run", async () => {
  const c = client(path => {
    if (path.startsWith("/portal/activity/campaign/config")) return { config: { in_period: true } };
    if (path.startsWith("/portal/activity/campaign/tasks?")) return {
      tasks: [{ task_code: "a", target_count: 1, enabled: 1 }, { task_code: "b", target_count: 1, enabled: 1 }],
      progress: [{ task_code: "a", progress: 1 }, { task_code: "b", progress: 1 }]
    };
    if (path.includes("/a/claim")) throw Object.assign(new Error("条件不满足"), { code: 12304 });
    if (path.includes("/b/claim")) throw new Error("HTTP 500");
    return {};
  });
  const result = await campaign(c);
  assert.deepEqual([result.ready, result.claimed, result.errors.length], [2, 0, 1]);
  assert.match(result.errors[0], /^b：HTTP 500/);
  assert.ok(c.calls.some(x => x.path.includes("/b/viewed")), "the second task is still tried");
});
