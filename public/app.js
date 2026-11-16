const $ = id => document.getElementById(id);
const names = { all: "执行所有任务", checkin: "签到（旧版记录）", activity: "连登活跃", tasks: "成长任务", sweep: "补领奖励", task: "执行单任务", travel: "猫猫旅行", bonus: "连登福利", night: "夜猫子", keepalive: "登录续期", web: "国际版网页会话", inspect: "查询状态" };
const scheduleNames = { daily: "活跃 / 旅行 / 连登福利", tasks: "成长任务", sweep: "补领清扫", night: "夜猫子任务", keepalive: "登录续期检查" };
const intlNames = { daily: "连登活跃 / 签到 / 连登福利", web: "网页会话（每日活跃奖励）", keepalive: "登录续期检查" };

const statuses = { running: "执行中", queued: "排队中", succeeded: "已完成", partial: "部分失败", failed: "失败", deferred: "稍后重试", interrupted: "重启中断", cancelled: "已停止" };
let current, filled = false, modelField = null;
const selected = new Set(), opened = new Set();
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

  $("jobs").replaceChildren();
  for (const job of current.jobs) {
    const details = element("details", undefined, "job");
    details.open = opened.has(job.id) || job.status === "running";
    details.ontoggle = () => details.open ? opened.add(job.id) : opened.delete(job.id);
    const summary = element("summary"), status = element("span", statuses[job.status] || job.status, `status ${job.status}`);
    const counts = job.counts?.total ? ` · 成功 ${job.counts.succeeded} / 失败 ${job.counts.failed}${job.counts.limited ? ` / 限流 ${job.counts.limited}` : ""}` : "";
    summary.append(status, element("span", `${job.actions.map(a => names[a]).join(" / ")}${job.task ? ` · ${job.task}` : ""} · ${job.accounts.length} 个账号${counts}`, "job-name"), element("span", new Date(job.created).toLocaleString(), "muted"));
    const logs = element("div", job.logs.map(log => `${new Date(log.at).toLocaleTimeString()}  ${current.accounts.find(a => a.id === log.account)?.name || ""}  ${log.message}`).join("\n") || "等待执行…", "log");
    details.append(summary, logs);
    if (job.actions.includes("inspect") && job.results.length) details.append(element("pre", JSON.stringify(job.results, null, 2), "log"));
    if (job.status === "running") {
      const cancel = element("button", "停止当前执行", "cancel");
      cancel.type = "button";
      cancel.onclick = () => api("/api/cancel", { id: job.id }).then(refresh).catch(failure);
      details.append(cancel);
    }
    $("jobs").append(details);
  }
  if (!current.jobs.length) $("jobs").append(element("p", "还没有执行记录。可以先选择一个账号试运行。", "empty"));
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
  $("updated").textContent = `更新于 ${new Date().toLocaleTimeString()}`;
}

async function board(view) {
  view = view || await api("/api/board");
  updateSchedPill(view);
  WBBoard.render($("board"), view, Date.now(), {
    onSchedule: (intl, on) => save({ ...current.config, [intl ? "intlEnabled" : "enabled"]: on }).then(() => board()).catch(failure),
    onTask: (account, task) => api("/api/run", { actions: ["task"], accounts: [account], task }).then(() => refresh()).catch(e => { failure(e); throw e; }),
    onQueue: accounts => api("/api/run", { actions: ["tasks"], accounts }).then(() => refresh()).catch(e => { failure(e); throw e; }),
    onRunAction: (action, accounts) => api("/api/run", { action, accounts: accounts || [...selected] }).then(() => refresh()).catch(e => { failure(e); throw e; }),
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
