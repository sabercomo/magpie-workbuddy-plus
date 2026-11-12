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
//
// We don't ask: no "Hi" probe is sent. A real chat request that WorkBuddy
// refuses with 6004 or 6020 is recorded instead, and the board only reads
// those observations.

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

// Record a real refusal: a spent model (6004, with its reset time) or a
// queued one (6020). A plain 429 is a rate limit on the request, not a model
// limit, and is left alone.
export function note(memory, model, payload, now = Date.now()) {
  if (!memory || !model || !payload || typeof payload !== "object") return false;
  const code = Number(payload.code), msg = payload.msg || payload.message || "";
  if (code === 6020 || /queue\.waiting/.test(msg)) {
    const q = payload.data || {};
    memory[model] = { checked: now, queued: { position: Number(q.queue_position) || 0, size: /^\d+$/.test(String(q.queue_size ?? "")) ? Number(q.queue_size) : String(q.queue_size ?? ""), wait: (Number(q.estimated_wait) || 0) * 1000 } };
    return true;
  }
  const resets = parseReset(msg);
  if (code === 6004 || resets) { memory[model] = { checked: now, resets: resets || now + DAY }; return true; }
  return false;
}

// A model that just answered is not limited; drop an older refusal.
export function forget(memory, model) {
  if (memory && model) delete memory[model];
}

// memory: { [model]: { checked, resets?, queued? } }, filled by note() from
// real refusals and kept between board refreshes. Returns the models spent
// right now, { model, resets }, then those found queued, { model, queued:
// { position, size, at, until } }, shown until the wait they were told is up.
// Entries whose reset and queue have passed are dropped as they are read.
const MIN_QUEUE = 10 * 60_000;
const until = m => m.checked + Math.max(m.queued.wait || 0, MIN_QUEUE);
export function limits(memory = {}, now = Date.now()) {
  for (const [model, m] of Object.entries(memory)) if (!(m.resets > now) && !(m.queued && until(m) > now)) delete memory[model];
  const spent = Object.entries(memory).filter(([, m]) => m.resets > now).map(([model, m]) => ({ model, resets: m.resets })).sort((a, b) => a.resets - b.resets);
  const queued = Object.entries(memory).filter(([, m]) => m.queued && until(m) > now)
    .map(([model, m]) => ({ model, queued: { position: m.queued.position, size: m.queued.size, at: m.checked, until: until(m) } })).sort((a, b) => a.queued.until - b.queued.until);
  return [...spent, ...queued];
}
