const $ = selector => document.querySelector(selector);
const view = globalThis.WBPLUS;
const now = Date.parse(view.generated);
const fixture = structuredClone(view);
const personal = fixture.accounts.filter(a => !a.enterprise && a.realm !== "intl");
const template = structuredClone(personal[0]);
const domestic = ["主力号", "备用号", "测试号", "工作号"].map((name, i) => {
  const account = structuredClone(template);
  Object.assign(account, {
    id: `review-${i}`, name, enabled: true, paused: false, errors: {}, limits: [],
    health: { state: "normal", failures: 0, lastSuccess: new Date(now - 7*3600000).toISOString(), next: "20:53" },
    tasks: { total: 9, claimed: 9, credit: 0, open: [] },
    campaigns: [{ title: "每日活动", tasks: [{ title: "活动奖励", claimed: false, manual: false, disabled: false }] }],
    compensation: { active: false, claimed: i < 2, credit: 0 },
    buddy: { affordable: i < 2 ? 5 : 2, maxOpen: 5 }
  });
  account.growth.energy = i < 2 ? 50 : 23;
  return account;
});
const other = fixture.accounts.filter(a => a.enterprise || a.realm === "intl");
for (const a of other) {
  a.health = { state: "normal", failures: 0, lastSuccess: new Date(now - 3600000).toISOString(), next: a.enterprise ? null : "21:00" };
  a.limits = [];
  a.errors = {};
}
view.accounts = [...domestic, ...other];
view.jobs = structuredClone(fixture.jobs);
// Keep all queue/log fixtures on preview account identifiers.
const ids = { "demo-1": "review-0", "demo-2": "review-1", "demo-5": "review-2" };
for (const job of view.jobs) {
  job.accounts = job.accounts.map(id => ids[id] || id);
  for (const entry of [...(job.logs || []), ...(job.queue || []), ...(job.retries || [])]) entry.account = ids[entry.account] || entry.account;
}
const baseline = structuredClone(view.accounts);
for (const a of view.accounts) {
  const row = document.createElement('div'), input = document.createElement('input'), copy = document.createElement('div'), name = document.createElement('strong'), info = document.createElement('p'), toggle = document.createElement('button');
  row.className = 'review-execution-account'; input.type = 'checkbox'; input.setAttribute('aria-label', `执行时选择 ${a.name}`);
  name.textContent = a.name; info.textContent = a.realm === 'intl' ? '国际版 · 复用 Magpie 登录' : a.enterprise ? '企业 · 无个人成长奖励' : '国内个人 · 复用 Magpie 登录';
  toggle.type = 'button'; toggle.textContent = '停用'; toggle.onclick = () => { toggle.textContent = toggle.textContent === '停用' ? '启用' : '停用'; input.disabled = toggle.textContent === '启用'; };
  copy.append(name, info); row.append(input, copy, toggle); document.querySelector('#execution-accounts').append(row);
}
const feedback = text => { $("#feedback").textContent = text; };
const paint = () => WBBoard.render($("#board"), view, now, hooks);
const hooks = {
  onRunAction: async (action, wanted) => {
    const rows = view.accounts.filter(a => !wanted || wanted.includes(a.id));
    if (action === "compensation") for (const a of rows) a.compensation.claimed = true;
    if (action === "buddy") for (const a of rows) { a.growth.energy -= Math.min(a.buddy.affordable, a.buddy.maxOpen)*10; a.buddy.affordable = 0; }
    if (action === "sweep") for (const a of rows) { a.tasks.open = a.tasks.open.filter(t => t.state !== "claimable"); for (const c of a.campaigns || []) for (const t of c.tasks || []) t.claimed = true; }
    paint();
    feedback("演示操作已完成，仅改变这份样稿。");
    return "演示操作已完成";
  },
  onPauseAccount: async (id, paused) => { view.accounts.find(a => a.id === id).paused = paused; paint(); return paused ? "任务已暂停" : "任务已恢复"; },
  onPauseAccounts: async (ids, paused) => { for (const a of view.accounts) if (ids.includes(a.id) && !a.enterprise) a.paused = paused; paint(); return "演示操作已完成"; },
  onConfig: async patch => { Object.assign(view.settings, patch); paint(); return "已保存到样稿"; },
  onSchedule: async (intl, enabled) => { view[intl ? "intlEnabled" : "enabled"] = enabled; paint(); },
  onRetry: async () => "演示重试已提交",
  onCancel: async () => "演示任务已取消",
  onOpenSettings: () => { WBBoard.goTab("schedule"); feedback("并发与任务开关位于右侧任务设置；窄窗口中位于队列下方。"); }
};
const compare = optimized => {
  globalThis.UI_REVIEW = optimized;
  document.body.classList.toggle("review-on", optimized);
  for (const b of document.querySelectorAll("[data-ui]")) b.setAttribute("aria-pressed", String((b.dataset.ui === "after") === optimized));
  $("#footer-copy").textContent = optimized ? "后台自动更新 · 完整记录可在本机面板查看" : "余额与旅行状态由后台服务约每 3 分钟刷新；按钮会让 Magpie 重载插件后交给后台服务执行。";
  paint();
};
for (const b of document.querySelectorAll("[data-ui]")) b.onclick = () => compare(b.dataset.ui === "after");
$("#scenario").onchange = event => {
  view.accounts = structuredClone(baseline);
  if (event.target.value === "attention") {
    view.accounts[0].compensation = { active: true, claimed: false, credit: 500, end: "2026-11-22 23:59:59" };
    view.accounts[1].health = { state: "failed", failures: 3, lastSuccess: new Date(now-86400000).toISOString(), next: "20:53" };
    view.accounts[1].limits = [{ model: "kimi-k3.1-pro", resets: now+3600000 }];
    view.accounts[2].errors.compensation = "查询超时，请重新查询";
  }
  paint();
};
$("#theme").onclick = () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#theme").textContent = dark ? "切换浅色" : "切换深色";
};
$("#show-footer").onclick = () => { WBBoard.goTab("board"); requestAnimationFrame(() => $(".wb-quota").scrollIntoView({block:"center"})); };
$("#refresh").onclick = event => { event.currentTarget.textContent = "✓ 已刷新"; $("#updated").textContent = "示例余额已更新"; };
$("#settings").onclick = hooks.onOpenSettings;
for (const b of document.querySelectorAll("[data-run]")) b.onclick = () => { hooks.onRunAction(b.dataset.run); if (b.closest('.run-menu')) b.closest("details").open = false; };
compare(UI_REVIEW);
$("#theme").textContent = document.documentElement.dataset.theme === "dark" ? "切换浅色" : "切换深色";
if (previewQuery.get("section") === "footer") $("#show-footer").click();
