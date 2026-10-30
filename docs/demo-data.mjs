// Writes a board snapshot with made-up accounts, for the README screenshots:
//   bun docs/demo-data.mjs ~/Applications/Magpie-WorkBuddy-Plus/page [15:00]
// The optional time sets the board's clock to that time today; the page must
// then be shown at the same time for travel and expiry to read right.
// then open WorkBuddy Plus in Magpie. The service puts the real snapshot back
// on its next refresh (within about 10 minutes, or after any run).
import { writePage } from "../board.mjs";
import { join } from "node:path";

const clock = process.argv[3]?.split(":").map(Number);
const now = clock ? new Date().setHours(clock[0], clock[1], 0, 0) : Date.now(), H = 3600_000, D = 24 * H;
const at = (d, h, m = 0) => { const t = new Date(now + d * D); t.setHours(h, m, 0, 0); return t.getTime(); };
const days = (base, credit) => Array.from({ length: 7 }, (_, i) => {
  const d = new Date(now - (6 - i) * D);
  return { date: d.toISOString().slice(0, 10), credit: credit[i], count: Math.round(credit[i] / 3) };
});
const usage = credit => {
  const list = days(now, credit), total = credit.reduce((s, c) => s + c, 0);
  return { days: list, credit: total, count: list.reduce((s, d) => s + d.count, 0),
    models: [["claude-sonnet", .55], ["deepseek-v3", .25], ["hunyuan-turbos", .12], ["glm-4.6", .08]].map(([model, k]) => ({ model, credit: Math.round(total * k * 100) / 100, count: Math.round(total * k / 3) })) };
};
const task = (title, state, current, target, credit, energy = 0, note = "") => ({ title, state, note, current, target, credit, energy, ends: at(12, 23, 59) });

const accounts = [
  {
    id: "demo-1", name: "主力号", enterprise: false, expires: now + 26 * D, errors: {},
    balance: { balance: 1863.5, size: 3300, packages: [
      { name: "新人体验积分", balance: 186.5, size: 300, expires: at(1, 23, 59) },
      { name: "成长任务奖励", balance: 677, size: 1000, expires: at(8, 23, 59) },
      { name: "连登兑换积分", balance: 1000, size: 2000, expires: at(41, 23, 59) }
    ] },
    usage: usage([92, 140, 76, 188, 120, 64, 108]),
    travel: { state: "traveling", name: "团子", location: "敦煌", departAt: now - 2 * H, arriveAt: now + 1.5 * H, limitReached: false, reward: 30 },
    streak: { days: 12, makeupCards: 1, active: true, nextTier: { days: 14, remaining: 2, credit: 200, energy: 50 } },
    tasks: { total: 9, claimed: 5, credit: 260, open: [
      task("体验专家团队协作", "claimable", 1, 1, 80, 20),
      task("连续 3 天使用 Skill", "auto", 2, 3, 100, 30),
      task("关注官方公众号", "manual", 0, 1, 50, 0, "需要关注官方公众号满 24 小时"),
      task("邀请好友体验", "locked", 0, 1, 30)
    ] },
    growth: { energy: 340, earned: 1280, spent: 940, draws: 2, buddies: 7, rarity: { R: 4, SR: 2, UR: 1 }, current: ["团子"] },
    checkin: { outcome: "claimed", credit: 100, streak: 12, at: at(0, 0, 0) }
  },
  {
    id: "demo-2", name: "备用号", enterprise: false, expires: now + 14 * H, errors: {},
    balance: { balance: 412, size: 1300, packages: [
      { name: "成长任务奖励", balance: 212, size: 800, expires: at(5, 23, 59) },
      { name: "新人体验积分", balance: 200, size: 500, expires: at(27, 23, 59) }
    ] },
    usage: usage([12, 0, 30, 8, 22, 40, 16]),
    travel: { state: "arrived", name: "芝麻", location: "大理", departAt: now - 5 * H, arriveAt: now - H, limitReached: false, reward: 30 },
    streak: { days: 5, makeupCards: 0, active: true, nextTier: { days: 7, remaining: 2, credit: 100, energy: 20 } },
    tasks: { total: 9, claimed: 7, credit: 80, open: [
      task("连续 3 天使用 Skill", "auto", 1, 3, 50, 10),
      task("在桌面端发起对话", "manual", 0, 1, 30, 0, "需要在桌面端发起对话")
    ] },
    growth: { energy: 85, earned: 420, spent: 335, draws: 0, buddies: 3, rarity: { R: 2, SR: 1 }, current: ["芝麻"] },
    checkin: { outcome: "claimed", credit: 100, streak: 5, at: at(0, 0, 0) }
  },
  {
    id: "demo-3", name: "公司账号", enterprise: true, expires: now + 20 * D, errors: {},
    balance: { balance: 597.21, size: 2000, used: 1402.79, resets: at(2, 0), packages: [{ name: "企业月度额度", balance: 597.21, size: 2000, expires: at(2, 0), resets: true }] },
    usage: usage([210, 260, 190, 240, 305, 120, 77]),
    checkin: { outcome: "inactive" }
  }
];

const hhmm = t => `${String(new Date(t).getHours()).padStart(2, "0")}:${String(new Date(t).getMinutes()).padStart(2, "0")}`;
const slots = [["night", "01:00"], ["daily", "09:00"], ["tasks", "09:10"], ["daily", "21:00"], ["tasks", "21:10"], ["keepalive", "22:00"]].map(([kind, time]) => {
  const [h, m] = time.split(":").map(Number), due = at(0, h, m) <= now;
  return { kind, at: time, status: due ? "succeeded" : "upcoming", attempts: due ? 1 : 0 };
});
const job = (actions, minutes, last) => ({ id: `demo-${minutes}`, actions, status: "succeeded", trigger: "manual", created: new Date(now - minutes * 60_000).toISOString(), finished: new Date(now - minutes * 60_000 + 40_000).toISOString(), last });

writePage(join(process.argv[2], "data.js"), {
  generated: new Date(now).toISOString(), at: now - 4 * 60_000, refreshing: false, enabled: true,
  schedules: { daily: ["09:00", "21:00"], tasks: ["09:10", "21:10"], night: ["01:00"], keepalive: ["22:00"] },
  accounts, today: { timezone: "Asia/Shanghai", slots, next: slots.find(s => s.status === "upcoming") || null },
  jobs: [
    job(["tasks"], 95, "主力号：成长任务完成 2 项，领取 80 积分"),
    job(["travel"], 130, "备用号：芝麻出发去大理"),
    job(["activity", "travel", "bonus"], 140, "2 个账号已活跃；主力号：团子出发去敦煌"),
    job(["night"], 600, "主力号、备用号：夜猫子任务已上报")
  ]
});
console.log("demo board written,", hhmm(now));
