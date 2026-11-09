import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { defaults } from "../storage.mjs";

// Exercise the shipped page script with a small DOM fixture. This checks
// button/account selection and schedule editing without contacting a vendor.
test("panel runs selected accounts and saves deduplicated schedule times", async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.value = ""; this.dataset = {}; this.style = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    removeAttribute() {}
  }
  const nodes = new Map(), buttonNames = [...readFileSync(new URL("../public/index.html", import.meta.url), "utf8").matchAll(/data-action="([^"]+)"/g)].map(m => m[1]);
  const buttons = buttonNames.map(action => { const b = new Element("button"); b.dataset.action = action; return b; });
  for (const id of ["schedule-state", "toggle-schedule", "error", "accounts", "jobs", "updated", "config-form", "schedule-fields", "saved", "board", "board-state", "board-refresh", "board-login", "toggle-intl"]) nodes.set(id, new Element("div"));
  const form = nodes.get("config-form"); form.elements = {};
  for (const name of ["timezone", "proxy", "spread"]) form.elements[name] = new Element("input");
  nodes.get("schedule-fields").append = function (...labels) { for (const label of labels) { const input = label.children[0]; form.elements[input.name] = input; } this.children.push(...labels); };
  const calls = [], status = { config: structuredClone(defaults), accounts: [
    { id: "cn:a", name: "国内测试", realm: "cn", source: "magpie", enabled: true },
    { id: "cn:b", name: "国内测试二", realm: "cn", source: "magpie", enabled: true }
  ], jobs: [] };
  const board = { at: Date.now(), enabled: true, signin: { status: "waiting", started: new Date().toISOString(), url: "https://www.workbuddy.cn/login?state=s" }, today: { timezone: "Asia/Shanghai", next: { kind: "daily", at: "21:00", status: "upcoming" }, slots: [
    { kind: "daily", at: "09:00", status: "succeeded", attempts: 1 }, { kind: "tasks", at: "09:10", status: "failed", attempts: 2 }, { kind: "daily", at: "21:00", status: "upcoming", attempts: 0 }
  ] }, accounts: [{ id: "cn:a", name: "国内测试", expires: 0, errors: {}, balance: { balance: 120, size: 300, packages: [{ name: "活动赠送", balance: 120, size: 300, expires: Date.now() + 86400_000 }] },
    streak: { days: 8, makeupCards: 1, active: true, nextTier: { days: 14, remaining: 6, credit: 50, energy: 3 } },
    growth: { energy: 30, earned: 110, spent: 80, draws: 0, buddies: 2, rarity: { SR: 1, R: 1 }, current: ["团子"] },
    tasks: { total: 2, claimed: 1, credit: 100, open: [{ title: "关注公众号", state: "manual", note: "需要关注官方公众号", current: 0, target: 1, credit: 100, energy: 5, ends: 0 }] },
    travel: { state: "traveling", location: "咖啡馆", departAt: Date.now() - 3600_000, arriveAt: Date.now() + 3600_000 }, usage: { credit: 3, count: 2, days: [{ date: "2026-10-29", credit: 3, count: 2 }], models: [], charges: 14, free: 1, recent: [{ at: Date.now() - 1 * 60_000, credit: 0.37, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 2 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 3 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 4 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 5 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 6 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 7 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 8 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 9 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 10 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 11 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }, { at: Date.now() - 12 * 60_000, credit: 0.2, model: "glm-5.2", client: "WorkBuddy" }] },
    checkin: { outcome: "claimed", credit: 100, streak: 11, at: Date.now() },
    limits: [{ model: "kimi-k3-1", resets: Date.now() + 3600_000 }],
    ledger: { gained: 110, used: 3, sources: [["每日签到", 100], ["猫猫旅行", 10]], entries: [{ at: Date.now() - 60_000, credit: 10, name: "CodeBuddy个人版国内运营裂变包", left: 0, source: "猫猫旅行" }, { at: Date.now() - 3600_000, credit: 100, name: "CodeBuddy个人版国内运营裂变包", left: 100, ends: Date.now() + 20 * 86400_000, source: "每日签到" }] } },
    { id: "cn:e", name: "企业号", enterprise: true, expires: 0, errors: {}, checkin: { outcome: "inactive" }, limits: [{ model: "kimi-k3.1-pro", queued: { position: 907, size: 908, at: Date.now() - 60_000, until: Date.now() + 3600_000 } }] },
    { id: "intl:x", name: "海外号", realm: "intl", expires: 0, errors: {}, travel: { state: "none" }, streak: { days: 2, active: false, makeupCards: 0 }, tasks: { claimed: 0, total: 1, open: [{ code: "first_chat", title: "完成一次对话", state: "manual" }] }, growth: { energy: 0, buddies: 0, draws: 0, rarity: {} }, checkin: { outcome: "closed" },
      ledger: { gained: 30, used: 0, sources: [["每日活跃奖励", 30]], entries: [{ at: Date.now() - 1000, credit: 30, name: "Bonus Pack", left: 30, source: "每日活跃奖励" }] } }],
    models: { at: Date.now(),
      ent: { account: "企业号", plan: { name: "企业", paid: true }, models: [
        { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", desc: "", rate: 0.97, context: 256000, reasoning: { levels: ["low", "high", "max"], default: "high", off: false } },
        { id: "kimi-k2.5", name: "Kimi-K2.5", desc: "", rate: 0.45, context: 256000, reasoning: { levels: ["medium"], default: "medium", fixed: true, off: false } }] },
      cn: { account: "国内测试", plan: { name: "体验版", paid: false }, models: [
        { id: "auto", name: "Auto", desc: "自动选择", rate: null, context: 256000, isDefault: true },
        { id: "hy3", name: "Hy3", desc: "混元", rate: 0, context: 192000, promo: { label: "限时免费", note: "", hours: "", until: 0, rate: 0 } },
        { id: "glm-5.2", name: "GLM-5.2", desc: "长程", rate: 0.79, context: 1000000, reasoning: { levels: ["high", "xhigh"], default: "high", off: true }, promo: { label: "夜间折扣", note: "", hours: "23:00–07:50", until: 0, rate: 0.5 } },
        { id: "glm-5.3", name: "GLM-5.3", desc: "旗舰", rate: 0.69, context: 1000000, tier: { label: "订阅优先", note: "会员优先调度", exclusive: false } },
        { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", desc: "", rate: 0.11, context: 1000000, promo: { label: "夜间折扣", note: "非高峰期积分5折", hours: "非高峰", until: 0, rate: 0.06, approx: true } }] },
      intl: { account: "abroad", plan: { name: "Free", paid: false }, models: [
        { id: "deepseek-v4.1-flash-sg", name: "Deepseek-V4.1-Flash", desc: "", rate: 0.03, context: 1000000 },
        { id: "primary-model", name: "Primary", desc: "", rate: 3.31, context: 272000 },
        { id: "gpt-6-luna", name: "GPT-6-Luna", desc: "", rate: 0.07, context: 1000000, tier: { label: "Pro Only", note: "模型仅面向 Pro 用户开放。", exclusive: true } }] } } };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), querySelectorAll: () => buttons },
    fetch: async (path, init) => { calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined }); return { ok: true, json: async () => path === "/api/status" ? structuredClone(status) : path === "/api/board" ? structuredClone(board) : {} }; },
    setInterval() {}, console
  });
  context.globalThis = context;
  for (const file of ["../page/board.js", "../public/app.js"]) vm.runInContext(readFileSync(new URL(file, import.meta.url), "utf8"), context);
  await setImmediate();
  const text = node => typeof node === "string" ? node : [node.textContent || "", ...node.children.map(text)].join(" ");
  assert.match(text(nodes.get("board")), /^\s*正在等待 WorkBuddy 登录[\s\S]*https:\/\/www\.workbuddy\.cn\/login\?state=s/);
  // The list view: the account row and its expanded detail, then what needs a person.
  assert.match(text(nodes.get("board")), /国内测试 个人 · 连登 8 天 · 已签到 \+100[\s\S]*120 \/ 300[\s\S]*每日签到 已签到 \+100 \d\d:\d\d 由 Magpie 签到 · 连续签到 11 天[\s\S]*任务 1\/2[\s\S]*能量 30[\s\S]*关注公众号 需手动[\s\S]*在咖啡馆 约 \d\d:\d\d 归来[\s\S]*模型额度用完 1 个[\s\S]*需要你处理 1 件\s+120 积分（活动赠送）将作废[\s\S]*其他提醒 1 件 [\s\S]*「关注公众号」需手动完成 \+100 积分/);
  // 模型限额: a spent model in the detail, and among what needs a person.
  assert.match(text(nodes.get("board")), /kimi-k3-1 额度已用完 (今天|明天) \d\d:\d\d 恢复[\s\S]*kimi-k3.1-pro 排队中 第 907 位 · 预计 (今天|明天) \d\d:\d\d/);
  // A model short of capacity queues an enterprise account too: same yellow box, after the spent ones.
  assert.match(text(nodes.get("board")), /模型额度用完 1 个 · 排队中 1 个\s+kimi-k3-1 额度已用完（国内测试） (今天|明天) \d\d:\d\d 恢复\s+kimi-k3.1-pro 排队中（企业号） 预计 (今天|明天) \d\d:\d\d 排到/);
  // 积分流水: the week's totals, then each change, a gain named by what ran.
  assert.match(text(nodes.get("board")), /积分流水 · 近 7 天 获得 \+110 · 用掉 3[\s\S]*每日签到 \+100 · 猫猫旅行 \+10[\s\S]*\+10 猫猫旅行 已用完[\s\S]*\+100 每日签到 余 100 · \d\d\/\d\d 作废/);
  // 扣分明细: each charged request with two decimals, ten shown, the rest folded.
  assert.match(text(nodes.get("board")), /扣分明细 · 近 7 天 14 次扣分 · 另有 1 次免费[\s\S]*−0.37 glm-5.2 WorkBuddy[\s\S]*再显示 2 条[\s\S]*只保留最近 12 条/);
  // It sits in the right column under the cat trip, beside the credit history on the left.
  const find = (node, cls) => typeof node === "string" ? undefined : node.className === cls ? node : node.children.map(c => find(c, cls)).find(Boolean);
  assert.match(text(find(nodes.get("board"), "wb-col-r")), /猫猫旅行[\s\S]*扣分明细 · 近 7 天/);
  assert.doesNotMatch(text(find(nodes.get("board"), "wb-col-l")), /扣分明细/);
  const button = (node, label) => typeof node === "string" ? undefined : node.textContent === label && node.onclick ? node : node.children.map(c => button(c, label)).find(Boolean);
  // 成长 starts folded. WorkBuddy AI has no Buddy travel, so its detail shows none.
  const all = (node, cls) => typeof node === "string" ? [] : [...(node.className === cls ? [node] : []), ...node.children.flatMap(c => all(c, cls))];
  // Only the spent model is yellow; what can wait is a plain list, folded.
  const notes = all(nodes.get("board"), "wb-fold wb-notes");
  assert.equal(notes.length, 1);
  assert.ok(!notes[0].open);
  assert.ok(all(notes[0], "wb-line wb-alert plain").length === 1, "WorkBuddy AI client-only tasks are not reminders");
  assert.equal(all(nodes.get("board"), "wb-alerts ").length, 1, "one yellow box, the model limits");
  assert.ok(all(nodes.get("board"), "wb-fold").length >= 2 && all(nodes.get("board"), "wb-fold").every(f => !f.open));
  const intlDetail = all(nodes.get("board"), "wb-detail-grid").find(g => /每日活跃奖励/.test(text(g)));
  assert.ok(intlDetail);
  assert.doesNotMatch(text(intlDetail), /猫猫旅行/);
  // No campaign, no check-in block; the daily reward instead; its client-only tasks aren't listed.
  assert.match(text(intlDetail), /每日活跃奖励 今日已领 \+30 \d\d:\d\d 到账，来自完成的网页会话[\s\S]*成长 连登 2 天/);
  assert.doesNotMatch(text(intlDetail), /暂无签到活动|每日签到|完成一次对话/);
  assert.doesNotMatch(text(nodes.get("board")), /「完成一次对话」/);
  button(nodes.get("board"), "圆环").onclick();
  // Two rings for WorkBuddy AI: active and tasks.
  assert.match(text(nodes.get("board")), /海外号[^海]*今日完成 1\/2/);
  assert.match(text(nodes.get("board")), /全部[\s\S]*国内测试 120 积分 今日完成 2\/3/);
  button(nodes.get("board"), "国内测试").onclick();
  assert.match(text(nodes.get("board")), /今日活跃 连登 8 天[\s\S]*在咖啡馆[\s\S]*每日签到 已签到 \+100[\s\S]*待处理 关注公众号 · \+100 积分/);
  button(nodes.get("board"), "小组件").onclick();
  assert.match(text(nodes.get("board")), /即将作废 明天 120 积分[\s\S]*今日 0\/2 完成[\s\S]*签到 1\/1[\s\S]*猫猫 1 只在咖啡馆\s+国内测试 · 约 \d\d:\d\d 归来\s+能量 30[\s\S]*成长任务 1\/2[\s\S]*关注公众号 需手动\s+连登 8 天/);
  button(nodes.get("board"), "模型").onclick();
  assert.match(text(nodes.get("board")), /国内版 5[\s\S]*国际版 3[\s\S]*你现在能用 全部 5 个 不开会员也能用；1 个高峰时会员优先[\s\S]*正在优惠 3 个模型 限时免费 1 · 夜间折扣 2[\s\S]*最省积分 Hy3 免费 其次 DeepSeek-V4.1-Flash ×0.11[\s\S]*全部用户可用模型：5[\s\S]*Auto 默认[\s\S]*auto[\s\S]*256K\s+随任务浮动[\s\S]*GLM-5.2 夜间折扣[\s\S]*×0.79 23:00–07:50 ×0.50[\s\S]*GLM-5.3 订阅优先[\s\S]*DeepSeek-V4.1-Flash 夜间折扣[\s\S]*×0.11\s+非高峰 约 ×0.06/);
  // Native reasoning levels: the default in bold, 「可关」 when thinking can be off, 「—」 when none listed.
  assert.match(text(nodes.get("board")), /推理档位[\s\S]*auto\s+—\s+256K[\s\S]*glm-5.2\s+high\s+xhigh\s+可关/);
  // An enterprise login adds its own list, first.
  assert.match(text(nodes.get("board")), /企业 2\s+国内版 5\s+国际版 3/);
  button(nodes.get("board"), "企业 2").onclick();
  assert.match(text(nodes.get("board")), /企业账号 企业号 模型由企业配置决定[\s\S]*企业账号读到的列表[\s\S]*Kimi-K3.1-Pro[\s\S]*low\s+high\s+max[\s\S]*Kimi-K2.5[\s\S]*medium\s+固定/);
  button(nodes.get("board"), "国际版 3").onclick();
  // Pro-only models sit apart from what a Free plan can use, and a costly rate stands out.
  assert.match(text(nodes.get("board")), /你现在能用 2 个模型 共 3 个，另外 1 个是 Pro-only[\s\S]*国际版账号 Free 计划 abroad · 升级 Pro 才能用全部[\s\S]*最省积分 Deepseek-V4.1-Flash ×0.03[\s\S]*Free 用户可用模型：2[\s\S]*Primary[\s\S]*×3.31[\s\S]*Pro-only 模型：1[\s\S]*GPT-6-Luna Pro/);
  button(nodes.get("board"), "列表").onclick();
  // The enterprise login has no daily credits: no check-in shown, nothing to flag.
  assert.doesNotMatch(text(nodes.get("board")), /企业号：|没签上/);
  assert.match(text(nodes.get("board")), /今日定时 · 每天 3 次 下一次 21:00 活跃 · 旅行 · 福利[\s\S]*09:00 完成[\s\S]*09:10 失败 2\/3 成长任务[\s\S]*21:00 下一次[\s\S]*模型额度用完/);
  assert.equal(nodes.get("accounts").children.length, 2);
  const checkbox = nodes.get("accounts").children[1].children[0]; checkbox.checked = true; checkbox.onchange();
  await buttons.find(b => b.dataset.action === "activity").onclick();
  assert.deepEqual(calls.find(c => c.path === "/api/run").body, { action: "activity", accounts: ["cn:b"] });
  form.elements["schedule-daily"].value = "21:00, 09:00, 09:00";
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.deepEqual(calls.find(c => c.path === "/api/config").body.schedules.daily, ["09:00", "21:00"]);
});
