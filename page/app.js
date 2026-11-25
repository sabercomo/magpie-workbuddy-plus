// Magpie's page is sandboxed with no network: it reads data.js, which the
// background service rewrites, and asks for work by saving a request into
// the plugin's options (see index.mjs).
const $ = id => document.getElementById(id);
const names = { all: "执行所有任务", "pause-tasks": "暂停任务", "resume-tasks": "恢复任务", activity: "连登活跃", tasks: "成长任务", sweep: "补领奖励", task: "执行单任务", travel: "猫猫旅行", bonus: "连登福利", night: "夜猫子", inspect: "查询状态", web: "国际版网页会话", refresh: "刷新余额", login: "添加国内版账号", "login-intl": "添加国际版账号", pause: "暂停国内版定时", resume: "开启国内版定时", "intl-on": "开启国际版定时", "intl-off": "暂停国际版定时", retry: "重试失败任务", cancel: "停止执行", config: "保存设置" };
let pending = null;
let syncPending, syncEdited = false, syncChoicesKey;
const build = globalThis.WBPLUS?.build;

function note(text, bad) { $("note").textContent = text; $("note").className = bad ? "note bad" : "note"; $("note").hidden = !text; }
const saveHint = "保存后由 Magpie 重载插件交给后台服务。";
function saveNote(text, bad) {
  const status = $("save-status");
  if (!status) return;
  status.textContent = text || saveHint;
  status.classList.toggle("bad", !!bad);
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

function paint() {
  const view = globalThis.WBPLUS;
  const offline = !view || Date.now() - Date.parse(view.generated) > 25 * 60_000;
  $("state").textContent = !view ? "后台服务还没有写出数据：Magpie 加载本插件时会启动它。一直这样的话，看 ~/.config/workbuddy-plus/service.log；Windows 上常见原因是端口被系统保留，见 README 的「端口」一节。"
    : `${view.refreshing ? "正在刷新…" : `余额更新于 ${WBBoard.when(view.at)}`}${offline ? " · 后台服务可能未运行" : ""}`;
  updateSchedPill(view);
  for (const node of document.querySelectorAll(".intl-only")) node.hidden = !view?.intl?.accounts;
  $("cn-state").textContent = view ? `· 定时${view.enabled ? "已开启" : "已暂停"}` : "";
  $("intl-state").textContent = view ? `· 定时${view.intlEnabled ? "已开启" : "已暂停"}` : "";

  WBBoard.render($("board"), view, Date.now(), {
    onSchedule: (intl, on) => ask(intl ? (on ? "intl-on" : "intl-off") : (on ? "resume" : "pause")).catch(e => note(`提交失败：${e.message}`, true)),
    onTask: (account, task) => ask("task", { task, accounts: [account] }),
    onQueue: accounts => ask("tasks", { accounts }),
    onRunAction: (action, accounts) => ask(action, accounts ? { accounts } : {}),
    onRefresh: () => ask("refresh"),
    onPauseAccount: (account, paused) => ask(paused ? "pause-tasks" : "resume-tasks", { accounts: [account] }),
    onPauseAccounts: (accounts, paused) => ask(paused ? "pause-tasks" : "resume-tasks", { accounts }),
    onConfig: config => ask("config", { config }).then(() => "已提交，等待后台保存"),
    onRetry: job => ask("retry", { job }),
    onCancel: job => ask("cancel", { job }),
    onOpenSettings: () => settings(true)
  });

  fill(view);
  fillSync(view?.sync);
  const done = view?.request;
  if (pending && done?.id === pending) {
    pending = null;
    note(done.ok ? `${names[done.action] || done.action}：已交给后台服务` : `${names[done.action] || done.action}：${done.error}`, !done.ok);
  }
}

const syncHints = {
  off: "本机不发布或接收账号。定时按原设置运行。",
  master: "发布所选账号。登录和续期仍由 Magpie 负责。",
  follower: "接收主机共享的账号，不覆盖本机登录。同步来的账号不在本机续期。Plus 的国内版和国际版定时暂停。",
  unavailable: "无法读取本机的同步设置。"
};
const syncSection = $("sync-settings"), syncForm = $("settings-form");
const syncRoles = syncSection?.querySelectorAll('input[name="sync-role"]') || [];
const syncRole = () => [...syncRoles].find(input => input.checked)?.value;
const syncPicks = () => [...($("sync-accounts")?.querySelectorAll("input:checked") || [])].map(input => input.value);
function paintSyncRole(role) {
  $("sync-role-hint").textContent = syncHints[role] || syncHints.unavailable;
  $("sync-account-row").hidden = role !== "master";
}

function fillSync(sync) {
  if (!syncSection) return;
  syncSection.hidden = !sync;
  if (!sync) return;
  const ack = sync.reply;
  if (syncPending?.id && ack?.id === syncPending.id) {
    syncPending = null;
    syncEdited = false;
    edited = false;
    saveNote(ack.error === "empty" ? "请至少选择一个要共享的账号。" : ack.error ? "无法保存账号同步设置，请刷新账号后重试。" : "已保存账号同步设置。", !!ack.error);
  }
  for (const input of syncRoles) {
    input.disabled = !sync.target;
    if (!syncEdited) input.checked = input.value === sync.role;
  }
  const list = $("sync-accounts"), choices = sync.choices || [], key = JSON.stringify([choices, sync.picks]);
  if (!syncEdited && syncChoicesKey !== key) {
    syncChoicesKey = key;
    list.replaceChildren(...choices.map(account => {
      const label = document.createElement("label"), input = document.createElement("input"), name = document.createElement("span"), type = document.createElement("small");
      label.className = "sync-account";
      input.type = "checkbox";
      input.value = account.id;
      input.checked = sync.picks.includes(account.id);
      name.textContent = account.name;
      type.textContent = account.realm === "intl" ? "国际版" : "国内版";
      label.append(input, name, type);
      return label;
    }));
    if (!choices.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "没有可共享的账号。请在 Magpie 用浏览器登录 WorkBuddy。";
      list.append(empty);
    }
  }
  paintSyncRole(syncRole());
  const code = sync.code;
  const [title, hint, tone] = ({
    off: ["未启用", "", ""],
    unavailable: ["无法读取同步设置", "", "warn"],
    waiting: sync.role === "follower" ? ["等候主机发布", "主机发布后，本机会自动接收账号。", ""] : ["正在等候发布", "", ""],
    published: [`已发布 ${sync.count} 个账号`, "", "ok"],
    received: [`已接收 ${sync.count} 个账号${sync.skipped ? `，跳过 ${sync.skipped} 个` : ""}`, sync.skipped ? "已在本机登录的账号未被覆盖。" : "", sync.skipped ? "warn" : "ok"],
    unconfigured: ["未配置 GitHub 同步", "请先在 Magpie 的同步设置中配置 GitHub。", "warn"],
    missing: ["找不到要共享的账号", "请检查主机登录状态，或重新选择共享账号。", "warn"],
    "other-master": ["已有其他主机", "请先在原主机关闭同步，等候旧主机停止发布后再试。", "warn"],
    failed: ["同步失败", "请检查 Magpie 的 GitHub 同步配置与网络；本机会重试。", "warn"]
  })[code] || ["未启用", "", ""];
  $("sync-result").dataset.tone = tone;
  $("sync-result-title").textContent = title;
  $("sync-result-hint").textContent = hint;
  $("sync-result-hint").hidden = !hint;
  const time = $("sync-result-time");
  time.hidden = !sync.at;
  if (sync.at) { time.dateTime = new Date(sync.at).toISOString(); time.textContent = WBBoard.when(sync.at); }
}
if (syncSection) syncSection.addEventListener("change", () => { syncEdited = true; paintSyncRole(syncRole()); });

const kinds = ["daily", "tasks", "sweep", "night"], intlKinds = ["daily", "web"];
let edited = false, initialSettings;
function fill(view) {
  const form = $("settings-form");
  if (!view?.settings || edited) return;
  for (const k of kinds) form.elements[k].value = (view.schedules?.[k] || []).join(", ");
  for (const k of intlKinds) form.elements[`intl-${k}`].value = (view.intlSchedules?.[k] || []).join(", ");
  const pick = form.elements["intl-model"], wanted = view.settings.intlWebModel || "auto", host = $("intl-model-pick");
  if (!host.firstChild?.open) {
    pick.value = wanted;
    host.replaceChildren(WBBoard.picker(pick, WBBoard.modelChoices(view.models?.intl?.models, wanted), () => { edited = true; }));
  }
  form.elements["intl-web-on"].checked = view.settings.intlWeb !== false;
  form.elements["campaign-app"].checked = view.settings.campaignApp === true;
  form.elements["skill-share"].checked = view.settings.skillShare !== false;
  form.elements["buddy-auto"].checked = view.settings.buddyAuto === true;
  form.elements.spread.value = view.settings.spread;
  form.elements.timezone.value = view.settings.timezone || "";
  form.elements.proxy.value = view.settings.proxy || "";
  if (form.elements.intlProxy) form.elements.intlProxy.value = view.settings.intlProxy || "";
  initialSettings = readSettings(form);
}
$("settings-form").oninput = $("settings-form").onchange = () => { edited = true; };

function settings(open) {
  document.body.classList.toggle("in-settings", open);
  $("settings").hidden = !open;
  if (!open) {
    if (edited) { edited = false; fill(globalThis.WBPLUS); }
    if (syncEdited && !syncPending) { syncEdited = false; syncChoicesKey = undefined; fillSync(globalThis.WBPLUS?.sync); }
    saveNote("");
  }
  (open ? $("close-settings") : $("open-settings")).focus();
}
$("open-settings").onclick = () => settings(true);
$("close-settings").onclick = () => settings(false);
if ($("sched-pill")) $("sched-pill").onclick = () => { settings(false); WBBoard.goTab("schedule"); };

async function sendOptions(changes) {
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Magpie 没有响应，请重试")), 10_000); });
  try { await Promise.race([(async () => {
    const options = (await magpie.options.get()) || {};
    await magpie.options.set({ ...options, ...changes });
  })(), guard]); } finally { clearTimeout(timer); }
}

async function ask(action, extra = {}) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await sendOptions({ request: { id, action, at: Date.now(), ...extra } });
  pending = id;
  note(`${names[action]}：已提交，等待 Magpie 重载插件…`);
  setTimeout(reload, 2000);
}

function readSettings(form) {
  const { scheduleTimes } = WBBoard, fields = form.elements;
  return {
    schedules: Object.fromEntries(kinds.map(k => [k, scheduleTimes(fields[k].value)])),
    intlSchedules: Object.fromEntries(intlKinds.map(k => [k, scheduleTimes(fields[`intl-${k}`].value)])),
    intlWebModel: fields["intl-model"].value || "auto", intlWeb: fields["intl-web-on"].checked,
    campaignApp: fields["campaign-app"].checked, skillShare: fields["skill-share"].checked, buddyAuto: fields["buddy-auto"].checked,
    spread: Number(fields.spread.value || 0), timezone: fields.timezone.value.trim(), proxy: fields.proxy.value.trim(),
    ...(fields.intlProxy ? { intlProxy: fields.intlProxy.value.trim() } : {})
  };
}

// Magpie's iframe allows scripts but blocks native form submission.
$("save-settings").onclick = async event => {
  const form = syncForm, button = event.currentTarget;
  if (syncPending) return;
  if (!form.reportValidity()) return;
  const config = readSettings(form);
  const bad = [...Object.values(config.schedules), ...Object.values(config.intlSchedules)].flat().find(t => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t));
  if (bad) return saveNote(`时间「${bad}」不对，应为 HH:MM，例如 09:00`, true);
  if (config.intlProxy && config.intlProxy !== "direct" && !/^https?:\/\//.test(config.intlProxy)) return saveNote("国际版代理需要 http:// 或 https:// 地址，或留空 / direct", true);
  const sync = globalThis.WBPLUS?.sync, role = syncRole(), picks = role === "master" ? syncPicks() : [];
  const syncChanged = syncEdited && sync?.target && (role !== sync.role || picks.slice().sort().join("\0") !== sync.picks.slice().sort().join("\0"));
  if (syncChanged && role === "master" && !picks.length) return saveNote("请至少选择一个要共享的账号。", true);
  const changes = WBBoard.settingsChanges(initialSettings, config);
  button.disabled = true;
  saveNote("正在保存…");
  try {
    if (syncChanged) {
      // getRandomValues is available even if the host's sandbox is not a secure context.
      const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
      const id = hex.replace(/^(........)(....)(....)(....)/, "$1-$2-$3-$4-"), at = Date.now();
      syncPending = { id };
      await sendOptions({ ...(Object.keys(changes).length ? { request: { id, action: "config", at, config: changes } } : {}), syncRequest: { id, at, target: sync.target, role, picks } });
      setTimeout(reload, 2000);
      setTimeout(() => {
        if (syncPending?.id === id) { syncPending = null; saveNote("还没收到 Magpie 的保存结果，可以重试。", true); }
      }, 120_000);
    } else {
      await ask("config", { config: changes });
      initialSettings = config;
      edited = false;
      settings(false);
    }
  }
  catch (e) { syncPending = null; saveNote(`提交失败：${e.message}`, true); }
  finally { setTimeout(() => { button.disabled = false; }, 3000); }
};

function reload() {
  const script = document.createElement("script");
  script.src = `data.js?t=${Date.now()}`;
  script.onload = script.onerror = () => {
    script.remove();
    if (globalThis.WBPLUS?.build && globalThis.WBPLUS.build !== build) return location.reload();
    paint();
  };
  document.head.append(script);
}

const menus = [...document.querySelectorAll("details.run-menu")];
document.addEventListener("click", event => { for (const m of menus) if (!m.contains(event.target)) m.open = false; });
document.addEventListener("keydown", event => { if (event.key !== "Escape") return; if (!$("settings").hidden && !menus.some(m => m.open) && !document.querySelector(".wb-pick[open]")) return settings(false); for (const m of menus) if (m.open) { m.open = false; m.querySelector("summary").focus(); } });

for (const button of document.querySelectorAll("[data-action]")) button.onclick = async () => {
  const action = button.dataset.action;
  for (const m of menus) m.open = false;
  button.disabled = true;
  try { await ask(action); } catch (e) { note(`提交失败：${e.message}`, true); }
  finally { setTimeout(() => { button.disabled = false; }, 3000); }
};

paint();
setInterval(reload, 15_000);
