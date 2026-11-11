// Writes a board snapshot with made-up accounts, for the README screenshots.
// docs/screenshots.sh runs it and photographs the page; by hand:
//   bun docs/demo-data.mjs <folder with the page's files> [15:00]
// The optional time sets the board's clock to that time today; the page must
// then be shown at the same time for travel and expiry to read right.
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
    models: [["kimi-k3.1-pro", .55], ["deepseek-v4.1-flash", .25], ["glm-5.3", .12], ["hy3", .08]].map(([model, k]) => ({ model, credit: Math.round(total * k * 100) / 100, count: Math.round(total * k / 3) })),
    charges: 48, free: 6, recent: [[18, 2.41, "kimi-k3.1-pro"], [41, 0.37, "deepseek-v4.1-flash"], [66, 1.92, "kimi-k3.1-pro"], [130, 0.08, "glm-5.3-flash"], [190, 0.52, "glm-5.3"]].map(([m, credit, model]) => ({ at: now - m * 60_000, credit, model, client: "WorkBuddy" })) };
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
    checkin: { outcome: "claimed", credit: 100, streak: 12, at: at(0, 0, 0) },
    // Its own 24-hour allowance on one model spent, back late tonight.
    limits: [{ model: "kimi-k3-1", resets: at(0, 23, 40) }],
    ledger: { gained: 430, used: 788, sources: [["每日签到", 300], ["成长任务", 100], ["猫猫旅行", 30]], entries: [
      { at: at(0, 0, 0), credit: 100, name: "每日签到奖励", left: 100, ends: at(30, 23, 59), source: "每日签到" },
      { at: at(-1, 12, 40), credit: 30, name: "猫猫旅行奖励", left: 30, ends: at(29, 23, 59), source: "猫猫旅行" },
      { at: at(-1, 9, 10), credit: 100, name: "成长任务奖励", left: 77, ends: at(8, 23, 59), source: "成长任务" }
    ] }
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
    checkin: { outcome: "inactive" },
    // Short of capacity, a model queues enterprise accounts too.
    limits: [{ model: "kimi-k3.1-pro", queued: { position: 257, size: "999+", at: now - 8 * 60_000, until: now + 52 * 60_000 } }]
  },
  {
    id: "intl:demo-4", name: "海外号", realm: "intl", enterprise: false, expires: now + 300 * D, errors: {},
    balance: { balance: 530, size: 800, packages: [
      { name: "Bonus Pack", balance: 30, size: 30, expires: at(30, 23, 59) },
      { name: "Free plan credits", balance: 500, size: 770, expires: at(18, 23, 59) }
    ] },
    usage: usage([6, 0, 3, 1, 4, 2, 1]),
    streak: { days: 9, makeupCards: 0, active: true },
    tasks: { total: 5, claimed: 1, credit: 0, open: [] },
    growth: { energy: 40, earned: 60, spent: 20, draws: 0, buddies: 0, rarity: {} },
    checkin: { outcome: "closed" },
    ledger: { gained: 30, used: 12, sources: [["每日活跃奖励", 30]], entries: [{ at: at(0, 10, 41), credit: 30, name: "Bonus Pack", left: 30, ends: at(30, 23, 59), source: "每日活跃奖励" }] }
  }
];

// Both builds' model lists as their configs read on 2026-11-02 (public
// catalog data); only the account names are made up.
// Native reasoning levels as the configs list them: [levels, default, can be off].
const levels = {
  auto: [["high"]], "default-model": null, "hy4-preview": [["high"]], "mimo-v2.6-pro": [["high"]], "kimi-k3": [["medium"]], "kimi-k2.5": [["medium"]],
  hy3: [["low", "high"], "high"], "hy3-x": [["low", "high"], "high"], "glm-5.2": [["high", "xhigh"], "high", true],
  "kimi-k3-1": [["low", "high", "xhigh"], "high", true], "kimi-k2.8-preview": [["low", "high", "max"], "high", true],
  "deepseek-v4-pro": [["high", "xhigh"], "high", true], "deepseek-v4.1-flash": [["low", "high", "max"], "high", true],
  "step-5-preview": [["low", "medium", "high"], "high"], "gemini-3.8-flash": [["low", "medium", "high"], "medium"],
  "space-bunny": [["low", "medium", "high", "xhigh", "max"], "max"], "minimax-m3.1-flash": [["low", "medium", "high", "xhigh", "max"], "max"],
  "gpt-6-astra": [["low", "medium", "high", "xhigh", "max"], "high", true], "gpt-5.6-sol": [["low", "medium", "high", "xhigh", "max"], "high", true],
  "gpt-5.6-terra": [["low", "medium", "high", "xhigh", "max"], "high", true], "gpt-5.6-luna": [["low", "medium", "high", "xhigh", "max"], "high", true],
  "gpt-6.1-sol": [["low", "medium", "high", "xhigh"], "high"], "gpt-6-sol": [["low", "medium", "high", "xhigh"], "high"],
  "gpt-6-luna": [["low", "medium", "high", "xhigh"], "high"], "grok-4.7": [["low", "medium", "high", "xhigh"], "high"]
};
const reasoningOf = id => {
  const l = id in levels ? levels[id] : [["low", "high", "max"], "high"];
  if (!l) return null;
  return l[0].length === 1 ? { levels: l[0], default: l[0][0], fixed: true, off: false } : { levels: l[0], default: l[1], off: !!l[2] };
};
const model = ([id, name, rate, context, desc, extra = {}]) => ({ id, name, desc, rate, context, isDefault: !!extra.def, reasoning: reasoningOf(id), ...extra.tier ? { tier: extra.tier } : {}, ...extra.promo ? { promo: extra.promo } : {} });
const proOnly = { label: "Pro Only", note: "模型仅面向 Pro 用户开放。", exclusive: true };
const queued = { label: "订阅优先", note: "资源紧张，旗舰版及高级版会员享优先调度。", exclusive: false };
const models = {
  at: now - 4 * 60_000,
  cn: { account: "主力号", plan: { name: "体验版", paid: false }, models: [
    ["auto", "Auto", null, 256000, "平衡效果与速度。自动为每个任务匹配最优模型，积分倍率随之浮动", { def: true }],
    ["hy4-preview", "Hy4 preview", 0.29, 960000, "混元思考模型，具有增强的推理能力"],
    ["hy3", "Hy3", 0, 192000, "混元思考模型，具有增强的推理能力", { promo: { label: "限时免费", note: "7月6日–11月15日，每日赠送免费额度。", hours: "", until: at(13, 0), rate: 0 } }],
    ["hy3-x", "Hy3 (X)", 0.05, 192000, "混元思考模型，具有增强的推理能力"],
    ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", 0.11, 1000000, "已更新至 V4.1-Flash-1017 最新版，支持 1M 上下文窗口，原生多模态", { promo: { label: "夜间折扣", note: "周一至周五 09:00–12:00、14:00–18:00 属高峰原价，非高峰期积分5折", hours: "", until: 0 } }],
    ["glm-5.3", "GLM-5.3", 0.69, 1000000, "旗舰模型，擅长复杂软件工程与长程 Agent 任务", { tier: queued }],
    ["glm-5.3-flash", "GLM-5.3-Flash", 0.08, 1000000, "原生多模态模型，擅长视觉理解与专业任务", { tier: queued }],
    ["glm-5.2", "GLM-5.2", 0.79, 1000000, "1M 上下文，擅长长程任务", { promo: { label: "夜间折扣", note: "每晚 23:00—次日 8:00 积分限时立减，错峰用更省", hours: "23:00–07:50", until: 0, rate: 0.5 } }],
    ["space-bunny", "Space-Bunny", 0.08, 1000000, "推理速度极快，编码能力强劲，并支持原生多模态输入的匿名大模型"],
    ["minimax-m3.1-flash", "MiniMax-M3.1-Flash", 0.08, 1000000, "原生多模态，擅长 office、agentic、编程任务，推理速度优异"],
    ["kimi-k3.1-pro", "Kimi-K3.1-Pro", 0.97, 1000000, "Kimi 全新旗舰模型，3万亿级参数。办公、代码、3D 创作与长程 Agent 能力全面升级"],
    ["kimi-k3-1", "Kimi-K3", 1.62, 1000000, "擅长处理复杂的长程自主任务，前端开发能力突出"],
    ["kimi-k2.8-preview", "Kimi-K2.8-Preview", 0.77, 1000000, "擅长处理复杂的长程自主任务，前端开发能力突出", { tier: queued }],
    ["deepseek-v4-pro", "DeepSeek-V4-Pro", 0.51, 1000000, "DeepSeek 旗舰模型，支持 1M 上下文窗口", { promo: { label: "夜间折扣", note: "周一至周五 09:00–12:00、14:00–18:00 属高峰原价，非高峰期积分5折", hours: "", until: 0 } }],
    ["step-5-preview", "Step-5-Preview", 0.33, 1000000, "阶跃 StepFun 面向真实任务的新一代旗舰基模"],
    ["mimo-v2.6-pro", "Xiaomi MiMo-V2.6-Pro", 0.13, 1000000, "旗舰推理模型，面向专业、长程、复杂工作流"]
  ].map(model) },
  ent: { account: "公司账号", plan: { name: "企业", paid: true }, models: [
    ["auto", "Auto", null, 256000, "平衡效果与速度。自动为每个任务匹配最优模型，积分倍率随之浮动", { def: true }],
    ["hy3", "Hy3", 0, 192000, "混元思考模型，具有增强的推理能力"],
    ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", 0.11, 1000000, "支持 1M 上下文窗口，原生多模态"],
    ["glm-5.3-flash", "GLM-5.3-Flash", 0.08, 1000000, "原生多模态模型，擅长视觉理解与专业任务"],
    ["glm-5.3-flashx", "GLM-5.3-FlashX", 0.19, 1000000, "原生多模态模型，擅长视觉理解与专业任务"],
    ["kimi-k2.5", "Kimi-K2.5", 0.45, 256000, "擅长处理复杂的长程自主任务"],
    ["kimi-k3.1-pro", "Kimi-K3.1-Pro", 0.97, 1000000, "Kimi 全新旗舰模型，3万亿级参数"],
    ["kimi-k3.1-pro-highspeed", "Kimi-K3.1-Pro-Highspeed", 1.56, 1000000, "K3.1 Pro 高速版本"],
    ["minimax-m3.1-flash", "MiniMax-M3.1-Flash", 0.08, 1000000, "原生多模态，擅长 office、agentic、编程任务"],
    ["mimo-v2.6-pro", "Xiaomi MiMo-V2.6-Pro", 0.13, 1000000, "旗舰推理模型，面向专业、长程、复杂工作流"]
  ].map(model) },
  intl: { account: "海外号", plan: { name: "Free", paid: false }, models: [
    ["default-model", "Auto", null, 176000, "优秀的编码模型，适合日常使用", { def: true }],
    ["hy4-preview", "Hy4 Preview", 0.29, 1000000, "混元思考模型，具有增强的推理能力"],
    ["hy3", "Hy3", 0, 192000, "混元思考模型，具有增强的推理能力"],
    ["deepseek-v4.1-flash-sg", "Deepseek-V4.1-Flash", 0.03, 1000000, "DeepSeek 旗舰模型，支持 1M 上下文窗口，原生多模态"],
    ["gpt-6-astra", "GPT-6-Astra", 6.67, 1000000, "OpenAI 旗舰模型，擅长复杂推理与长程任务", { tier: proOnly }],
    ["gpt-6.1-sol", "GPT-6.1-Sol", 1.33, 1000000, "专为复杂编码和智能体工作流构建的模型", { tier: proOnly }],
    ["gpt-6-sol", "GPT-6-Sol", 1.33, 1000000, "专为复杂编码和智能体工作流构建的模型", { tier: proOnly }],
    ["gpt-6-luna", "GPT-6-Luna", 0.07, 1000000, "专为单一聚焦、高吞吐量任务打造的高效模型", { tier: proOnly }],
    ["gpt-5.6-sol", "GPT-5.6-Sol", 3.47, 1000000, "OpenAI 旗舰模型，擅长复杂推理与长程任务", { tier: proOnly }],
    ["gpt-5.6-terra", "GPT-5.6-Terra", 1.39, 1000000, "OpenAI 均衡模型，兼顾能力、速度与成本", { tier: proOnly }],
    ["gpt-5.6-luna", "GPT-5.6-Luna", 0.14, 1000000, "OpenAI 轻量模型，响应快速，适合日常任务", { tier: proOnly }],
    ["grok-4.7", "Grok-4.7", 1.9, 500000, "SpaceXAI 打造的前沿模型，专为编程、智能体任务及知识型工作而设计", { tier: proOnly }],
    ["gemini-3.8-flash", "Gemini-3.8-Flash", 0.95, 1000000, "能力均衡，适合日常使用", { tier: proOnly }],
    ["glm-5.3", "GLM-5.3", 0.69, 1000000, "能力均衡，适合日常使用"],
    ["glm-5.3-flash", "GLM-5.3-Flash", 0.08, 1000000, "原生多模态模型，擅长视觉理解与专业任务"],
    ["kimi-k3.1-pro", "Kimi-K3.1-Pro", 0.97, 1000000, "Kimi 全新旗舰模型，3万亿级参数", { tier: proOnly }],
    ["kimi-k3.1-pro-highspeed", "Kimi-K3.1-Pro-Highspeed", 1.56, 1000000, "K3.1 Pro 高速版本，响应速度提升至 K3.1 Pro 的 2–3 倍", { tier: proOnly }],
    ["kimi-k3", "Kimi-K3", 1.62, 1000000, "擅长处理复杂的长程自主任务，前端开发能力突出"],
    ["minimax-m3.1-flash", "MiniMax-M3.1-Flash", 0.08, 1000000, "原生多模态，擅长 office、agentic、编程任务，推理速度优异"]
  ].map(model) }
};

const hhmm = t => `${String(new Date(t).getHours()).padStart(2, "0")}:${String(new Date(t).getMinutes()).padStart(2, "0")}`;
const slots = [["night", "01:00"], ["daily", "09:00"], ["tasks", "09:10"], ["daily", "21:00"], ["tasks", "21:10"], ["keepalive", "22:00"],
  ["intl-daily", "09:00"], ["intl-web", "10:30"], ["intl-daily", "21:00"], ["intl-keepalive", "22:00"]].map(([kind, time]) => {
  const [h, m] = time.split(":").map(Number), due = at(0, h, m) <= now;
  return { kind, at: time, status: due ? "succeeded" : "upcoming", attempts: due ? 1 : 0 };
});
const job = (actions, minutes, last) => ({ id: `demo-${minutes}`, actions, status: "succeeded", trigger: "manual", created: new Date(now - minutes * 60_000).toISOString(), finished: new Date(now - minutes * 60_000 + 40_000).toISOString(), last });

writePage(join(process.argv[2], "data.js"), {
  generated: new Date(now).toISOString(), at: now - 4 * 60_000, refreshing: false, enabled: true, intlEnabled: true,
  schedules: { daily: ["09:00", "21:00"], tasks: ["09:10", "21:10"], night: ["01:00"], keepalive: ["22:00"] },
  intlSchedules: { daily: ["09:00", "21:00"], web: ["10:30"], keepalive: ["22:00"] },
  intl: { enabled: true, web: true, accounts: 1 },
  settings: { timezone: "Asia/Shanghai", spread: 0, proxy: "", intlWebModel: "auto" },
  accounts, models, today: { timezone: "Asia/Shanghai", slots, next: slots.find(s => s.status === "upcoming") || null },
  jobs: [
    job(["web"], 70, "海外号：国际版网页会话已跑完（hy3，当前免费，11 秒），每日活跃奖励通常次日凌晨到账"),
    job(["tasks"], 95, "主力号：成长任务完成 2 项，领取 80 积分"),
    job(["travel"], 130, "备用号：芝麻出发去大理"),
    job(["activity", "travel", "bonus"], 140, "2 个账号已活跃；主力号：团子出发去敦煌"),
    job(["night"], 600, "主力号、备用号：夜猫子任务已上报")
  ]
});
console.log("demo board written,", hhmm(now));
