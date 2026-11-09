// 模型限额: besides credits, each model has its own allowance per account over
// a rolling 24-hour window. WorkBuddy doesn't say how much is left; it answers
// a request on a spent model with HTTP 429, code 6004, and when the window
// resets:
//   cn   「您的使用量已超出频率限制，将在 2026-11-09 00:14:03 UTC+8 重置…」
//   intl "... your usage will reset at 2026-09-19 18:29:03 UTC+8 ..."
// A model short of capacity answers HTTP 429 too, code 6020, with a queue:
//   {"msg":"queue.waiting.title","data":{"queue_position":907,"queue_size":908,
//    "retry_after":40,"estimated_wait":4535}}   (seconds; a long queue's size is "999+")
// That stops an enterprise account as well, however much allowance it has.
// So the only way to know is to ask: one minimal chat request ("Hi", at most
// 16 tokens, no reasoning). A spent model costs nothing to ask; a live one
// costs a fraction of a credit.
//
// To keep that rare, a model is asked only when the account used it within
// the last day and again since it was last asked, at most once an hour, and
// never while a known window is still running. Once the reset time passes the
// model counts as recovered without being asked.

import { randomUUID } from "node:crypto";

const HOUR = 3600_000, DAY = 24 * HOUR;

// The stamp is wall-clock time in the body's own UTC offset (+8 if none).
export function parseReset(text) {
  const s = String(text || "");
  const m = s.match(/(?:reset at|将在)\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*UTC([+-]\d{1,2}))?/)
    || s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC([+-]\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, offset = "+8"] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - Number(offset) * HOUR;
}

// One minimal chat request, shaped like the client's own: WorkBuddy AI turns
// one away without the conversation headers and a system prompt first (code
// 11128). Returns { limited, resets? } or { limited: false, queued }; anything
// but a reply, a 6004 or a 6020 throws.
export async function probe(client, model) {
  await client.refresh();
  const id = () => randomUUID().replace(/-/g, ""), turn = id(), message = id();
  const response = await client.fetch(client.site.origin + "/v2/chat/completions", {
    method: "POST",
    headers: { ...client.headers(), "X-Agent-Type": "main", "X-Private-Data": "true", "X-Conversation-ID": randomUUID(), "X-Conversation-Request-ID": turn, "X-Root-Request-ID": turn, "X-Conversation-Message-ID": message, "X-Request-ID": message },
    body: JSON.stringify({ model, messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "Hi" }], stream: true, max_tokens: 16, reasoning_effort: "none" })
  });
  const text = await response.text();
  if (response.ok) return { limited: false };
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  if (response.status === 429 && (payload.code === 6020 || /queue\.waiting/.test(payload.msg || ""))) {
    const q = payload.data || {};
    return { limited: false, queued: { position: Number(q.queue_position) || 0, size: /^\d+$/.test(String(q.queue_size ?? "")) ? Number(q.queue_size) : String(q.queue_size ?? ""), wait: (Number(q.estimated_wait) || 0) * 1000 } };
  }
  const resets = parseReset(payload.msg || payload.message || text);
  if (response.status === 429 && (payload.code === 6004 || resets)) return { limited: true, ...(resets ? { resets } : {}) };
  throw new Error(`HTTP ${response.status}，${String(payload.msg || payload.message || text).slice(0, 120)}`);
}

// memory: { [model]: { checked, resets?, queued?, error? } }, kept between
// board refreshes. used: { [model]: newest request time }. Returns the models
// spent right now, { model, resets }, then those found queued, { model, queued:
// { position, size, at, until } }, shown until the wait they were told is up.
const MIN_QUEUE = 10 * 60_000;
const until = m => m.checked + Math.max(m.queued.wait || 0, MIN_QUEUE);
export async function limits(client, used = {}, memory = {}, now = Date.now(), ask = probe) {
  for (const [model, m] of Object.entries(memory)) if (!(used[model] > now - 7 * DAY) && !(m.resets > now)) delete memory[model];
  for (const [model, last] of Object.entries(used).sort((a, b) => b[1] - a[1])) {
    const m = memory[model];
    if (m?.resets > now) continue;
    if (!(last > now - DAY)) continue;
    // Recovered at its reset time, then not used again: nothing to ask. A
    // check that failed, or found a queue, is tried again after the hour all the same.
    if (m && (now - m.checked < HOUR || (!m.error && !m.queued && (last <= m.checked || last <= (m.resets || 0))))) continue;
    try {
      const got = await ask(client, model);
      memory[model] = { checked: now, ...(got.limited ? { resets: got.resets || now + DAY } : got.queued ? { queued: got.queued } : {}) };
    } catch (e) {
      memory[model] = { checked: now, error: e.message.slice(0, 120) };
    }
  }
  const spent = Object.entries(memory).filter(([, m]) => m.resets > now).map(([model, m]) => ({ model, resets: m.resets })).sort((a, b) => a.resets - b.resets);
  const queued = Object.entries(memory).filter(([, m]) => m.queued && until(m) > now)
    .map(([model, m]) => ({ model, queued: { position: m.queued.position, size: m.queued.size, at: m.checked, until: until(m) } })).sort((a, b) => a.queued.until - b.queued.until);
  return [...spent, ...queued];
}
