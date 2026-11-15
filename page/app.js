// Magpie's page is sandboxed with no network: it reads data.js, which the
// background service rewrites, and asks for work by saving a request into
// the plugin's options (see index.mjs).
const $ = id => document.getElementById(id);
const names = { all: "全部跑一遍", activity: "连登活跃", tasks: "成长任务", travel: "猫猫旅行", bonus: "连登福利", night: "夜猫子", keepalive: "登录续期", inspect: "查询状态", web: "国际版网页会话", refresh: "刷新余额", login: "添加国内版账号", "login-intl": "添加国际版账号", pause: "暂停国内版定时", resume: "开启国内版定时", "intl-on": "开启国际版定时", "intl-off": "暂停国际版定时", config: "保存设置" };
const statuses = { running: "执行中", queued: "排队中", succeeded: "已完成", failed: "有失败", deferred: "稍后重试", interrupted: "中断", cancelled: "已停止" };
let pending = null;
const build = globalThis.WBPLUS?.build;

function note(text, bad) { $("note").textContent = text; $("note").className = bad ? "note bad" : "note"; $("note").hidden = !text; }


function paint() {
  const view = globalThis.WBPLUS;
  const offline = !view || Date.now() - Date.parse(view.generated) > 25 * 60_000;
  $("state").textContent = !view ? "后台服务还没有写出数据：Magpie 加载本插件时会启动它。一直这样的话，看 ~/.config/workbuddy-plus/service.log；Windows 上常见原因是端口被系统保留，见 README 的「端口」一节。"
    : `${view.refreshing ? "正在刷新…" : `余额更新于 ${WBBoard.when(view.at)}`}${offline ? " · 后台服务可能未运行" : ""}`;
  if (view?.panel) $("panel").textContent = view.panel;
  // WorkBuddy AI's settings show once one of its logins is on the board.
  for (const node of document.querySelectorAll(".intl-only")) node.hidden = !view?.intl?.accounts;
  $("cn-state").textContent = view ? `· 定时${view.enabled ? "已开启" : "已暂停"}` : "";
  $("intl-state").textContent = view ? `· 定时${view.intlEnabled ? "已开启" : "已暂停"}` : "";
  // Each build's schedule switch lives on its row in 今日定时.
  WBBoard.render($("board"), view, Date.now(), { onSchedule: (intl, on) => ask(intl ? (on ? "intl-on" : "intl-off") : (on ? "resume" : "pause")).catch(e => note(`提交失败：${e.message}`, true)) });
  fill(view);
  $("jobs").replaceChildren();
  if (view && !view.jobs?.length) $("jobs").append(Object.assign(document.createElement("p"), { className: "muted", textContent: "还没有执行记录" }));
  for (const job of view?.jobs || []) {
    const row = document.createElement("div"), cells = [[statuses[job.status] || job.status, job.status], [job.actions.map(a => names[a] || a).join(" / ")], [WBBoard.when(Date.parse(job.created))], [job.last, "last"]];
    row.className = "job";
    for (const [text, className] of cells) { const span = document.createElement("span"); span.textContent = text; if (className) span.className = className; row.append(span); }
    $("jobs").append(row);
  }
  const done = view?.request;
  if (pending && done?.id === pending) {
    pending = null;
    note(done.ok ? `${names[done.action] || done.action}：已交给后台服务` : `${names[done.action] || done.action}：${done.error}`, !done.ok);
  }
}

// The settings form follows the saved settings until it's edited; an edit is
// kept through the redraws until it's saved.
const kinds = ["daily", "tasks", "night", "keepalive"], intlKinds = ["daily", "web", "keepalive"];
let edited = false;
function fill(view) {
  const form = $("settings-form");
  if (!view?.settings || edited) return;
  for (const k of kinds) form.elements[k].value = (view.schedules?.[k] || []).join(", ");
  for (const k of intlKinds) form.elements[`intl-${k}`].value = (view.intlSchedules?.[k] || []).join(", ");
  // The web conversation's model: automatic, or one of WorkBuddy AI's own.
  // An open menu is left alone: the page redraws every 15 seconds.
  const pick = form.elements["intl-model"], wanted = view.settings.intlWebModel || "auto", host = $("intl-model-pick");
  if (!host.firstChild?.open) {
    pick.value = wanted;
    host.replaceChildren(WBBoard.picker(pick, WBBoard.modelChoices(view.models?.intl?.models, wanted), () => { edited = true; }));
  }
  form.elements["intl-web-on"].checked = view.settings.intlWeb !== false;
  form.elements.spread.value = view.settings.spread;
  form.elements.timezone.value = view.settings.timezone || "";
  form.elements.proxy.value = view.settings.proxy || "";
}
$("settings-form").oninput = $("settings-form").onchange = () => { edited = true; };

// 设置 opens in place of the board; 返回 or Escape goes back. An edit not
// saved is let go, so the form shows the saved settings next time.
function settings(open) {
  document.body.classList.toggle("in-settings", open);
  $("settings").hidden = !open;
  if (!open && edited) { edited = false; fill(globalThis.WBPLUS); }
  (open ? $("close-settings") : $("open-settings")).focus();
}
$("open-settings").onclick = () => settings(true);
$("close-settings").onclick = () => settings(false);

async function ask(action, extra = {}) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const options = (await magpie.options.get()) || {};
  await magpie.options.set({ ...options, request: { id, action, at: Date.now(), ...extra } });
  pending = id;
  note(`${names[action]}：已提交，等待 Magpie 重载插件…`);
  setTimeout(reload, 2000);
}

$("settings-form").onsubmit = async event => {
  event.preventDefault();
  const form = event.target, button = form.querySelector("button");
  const times = v => [...new Set(v.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean))].sort();
  const config = { schedules: Object.fromEntries(kinds.map(k => [k, times(form.elements[k].value)])), intlSchedules: Object.fromEntries(intlKinds.map(k => [k, times(form.elements[`intl-${k}`].value)])), intlWebModel: form.elements["intl-model"].value || "auto", intlWeb: form.elements["intl-web-on"].checked, spread: Number(form.elements.spread.value || 0), timezone: form.elements.timezone.value.trim(), proxy: form.elements.proxy.value.trim() };
  const bad = [...Object.values(config.schedules), ...Object.values(config.intlSchedules)].flat().find(t => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t));
  if (bad) return note(`时间「${bad}」不对，应为 HH:MM，例如 09:00`, true);
  button.disabled = true;
  try { await ask("config", { config }); edited = false; settings(false); }
  catch (e) { note(`提交失败：${e.message}`, true); }
  finally { setTimeout(() => { button.disabled = false; }, 3000); }
};

// The page may load only its own files, so data.js is fetched again as a script.
function reload() {
  const script = document.createElement("script");
  script.src = `data.js?t=${Date.now()}`;
  script.onload = script.onerror = () => {
    script.remove();
    // The plugin was updated while this page stayed open: load the new scripts.
    if (globalThis.WBPLUS?.build && globalThis.WBPLUS.build !== build) return location.reload();
    paint();
  };
  document.head.append(script);
}

// A menu closes once something is picked, on a click outside it, or on Escape.
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
