import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkBuddyClient, RateLimited } from "../client.mjs";
import { limits, note, forget, parseReset } from "../limits.mjs";

const HOUR = 3600_000, DAY = 24 * HOUR;

test("a 6004 reply's reset time is read in its own UTC offset, China's and WorkBuddy AI's wording alike", () => {
  assert.equal(parseReset("您的使用量已超出频率限制，将在 2026-11-09 00:14:03 UTC+8 重置，您也可以切换其他模型继续使用。"), Date.parse("2026-11-08T16:14:03Z"));
  assert.equal(parseReset("Too many requests, your usage will reset at 2026-09-19 18:29:03 UTC+8."), Date.parse("2026-09-19T10:29:03Z"));
  assert.equal(parseReset("usage will reset at 2026-09-19 10:29:03 UTC+0"), Date.parse("2026-09-19T10:29:03Z"));
  assert.equal(parseReset("将在 2026-11-09 00:14:03 重置"), Date.parse("2026-11-08T16:14:03Z"));
  assert.equal(parseReset("rate limited"), null);
});

test("a real refusal is recorded: 6004 keeps its reset, 6020 its queue, a plain 429 nothing", () => {
  const now = Date.parse("2026-11-09T06:15:00Z"), memory = {};
  assert.equal(note(memory, "kimi-k3-1", { code: 6004, msg: "您的使用量已超出频率限制，将在 2026-11-09 00:14:03 UTC+8 重置" }, now), true);
  assert.deepEqual(memory["kimi-k3-1"], { checked: now, resets: Date.parse("2026-11-08T16:14:03Z") });
  assert.equal(note(memory, "kimi-k3.1-pro", { code: 6020, msg: "queue.waiting.title", data: { queue_position: 907, queue_size: "999+", estimated_wait: 4535 } }, now), true);
  assert.deepEqual(memory["kimi-k3.1-pro"], { checked: now, queued: { position: 907, size: "999+", wait: 4535_000 } });
  // A plain 429 is rate limiting on the request, not the model's allowance.
  assert.equal(note(memory, "glm-5.3", { code: 1, msg: "slow down" }, now), false);
  assert.equal(memory["glm-5.3"], undefined);
  assert.equal(note(memory, "glm-5.3", null, now), false);
  forget(memory, "kimi-k3-1");
  assert.equal(memory["kimi-k3-1"], undefined);
});

test("the board lists a spent model and then a queued one, dropping each once its time is up", () => {
  const now = Date.parse("2026-11-09T06:15:00Z"), memory = {};
  note(memory, "kimi-k3-1", { code: 6004, msg: "将在 2026-11-09 19:15:00 UTC+8 重置" }, now);
  note(memory, "kimi-k3.1-pro", { code: 6020, msg: "queue.waiting.title", data: { queue_position: 3, queue_size: 40, estimated_wait: 30 } }, now);
  assert.deepEqual(limits(memory, now), [
    { model: "kimi-k3-1", resets: now + 5 * HOUR },
    { model: "kimi-k3.1-pro", queued: { position: 3, size: 40, at: now, until: now + 10 * 60_000 } }
  ]);
  // A short queue stays listed for at least ten minutes.
  assert.deepEqual(limits(memory, now + 9 * 60_000).at(-1), { model: "kimi-k3.1-pro", queued: { position: 3, size: 40, at: now, until: now + 10 * 60_000 } });
  assert.deepEqual(limits(memory, now + 11 * 60_000), [{ model: "kimi-k3-1", resets: now + 5 * HOUR }]);
  // Past its reset the model is gone; the empty entry is dropped too.
  assert.deepEqual(limits(memory, now + 6 * HOUR), []);
  assert.deepEqual(memory, {});
});

test("a real chat refused with 6004 is recorded by the client; a later success clears it", async () => {
  const account = { id: "intl:u1", name: "fixture", realm: "intl", auth: { uid: "u1", access: "private-access", expires: Date.now() + DAY } };
  const memory = {};
  let reply = () => Response.json({ code: 6004, msg: "your usage will reset at 2026-11-09 10:15:00 UTC+8" }, { status: 429 });
  const client = new WorkBuddyClient(account, { proxy: "" }, { gap: 0, wait: async () => {}, limits: memory, fetcher: async () => reply() });
  await assert.rejects(client.request("/v2/chat/completions", { body: { model: "glm-5.2" } }), RateLimited);
  assert.deepEqual(memory["glm-5.2"], { checked: memory["glm-5.2"].checked, resets: Date.parse("2026-11-09T02:15:00Z") });
  reply = () => Response.json({ code: 0, data: { ok: true } });
  assert.deepEqual(await client.request("/v2/chat/completions", { body: { model: "glm-5.2" } }), { ok: true });
  assert.deepEqual(memory, {});
});
