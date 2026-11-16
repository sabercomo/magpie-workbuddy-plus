import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { defaults } from "../storage.mjs";

// Exercise the shipped page script with a small DOM fixture. This checks
// button/account selection, two-level navigation, board views, task center,
// models catalog, and schedule editing without contacting a vendor.
test("panel runs selected accounts and saves deduplicated schedule times", async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.value = ""; this.dataset = {}; this.style = {}; this.classList = { toggle() {}, add() {}, remove() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(k, v) { (this.attributes ||= {})[k] = v; }
    getAttribute(k) { return this.attributes?.[k] ?? null; }
    removeAttribute() {}
    get lastChild() { return this.children.at(-1); }
  }
  const nodes = new Map(), buttonNames = [...readFileSync(new URL("../public/index.html", import.meta.url), "utf8").matchAll(/data-action="([^"]+)"/g)].map(m => m[1]);
  const buttons = buttonNames.map(action => { const b = new Element("button"); b.dataset.action = action; return b; });
  for (const id of ["error", "accounts", "jobs", "updated", "config-form", "schedule-fields", "intl-schedule-fields", "intl-fields", "cn-state", "intl-state", "saved", "board", "board-state", "board-refresh", "add-menu", "open-settings", "close-settings", "settings", "sched-pill", "run-scope-note"]) nodes.set(id, new Element("div"));
  nodes.get("add-menu").contains = () => false;
  const form = nodes.get("config-form"); form.elements = {};
  for (const name of ["timezone", "proxy", "spread", "intlWeb", "skillShare"]) form.elements[name] = new Element("input");
  for (const id of ["schedule-fields", "intl-schedule-fields"]) nodes.get(id).append = function (...labels) { for (const label of labels) { const input = label.children[0]; form.elements[input.name] = input; } this.children.push(...labels); };
  const calls = [], status = { config: structuredClone(defaults), intlSchedules: structuredClone(defaults.intlSchedules), intlModels: ["hy3", "kimi-k3"], accounts: [
    { id: "cn:a", name: "国内测试", realm: "cn", source: "magpie", enabled: true },
    { id: "intl:c", name: "国际测试", realm: "intl", source: "magpie", enabled: true },
    { id: "cn:b", name: "国内测试二", realm: "cn", source: "magpie", enabled: true }
  ], jobs: [{
    id: "partial-job",
    actions: ["tasks"],
    accounts: ["cn:a"],
    status: "partial",
    counts: { succeeded: 3, failed: 1, limited: 0, total: 4 },
    created: "2026-11-15T08:15:00.000Z",
    finished: "2026-11-15T08:17:30.973Z",
    results: [],
    logs: [{ at: "2026-11-15T08:17:26.369Z", account: "cn:a", message: "桌面端对话1次：已领奖，100 积分 / 5 能量" }]
  }] };
  const board = { at: Date.now(), enabled: true, intlEnabled: false, networkPaused: { until: Date.now() + 600_000, at: new Date().toISOString(), message: "ECONNRESET: The socket connection was closed unexpectedly." }, signin: { status: "waiting", started: new Date().toISOString(), url: "https://www.workbuddy.cn/login?state=s" }, today: { timezone: "Asia/Shanghai", next: { kind: "daily", at: "21:00", status: "upcoming" }, slots: [
    { kind: "daily", at: "09:00", status: "succeeded", attempts: 1 }, { kind: "tasks", at: "09:10", status: "failed", attempts: 2 }, { kind: "daily", at: "21:00", status: "upcoming", attempts: 0 }, { kind: "intl-web", at: "10:30", status: "upcoming", attempts: 0, paused: true }
  ] }, accounts: [{ id: "cn:a", name: "国内测试", expires: 0, errors: {}, balance: { balance: 120, size: 300, packages: [{ name: "活动赠送", balance: 120, size: 300, expires: Date.now() + 86400_000 }] },
    streak: { days: 8, makeupCards: 1, active: true, nextTier: { days: 14, remaining: 6, credit: 50, energy: 3 } },
    growth: { energy: 30, earned: 110, spent: 80, draws: 0, buddies: 2, rarity: { SR: 1, R: 1 }, current: ["团子"] },
    tasks: { total: 3, claimed: 1, credit: 200, open: [{ code: "chat_5", title: "聊天 5 次", state: "auto", current: 0, target: 1, credit: 100, energy: 0, ends: 0 }, { title: "关注公众号", state: "manual", note: "需要关注官方公众号", current: 0, target: 1, credit: 100, energy: 5, ends: 0 }] },
    campaigns: [{ code: "campaign_starbucks_2026", label: "星巴克协作", tasks: [
      { code: "ai_chat", label: "与 AI 对话 3 次", progress: 3, target: 3, credit: 100, done: true, claimed: true, manual: false },
      { code: "app", label: "解锁 App 强大能力", progress: 1, target: 1, credit: 100, done: true, claimed: true, manual: false },
      { code: "invite", label: "邀请好友", progress: 0, target: 1, credit: 0, done: false, claimed: false, manual: true }
    ] }],
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
  const bodyEl = new Element("body");
  const context = vm.createContext({
    document: { body: bodyEl, getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), querySelectorAll: selector => selector === "[data-action]" ? buttons : [], querySelector: () => null, addEventListener() {} },
    fetch: async (path, init) => { calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined }); return { ok: true, json: async () => path === "/api/status" ? structuredClone(status) : path === "/api/board" ? structuredClone(board) : {} }; },
    setInterval() {}, console
  });
  context.globalThis = context;
  for (const file of ["../page/board.js", "../public/app.js"]) vm.runInContext(readFileSync(new URL(file, import.meta.url), "utf8"), context);
  await setImmediate();
  const text = node => typeof node === "string" ? node : [node.textContent || "", ...node.children.map(text)].join(" ");
  const findNode = (node, predicate) => {
    if (typeof node === "string") return;
    if (predicate(node)) return node;
    for (const child of node.children || []) { const hit = findNode(child, predicate); if (hit) return hit; }
  };
  const all = (node, cls) => typeof node === "string" ? [] : [...(node.className === cls ? [node] : []), ...node.children.flatMap(c => all(c, cls))];
  const button = (node, label) => typeof node === "string" ? undefined : node.onclick && text(node).trim() === label ? node : node.children.map(c => button(c, label)).find(Boolean);

  const jobRows = nodes.get("jobs").children;
  assert.equal(jobRows.length, 1);
  assert.equal(jobRows[0].open, false, "completed jobs start folded");
  assert.match(text(jobRows[0]), /部分失败\s+成长任务 · 1 个账号 · 成功 3 \/ 失败 1[\s\S]*桌面端对话1次：已领奖/);
  assert.match(text(nodes.get("board")), /^\s*正在等待国内版 WorkBuddy 登录[\s\S]*https:\/\/www\.workbuddy\.cn\/login\?state=s/);

  // Primary navigation tabs separate functional modules from board view modes.
  const navTabs = [];
  (function walk(n) { if (typeof n === "string") return; if (n.dataset?.tab) navTabs.push(n.dataset.tab); (n.children || []).forEach(walk); })(nodes.get("board"));
  assert.deepEqual(navTabs, ["board", "tasks", "schedule", "models"]);
  assert.equal(bodyEl.dataset.wbTab, "board");

  // The alert footer follows the board content and expands into a flat list.
  const alertToggle = findNode(nodes.get("board"), n => n.className === "wb-alert-toggle");
  assert.ok(alertToggle);
  assert.ok(text(nodes.get("board")).indexOf("国内测试 个人 · 连登 8 天") < text(nodes.get("board")).indexOf("模型额度用完 1 个"));
  alertToggle.onclick();
  const rendered = text(nodes.get("board")), alerts = rendered.slice(rendered.indexOf("模型额度用完 1 个"));
  assert.match(alerts, /模型额度用完 1 个[\s\S]*需要你处理[\s\S]*网络\/代理连续失败，自动任务暂停至 \d\d\/\d\d \d\d:\d\d[\s\S]*120 积分（活动赠送）将作废[\s\S]*其他提醒 1 件[\s\S]*「关注公众号」需手动完成 \+100 积分/);
  assert.doesNotMatch(alerts, /星巴克协作：邀请好友/);

  // Tasks center aggregates open tasks, cat travel, and campaign items, and supports single-task execution.
  findNode(nodes.get("board"), n => n.dataset?.tab === "tasks").onclick();
  assert.equal(bodyEl.dataset.wbTab, "tasks");
  assert.match(text(nodes.get("board")), /1 项可以自动做[\s\S]*2 项待办 · 1 项需手动 · 合计 \+100 积分[\s\S]*聊天 5 次\s+0\/1 · \+100 积分 定时会完成 执行[\s\S]*关注公众号\s+0\/1 · \+100 积分 · \+5 能量 · 需要关注官方公众号 需手动 官方客户端[\s\S]*猫猫旅行快捷处理[\s\S]*运营活动任务/);
  await findNode(nodes.get("board"), n => n.textContent?.startsWith("执行全部待办") && n.className === "wb-task-run-all").onclick();
  assert.ok(calls.some(call => call.path === "/api/run" && JSON.stringify(call.body) === JSON.stringify({ actions: ["tasks"], accounts: ["cn:a"] })));
  calls.length = 0;
  await findNode(nodes.get("board"), n => n.textContent === "执行" && n.className === "wb-task-run").onclick();
  assert.ok(calls.some(call => call.path === "/api/run" && JSON.stringify(call.body) === JSON.stringify({ actions: ["task"], accounts: ["cn:a"], task: "chat_5" })));
  calls.length = 0;

  // Tasks filters and grouping switch cleanly
  button(nodes.get("board"), "按状态分组").onclick();
  assert.match(text(nodes.get("board")), /定时会完成 \(1\)[\s\S]*需手动 \(1\)/);
  button(nodes.get("board"), "按账号分组").onclick();
  button(nodes.get("board"), "可自动 1").onclick();
  assert.match(text(nodes.get("board")), /聊天 5 次/);
  assert.doesNotMatch(text(nodes.get("board")), /关注公众号 需手动/);
  button(nodes.get("board"), "全部 2").onclick();

  // Back to Board: list view preserves original expanded account detail unchanged.
  findNode(nodes.get("board"), n => n.dataset?.tab === "board").onclick();
  assert.match(text(nodes.get("board")), /kimi-k3-1 额度已用完 (今天|明天) \d\d:\d\d 恢复[\s\S]*kimi-k3.1-pro 排队中 第 907 位 · 预计 (今天|明天) \d\d:\d\d/);
  assert.match(text(nodes.get("board")), /模型额度用完 1 个 · 排队中 1 个\s+kimi-k3-1 额度已用完（国内测试） (今天|明天) \d\d:\d\d 恢复\s+kimi-k3.1-pro 排队中（企业号） 预计 (今天|明天) \d\d:\d\d 排到/);
  assert.match(text(nodes.get("board")), /积分流水 · 近 7 天 获得 \+110 · 用掉 3[\s\S]*每日签到 \+100 · 猫猫旅行 \+10[\s\S]*\+10 猫猫旅行 已用完[\s\S]*\+100 每日签到 余 100 · \d\d\/\d\d 作废/);
  assert.match(text(nodes.get("board")), /扣分明细 · 近 7 天 14 次扣分 · 另有 1 次免费[\s\S]*−0.37 glm-5.2 WorkBuddy[\s\S]*再显示 2 条[\s\S]*只保留最近 12 条/);
  const find = (node, cls) => typeof node === "string" ? undefined : node.className === cls ? node : node.children.map(c => find(c, cls)).find(Boolean);
  assert.match(text(find(nodes.get("board"), "wb-col-r")), /猫猫旅行[\s\S]*扣分明细 · 近 7 天/);
  assert.doesNotMatch(text(find(nodes.get("board"), "wb-col-l")), /扣分明细/);
  assert.deepEqual([...new Set(all(nodes.get("board"), "wb-row").map(r => r.attributes?.["aria-expanded"]).filter(Boolean))], ["false"]);
  const notes = all(nodes.get("board"), "wb-alert-more");
  assert.equal(notes.length, 1);
  assert.ok(!notes[0].open);
  assert.equal(all(notes[0], "wb-alert-row plain").length, 1);
  assert.ok(findNode(nodes.get("board"), n => n.className?.startsWith("wb-alert-footer")));
  assert.ok(all(nodes.get("board"), "wb-fold").length >= 2 && all(nodes.get("board"), "wb-fold").every(f => !f.open));
  const intlDetail = all(nodes.get("board"), "wb-detail-grid").find(g => /每日活跃奖励/.test(text(g)));
  assert.ok(intlDetail);
  assert.doesNotMatch(text(intlDetail), /猫猫旅行/);
  assert.match(text(intlDetail), /每日活跃奖励 今日到账 \+30 \d\d:\d\d 到账；奖励在活跃后的次日凌晨发放[\s\S]*成长 连登 2 天/);
  assert.doesNotMatch(text(intlDetail), /暂无签到活动|每日签到|完成一次对话/);
  assert.doesNotMatch(text(nodes.get("board")), /「完成一次对话」/);

  const heads = all(nodes.get("board"), "wb-group-head").map(h => text(h).replace(/\s+/g, " ").trim());
  assert.equal(heads.length, 2);
  assert.match(heads[0], /^国内版 120 积分 · 2 个账号 今日 0\/1 完成 · 成长 1\/3 · 近 7 天 \d+/);
  assert.match(heads[1], /^国际版 移到上面 0 积分 · 1 个账号 每日奖励 今日到账 \+30 · 近 7 天/);
  assert.doesNotMatch(heads[1], /成长|猫猫/);
  const listNames = () => all(nodes.get("board"), "wb-who").map(w => text(w).trim().split(/\s+/)[0]);
  assert.deepEqual(listNames(), ["国内测试", "企业号", "海外号"]);
  button(nodes.get("board"), "移到上面").onclick();
  assert.deepEqual(listNames(), ["海外号", "国内测试", "企业号"]);
  button(nodes.get("board"), "移到上面").onclick();
  assert.deepEqual(listNames(), ["国内测试", "企业号", "海外号"]);
  // Personal logins lead and enterprise logins close the 国内版 group, whatever order the API sends.
  board.accounts = [board.accounts[1], board.accounts[2], board.accounts[0]];
  nodes.get("board-refresh").onclick();
  await setImmediate();
  assert.deepEqual(listNames(), ["国内测试", "企业号", "海外号"]);

  // Board view switcher: Rings & Widgets live inside Board and keep the alert footer.
  button(nodes.get("board"), "圆环").onclick();
  assert.match(text(nodes.get("board")), /国际版[\s\S]*海外号[^海]*今日完成 1\/2/);
  assert.match(text(nodes.get("board")), /国内版\s+120\s+积分 · 2 个账号[\s\S]*国内测试 120 积分 今日完成 1\/3/);
  findNode(nodes.get("board"), n => n.className === "wb-ringcard" && /国内测试/.test(text(n))).onclick();
  assert.match(text(nodes.get("board")), /今日活跃 连登 8 天[\s\S]*猫猫旅行 在咖啡馆[\s\S]*成长任务 1\/3[\s\S]*每日签到 已签到 \+100[\s\S]*近 7 天用量/);

  button(nodes.get("board"), "小组件").onclick();
  assert.match(text(nodes.get("board")), /即将作废 明天 120 积分[\s\S]*今日 0\/2 完成[\s\S]*签到 1\/1[\s\S]*猫猫 1 只在咖啡馆\s+国内测试 · 约 \d\d:\d\d 归来\s+能量 30[\s\S]*成长任务 1\/3[\s\S]*关注公众号 需手动\s+连登 8 天/);

  // Models tab
  findNode(nodes.get("board"), n => n.dataset?.tab === "models").onclick();
  assert.equal(bodyEl.dataset.wbTab, "models");
  assert.match(text(nodes.get("board")), /国内版 5[\s\S]*国际版 3[\s\S]*你现在能用 全部 5 个 不开会员也能用；1 个高峰时会员优先[\s\S]*正在优惠 3 个模型 限时免费 1 · 夜间折扣 2[\s\S]*最省积分 Hy3 免费 其次 DeepSeek-V4.1-Flash ×0.11[\s\S]*全部用户可用模型：5[\s\S]*Auto 默认[\s\S]*auto[\s\S]*256K\s+随任务浮动[\s\S]*GLM-5.2 夜间折扣[\s\S]*×0.79 23:00–07:50 ×0.50[\s\S]*GLM-5.3 订阅优先[\s\S]*DeepSeek-V4.1-Flash 夜间折扣[\s\S]*×0.11\s+非高峰 约 ×0.06/);
  assert.match(text(nodes.get("board")), /推理档位[\s\S]*auto\s+—\s+256K[\s\S]*glm-5.2\s+high\s+xhigh\s+可关/);
  assert.match(text(nodes.get("board")), /企业 2\s+国内版 5\s+国际版 3/);
  button(nodes.get("board"), "企业 2").onclick();
  assert.match(text(nodes.get("board")), /企业账号 企业号 模型由企业配置决定[\s\S]*企业账号读到的列表[\s\S]*Kimi-K3.1-Pro[\s\S]*low\s+high\s+max[\s\S]*Kimi-K2.5[\s\S]*medium\s+固定/);
  button(nodes.get("board"), "国际版 3").onclick();
  assert.match(text(nodes.get("board")), /你现在能用 2 个模型 共 3 个，另外 1 个是 Pro-only[\s\S]*国际版账号 Free 计划 abroad · 升级 Pro 才能用全部[\s\S]*最省积分 Deepseek-V4.1-Flash ×0.03[\s\S]*Free 用户可用模型：2[\s\S]*Primary[\s\S]*×3.31[\s\S]*Pro-only 模型：1[\s\S]*GPT-6-Luna Pro/);

  // Schedule & Logs tab
  findNode(nodes.get("board"), n => n.dataset?.tab === "schedule").onclick();
  assert.equal(bodyEl.dataset.wbTab, "schedule");
  assert.match(text(nodes.get("board")), /今日定时 · 每天 4 次\s+下一次 21:00 国内版 活跃 · 旅行 · 福利[\s\S]*国内版\s+运行中\s+09:00 完成[\s\S]*09:10 失败 2\/3 成长任务[\s\S]*21:00 下一次[\s\S]*国际版\s+已暂停\s+10:30 已暂停 网页会话/);
  const switches = all(nodes.get("board"), "wb-switch");
  assert.deepEqual(switches.map(b => [b.attributes["aria-label"], b.attributes["aria-checked"]]), [["国内版定时", "true"], ["国际版定时", "false"]]);
  assert.equal(nodes.get("cn-state").textContent, "· 定时已暂停", "the settings card follows the saved config");
  await switches[1].onclick();
  assert.equal(switches[1].attributes["aria-checked"], "true");
  assert.equal(calls.filter(c => c.path === "/api/config").at(-1).body.intlEnabled, true, "the WorkBuddy AI switch flips its own schedule only");

  // Local panel account selection + manual action
  assert.deepEqual(nodes.get("accounts").children.map(row => row.children[1].children[0].textContent), ["国内测试", "国内测试二", "国际测试"]);
  assert.equal(nodes.get("accounts").children[2].className, "account intl");
  const checkbox = nodes.get("accounts").children[1].children[0]; checkbox.checked = true; checkbox.onchange();
  await buttons.find(b => b.dataset.action === "activity").onclick();
  assert.deepEqual(calls.find(c => c.path === "/api/run").body, { action: "activity", accounts: ["cn:b"] });

  // Settings form deduplication & model choices
  form.elements["schedule-daily"].value = "21:00, 09:00, 09:00";
  form.elements["intl-web"].value = "11:00，10:30";
  assert.equal(context.WBBoard.modelChoices([{ id: "hy3", name: "Hy3", rate: 0 }, { id: "gpt-6-luna", name: "GPT-6-Luna", rate: 0.07, tier: { exclusive: true } }, { id: "glm-5.3", name: "glm-5.3", rate: 0.69 }], "gone").map(r => [r.id, r.tag || "", r.note || ""].join("|")).join(" "),
    "auto||优先当前免费的模型 hy3|免费|hy3 gpt-6-luna|Pro|gpt-6-luna glm-5.3|×0.69| gone||");
  const menu = all(nodes.get("intl-schedule-fields"), "wb-pick-menu")[0], option = menu?.children.find(b => text(b).includes("kimi-k3"));
  option.onclick();
  assert.equal(form.elements["intl-model"].value, "kimi-k3", "picking from the menu sets the form's value");
  form.elements["intl-model"].value = "hy3";
  assert.equal(form.elements.intlWeb.checked, true, "the switch shows the saved setting");
  form.elements.intlWeb.checked = false;
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  const saved = calls.filter(c => c.path === "/api/config").at(-1).body;
  assert.deepEqual([saved.schedules.daily, saved.schedules.sweep, saved.intlSchedules.web, saved.intlSchedules.daily, saved.intlWebModel, saved.intlWeb], [["09:00", "21:00"], ["10:00", "22:10"], ["10:30", "11:00"], ["09:00", "21:00"], "hy3", false]);

  // Back to board list view: enterprise login hides check-in and locked unlockAt renders properly.
  findNode(nodes.get("board"), n => n.dataset?.tab === "board").onclick();
  button(nodes.get("board"), "列表").onclick();
  assert.doesNotMatch(text(nodes.get("board")), /企业号：|没签上/);
  const unlockAt = new Date(2026, 10, 13).getTime();
  board.accounts.find(a => a.id === "cn:a").tasks.open.push({ title: "创建 1 个定时任务", state: "locked", unlockAt });
  context.WBBoard.render(nodes.get("board"), board, unlockAt - 1000);
  assert.match(text(nodes.get("board")), /创建 1 个定时任务 11\/13 00:00 解锁/);
  context.WBBoard.render(nodes.get("board"), board, unlockAt);
  assert.match(text(nodes.get("board")), /创建 1 个定时任务 未解锁/);
});

test("magpie page wires board tabs, task actions, schedule pill and settings", async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.value = ""; this.dataset = {}; this.style = {}; this.classList = { toggle(c, force) { this._on = force; } }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(k, v) { (this.attributes ||= {})[k] = v; }
    getAttribute(k) { return this.attributes?.[k] ?? null; }
    removeAttribute() {}
    focus() {}
    get lastChild() { return this.children.at(-1); }
  }
  const nodes = new Map(), requests = [];
  for (const id of ["state", "note", "board", "jobs", "panel", "cn-state", "intl-state", "sched-pill", "intl-model-pick", "settings", "settings-form", "open-settings", "close-settings"]) nodes.set(id, new Element("div"));
  const form = nodes.get("settings-form");
  form.elements = Object.fromEntries(["daily", "tasks", "sweep", "night", "keepalive", "intl-daily", "intl-web", "intl-keepalive", "intl-model", "intl-web-on", "skill-share", "spread", "timezone", "proxy"].map(k => [k, new Element("input")]));
  const bodyEl = new Element("body");
  const context = vm.createContext({
    WBPLUS: {
      build: "abc123", generated: new Date().toISOString(), at: Date.now(), enabled: true, intlEnabled: true,
      schedules: structuredClone(defaults.schedules), intlSchedules: structuredClone(defaults.intlSchedules),
      settings: { timezone: "Asia/Shanghai", spread: 10, proxy: "", intlWebModel: "auto", intlWeb: true, skillShare: true },
      intl: { accounts: 0 }, today: { timezone: "Asia/Shanghai", next: { kind: "tasks", at: "21:10", status: "upcoming" }, slots: [{ kind: "tasks", at: "21:10", status: "upcoming" }] },
      accounts: [{ id: "cn:a", name: "主力号", expires: 0, errors: {}, balance: { balance: 100, size: 200, packages: [] }, tasks: { total: 2, claimed: 1, credit: 50, open: [{ code: "skill_1", title: "技能任务", state: "claimable", current: 1, target: 1, credit: 50 }] }, travel: { state: "arrived", location: "大理", reward: 30 } }],
      jobs: []
    },
    magpie: { options: { get: async () => ({}), set: async opts => { requests.push(opts.request); } } },
    document: { body: bodyEl, getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    setInterval() {}, setTimeout() {}, console
  });
  context.globalThis = context;
  for (const file of ["../page/board.js", "../page/app.js"]) vm.runInContext(readFileSync(new URL(file, import.meta.url), "utf8"), context);

  assert.equal(nodes.get("sched-pill").textContent, "定时运行中 · 下次 21:10");
  nodes.get("sched-pill").onclick();
  assert.equal(bodyEl.dataset.wbTab, "schedule");

  const findNode = (node, pred) => typeof node === "string" ? undefined : pred(node) ? node : (node.children || []).map(c => findNode(c, pred)).find(Boolean);
  findNode(nodes.get("board"), n => n.dataset?.tab === "tasks").onclick();
  await findNode(nodes.get("board"), n => n.textContent === "补领奖励" && n.className === "wb-task-sweep").onclick();
  assert.equal(requests.at(-1).action, "sweep");
  await findNode(nodes.get("board"), n => n.textContent === "领奖并出发" && n.className?.includes("wb-task-run")).onclick();
  assert.equal(requests.at(-1).action, "travel");
  assert.equal(requests.at(-1).accounts.join(","), "cn:a");
});
