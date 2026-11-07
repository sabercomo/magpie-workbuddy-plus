// Credit history (积分流水): the account's grants, each named by what gave it.
// WorkBuddy keeps every grant as its own package row (see summarize), with
// when it was made and how much; what it came from is read off the evidence:
// the line of this plugin's own run log that gave that amount within minutes
// of it, else Magpie's China check-in, which lands just after midnight.
const round = n => Math.round(n * 100) / 100;
const near = 5 * 60_000;

// Log lines that give credit, the label each stands for, and whether its
// amount must match the grant's (a streak exchange or a draw names none).
const sources = [
  [/猫猫归来/, "猫猫旅行", true],
  [/：已领奖/, "成长任务", true],
  [/签到：/, "每日签到", true],
  [/新手礼包/, "新手礼包", true],
  [/活动补偿/, "活动补偿", true],
  [/已兑换连登/, "连登兑换", false],
  [/成长抽奖/, "成长抽奖", false]
];
const amountOf = message => { const m = String(message).match(/([\d.]+)\s*积分/); return m ? Number(m[1]) : null; };

export function sourceOf(grant, logs, signed, timezone = "Asia/Shanghai") {
  let best = null;
  for (const log of logs) {
    const t = Date.parse(log.at), gap = Math.min(Math.abs(t - grant.at), grant.start ? Math.abs(t - grant.start) : Infinity);
    if (!(gap <= near)) continue;
    const hit = sources.find(([pattern]) => pattern.test(log.message));
    if (!hit || (hit[2] && amountOf(log.message) !== grant.credit)) continue;
    if (!best || gap < best.gap) best = { gap, label: hit[1] };
  }
  if (best) return best.label;
  if (signed && Math.abs(signed - grant.at) <= near) return "每日签到";
  // Magpie checks in for China right after midnight, when this plugin runs nothing.
  const hour = Number(new Intl.DateTimeFormat("en", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(grant.at));
  return hour === 0 && grant.credit === 100 ? "每日签到" : "";
}

// The board's share: the last week's grants, newest first, what each came
// from, their total by source, and what was used meanwhile.
export function ledger(balance, usage, logs, signed, now = Date.now(), days = 7) {
  const entries = (balance?.grants || []).filter(g => g.at >= now - days * 86400_000).map(g => ({ ...g, source: sourceOf(g, logs, signed) }));
  // A day's one unexplained 100-credit grant is its check-in, landed late
  // (Magpie closed at midnight, signed in at 02:14).
  const day = t => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(t), signedDays = new Set(entries.filter(e => e.source === "每日签到").map(e => day(e.at)));
  for (const e of [...entries].reverse()) if (!e.source && e.credit === 100 && !signedDays.has(day(e.at))) { e.source = "每日签到"; signedDays.add(day(e.at)); }
  const bySource = new Map();
  for (const e of entries) bySource.set(e.source || "其他", round((bySource.get(e.source || "其他") || 0) + e.credit));
  return {
    gained: round(entries.reduce((s, e) => s + e.credit, 0)), used: round(usage?.credit || 0),
    sources: [...bySource].sort((a, b) => b[1] - a[1]), entries: entries.slice(0, 40)
  };
}
