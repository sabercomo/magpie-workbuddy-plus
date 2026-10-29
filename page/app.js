// Magpie's page is sandboxed with no network: it reads data.js, which the
// background service rewrites, and asks for work by saving a request into
// the plugin's options (see index.mjs).
const $ = id => document.getElementById(id);
const names = { all: "全部执行", activity: "连登活跃", tasks: "成长任务", travel: "猫猫旅行", bonus: "连登福利", night: "夜猫子", keepalive: "登录续期", inspect: "查询状态", refresh: "刷新", pause: "暂停定时", resume: "开启定时" };
const statuses = { running: "执行中", queued: "排队中", succeeded: "已完成", failed: "有失败", interrupted: "中断", cancelled: "已停止" };
let pending = null;
const build = globalThis.WBPLUS?.build;

function note(text, bad) { $("note").textContent = text; $("note").className = bad ? "note bad" : "note"; $("note").hidden = !text; }

function paint() {
  const view = globalThis.WBPLUS;
  const offline = !view || Date.now() - Date.parse(view.generated) > 25 * 60_000;
  $("state").textContent = !view ? "后台服务还没有写出数据：用 bun install.mjs 安装后台服务，或调用一次本插件的 status 工具启动它。"
    : `${view.refreshing ? "正在刷新…" : `余额更新于 ${WBBoard.when(view.at)}`} · ${view.enabled ? "定时运行中" : "定时已暂停"}${offline ? " · 后台服务可能未运行" : ""}`;
  $("schedule").dataset.action = view?.enabled ? "pause" : "resume";
  $("schedule").textContent = view?.enabled ? "暂停定时" : "开启定时";
  WBBoard.render($("board"), view);
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

for (const button of document.querySelectorAll("[data-action]")) button.onclick = async () => {
  const action = button.dataset.action, id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  button.disabled = true;
  try {
    const options = (await magpie.options.get()) || {};
    await magpie.options.set({ ...options, request: { id, action, at: Date.now() } });
    pending = id;
    note(`${names[action]}：已提交，等待 Magpie 重载插件…`);
    setTimeout(reload, 2000);
  } catch (e) { note(`提交失败：${e.message}`, true); }
  finally { setTimeout(() => { button.disabled = false; }, 3000); }
};

paint();
setInterval(reload, 15_000);
