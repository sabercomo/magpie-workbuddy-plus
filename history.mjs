// Credit history (积分流水): the account's grants, each named by what gave it.
// WorkBuddy keeps every grant as its own package row (see summarize), with
// when it was made and how much. Use its grant reason when available, then
// match a credited amount and time in the run log or Magpie's check-in.
const round = n => Math.round(n * 100) / 100;
const near = 5 * 60_000;

const sources = [
  [/^猫猫归来：已领取/, "猫猫旅行"],
  [/：已领奖，/, "成长任务"],
  [/签到：\+/, "每日签到"],
  [/^新手礼包：已领取/, "新手礼包"],
  [/^(官方|活动)补偿：已领取/, "活动补偿"],
  [/^成长抽奖 \d+\/\d+：(?:\{"prize_name":")?\+?\d+(?:\.\d+)?\s*积分(?:"|$)/, "成长抽奖"]
];
const amountOf = message => { const m = String(message).match(/([\d.]+)\s*积分/); return m ? Number(m[1]) : null; };

export function sourceOf(grant, logs, signed) {
  let best = null;
  for (const log of logs) {
    const t = Date.parse(log.at), gap = Math.min(Math.abs(t - grant.at), grant.start ? Math.abs(t - grant.start) : Infinity);
    if (!(gap <= near)) continue;
    const hit = sources.find(([pattern]) => pattern.test(log.message));
    if (!hit || amountOf(log.message) !== grant.credit) continue;
    if (!best || gap < best.gap) best = { gap, label: hit[1] };
  }
  if (best) return best.label;
  if (signed?.credit === grant.credit && Math.abs(signed.at - grant.at) <= near) return "每日签到";
  return "";
}

// The board's share: the grants of the last seven calendar days (Beijing's,
// today included: the same days the usage total covers), newest first, what
// each came from, their total by source, and what was used meanwhile.
// WorkBuddy AI's daily activity reward is a Bonus Pack of 30 or 50 with no
// reason given; it lands the night after the day it is for (02:00 to 07:00
// in Beijing), not minutes after that day's web conversation.
export const reward = (g, realm) => realm === "intl" && /^Bonus Pack$/i.test(String(g.name || "").trim()) && [30, 50].includes(g.credit);

export function ledger(balance, usage, logs, signed, now = Date.now(), days = 7, realm = "cn") {
  const day = t => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(t), since = Date.parse(`${day(now - (days - 1) * 86400_000)}T00:00:00+08:00`);
  const entries = (balance?.grants || []).filter(g => g.at >= since).map(({ grantReason, ...grant }) => {
    const recorded = sourceOf(grant, logs, signed);
    const activityReward = !recorded && reward(grant, realm);
    const source = grantReason || recorded || (activityReward ? "每日活跃奖励" : "来源未确认");
    return { ...grant, source, ...(grantReason && activityReward ? { activityReward } : {}) };
  });
  const bySource = new Map();
  for (const e of entries) bySource.set(e.source, round((bySource.get(e.source) || 0) + e.credit));
  return {
    gained: round(entries.reduce((s, e) => s + e.credit, 0)), used: round(usage?.credit || 0),
    sources: [...bySource].sort((a, b) => b[1] - a[1]), entries: entries.slice(0, 40)
  };
}
