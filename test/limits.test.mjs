import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../storage.mjs";
import { WorkBuddyClient } from "../client.mjs";
import { limits, parseReset, probe } from "../limits.mjs";

const HOUR = 3600_000;

test("a 6004 reply's reset time is read in its own UTC offset, China's and WorkBuddy AI's wording alike", () => {
  assert.equal(parseReset("您的使用量已超出频率限制，将在 2026-11-09 00:14:03 UTC+8 重置，您也可以切换其他模型继续使用。"), Date.parse("2026-11-08T16:14:03Z"));
  assert.equal(parseReset("Too many requests, your usage will reset at 2026-09-19 18:29:03 UTC+8."), Date.parse("2026-09-19T10:29:03Z"));
  assert.equal(parseReset("usage will reset at 2026-09-19 10:29:03 UTC+0"), Date.parse("2026-09-19T10:29:03Z"));
  assert.equal(parseReset("将在 2026-11-09 00:14:03 重置"), Date.parse("2026-11-08T16:14:03Z"));
  assert.equal(parseReset("rate limited"), null);
});

test("a probe is one minimal chat request: a spent model answers 6004 with its reset, a live one answers", async () => {
  const seen = [];
  let reply;
  const account = { id: "cn:u1", name: "fixture", realm: "cn", auth: { uid: "u1", access: "private-access", expires: Date.now() + 86400_000 } };
  const client = new WorkBuddyClient(account, defaults, { gap: 0, fetcher: async (url, init) => { seen.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return reply(); } });
  reply = () => Response.json({ code: 6004, msg: "您的使用量已超出频率限制，将在 2026-11-09 00:14:03 UTC+8 重置，您也可以切换其他模型继续使用。" }, { status: 429 });
  assert.deepEqual(await probe(client, "kimi-k3-1"), { limited: true, resets: Date.parse("2026-11-08T16:14:03Z") });
  assert.equal(seen[0].url, "https://www.workbuddy.cn/v2/chat/completions");
  assert.deepEqual(seen[0].body, { model: "kimi-k3-1", messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "Hi" }], stream: true, max_tokens: 16, reasoning_effort: "none" });
  // WorkBuddy AI refuses a chat without the client's conversation headers.
  assert.equal(seen[0].headers["X-Agent-Type"], "main");
  assert.match(seen[0].headers["X-Conversation-ID"], /^[0-9a-f-]{36}$/);
  assert.equal(seen[0].headers["X-Request-ID"], seen[0].headers["X-Conversation-Message-ID"]);
  reply = () => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  assert.deepEqual(await probe(client, "deepseek-v4.1-flash"), { limited: false });
  reply = () => Response.json({ code: 11, msg: "model not found" }, { status: 400 });
  await assert.rejects(probe(client, "nope"), /HTTP 400，model not found/);
  // A plain 429 without 6004 or a reset time is a rate limit on the request, not a spent model.
  reply = () => Response.json({ code: 1, msg: "slow down" }, { status: 429 });
  await assert.rejects(probe(client, "deepseek-v4.1-flash"), /HTTP 429/);
});

test("a model is asked only when used within the day and since it was last asked, at most hourly, never inside its window", async () => {
  const now = Date.parse("2026-11-08T12:00:00Z"), asked = [];
  const answers = { "kimi-k3-1": { limited: true, resets: now + 12 * HOUR }, "glm-5.3": { limited: false } };
  const ask = async (_, model) => { asked.push(model); if (model === "broken") throw new Error("HTTP 400，bad"); return answers[model]; };
  const memory = {};
  const used = { "kimi-k3-1": now - HOUR, "glm-5.3": now - 2 * HOUR, "old-model": now - 2 * 24 * HOUR, broken: now - HOUR };
  assert.deepEqual(await limits(null, used, memory, now, ask), [{ model: "kimi-k3-1", resets: now + 12 * HOUR }]);
  assert.deepEqual(asked.sort(), ["broken", "glm-5.3", "kimi-k3-1"], "a model unused for a day is not asked");
  assert.equal(memory.broken.error, "HTTP 400，bad");

  // Inside the hour, or not used since: nothing is asked; the spent model stays listed.
  asked.length = 0;
  assert.deepEqual(await limits(null, { ...used, "glm-5.3": now + 10 * 60_000 }, memory, now + 30 * 60_000, ask), [{ model: "kimi-k3-1", resets: now + 12 * HOUR }]);
  const { broken, ...rest } = used;
  assert.deepEqual(await limits(null, rest, memory, now + 2 * HOUR, ask), [{ model: "kimi-k3-1", resets: now + 12 * HOUR }]);
  assert.deepEqual(asked, []);

  // Used again after an hour: asked again. A failed check is retried after the hour, used or not.
  assert.deepEqual(await limits(null, { ...used, "glm-5.3": now + 90 * 60_000 }, memory, now + 2 * HOUR, ask), [{ model: "kimi-k3-1", resets: now + 12 * HOUR }]);
  assert.deepEqual(asked.sort(), ["broken", "glm-5.3"]);
  delete used.broken; delete memory.broken;

  // Past its reset the model counts as recovered without asking, until it's used again.
  asked.length = 0;
  assert.deepEqual(await limits(null, used, memory, now + 13 * HOUR, ask), []);
  assert.deepEqual(asked, []);
  answers["kimi-k3-1"] = { limited: false };
  await limits(null, { ...used, "kimi-k3-1": now + 13 * HOUR }, memory, now + 13.5 * HOUR, ask);
  assert.deepEqual(asked, ["kimi-k3-1"]);

  // A model unused for a week is forgotten.
  await limits(null, { "kimi-k3-1": now + 7.5 * 24 * HOUR }, memory, now + 8 * 24 * HOUR, ask);
  assert.deepEqual(Object.keys(memory), ["kimi-k3-1"]);
});
