// 模型限额: besides credits, each model has its own allowance per account over
// a rolling 24-hour window. WorkBuddy doesn't say how much is left; it answers
// a request on a spent model with HTTP 429, code 6004, and when the window
// resets:
//   cn   「您的使用量已超出频率限制，将在 2026-11-09 00:14:03 UTC+8 重置…」
//   intl "... your usage will reset at 2026-09-19 18:29:03 UTC+8 ..."
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
// 11128). Returns { limited, resets? }; anything but a reply or a 6004 throws.
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
  const resets = parseReset(payload.msg || payload.message || text);
  if (response.status === 429 && (payload.code === 6004 || resets)) return { limited: true, ...(resets ? { resets } : {}) };
  throw new Error(`HTTP ${response.status}，${String(payload.msg || payload.message || text).slice(0, 120)}`);
}

// memory: { [model]: { checked, resets? } }, kept between board refreshes.
// used: { [model]: newest request time }. Returns the models spent right now.
export async function limits(client, used = {}, memory = {}, now = Date.now(), ask = probe) {
  for (const [model, m] of Object.entries(memory)) if (!(used[model] > now - 7 * DAY) && !(m.resets > now)) delete memory[model];
  for (const [model, last] of Object.entries(used).sort((a, b) => b[1] - a[1])) {
    const m = memory[model];
    if (m?.resets > now) continue;
    if (!(last > now - DAY)) continue;
    // Recovered at its reset time, then not used again: nothing to ask. A
    // check that failed is tried again after the hour all the same.
    if (m && (now - m.checked < HOUR || (!m.error && (last <= m.checked || last <= (m.resets || 0))))) continue;
    try {
      const got = await ask(client, model);
      memory[model] = { checked: now, ...(got.limited ? { resets: got.resets || now + DAY } : {}) };
    } catch (e) {
      memory[model] = { checked: now, error: e.message.slice(0, 120) };
    }
  }
  return Object.entries(memory).filter(([, m]) => m.resets > now).map(([model, m]) => ({ model, resets: m.resets })).sort((a, b) => a.resets - b.resets);
}
