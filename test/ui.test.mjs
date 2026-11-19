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
    focus() { context.document.activeElement = this; }
  }
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const nodes = new Map(), buttonNames = [...html.matchAll(/data-action="([^"]+)"/g)].map(m => m[1]);
  assert.match(html, /class="wb-header-brand"[^>]*>\s*<button[^>]*id="wb-nav-toggle"/);
  assert.doesNotMatch(html.match(/<header>[\s\S]*?<\/header>/)[0], /<img\b/, "the panel title has no logo");
  const buttons = buttonNames.map(action => { const b = new Element("button"); b.dataset.action = action; return b; });
  for (const id of ["error", "accounts", "jobs", "updated", "config-form", "schedule-fields", "intl-schedule-fields", "intl-fields", "intl-conversation", "intl-model-pick", "cn-state", "intl-state", "saved", "board", "board-state", "board-refresh", "add-menu", "open-settings", "close-settings", "settings", "sched-pill", "run-scope-note", "wb-nav-toggle"]) nodes.set(id, new Element("div"));
  nodes.get("add-menu").contains = () => false;
  const form = nodes.get("config-form"); form.elements = {};
  for (const name of ["timezone", "proxy", "intlProxy", "spread", "intlWeb", "campaignApp", "skillShare"]) form.elements[name] = new Element("input");
  for (const id of ["schedule-fields", "intl-schedule-fields"]) nodes.get(id).append = function (...labels) { for (const label of labels) { const input = label.children[0]; form.elements[input.name] = input; } this.children.push(...labels); };
  const calls = [], status = { config: { ...structuredClone(defaults), intlProxy: "http://127.0.0.1:1082" }, intlSchedules: structuredClone(defaults.intlSchedules), intlModels: ["hy3", "kimi-k3"], accounts: [
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
    queue: [{ account: "cn:a", status: "failed", actions: ["tasks"], completed: 1, total: 1 }],
    logs: [{ at: "2026-11-15T08:17:26.369Z", account: "cn:a", message: "桌面端对话1次：已领奖，100 积分 / 5 能量" }],
    retries: [{ at: "2026-11-15T08:17:20.000Z", account: "cn:a", action: "tasks", attempt: 1, status: 429, waitMs: 5000 }]
  }] };
  const board = { at: Date.now(), enabled: true, intlEnabled: false, networkPaused: { until: Date.now() + 600_000, at: new Date().toISOString(), message: "ECONNRESET: The socket connection was closed unexpectedly." }, signin: { status: "waiting", started: new Date().toISOString(), url: "https://www.workbuddy.cn/login?state=s" }, today: { timezone: "Asia/Shanghai", next: { kind: "daily", at: "21:00", status: "upcoming" }, slots: [
    { kind: "daily", at: "09:00", status: "succeeded", attempts: 1 }, { kind: "tasks", at: "09:10", status: "failed", attempts: 2 }, { kind: "daily", at: "21:00", status: "upcoming", attempts: 0 }, { kind: "intl-web", at: "10:30", status: "upcoming", attempts: 0, paused: true }
  ] }, accounts: [{ id: "cn:a", name: "国内测试", expires: 0, errors: {}, health: { state: "normal", failures: 0, lastSuccess: new Date(Date.now() - 60_000).toISOString(), cooldownUntil: 0, next: "21:00" }, balance: { balance: 120, size: 300, packages: [{ name: "活动赠送", balance: 120, size: 300, expires: Date.now() + 86400_000 }] },
    streak: { days: 8, makeupCards: 1, active: true, nextTier: { days: 14, remaining: 6, credit: 50, energy: 3 } },
    growth: { energy: 30, earned: 110, spent: 80, draws: 0, buddies: 2, rarity: { SR: 1, R: 1 }, current: ["团子"] },
    compensation: { active: true, claimed: false, credit: 500, end: new Date(Date.now() + 5 * 86400_000).toISOString() },
    buddy: { affordable: 2, maxOpen: 5 },
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
    { id: "cn:e", name: "企业号", enterprise: true, expires: 0, errors: {}, health: { state: "paused", failures: 0, lastSuccess: null, cooldownUntil: 0, next: null }, checkin: { outcome: "inactive" }, limits: [{ model: "kimi-k3.1-pro", queued: { position: 907, size: 908, at: Date.now() - 60_000, until: Date.now() + 3600_000 } }] },
    { id: "intl:x", name: "海外号", realm: "intl", expires: 0, errors: {}, health: { state: "failed", failures: 3, lastSuccess: new Date(Date.now() - 7200_000).toISOString(), cooldownUntil: Date.now() + 20_000, next: "21:01" }, travel: { state: "none" }, streak: { days: 2, active: false, makeupCards: 0 }, tasks: { claimed: 0, total: 1, open: [{ code: "first_chat", title: "完成一次对话", state: "manual" }] }, growth: { energy: 0, buddies: 0, draws: 0, rarity: {} }, checkin: { outcome: "closed" },
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
  board.accounts[0].expires = Date.now() - 60_000;
  board.accounts[2].expires = Date.now() + 3600_000;
  board.accounts[1].balance = { balance: 42.75, size: 2000, packages: [] };
  const bodyEl = new Element("body");
  let failConfig = false;
  const context = vm.createContext({
    document: { body: bodyEl, getElementById: id => nodes.get(id) ?? (id.startsWith("wb-account-scope-") ? findNode(nodes.get("board"), n => n.id === id) : undefined), createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), querySelectorAll: selector => selector === "[data-action]" ? buttons : [], querySelector: () => null, addEventListener() {} },
    fetch: async (path, init) => { calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined }); if (path === "/api/config" && failConfig) return { ok: false, json: async () => ({ error: "配置无效" }) }; return { ok: true, json: async () => path === "/api/status" ? structuredClone(status) : path === "/api/board" ? structuredClone(board) : {} }; },
    setInterval() {}, console
  });
  context.globalThis = context;
  for (const file of ["../page/board.js", "../public/app.js"]) vm.runInContext(readFileSync(new URL(file, import.meta.url), "utf8"), context);
  await setImmediate();
  const text = node => typeof node === "string" ? node : [node.textContent || "", ...(node.children || []).map(text)].join(" ");
  const findNode = (node, predicate) => {
    if (typeof node === "string") return;
    if (predicate(node)) return node;
    for (const child of node.children || []) { const hit = findNode(child, predicate); if (hit) return hit; }
  };
  const all = (node, cls) => typeof node === "string" ? [] : [...(node.className === cls ? [node] : []), ...node.children.flatMap(c => all(c, cls))];
  const domesticTotal = findNode(nodes.get("board"), n => n.className === "wb-group-total");
  assert.equal(text(domesticTotal).replace(/\s+/g, " ").trim(), "120 个人积分 · 1 个账号 1 个企业账号 · 额度单独列示", "personal totals must exclude the independently shared enterprise allowance");
  const button = (node, label) => typeof node === "string" ? undefined : node.onclick && text(node).trim() === label ? node : node.children.map(c => button(c, label)).find(Boolean);

  assert.match(text(nodes.get("board")), /^\s*正在等待国内版 WorkBuddy 登录[\s\S]*https:\/\/www\.workbuddy\.cn\/login\?state=s/);

  // Primary navigation tabs separate functional modules from board view modes.
  const navTabs = [];
  (function walk(n) { if (typeof n === "string" || n.inert) return; if (n.dataset?.tab) navTabs.push(n.dataset.tab); (n.children || []).forEach(walk); })(nodes.get("board"));
  assert.deepEqual(navTabs, ["board", "accounts", "tasks", "schedule", "models"]);
  assert.equal(bodyEl.dataset.wbTab, "board");

  context.WBBoard.goTab("schedule");
  const concurrencyGroup = findNode(nodes.get("board"), n => n.getAttribute?.("aria-label") === "账号并发");
  await button(concurrencyGroup, "2").onclick();
  assert.ok(calls.some(call => call.path === "/api/config" && call.body.concurrency === 2));
  calls.length = 0;
  assert.match(text(nodes.get("board")), /任务队列进度[\s\S]*账号并发[\s\S]*旅行后自动开盲盒/);
  const workTab = key => findNode(nodes.get("board"), n => n.dataset?.workTab === key);
  workTab("runs").onclick();
  const record = findNode(nodes.get("board"), n => n.dataset?.job === "partial-job");
  assert.equal(record.open, false, "completed records start folded");
  assert.match(text(record), /部分失败[\s\S]*成长任务[\s\S]*成功 3 \/ 失败 1[\s\S]*桌面端对话1次：已领奖/);
  workTab("logs").onclick();
  assert.match(text(nodes.get("board")), /桌面端对话1次：已领奖/);
  const logPanel = findNode(nodes.get("board"), n => n.className === "wb-work-card");
  button(logPanel, "对话").onclick();
  assert.match(text(nodes.get("board")), /暂无记录/);
  context.WBBoard.goTab("board");

  // Accounts tab is the approved health/task matrix; the nav can become a sidebar.
  findNode(nodes.get("board"), n => n.dataset?.tab === "accounts").onclick();
  assert.equal(bodyEl.dataset.wbTab, "accounts");
  const accountText = text(nodes.get("board"));
  assert.match(accountText, /账号与健康[\s\S]*正常 1[\s\S]*需留意 0[\s\S]*连续失败 1[\s\S]*已暂停 1/);
  const accountScope = key => findNode(nodes.get("board"), n => n.dataset?.accountScope === key);
  const accountRows = () => all(nodes.get("board"), "wb-account-main-row");
  assert.deepEqual(["all", "domestic", "international", "enterprise", "abnormal"].map(key => accountScope(key)?.getAttribute("aria-label")),
    ["全部账号 3 个账号", "国内个人 1 个账号", "国际个人 1 个账号", "企业 1 个账号", "仅看异常 2 个账号"]);
  const filterAccounts = key => {
    const input = accountScope(key);
    input.focus();
    input.onchange();
    assert.equal(accountScope(key).checked, true);
    assert.equal(context.document.activeElement, accountScope(key), "filter changes retain keyboard focus");
    return accountRows().map(row => row.dataset.account);
  };
  assert.deepEqual(filterAccounts("international"), ["intl:x"]);
  assert.match(text(accountRows()[0]), /海外号[\s\S]*国际个人/);
  const internationalEnterprise = { id: "intl:e", name: "国际企业测试", realm: "intl", enterprise: true, enabled: false };
  context.WBBoard.render(nodes.get("board"), { ...board, accounts: [...board.accounts, internationalEnterprise] });
  assert.deepEqual(accountRows().map(row => row.dataset.account), ["intl:x"], "international personal still excludes enterprise after refresh");
  assert.deepEqual(filterAccounts("enterprise"), ["cn:e", "intl:e"]);
  assert.match(text(accountRows()[1]), /国际企业测试[\s\S]*企业账号[\s\S]*只读/);
  assert.deepEqual(filterAccounts("abnormal"), ["cn:e", "intl:x", "intl:e"]);
  context.WBBoard.render(nodes.get("board"), { ...board, accounts: [board.accounts[0]] });
  assert.deepEqual(filterAccounts("enterprise"), []);
  assert.equal(accountScope("enterprise").getAttribute("aria-label"), "企业 0 个账号");
  assert.match(text(nodes.get("board")), /暂无企业账号/);
  assert.deepEqual(filterAccounts("domestic"), ["cn:a"]);
  context.WBBoard.render(nodes.get("board"), { ...board, jobs: status.jobs });
  assert.deepEqual(filterAccounts("all"), ["cn:a", "cn:e", "intl:x"]);
  assert.deepEqual(calls, [], "category changes use existing snapshot data");
  assert.match(accountText, /账号 健康状态 · 下次定时 停用账号/);
  assert.doesNotMatch(accountText, /每日签到 · 加油站|成长任务 · 福利活动|成长计划连登/);
  assert.doesNotMatch(accountText, /执行成长任务|派出旅行|猫猫旅行/);
  const pauseTask = findNode(nodes.get("board"), n => n.textContent === "停用账号" && n.className === "wb-account-pause");
  assert.ok(pauseTask);
  await pauseTask.onclick();
  assert.ok(calls.some(call => call.path === "/api/config" && (call.body?.pausedAccounts || []).includes("cn:a")));
  calls.length = 0;
  assert.deepEqual(filterAccounts("domestic"), ["cn:a"]);
  const selectAll = findNode(nodes.get("board"), n => n.getAttribute?.("aria-label") === "选择当前筛选的全部账号");
  selectAll.checked = true;
  selectAll.onchange();
  assert.match(text(nodes.get("board")), /已选 1 个账号/);
  const batch = findNode(nodes.get("board"), n => n.className === "wb-account-batch");
  assert.equal(nodes.get("board").children[2].children[0], batch, "the fixed batch bar sits outside the page container");
  assert.deepEqual(all(batch, "wb-account-batch-button").map(node => text(node).trim()), ["刷新余额", "暂停账号任务", "取消选择"]);
  assert.match(readFileSync(new URL("../page/board.css", import.meta.url), "utf8"), /\.wb-account-batch\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(readFileSync(new URL("../page/board.css", import.meta.url), "utf8"), /\.wb-board \.wb-account-table th:nth-child\(3\) \{ width: 46%; \}/);
  assert.doesNotMatch(readFileSync(new URL("../page/board.css", import.meta.url), "utf8"), /\.wb-account-table\{min-width:900px\}/);
  await button(batch, "暂停账号任务").onclick();
  assert.ok(calls.some(call => call.path === "/api/config" && (call.body?.pausedAccounts || []).includes("cn:a")));
  calls.length = 0;
  await button(batch, "取消选择").onclick();
  const accountToggle = findNode(nodes.get("board"), n => n.className === "wb-account-toggle" && /国内测试/.test(text(n)));
  accountToggle.onclick();
  assert.match(text(nodes.get("board")), /国内测试 · 诊断与积分[\s\S]*120 \/ 300 积分[\s\S]*连续失败 0 次[\s\S]*请求重试明细[\s\S]*HTTP 429[\s\S]*等待 5 秒后重试/);
  const retryAccount = findNode(nodes.get("board"), n => n.textContent === "重试失败操作" && n.className === "wb-account-detail-action");
  assert.ok(retryAccount);
  await retryAccount.onclick();
  assert.ok(calls.some(call => call.path === "/api/retry" && call.body.id === "partial-job"));
  calls.length = 0;
  const navToggle = nodes.get("wb-nav-toggle");
  const sidebar = findNode(nodes.get("board"), n => n.className === "wb-nav wb-side-nav");
  const horizontal = findNode(nodes.get("board"), n => n.className === "wb-nav wb-top-nav");
  assert.equal(navToggle.getAttribute("aria-pressed"), "false");
  assert.equal(sidebar.inert, true);
  assert.equal(horizontal.inert, false);
  navToggle.onclick();
  assert.equal(navToggle.getAttribute("aria-pressed"), "true");
  assert.equal(sidebar.inert, false);
  assert.equal(horizontal.inert, true);
  assert.equal(findNode(sidebar, n => n.dataset?.tab === "accounts").getAttribute("aria-current"), "page");
  assert.match(text(nodes.get("board")), /账号与健康[\s\S]*国内测试/);
  const splitter = findNode(nodes.get("board"), n => n.getAttribute?.("role") === "separator");
  assert.equal(splitter.hidden, false);
  context.WBBoard.render(nodes.get("board"), board);
  assert.equal(findNode(nodes.get("board"), n => n.getAttribute?.("role") === "separator"), splitter, "refresh keeps the same drag handle");
  navToggle.onclick();
  assert.equal(navToggle.getAttribute("aria-pressed"), "false");
  assert.equal(splitter.hidden, true);
  assert.equal(sidebar.inert, true);
  assert.equal(horizontal.inert, false);
  findNode(nodes.get("board"), n => n.dataset?.tab === "board").onclick();

  // The alert footer follows the board content and expands into a flat list.
  const alertToggle = findNode(nodes.get("board"), n => n.className === "wb-alert-toggle");
  assert.ok(alertToggle);
  assert.ok(text(nodes.get("board")).indexOf("国内测试 个人 · 连登 8 天") < text(nodes.get("board")).indexOf("模型额度"));
  assert.match(text(nodes.get("board")), /模型额度[\s\S]*kimi-k3-1[\s\S]*国内测试[\s\S]*额度已用完[\s\S]*kimi-k3\.1-pro[\s\S]*企业号[\s\S]*排队中/);
  alertToggle.onclick();
  const rendered = text(nodes.get("board")), alerts = rendered.slice(rendered.indexOf("需要你处理"));
  assert.match(alerts, /需要你处理[\s\S]*网络\/代理连续失败，自动任务暂停至 \d\d\/\d\d \d\d:\d\d[\s\S]*120 积分（活动赠送）将作废[\s\S]*其他提醒 2 件[\s\S]*官方补偿 500 积分待领[\s\S]*「关注公众号」需手动完成 \+100 积分/);
  assert.doesNotMatch(alerts, /星巴克协作：邀请好友/);
  assert.match(alerts, /国内测试 的登录已过期[\s\S]*请在 Magpie「供应商」确认登录状态/);
  assert.doesNotMatch(alerts, /海外号 的登录/);

  // Tasks center: the restored per-account matrix, with the 0.7.4 boxes below it.
  findNode(nodes.get("board"), n => n.dataset?.tab === "tasks").onclick();
  assert.equal(bodyEl.dataset.wbTab, "tasks");
  assert.equal(nodes.get("board").children[2].children.length, 0, "switching views clears the floating batch controls");
  const taskText = text(nodes.get("board"));
  assert.match(taskText, /1 项可以自动做[\s\S]*2 项待办 · 1 项需手动 · 合计 \+100 积分/);
  assert.match(taskText, /全部 2[\s\S]*可领奖 0[\s\S]*可自动 1[\s\S]*需手动 1[\s\S]*未解锁 0/);
  assert.match(taskText, /国内版[\s\S]*积分 · 1 个账号[\s\S]*国内测试[\s\S]*1\/3 已领 · 2 项待办/);
  assert.match(taskText, /聊天 5 次[\s\S]*定时会完成[\s\S]*0\/1 · \+100 积分[\s\S]*执行/);
  assert.match(taskText, /关注公众号[\s\S]*需手动[\s\S]*官方客户端/);
  assert.match(taskText, /猫猫旅行快捷处理[\s\S]*一键收派/);
  assert.match(taskText, /Buddy 盲盒[\s\S]*打开全部 · 2 个[\s\S]*国内测试 能量 30 · 可开 2 个/);
  assert.match(taskText, /官方补偿 1[\s\S]*国内测试 官方补偿 \+500 积分 · 剩余 5 天/);
  assert.match(taskText, /运营活动任务[\s\S]*星巴克协作/);
  assert.doesNotMatch(taskText, /有 \d+ 件需要你处理|查看全部任务/);
  const extras = findNode(nodes.get("board"), n => n.className === "wb-task-extras");
  assert.ok(extras, "travel, Buddy, compensation and campaigns live in one extras grid");
  assert.ok(findNode(extras, n => n.className?.includes("wb-task-panel")), "the two 0.7.4 panels are reused");
  assert.equal(all(nodes.get("board"), "wb-card-handle").length, 5, "the account card and four extras each get a drag grip");
  await findNode(nodes.get("board"), n => n.textContent === "补领奖励" && n.className === "wb-task-sweep").onclick();
  assert.ok(calls.some(call => call.path === "/api/run" && JSON.stringify(call.body) === JSON.stringify({ action: "sweep", accounts: [] })));
  calls.length = 0;
  await findNode(nodes.get("board"), n => n.textContent === "执行全部待办" && n.className === "wb-task-run-all").onclick();
  assert.ok(calls.some(call => call.path === "/api/run" && JSON.stringify(call.body) === JSON.stringify({ actions: ["tasks"], accounts: ["cn:a"] })));
  calls.length = 0;
  await findNode(nodes.get("board"), n => n.textContent === "执行" && n.className === "wb-task-run").onclick();
  assert.ok(calls.some(call => call.path === "/api/run" && JSON.stringify(call.body) === JSON.stringify({ actions: ["task"], accounts: ["cn:a"], task: "chat_5" })));
  calls.length = 0;
  await button(extras, "领取").onclick();
  assert.ok(calls.some(call => call.path === "/api/run" && JSON.stringify(call.body) === JSON.stringify({ action: "compensation", accounts: ["cn:a"] })));
  calls.length = 0;
  await button(extras, "开 2 个").onclick();
  assert.ok(calls.some(call => call.path === "/api/run" && JSON.stringify(call.body) === JSON.stringify({ action: "buddy", accounts: ["cn:a"] })));
  calls.length = 0;
  const autoBuddy = findNode(nodes.get("board"), n => n.className === "wb-task-auto")?.children[1];
  assert.equal(autoBuddy.checked, false);
  assert.equal(autoBuddy.getAttribute("role"), "switch");
  assert.equal(autoBuddy.className, "wb-pill-switch");
  autoBuddy.checked = true;
  await autoBuddy.onchange();
  assert.ok(calls.some(call => call.path === "/api/config" && call.body.buddyAuto === true));
  calls.length = 0;

  // The old status filter and grouping still work after the restore.
  button(nodes.get("board"), "按状态分组").onclick();
  assert.match(text(nodes.get("board")), /定时会完成 \(1\)[\s\S]*需手动 \(1\)/);
  button(nodes.get("board"), "按账号分组").onclick();
  button(nodes.get("board"), "可自动 1").onclick();
  const filtered = text(nodes.get("board"));
  assert.match(filtered, /聊天 5 次/);
  assert.doesNotMatch(filtered, /关注公众号[\s\S]*需手动/);
  button(nodes.get("board"), "全部 2").onclick();

  // Back to Board: list view preserves original expanded account detail unchanged.
  findNode(nodes.get("board"), n => n.dataset?.tab === "board").onclick();
  assert.equal(findNode(nodes.get("board"), n => n.className === "wb-reward-cards"), undefined, "Board stays read-only for task actions");
  assert.match(text(nodes.get("board")), /kimi-k3-1 额度已用完 (今天|明天) \d\d:\d\d 恢复[\s\S]*kimi-k3.1-pro 排队中 第 907 位 · 预计 (今天|明天) \d\d:\d\d/);
  assert.match(text(nodes.get("board")), /模型额度[\s\S]*kimi-k3-1[\s\S]*国内测试 · 额度已用完[\s\S]*kimi-k3\.1-pro[\s\S]*企业号 · 排队中[\s\S]*第 907 位/);
  assert.match(text(nodes.get("board")), /积分流水 · 近 7 天 获得 \+110 · 用掉 3[\s\S]*每日签到 \+100 · 猫猫旅行 \+10[\s\S]*\+10 猫猫旅行 已用完[\s\S]*\+100 每日签到 余 100 · \d\d\/\d\d 作废/);
  assert.match(text(nodes.get("board")), /扣分明细 · 近 7 天 14 次扣分 · 另有 1 次免费[\s\S]*−0.37 glm-5.2 WorkBuddy[\s\S]*再显示 2 条[\s\S]*只保留最近 12 条/);
  const find = (node, cls) => typeof node === "string" ? undefined : node.className === cls ? node : node.children.map(c => find(c, cls)).find(Boolean);
  assert.match(text(find(nodes.get("board"), "wb-col-r")), /猫猫旅行[\s\S]*扣分明细 · 近 7 天/);
  assert.doesNotMatch(text(find(nodes.get("board"), "wb-col-l")), /扣分明细/);
  assert.deepEqual([...new Set(all(nodes.get("board"), "wb-row").map(r => r.attributes?.["aria-expanded"]).filter(Boolean))], ["false"]);
  const notes = all(nodes.get("board"), "wb-alert-more");
  assert.equal(notes.length, 1);
  assert.ok(!notes[0].open);
  assert.equal(all(notes[0], "wb-alert-row plain").length, 2);
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
  assert.match(heads[0], /^国内版 120 个人积分 · 1 个账号 1 个企业账号 · 额度单独列示 今日 0\/1 完成 · 成长 1\/3 · 近 7 天 \d+/);
  assert.match(heads[1], /^国际版 移到上面 0 个人积分 · 1 个账号 每日奖励 今日到账 \+30 · 近 7 天/);
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
  assert.match(text(nodes.get("board")), /国内版\s+120\s+个人积分 · 1 个账号[\s\S]*1 个企业账号 · 额度单独列示[\s\S]*国内测试 120 积分 今日完成 1\/3/);
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
  assert.equal(form.elements.intlProxy.value, "http://127.0.0.1:1082", "the international proxy is filled from the saved config");
  form.elements["schedule-daily"].value = "21:00, 09:00, 09:00";
  form.elements["intl-web"].value = "11:00，10:30";
  assert.equal(context.WBBoard.modelChoices([{ id: "hy3", name: "Hy3", rate: 0 }, { id: "gpt-6-luna", name: "GPT-6-Luna", rate: 0.07, tier: { exclusive: true } }, { id: "glm-5.3", name: "glm-5.3", rate: 0.69 }], "gone").map(r => [r.id, r.tag || "", r.note || ""].join("|")).join(" "),
    "auto||优先当前免费的模型 hy3|免费|hy3 gpt-6-luna|Pro|gpt-6-luna glm-5.3|×0.69| gone||");
  form.elements["intl-model"] = nodes.get("intl-model-pick").children[0];
  const menu = all(nodes.get("intl-model-pick"), "wb-pick-menu")[0], option = menu?.children.find(b => text(b).includes("kimi-k3"));
  option.onclick();
  assert.equal(form.elements["intl-model"].value, "kimi-k3", "picking from the menu sets the form's value");
  form.elements["intl-model"].value = "hy3";
  form.elements.intlProxy.value = "127.0.0.1:1082";
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.match(nodes.get("saved").textContent, /^国际版代理需要/);
  form.elements.intlProxy.value = "direct";
  assert.equal(form.elements.intlWeb.checked, true, "the switch shows the saved setting");
  form.elements.intlWeb.checked = false;
  form.elements.campaignApp.checked = true;
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  const saved = calls.filter(c => c.path === "/api/config").at(-1).body;
  assert.deepEqual([saved.schedules.daily, saved.schedules.sweep, saved.intlSchedules.web, saved.intlSchedules.daily, saved.intlWebModel, saved.intlWeb, saved.campaignApp, saved.intlProxy], [["09:00", "21:00"], ["10:01", "22:11"], ["10:30", "11:00"], ["09:01", "21:01"], "hy3", false, true, "direct"]);
  assert.equal(nodes.get("saved").textContent, "已保存", "the save result sits beside the button");
  failConfig = true;
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.match(nodes.get("saved").textContent, /^保存失败：配置无效/, "a failed save stays beside the button, not above the fold");

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

  const manualOnly = structuredClone(board);
  const manualAccount = manualOnly.accounts.find(a => a.id === "cn:a");
  manualAccount.tasks.open = [];
  manualAccount.buddy = { affordable: 0, maxOpen: 5 };
  context.WBBoard.goTab("tasks");
  context.WBBoard.render(nodes.get("board"), manualOnly);
  const taskBadge = () => findNode(nodes.get("board"), n => n.dataset?.tab === "tasks").lastChild;
  assert.equal(taskBadge().textContent, "1 待办", "unclaimed compensation counts without automatic growth tasks");
  assert.match(text(nodes.get("board")), /没有可自动执行的任务[\s\S]*0 项待办[\s\S]*官方补偿 1[\s\S]*国内测试 官方补偿 \+500 积分/);
  assert.match(text(nodes.get("board")), /国内测试 1\/3 已领 · 0 项待办[\s\S]*全部完成/, "accounts stay visible when every growth task is done");
  manualAccount.compensation.claimed = true;
  context.WBBoard.render(nodes.get("board"), manualOnly);
  assert.equal(taskBadge().hidden, true, "optional boxes and other realms do not raise manual todo badges");
  assert.match(text(nodes.get("board")), /官方补偿 暂无待领取/);
  assert.doesNotMatch(text(nodes.get("board")), /国内测试 官方补偿 \+500 积分/);
  assert.match(text(nodes.get("board")), /Buddy 盲盒[\s\S]*能量 30 · 没有可开盲盒/);
  assert.equal(findNode(nodes.get("board"), n => n.textContent === "打开全部" && n.className?.includes("wb-task-row-action")).disabled, true, "no boxes keeps a disabled open-all");
  assert.equal(findNode(nodes.get("board"), n => n.textContent === "开盲盒" && n.className === "wb-task-row-action").disabled, true, "no boxes keeps a disabled per-account action");
  assert.equal(findNode(nodes.get("board"), n => n.textContent === "全部领取" && n.className?.includes("wb-task-row-action")).disabled, true, "nothing claimable keeps a disabled bulk claim");
  assert.equal(findNode(nodes.get("board"), n => n.textContent === "领取" && n.className?.includes("wb-task-row-action")).disabled, true, "claimed compensation keeps a disabled row claim");
  manualAccount.errors.tasks = "ECONNREFUSED";
  context.WBBoard.render(nodes.get("board"), manualOnly);
  assert.match(text(nodes.get("board")), /任务读取失败：国内测试[\s\S]*检查网络和代理/);
  delete manualAccount.errors.tasks;
  for (const account of manualOnly.accounts) account.limits = [];
  manualAccount.balance.balance = 120.25;
  context.WBBoard.goTab("board");
  context.WBBoard.render(nodes.get("board"), manualOnly);
  assert.match(text(nodes.get("board")), /未记录到额度耗尽或排队/);
  assert.doesNotMatch(text(nodes.get("board")), /网关健康|全部可用/);
  button(nodes.get("board"), "小组件").onclick();
  const widgetTotal = findNode(nodes.get("board"), n => n.className?.includes("wb-w-realm"));
  assert.equal(text(widgetTotal).replace(/\s+/g, " ").trim(), "国内版 120.25", "widget subtotals also exclude enterprise allowance and keep fractions");
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
  for (const id of ["state", "note", "board", "jobs", "panel", "cn-state", "intl-state", "sched-pill", "intl-model-pick", "settings", "settings-form", "open-settings", "close-settings", "save-settings", "save-status", "wb-nav-toggle"]) nodes.set(id, new Element("div"));
  const form = nodes.get("settings-form");
  form.elements = Object.fromEntries(["daily", "tasks", "sweep", "night", "intl-daily", "intl-web", "intl-model", "intl-web-on", "campaign-app", "skill-share", "buddy-auto", "spread", "timezone", "proxy", "intlProxy"].map(k => [k, new Element("input")]));
  form.reportValidity = () => true;
  const bodyEl = new Element("body");
  const context = vm.createContext({
    WBPLUS: {
      panel: "http://127.0.0.1:4389", build: "abc123", generated: new Date().toISOString(), at: Date.now(), enabled: true, intlEnabled: true,
      schedules: structuredClone(defaults.schedules), intlSchedules: structuredClone(defaults.intlSchedules),
      settings: { timezone: "Asia/Shanghai", spread: 10, proxy: "", intlProxy: "http://127.0.0.1:1082", intlWebModel: "auto", intlWeb: true, campaignApp: false, skillShare: true },
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
  for (const file of ["../page/index.html", "../public/index.html"]) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /打开本机面板|使用说明|仅本机访问|后台自动更新|<footer\b/);
  nodes.get("sched-pill").onclick();
  assert.equal(bodyEl.dataset.wbTab, "schedule");

  const findNode = (node, pred) => typeof node === "string" ? undefined : pred(node) ? node : (node.children || []).map(c => findNode(c, pred)).find(Boolean);
  assert.match(readFileSync(new URL("../page/index.html", import.meta.url), "utf8"), /class="wb-header-brand"[^>]*>\s*<button[^>]*id="wb-nav-toggle"/);
  const navToggle = nodes.get("wb-nav-toggle");
  navToggle.onclick();
  assert.equal(navToggle.getAttribute("aria-pressed"), "true");
  findNode(nodes.get("board"), n => n.className === "wb-nav wb-side-nav").children.find(n => n.dataset.tab === "tasks").onclick();
  navToggle.onclick();
  assert.equal(bodyEl.dataset.wbTab, "tasks");
  await findNode(nodes.get("board"), n => n.textContent === "补领奖励" && n.className === "wb-task-sweep").onclick();
  assert.equal(requests.at(-1).action, "sweep");
  await findNode(nodes.get("board"), n => n.textContent === "领奖并出发" && n.className === "wb-task-run claim").onclick();
  assert.equal(requests.at(-1).action, "travel");
  assert.equal(requests.at(-1).accounts.join(","), "cn:a");

  // The App conversation setting is saved by Magpie's page too.
  assert.equal(form.elements["campaign-app"].checked, false);
  form.elements["campaign-app"].checked = true;
  assert.equal(form.elements.intlProxy.value, "http://127.0.0.1:1082", "the international proxy is filled from the saved config");
  form.elements.intlProxy.value = "direct";
  const button = nodes.get("save-settings");
  assert.match(readFileSync(new URL("../page/index.html", import.meta.url), "utf8"), /<button type="button" id="save-settings">/);
  await button.onclick({ currentTarget: button });
  const savedPage = requests.filter(r => r.action === "config").at(-1);
  assert.equal(savedPage.config.campaignApp, true);
  assert.equal(savedPage.config.intlProxy, "direct");
  assert.equal(button.disabled, true, "the save button is disabled while saving");

  // A malformed international proxy is rejected locally too.
  form.elements.intlProxy.value = "127.0.0.1:1082";
  button.disabled = false;
  await button.onclick({ currentTarget: button });
  assert.match(nodes.get("save-status").textContent, /^国际版代理需要/);
  assert.equal(button.disabled, false, "a rejected proxy does not disable the button");
  assert.equal(requests.filter(r => r.action === "config").length, 1, "nothing is sent for an invalid proxy");
  form.elements.intlProxy.value = "direct";

  // A malformed time keeps the settings open and says so beside the button.
  form.elements.daily.value = "9:00";
  button.disabled = false;
  await button.onclick({ currentTarget: button });
  assert.equal(nodes.get("save-status").textContent, "时间「9:00」不对，应为 HH:MM，例如 09:00");
  assert.equal(nodes.get("save-status").classList._on, true);
  assert.equal(button.disabled, false, "a rejected save does not disable the button");
  assert.equal(requests.filter(r => r.action === "config").length, 1, "nothing is sent for an invalid time");
});
