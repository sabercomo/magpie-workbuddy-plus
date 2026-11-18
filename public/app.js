const $ = id => document.getElementById(id);
const scheduleNames = { daily: "活跃 / 旅行 / 连登福利", tasks: "成长任务", sweep: "补领清扫", night: "夜猫子任务" };
const intlNames = { daily: "连登活跃 / 签到 / 连登福利", web: "网页会话（每日活跃奖励）" };

let current, filled = false, modelField = null;
const selected = new Set();
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-WorkBuddy-Plus": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
function failure(error) { $("error").textContent = error.message; $("error").hidden = false; }
function saveStatus(text, bad) { const status = $("saved"); status.textContent = text; status.classList.toggle("bad", !!bad); }
async function save(config) { await api("/api/config", config); await refresh(); }

function updateScopeNote() {
  const noteEl = $("run-scope-note");
  if (!noteEl) return;
  noteEl.textContent = selected.size
    ? `当前已勾选 ${selected.size} 个账号，立即执行将只针对这些账号。`
    : "将作用于全部已启用账号；可在「定时与记录」勾选指定账号。";
}

function updateSchedPill(view) {
  const pill = $("sched-pill");
  if (!pill) return;
  if (!view?.today?.slots) { pill.hidden = true; return; }
  pill.hidden = false;
  const anyOn = view.enabled !== false || (view.intl?.accounts && view.intlEnabled !== false);
  const next = view.today.next;
  pill.className = anyOn ? "sched-pill" : "sched-pill paused";
  pill.textContent = !anyOn ? "定时已暂停" : next ? `定时运行中 · 下次 ${next.runAt || next.at}` : "定时运行中 · 今日已完成";
}

function toggleSettings(open) {
  document.body?.classList?.toggle("in-settings", open);
  const panel = $("settings");
  if (panel) panel.hidden = !open;
  (open ? $("close-settings") : $("open-settings"))?.focus?.();
}

async function refresh() {
  current = await api("/api/status");
  const hasIntl = current.accounts.some(a => a.realm === "intl");
  $("intl-fields").hidden = $("intl-conversation").hidden = !hasIntl;
  $("cn-state").textContent = `· 定时${current.config.enabled ? "已开启" : "已暂停"}`;
  $("intl-state").textContent = `· 定时${current.config.intlEnabled ? "已开启" : "已暂停"}`;
  $("accounts").replaceChildren();
  const rank = a => (a.realm === "intl" ? 2 : 0) + (a.enterprise ? 1 : 0), accounts = [...current.accounts].sort((a, b) => rank(a) - rank(b));
  for (const account of accounts) {
    const row = element("div", undefined, account.realm === "intl" ? "account intl" : "account"), checkbox = element("input");
    checkbox.type = "checkbox"; checkbox.checked = selected.has(account.id); checkbox.disabled = !account.enabled;
    checkbox.setAttribute("aria-label", `选择 ${account.name}`);
    checkbox.onchange = () => { checkbox.checked ? selected.add(account.id) : selected.delete(account.id); updateScopeNote(); };
    const info = element("div", undefined, "account-info"), title = element("div", account.name, "account-name"), meta = element("div");
    meta.append(element("span", account.realm === "intl" ? "国际版" : account.enterprise ? "企业" : "个人", "tag"), element("span", account.enterprise ? "无个人成长奖励" : "复用 Magpie 登录", "muted"));
    info.append(title, meta);
    const toggle = element("button", account.enabled ? "停用" : "启用");
    toggle.type = "button";
    toggle.onclick = async () => {
      try {
        const config = { ...current.config, disabledAccounts: account.enabled ? [...current.config.disabledAccounts, account.id] : current.config.disabledAccounts.filter(id => id !== account.id) };
        selected.delete(account.id); updateScopeNote(); await save(config);
      } catch (e) { failure(e); }
    };
    row.append(checkbox, info, toggle); $("accounts").append(row);
  }
  updateScopeNote();

  if (!filled) {
    for (const [key, times] of Object.keys(scheduleNames).map(k => [k, current.config.schedules[k] || []])) {
      const label = element("label", scheduleNames[key]), input = element("input");
      input.name = `schedule-${key}`; input.value = times.join(", "); input.placeholder = "HH:MM, HH:MM";
      label.append(input); $("schedule-fields").append(label);
    }
    for (const [key, times] of Object.keys(intlNames).map(k => [k, current.intlSchedules[k] || []])) {
      const label = element("label", intlNames[key]), input = element("input");
      input.name = `intl-${key}`; input.value = times.join(", "); input.placeholder = "HH:MM, HH:MM";
      label.append(input); $("intl-schedule-fields").append(label);
    }
    const model = $("intl-model-pick"), pick = element("input"), wanted = current.config.intlWebModel || "auto";
    pick.type = "hidden"; pick.name = "intl-model"; pick.value = wanted;
    model.append(pick, WBBoard.picker(pick, WBBoard.modelChoices(current.intlModels, wanted)));
    modelField = { host: model, pick, count: (current.intlModels || []).length };
    for (const key of ["timezone", "proxy"]) $("config-form").elements[key].value = current.config[key];
    $("config-form").elements.spread.value = Number.isInteger(current.config.spread) ? current.config.spread : 10;
    $("config-form").elements.intlWeb.checked = current.config.intlWeb !== false;
    $("config-form").elements.campaignApp.checked = current.config.campaignApp === true;
    $("config-form").elements.skillShare.checked = current.config.skillShare !== false;
    filled = true;
  }
  if (modelField && (current.intlModels || []).length !== modelField.count && !modelField.host.lastChild.open) {
    modelField.count = (current.intlModels || []).length; modelField.host.lastChild.remove();
    modelField.host.append(WBBoard.picker(modelField.pick, WBBoard.modelChoices(current.intlModels, modelField.pick.value)));
  }
}

async function board(view) {
  view = view || await api("/api/board");
  view = { ...view, jobs: current.jobs };
  updateSchedPill(view);
  WBBoard.render($("board"), view, Date.now(), {
    onSchedule: (intl, on) => save({ ...current.config, [intl ? "intlEnabled" : "enabled"]: on }).then(() => board()).catch(failure),
    onTask: (account, task) => api("/api/run", { actions: ["task"], accounts: [account], task }).then(() => refresh()).catch(e => { failure(e); throw e; }),
    onQueue: accounts => api("/api/run", { actions: ["tasks"], accounts }).then(() => refresh()).catch(e => { failure(e); throw e; }),
    onRunAction: (action, accounts) => action === "refresh" ? api("/api/board", { accounts: accounts || [...selected] }).then(() => refresh()) : api("/api/run", { action, accounts: accounts || [...selected] }).then(() => refresh()).catch(e => { failure(e); throw e; }),
    onPauseAccount: (account, paused) => {
      const list = current.config.pausedAccounts || [];
      const config = { ...current.config, pausedAccounts: paused ? [...list, account] : list.filter(id => id !== account) };
      return save(config).then(() => refresh()).catch(e => { failure(e); throw e; });
    },
    onPauseAccounts: (accounts, paused) => save({ ...current.config, pausedAccounts: paused ? [...new Set([...current.config.pausedAccounts, ...accounts])] : current.config.pausedAccounts.filter(id => !accounts.includes(id)) }),
    onConfig: config => save({ ...current.config, ...config }),
    onRetry: id => api("/api/retry", { id }).then(refresh),
    onCancel: id => api("/api/cancel", { id }).then(refresh),
    onOpenSettings: () => toggleSettings(true)
  });
  $("board-state").textContent = view.refreshing ? "正在读取…" : view.at ? `更新于 ${new Date(view.at).toLocaleTimeString()}` : "";
}

$("board-refresh").onclick = () => api("/api/board", {}).then(board).catch(failure);
if ($("open-settings")) $("open-settings").onclick = () => toggleSettings(true);
if ($("close-settings")) $("close-settings").onclick = () => toggleSettings(false);
if ($("sched-pill")) $("sched-pill").onclick = () => { toggleSettings(false); WBBoard.goTab("schedule"); };

for (const item of document.querySelectorAll("[data-login]")) item.onclick = () => { $("add-menu").open = false; api("/api/login", { realm: item.dataset.login }).then(() => board()).catch(failure); };

const menus = [...document.querySelectorAll("details.run-menu")];
document.addEventListener("click", event => {
  for (const m of menus) if (!m.contains(event.target)) m.open = false;
  if ($("add-menu") && !$("add-menu").contains(event.target)) $("add-menu").open = false;
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const openMenu = menus.find(m => m.open);
  if (openMenu) { openMenu.open = false; openMenu.querySelector("summary")?.focus(); return; }
  if ($("add-menu")?.open) { $("add-menu").open = false; $("add-menu").querySelector("summary")?.focus(); return; }
  if ($("settings") && !$("settings").hidden && !document.querySelector(".wb-pick[open]")) toggleSettings(false);
});

for (const button of document.querySelectorAll("[data-action]")) button.onclick = async () => {
  for (const m of menus) m.open = false;
  button.disabled = true; $("error").hidden = true;
  try { await api("/api/run", { action: button.dataset.action, accounts: [...selected] }); await refresh(); }
  catch (e) { failure(e); } finally { button.disabled = false; }
};

$("config-form").onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    if (!current) throw new Error("还没有读到后台状态，请稍等再试");
    const config = { ...current.config, schedules: {} };
    const times = v => [...new Set(v.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean))].sort();
    for (const key of Object.keys(scheduleNames)) config.schedules[key] = times(form.elements[`schedule-${key}`].value);
    config.intlSchedules = {}; for (const key of Object.keys(intlNames)) config.intlSchedules[key] = times(form.elements[`intl-${key}`].value);
    config.intlWebModel = form.elements["intl-model"].value || "auto";
    for (const key of ["timezone", "proxy"]) config[key] = form.elements[key].value.trim();
    config.spread = Number(form.elements.spread.value || 0);
    config.intlWeb = form.elements.intlWeb.checked;
    config.campaignApp = form.elements.campaignApp.checked;
    config.skillShare = form.elements.skillShare.checked;
    saveStatus("正在保存…");
    await save(config);
    saveStatus("已保存");
  } catch (e) { saveStatus(`保存失败：${e.message}`, true); }
};

refresh().catch(failure); board().catch(failure);
setInterval(() => refresh().catch(failure), 4000);
setInterval(() => board().catch(failure), 15000);
