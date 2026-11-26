// Magpie's page is sandboxed with no network: it reads data.js, which the
// background service rewrites, and asks for work by saving a request into
// the plugin's options (see index.mjs).
const $ = id => document.getElementById(id);
const names = { all: "执行所有任务", "pause-tasks": "暂停任务", "resume-tasks": "恢复任务", activity: "连登活跃", tasks: "成长任务", sweep: "补领奖励", task: "执行单任务", travel: "猫猫旅行", bonus: "连登福利", night: "夜猫子", inspect: "查询状态", web: "国际版网页会话", refresh: "刷新余额", login: "添加国内版账号", "login-intl": "添加国际版账号", pause: "暂停国内版定时", resume: "开启国内版定时", "intl-on": "开启国际版定时", "intl-off": "暂停国际版定时", retry: "重试失败任务", cancel: "停止执行", config: "保存设置" };
let pending = null;
let syncPending, syncEdited = false, syncChoicesKey, syncClearing = false;
const build = globalThis.WBPLUS?.build;
const upgradeHint = "后台是旧版本，请重启电脑后重试。独立安装请重新运行新版安装脚本。";
const saveButton = $("save-settings");
let blocked = "", saving = false;

function note(text, bad) { $("note").textContent = text; $("note").className = bad ? "note bad" : "note"; $("note").hidden = !text; }
const saveHint = "保存后由 Magpie 重载插件交给后台服务。";
function saveNote(text, bad) {
  const status = $("save-status");
  if (!status) return;
  status.textContent = text || saveHint;
  status.classList.toggle("bad", !!bad);
}

function syncRequestId() {
  // getRandomValues is available even if the host's sandbox is not a secure context.
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
  return hex.replace(/^(........)(....)(....)(....)/, "$1-$2-$3-$4-");
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

function paintView(view, canSave) {
  const offline = !view || Date.now() - Date.parse(view.generated) > 25 * 60_000;
  $("state").textContent = !view ? "后台服务还没有写出数据：Magpie 加载本插件时会启动它。一直这样的话，看 ~/.config/workbuddy-plus/service.log；Windows 上常见原因是端口被系统保留，见 README 的「端口」一节。"
    : view.handoff === "old" ? "后台尚未完成升级" : `${view.refreshing ? "正在刷新…" : `余额更新于 ${WBBoard.when(view.at)}`}${offline ? " · 后台服务可能未运行" : ""}`;
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

  if (canSave) fill(view);
  else {
    edited = false;
    initialSettings = undefined;
    fillTimes(view, syncForm, true);
  }
  fillSync(view?.sync);
  const done = view?.request;
  if (pending && done?.id === pending) {
    pending = null;
    note(done.ok ? `${names[done.action] || done.action}：已交给后台服务` : `${names[done.action] || done.action}：${done.error}`, !done.ok);
  }
}

function paint() {
  const view = globalThis.WBPLUS, previous = blocked;
  blocked = !view ? "还没有读到后台设置，请稍等再试"
    : !view.version || view.handoff === "old" || !view.settings || !view.schedules || !view.intlSchedules ? upgradeHint : "";
  try { paintView(view, !blocked); }
  catch (error) {
    console.error("[workbuddy-plus]", error);
    blocked ||= "无法显示后台数据，请刷新后重试。";
  }
  saveButton.disabled = saving || !!blocked || !!syncPending;
  if (blocked) {
    if (view) note(blocked, true);
    saveNote(blocked === upgradeHint ? "后台升级后才能保存设置。" : blocked, true);
  } else if (previous) {
    if ($("note").textContent === previous) note("");
    saveNote("");
  }
}

const syncHints = {
  off: "本机不发布或接收账号。定时按原设置运行。",
  master: "本机发布所选账号，其他设备自动接收。",
  follower: "本机接收主机发布的账号，不覆盖本机登录，也不运行 Plus 定时。",
  unavailable: "无法读取本机的同步设置。"
};
const syncSection = $("sync-settings"), syncForm = $("settings-form");
const syncRoles = syncSection?.querySelectorAll('input[name="sync-role"]') || [];
const syncRole = () => [...syncRoles].find(input => input.checked)?.value;
const syncPicks = () => [...($("sync-accounts")?.querySelectorAll("input:checked") || [])].map(input => input.value);
function paintSyncRole(role) {
  $("sync-role-hint").textContent = syncHints[role] || syncHints.unavailable;
  $("sync-account-row").hidden = role !== "master";
  $("sync-actions").hidden = !role || role === "off" || role === "unavailable";
  $("sync-switch-master").hidden = role !== "follower";
  $("sync-switch-hint").hidden = role !== "follower";
}

function paintSyncActions(sync) {
  const role = sync?.role, off = !role || role === "off" || role === "unavailable";
  const supports = sync?.actions || {}, pending = !!syncPending, busy = syncPending?.kind === "now";
  const now = $("sync-now");
  now.hidden = supports.now !== true;
  now.disabled = off || syncEdited || pending || !!blocked || now.hidden;
  now.setAttribute("aria-busy", String(busy));
  now.textContent = busy ? "同步中…" : "立即同步";
  now.title = off ? "先选择主机或从机" : syncEdited ? "先保存账号同步设置" : "按已保存的角色立即同步一次";
  const master = role === "master";
  const canClear = master && supports.clear === true && Array.isArray(sync?.picks) && sync.picks.length > 0;
  const clear = $("sync-clear");
  clear.hidden = !canClear;
  clear.disabled = !canClear || syncEdited || pending || !!blocked;
  const cleared = master && sync?.code === "cleared";
  const hint = $("sync-clear-hint");
  hint.hidden = !(cleared || (canClear && syncEdited));
  hint.textContent = cleared ? "共享账号已清空。重新勾选账号并保存可恢复共享。" : "请先保存账号勾选，再清除共享。";
  $("sync-clear-confirm-panel").hidden = !syncClearing;
  $("sync-actions").hidden = off || (now.hidden && $("sync-switch-master").hidden);
  saveButton.disabled = saving || !!blocked || pending;
}

function syncWhen(ms) {
  const label = WBBoard.when(ms);
  return new Date(ms).toDateString() === new Date().toDateString() ? `今天 ${label.split(" ").at(-1)}` : label;
}

function paintSyncDevices(sync) {
  const snapshot = sync.snapshot, devices = sync.devices || [];
  const details = $("sync-snapshot");
  const owner = snapshot?.local ? "本机" : snapshot?.name;
  const lease = snapshot ? snapshot.online ? `当前主机是${owner}，租约至 ${syncWhen(snapshot.until)}。第 ${snapshot.generation} 代快照。`
    : `上次主机是${owner}，租约已到期。第 ${snapshot.generation} 代快照。` : "";
  details.textContent = lease + (sync.applied ? `本机已应用第 ${sync.applied} 代。` : "");
  details.hidden = !details.textContent;
  $("sync-device-row").hidden = !["master", "follower"].includes(sync.role);
  const hint = $("sync-device-hint");
  hint.textContent = sync.heartbeatFailed ? "本机未能上报心跳，其他设备可能看不到本机。"
    : sync.devicesUnavailable || sync.code === "failed" ? "暂时无法读取全部设备状态，本机会重试。"
    : devices.length ? "" : "暂未发现同步设备。";
  hint.hidden = !hint.textContent;
  $("sync-devices").replaceChildren(...devices.map(device => {
    const row = document.createElement("li"), identity = document.createElement("div"), value = document.createElement("div");
    const name = document.createElement("div"), role = document.createElement("small"), online = document.createElement("div");
    row.className = "sync-device";
    name.className = "sync-device-name";
    name.textContent = device.name;
    role.textContent = [device.role === "master" ? "主机" : "从机", device.local ? "本机" : "", device.role === "follower" && device.generation ? `已应用第 ${device.generation} 代` : ""].filter(Boolean).join("，");
    identity.append(name, role);
    value.className = "sync-device-value";
    online.className = "sync-device-state";
    online.dataset.online = String(device.online);
    online.textContent = device.online ? "在线" : "离线";
    value.append(online);
    if (device.seen) {
      const time = document.createElement("time"), minutes = Math.max(0, Math.floor((Date.now() - device.seen) / 60_000));
      time.dateTime = new Date(device.seen).toISOString();
      time.title = `${device.role === "master" ? "最近续租" : "最后心跳"}：${WBBoard.when(device.seen)}`;
      time.textContent = !minutes ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
      value.append(time);
    }
    row.append(identity, value);
    return row;
  }));
}

function fillSync(sync) {
  if (!syncSection) return;
  syncSection.hidden = !sync;
  if (!sync) return;
  const ack = sync.reply;
  if (syncPending?.id && ack?.id === syncPending.id) {
    const kind = syncPending.kind || "save";
    syncPending = null;
    syncClearing = false;
    if (kind === "save") { syncEdited = false; edited = false; }
    else if (kind === "clear") syncEdited = false;
    const message = ack.error
      ? kind === "clear" ? "无法清除共享账号，请刷新后重试。"
        : kind === "now" ? "无法立即同步，请刷新后重试。"
          : ack.error === "empty" ? "请至少选择一个要共享的账号。"
            : "无法保存账号同步设置，请刷新账号后重试。"
      : kind === "clear" ? "已清除共享账号。请保持同步开启，直到所有设备都同步过。"
        : kind === "now" ? "已提交立即同步。"
          : "已保存账号同步设置。";
    saveNote(message, !!ack.error);
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
      if (account.kind === "enterprise" || account.kind === "api") {
        const kind = document.createElement("small");
        kind.textContent = account.kind === "enterprise" ? " 企业" : " API Key";
        name.append(kind);
      }
      type.textContent = account.realm === "intl" ? "国际版" : "国内版";
      label.append(input, name, type);
      return label;
    }));
    if (!choices.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "没有可共享的账号。请先在 Magpie 登录或添加 WorkBuddy API Key。";
      list.append(empty);
    }
  }
  paintSyncRole(syncRole());
  $("sync-switch-master").disabled = !sync.target || !choices.length;
  const code = sync.code;
  const [title, hint, tone] = ({
    off: ["未启用", "", ""],
    unavailable: ["无法读取同步设置", "", "warn"],
    waiting: sync.role === "follower" ? ["等候主机发布", "主机发布后，本机会自动接收账号。", ""] : ["正在等候发布", "", ""],
    published: [`已发布 ${sync.count} 个账号`, "", "ok"],
    received: [`已接收 ${sync.count} 个账号${sync.skipped ? `，跳过 ${sync.skipped} 个` : ""}`, sync.skipped ? "已在本机登录的账号未被覆盖。" : "", sync.skipped ? "warn" : "ok"],
    cleared: sync.role === "follower" ? ["主机已清除共享", "本机已移除由同步导入的账号。", "warn"]
      : ["已清除共享", "从机会在下次同步时移除导入的账号。保持同步开启，直到所有设备都同步过，再关闭同步。", "warn"],
    unconfigured: ["未配置可用的同步存储", "请在 Magpie 的同步设置中检查 GitHub、WebDAV 或 S3 和同步口令。", "warn"],
    missing: ["找不到要共享的账号", "请检查主机登录状态，或重新选择共享账号。", "warn"],
    "other-master": ["已有其他主机", "请先在原主机关闭同步，等候旧主机停止发布后再试。", "warn"],
    failed: ["同步失败", "请检查 Magpie 的同步配置、存储权限与网络；本机会重试。", "warn"]
  })[code] || ["未启用", "", ""];
  $("sync-result").dataset.tone = tone;
  $("sync-result-title").textContent = title;
  $("sync-result-hint").textContent = hint;
  $("sync-result-hint").hidden = !hint;
  const time = $("sync-result-time");
  time.hidden = !sync.at;
  if (sync.at) { time.dateTime = new Date(sync.at).toISOString(); time.textContent = syncWhen(sync.at); }
  paintSyncDevices(sync);
  paintSyncActions(sync);
}
if (syncSection) {
  syncSection.addEventListener("change", () => {
    syncEdited = true;
    syncClearing = false;
    paintSyncRole(syncRole());
    paintSyncActions(globalThis.WBPLUS?.sync);
  });
  $("sync-switch-master").onclick = () => {
    const master = [...syncRoles].find(input => input.value === "master");
    master.click();
    master.focus();
  };
  $("sync-clear").onclick = () => {
    if (blocked || syncPending || syncEdited) return;
    const sync = globalThis.WBPLUS?.sync;
    if (!sync?.target) return;
    syncClearing = true;
    paintSyncActions(sync);
    $("sync-clear-cancel").focus();
  };
  $("sync-clear-cancel").onclick = () => {
    syncClearing = false;
    paintSyncActions(globalThis.WBPLUS?.sync);
    $("sync-clear").focus();
  };
  $("sync-clear-confirm").onclick = async () => {
    if (blocked || syncPending || syncEdited) return;
    const sync = globalThis.WBPLUS?.sync;
    if (!sync?.target) return;
    const id = syncRequestId(), at = Date.now();
    syncClearing = false;
    syncPending = { id, kind: "clear" };
    saveNote("正在清除共享…");
    paintSyncActions(sync);
    try {
      await sendOptions({ syncRequest: { id, at, target: sync.target, role: "master", picks: [], clear: true } });
    } catch (e) {
      syncPending = null;
      saveNote(`提交失败：${e.message}`, true);
      paintSyncActions(sync);
      return;
    }
    setTimeout(reload, 2000);
    setTimeout(() => {
      if (syncPending?.id === id) {
        syncPending = null;
        saveNote("还没收到 Magpie 的清除结果，可以重试。", true);
        paintSyncActions(globalThis.WBPLUS?.sync);
      }
    }, 120_000);
  };
  $("sync-now").onclick = async () => {
    if (blocked || syncPending || syncEdited) return;
    const sync = globalThis.WBPLUS?.sync;
    if (!sync?.target || !["master", "follower"].includes(sync.role)) return;
    const id = syncRequestId(), at = Date.now();
    syncPending = { id, kind: "now" };
    saveNote("正在请求同步…");
    paintSyncActions(sync);
    try { await sendOptions({ syncRequest: { id, at, target: sync.target, now: true } }); }
    catch (e) {
      syncPending = null;
      saveNote(`提交失败：${e.message}`, true);
      paintSyncActions(sync);
      return;
    }
    setTimeout(reload, 2000);
    setTimeout(() => {
      if (syncPending?.id === id) {
        syncPending = null;
        saveNote("还没收到 Magpie 的同步结果，可以重试。", true);
        paintSyncActions(globalThis.WBPLUS?.sync);
      }
    }, 120_000);
  };
}

const kinds = ["daily", "tasks", "sweep", "night"], intlKinds = ["daily", "web"];
let edited = false, initialSettings;
function fillTimes(view, form, readOnly) {
  const fillTime = (name, times) => {
    const input = form.elements[name];
    input.value = Array.isArray(times) ? times.join(", ") : "";
    input.readOnly = readOnly;
  };
  for (const k of kinds) fillTime(k, view?.schedules?.[k]);
  for (const k of intlKinds) fillTime(`intl-${k}`, view?.intlSchedules?.[k]);
}
function fill(view) {
  const form = $("settings-form");
  if (!view?.settings || edited) return;
  fillTimes(view, form, false);
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
    syncClearing = false;
    $("sync-clear-confirm-panel").hidden = true;
    if (edited) { edited = false; if (!blocked) fill(globalThis.WBPLUS); }
    if (syncEdited && !syncPending) { syncEdited = false; syncChoicesKey = undefined; fillSync(globalThis.WBPLUS?.sync); }
    if (!blocked) saveNote("");
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
  if (blocked && ["config", "pause", "resume", "intl-on", "intl-off", "pause-tasks", "resume-tasks"].includes(action)) throw new Error(blocked);
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
saveButton.onclick = async () => {
  const form = syncForm;
  if (blocked || saving || syncPending || !initialSettings) return;
  if (!form.reportValidity()) return;
  const config = readSettings(form);
  const bad = [...Object.values(config.schedules), ...Object.values(config.intlSchedules)].flat().find(t => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t));
  if (bad) return saveNote(`时间「${bad}」不对，应为 HH:MM，例如 09:00`, true);
  if (config.intlProxy && config.intlProxy !== "direct" && !/^https?:\/\//.test(config.intlProxy)) return saveNote("国际版代理需要 http:// 或 https:// 地址，或留空 / direct", true);
  const sync = globalThis.WBPLUS?.sync, role = syncRole(), picks = role === "master" ? syncPicks() : [];
  const syncChanged = syncEdited && sync?.target && (role !== sync.role || picks.slice().sort().join("\0") !== sync.picks.slice().sort().join("\0"));
  if (syncChanged && role === "master" && !picks.length) return saveNote("请至少选择一个要共享的账号。", true);
  const changes = WBBoard.settingsChanges(initialSettings, config);
  saving = saveButton.disabled = true;
  saveNote("正在保存…");
  try {
    if (syncChanged) {
      const id = syncRequestId(), at = Date.now();
      syncPending = { id, kind: "save" };
      await sendOptions({ ...(Object.keys(changes).length ? { request: { id, action: "config", at, config: changes } } : {}), syncRequest: { id, at, target: sync.target, role, picks } });
      setTimeout(reload, 2000);
      setTimeout(() => {
        if (syncPending?.id === id) {
          syncPending = null;
          saveNote("还没收到 Magpie 的保存结果，可以重试。", true);
          paintSyncActions(globalThis.WBPLUS?.sync);
        }
      }, 120_000);
    } else {
      await ask("config", { config: changes });
      initialSettings = config;
      edited = false;
      settings(false);
    }
  }
  catch (e) { syncPending = null; saveNote(`提交失败：${e.message}`, true); }
  finally { setTimeout(() => { saving = false; saveButton.disabled = !!blocked || !!syncPending; }, 3000); }
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
