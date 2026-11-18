// Local preview fixtures. No network, account data, or persistent settings.
const $ = s => document.querySelector(s);
const q = new URLSearchParams(location.search);
const now = Date.parse("2026-11-17T14:42:00+08:00");
const openedAt = performance.now();
const accounts = [
  { id:"old", name:"旧账号", realm:"国内个人", state:"expired", hint:"请到 Magpie「供应商」重新登录", last:"11/16 21:12", fails:0, next:"等待登录" },
  { id:"task", name:"测试号", realm:"国内个人", state:"failed", hint:"成长任务上报连续失败", last:"11/14 09:11", fails:3, next:"等待处理", comp:"none", lastRun:"report" },
  { id:"roam", name:"旅行号", realm:"国内个人", state:"limited", hint:"上游请求暂时限流", last:"今天 09:04", fails:1, cool:514, next:"21:01 活跃", comp:"error", energy:8, boxes:0, travel:"栗子正在旅行 · 18:40 归来" },
  { id:"global", name:"海外号", realm:"国际个人", state:"spent", hint:"DeepSeek 单模型额度用完", last:"今天 10:32", fails:0, cool:4680, next:"21:01 活跃" },
  { id:"standby", name:"备用号", realm:"国内个人", state:"soon", hint:"访问凭证预计 16:00 到期", last:"今天 10:01", fails:0, next:"21:01 活跃", comp:"pending", credit:500, energy:15, boxes:1, cap:1, travel:"年糕在家" },
  { id:"main", name:"主力号", realm:"国内个人", state:"ok", hint:"续期和任务运行正常", last:"今天 14:38", fails:0, next:"21:01 活跃", comp:"pending", credit:500, energy:36, boxes:3, cap:2, travel:"团子在家" },
  { id:"spare", name:"闲置号", realm:"国内个人", state:"ok", paused:true, hint:"保留看板和续期", last:"今天 09:01", fails:0, next:"21:11 成长", comp:"claimed", credit:500 },
  { id:"org", name:"公司账号", realm:"企业", state:"ok", disabled:true, hint:"在设置中管理停用账号", last:"11/15 22:01", fails:0, next:"已停用" }
];
const jobs = [
  { id:"growth", person:"主力号", title:"成长任务", status:"执行中", tone:"", at:"14:40", done:3, total:5, step:"领取已达标奖励" },
  { id:"travel", person:"备用号", title:"猫猫旅行", status:"排队中", tone:"idle", at:"14:41", done:0, total:3, step:"等待空闲位置" },
  { id:"web", person:"海外号", title:"网页会话", status:"失败", tone:"danger", at:"10:32", done:0, total:1, reason:"上游暂时不可用（HTTP 502）", attempts:[
    ["10:31:02","初次执行","上游暂时不可用（HTTP 502）"],
    ["10:32:07","手动重试","上游仍不可用（HTTP 502）"]
  ] },
  { id:"report", person:"测试号", title:"成长任务", status:"失败", tone:"danger", at:"09:11", reason:"成长任务上报连续 3 天返回 HTTP 400，已停止自动上报", attempts:[
    ["11/15 09:11","定时执行","HTTP 400：上游拒绝上报"],
    ["11/16 09:11","定时执行","HTTP 400：上游拒绝上报"],
    ["今天 09:11","定时执行","HTTP 400：达到暂停标准"]
  ] }
];
const logs = [
  ["14:40:18","任务","主力号","已识别「工作台搭建师」，进入成长任务流程。"],
  ["14:39:51","任务","主力号","领取成长任务奖励 +80 积分。"],
  ["10:32:07","对话","海外号","网页会话失败：上游暂时不可用（HTTP 502）。"],
  ["10:32:01","对话","海外号","手动重试网页会话。"],
  ["10:15:20","系统","旅行号","读取官方补偿失败：请求超时。"],
  ["09:11:52","任务","测试号","连续 3 天上报失败，已停止自动上报。"],
  ["09:01:24","系统","主力号","已刷新账号的登录状态。"]
];
const fixture = globalThis.WBPLUS;
const baseline = fixture.accounts;
const ids = { main:"demo-1", standby:"demo-2", org:"demo-3", global:"intl:demo-4" };
const health = {
  expired:["登录已过期","urgent demo-pill-urgent"], failed:["连续失败","urgent demo-pill-urgent"],
  limited:["限流","demo-pill-issue"], spent:["额度用完","demo-pill-issue"],
  soon:["登录将过期","outline"], ok:["正常","ok"], paused:["任务已暂停","demo-pill-quiet"], off:["已停用","demo-pill-quiet"]
};
for (const a of accounts) {
  a.native = baseline.find(r=>r.id===ids[a.id]) || {
    id:a.id, name:a.name, errors:{}, balance:{balance:0,size:0,packages:[]}
  };
  if (!ids[a.id]) baseline.push(a.native);
  a.native.expires = Date.now() + ({expired:-2,soon:1.3}[a.state] ?? 168)*3600_000;
}
const main = accounts.find(a=>a.id==="main");
const openTasks = main.native.tasks.open;
openTasks.push(
  {code:"workstation_expert",title:"工作台搭建师",state:"auto",current:0,target:1,credit:80},
  {code:"expert_use_library",title:"知识库搭建专家",state:"auto",current:0,target:1,credit:80,dynamic:true}
);
main.native.travel = { state:"idle",name:"团子",limitReached:false };
if (fixture.today.next) fixture.today.next.runAt="21:01";
if (q.has("dark")) document.documentElement.dataset.dark="";
let mode=q.get("view") && q.get("view")!=="health" ? "native" : "health";
let page="board", filter="all", channel="任务", logAccount=null, compOpen=false, focusJob=null;
let parallel=1, autoOpen=false, refreshed="14:42", approval;
const selected=new Set(), expandedAccounts=new Set(), expandedJobs=new Set();
const opNames={pause:"暂停任务",resume:"恢复任务",renew:"检查续期",balance:"刷新余额",run:"执行任务",travel:"猫猫旅行"};
const byId=id=>accounts.find(a=>a.id===id);
const stateOf=a=>a.disabled?"off":a.paused?"paused":a.state;
const personal=a=>a.realm==="国内个人";
const needs=a=>["expired","limited","spent","failed"].includes(stateOf(a));
const queue=()=>jobs.filter(j=>["执行中","排队中"].includes(j.status));
const inQueue=a=>queue().some(j=>j.person===a.name);
const compRows=()=>accounts.filter(a=>personal(a)&&a.comp);
const leftComp=30*3600+28*60;
const since=()=>Math.floor((performance.now()-openedAt)/1000);
const claimable=()=>compRows().filter(a=>a.comp==="pending"&&!a.disabled&&!a.paused&&since()<leftComp);
const errors=()=>compRows().filter(a=>a.comp==="error");
const num=n=>n.toLocaleString("zh-CN");
const nextOf=a=>a.paused?"任务已暂停":a.next;
const time=()=>new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(now+since()*1000);
const icon = (d,size=13) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const pulse=icon("M1.5 8h3L6.2 4l2.3 8 1.7-4h4");
const btn=(label,op,id="",attrs="",cls="demo-btn")=>`<button type="button" class="${cls}" data-op="${op}" data-id="${id}" ${attrs}>${label}</button>`;
const link=(label,op,id="",attrs="")=>btn(label,op,id,attrs,"wb-link-btn");
const seg=(label,op,id,on)=>btn(label,op,id,`aria-pressed="${on}"`,`wb-seg-btn${on?" on":""}`);
const pill=(label,cls="")=>`<span class="wb-pill ${cls}">${label}</span>`;
const sub=t=>`<small class="demo-sub">${t}</small>`;
function notice(text,bad=false) {
  const n=$("#note");
  n.hidden=false; n.textContent=text; n.classList.toggle("bad",bad);
}
function left(seconds) {
  const s=Math.max(0,seconds-since()), h=Math.floor(s/3600), m=Math.floor(s/60)%60;
  if (h) return `${h} 小时 ${m} 分`;
  return s ? `${String(m).padStart(2,"0")}:${String(s%60).padStart(2,"0")}` : "已到时";
}
const countdown=s=>`<span class="demo-num" data-left="${s}">${left(s)}</span>`;
setInterval(()=>document.querySelectorAll("[data-left]").forEach(el=>el.textContent=left(+el.dataset.left)),1000);

function compCard() {
  const pending=claimable(), amount=pending.reduce((n,a)=>n+a.credit,0);
  const status = pending.length ? `<strong>${pending.length} 个账号待领 ${num(amount)} 积分</strong>` : "暂无已确认可领补偿";
  const warning=errors().length ? `<span class="demo-danger">${errors().length} 个账号查询失败</span>` : "";
  return `<details class="demo-panel demo-comp" ${compOpen?"open":""}>
    <summary class="demo-line demo-head demo-flex"><span class="demo-flex row-title"><strong class="demo-title">官方补偿</strong>${pending.length?pill(`剩 ${countdown(leftComp)}`,"urgent demo-pill-urgent"):""}</span>
    <span class="wb-sub demo-flex">${status}${warning}</span><span class="wb-link-btn">${compOpen?"收起":"查看与领取"} ${compOpen?"↑":"↓"}</span></summary>
    <div class="demo-line demo-flex split"><span class="wb-sub">${pending.length?"11 月 18 日 21:10 截止。领取前会逐号重查。":"仅显示国内个人账号的补偿状态。"}</span>
      ${pending.length?btn(`领取全部（${pending.length}）`,"claim-all","","","demo-btn primary"):""}</div>
    <ul>${compRows().map(a=>{
      const [label,cls]=({pending:[`${a.credit} 积分待领`,"urgent demo-pill-urgent"],none:["当前无补偿","demo-pill-quiet"],error:["查询失败","urgent demo-pill-urgent"],claimed:[`已领取 ${a.credit} 积分`,"ok"]})[a.comp];
      return `<li class="demo-flex split"><span class="grow"><strong>${a.name}</strong>${a.comp==="error"?sub("上次查询超时，暂不能确认有没有补偿。"):a.paused&&a.comp==="pending"?sub("任务已暂停，恢复后可领。"):""}</span>${pill(label,cls)}${pending.includes(a)?link("领取","claim",a.id):a.comp==="error"?link("重新查询","comp-check",a.id):""}</li>`;
    }).join("")}</ul>
  </details>`;
}
function accountScope(op,a) {
  if (a.disabled) return false;
  if (op==="pause") return !a.paused && a.realm!=="企业";
  if (op==="resume") return a.paused;
  if (op==="balance") return a.state!=="expired";
  if (op==="run" || op==="travel") return !a.paused && !inQueue(a) && !["expired","limited","failed"].includes(a.state) && a.realm!=="企业";
  return true;
}
function quick(a) {
  if(a.disabled) return sub(a.hint);
  return `<div class="demo-flex">${["renew","run",...(personal(a)?["travel"]:[]),"balance",a.paused?"resume":"pause"].map(op=>btn(opNames[op],op,a.id,accountScope(op,a)?"":"disabled")).join("")}
    ${a.lastRun?link("失败记录","job",a.lastRun):""}</div>`;
}
function buddy(a) {
  if (!personal(a)||a.energy===undefined) return "";
  const max=Math.min(a.boxes,Math.max(1,a.cap));
  const label=a.boxes?`可开 ${a.boxes} 个 · 单次最多 ${max} 个`:"成长能量不足";
  return `<div class="demo-flex split"><span class="grow"><strong class="demo-title">Buddy 盲盒</strong> <span class="wb-sub">成长能量 ${a.energy} · ${label}</span>${sub(a.travel+(a.buddies?` · 刚开出 ${a.buddies}`:""))}</span>
    ${btn("开盲盒","box",a.id,a.boxes&&!a.paused&&a.state!=="limited"?"":"disabled","wb-brief-btn demo-btn")}</div>`;
}
function accountDetail(a) {
  return `<div class="demo-detail">${quick(a)}${buddy(a)}</div>`;
}
function healthRows(rows) {
  return rows.map(a=>{
    const on=expandedAccounts.has(a.id);
    return `<tr ${selected.has(a.id)?'class="selected"':""}>
      <td><input type="checkbox" data-select="${a.id}" aria-label="选中${a.name}" ${selected.has(a.id)?"checked":""} ${a.disabled?"disabled":""}></td>
      <td><div class="row-name"><span class="wb-avatar" aria-hidden="true">${a.name[0]}</span><span class="wb-who">${btn(a.name,"detail",a.id,`aria-expanded="${on}"`,"name")}${sub(a.realm)}</span></div></td>
      <td>${pill(...health[stateOf(a)])}<span class="demo-sub status-hint">${a.paused?"续期和看板照常":a.hint}</span>
        <span class="demo-mobile">${a.cool?`恢复 ${countdown(a.cool)}`:`最近成功 ${a.last.replace("今天 ","")}`}${a.fails?` · ${a.fails} 次失败`:""}</span></td>
      <td class="recent demo-num">${a.last}</td><td class="count demo-num ${a.fails>=3?"demo-danger":""}">${a.fails} 次</td>
      <td class="countdown">${a.cool?countdown(a.cool):'—'}</td><td class="next-cell">${nextOf(a)}</td>
      <td>${btn(on?"收起":"操作","detail",a.id,`aria-expanded="${on}" aria-label="${a.name}${on?"收起":"快捷操作"}"`,"wb-link-btn demo-health-menu")}</td>
    </tr>${on?`<tr class="row-detail"><td colspan="8"><p class="demo-mobile">最近成功 ${a.last} · 失败 ${a.fails} 次 · 下次定时：${nextOf(a)}</p>${accountDetail(a)}</td></tr>`:""}`;
  }).join("");
}
function boardScope() {
  const realm = $('[aria-label="版本筛选"] [aria-pressed="true"]')?.textContent.trim() || "全部";
  return accounts.filter(a=>realm.startsWith("全部")||(realm.startsWith("国际版")?a.realm==="国际个人":a.realm!=="国际个人"));
}
function shownAccounts() {
  return boardScope().filter(a=>filter==="all"||(filter==="attention"?needs(a):filter==="paused"?a.paused:a.disabled));
}
function healthView() {
  const rows=boardScope(), shown=shownAccounts(), pick=shown.filter(a=>!a.disabled);
  const counts=[["all","全部",rows.length],["attention","需处理",rows.filter(needs).length],["paused","任务已暂停",rows.filter(a=>a.paused).length],["off","已停用",rows.filter(a=>a.disabled).length]];
  return `<div class="demo-health">
    <div class="section-head"><h2>账号健康总览</h2><span class="wb-sub">最近成功指上次任务成功，不含余额刷新。</span></div>
    <div class="demo-panel">
      <div class="demo-line"><div class="wb-segs" aria-label="健康状态筛选">${counts.map(([id,label,n])=>seg(`${label} ${n}`,"filter",id,filter===id)).join("")}</div></div>
      ${selected.size?`<div class="demo-line demo-flex demo-batch"><strong>已选 ${selected.size} 个</strong>${["balance","renew","run","pause","resume"].map(op=>btn(opNames[op],"bulk",op)).join("")}${link("取消选择","clear")}</div>`:""}
      ${shown.length?`<table class="demo-table" aria-label="账号健康总览"><colgroup><col class="select"><col class="who"><col class="status"><col><col class="fail"><col class="cool"><col class="next"><col class="ops"></colgroup>
      <thead><tr><th><input type="checkbox" data-all aria-label="全选当前列表" ${pick.length&&pick.every(a=>selected.has(a.id))?"checked":""} ${pick.length?"":"disabled"}></th><th>账号</th><th>健康状态</th><th>最近成功</th><th>连续失败</th><th>冷却 / 恢复</th><th class="next-col">下次定时</th><th>操作</th></tr></thead><tbody>${healthRows(shown)}</tbody></table>`:"<div class='demo-line wb-sub'>没有符合条件的账号。</div>"}
    </div>
  </div>`;
}
function boardAdditions() {
  const root=$(".wb-tab-board"), tool=$(".wb-view-switch .wb-segs");
  root.classList.add("demo-board");
  if (mode==="health") {
    tool.querySelector(".on")?.classList.remove("on");
    for(const b of tool.children)b.setAttribute("aria-pressed","false");
    // Keep the original selector, today strip and reminder component.
    $(".wb-board-toolbar").nextElementSibling.outerHTML=healthView();
  }
  tool.insertAdjacentHTML("beforeend",seg(pulse+"健康","health","",mode==="health"));
  $(".wb-board-toolbar").insertAdjacentHTML("afterend",compCard());
  const alert=$(".wb-alert-footer");
  if(alert && (claimable().length || errors().length)) {
    const desc=[claimable().length?`官方补偿：${claimable().length} 个账号待领，11 月 18 日 21:10 截止`:"", errors().length?"补偿查询失败："+errors().map(a=>a.name).join("、"):""].filter(Boolean).join("；");
    alert.querySelector(".wb-alert-bar")?.insertAdjacentHTML("afterbegin",`<div class="demo-flex split demo-alert-inline"><span class="wb-alert-mark demo-danger">${desc}</span>${link("查看补偿","comp")}</div>`);
  }
  for(const a of accounts){
    const id=a.native.id.replace(/[^\w-]/g,"_");
    const panel=$(`#wb-detail-${id} .wb-detail-in`);
    if(panel) panel.insertAdjacentHTML("afterbegin",`<div class="demo-line">${accountDetail(a)}</div>`);
  }
  const all=$("[data-all]");
  if(all&&selected.size&&!all.checked) all.indeterminate=shownAccounts().some(a=>selected.has(a.id));
}
function tasksAdditions() {
  const box=$(".wb-brief"), date=$(".wb-brief-date");
  const need=[...box.querySelectorAll(".wb-brief-section")].find(s=>s.firstChild.textContent==="需要你处理");
  const compensation=[...need.querySelectorAll(".wb-brief-row")].filter(el=>el.querySelector(".wb-brief-name").textContent==="官方补偿");
  if(compensation.length){
    const pending=claimable(), amount=pending.reduce((n,a)=>n+a.credit,0);
    const info=[pending.length?`${pending.length} 个账号待领 ${num(amount)} 积分，11/18 21:10 截止`:"",errors().length?`${errors().length} 个账号查询失败`:""].filter(Boolean).join("；");
    compensation[0].outerHTML=`<div class="wb-brief-row"><div class="wb-brief-main"><strong class="wb-brief-name">官方补偿</strong><p class="wb-brief-note">${info}。</p></div><div class="wb-brief-side">${btn("查看补偿","comp","","","wb-brief-btn demo-btn")}</div></div>`;
    compensation.slice(1).forEach(el=>el.remove());
  }
  date.insertAdjacentHTML("afterend",`<div class="demo-flex demo-brief-meta"><span class="wb-sub">任务进度更新于 14:40</span>${link("查看执行队列","schedule")}</div>`);
  const accountSection=[...box.querySelectorAll(".wb-brief-section")].find(s=>s.firstChild.textContent==="账号");
  accountSection.insertAdjacentHTML("beforeend",`<details class="demo-panel demo-brief-activity">
    <summary class="demo-line demo-flex split"><strong>Buddy 加油站</strong>${pill("主力号今天已签到","ok")}<span class="wb-sub">详情 ↓</span></summary>
    <div class="demo-line demo-flex split"><span>签到活动周期</span><span>11/11 – 11/24 · 本期第 7 天</span></div>
    <div class="demo-line demo-flex split"><span>成长计划连登</span><strong>主力号 12 天</strong></div>
    <div class="demo-line"><strong>主力号今日签到 +100</strong>${sub("官方记录：今天 09:02，已采用。Magpie 本机记录：昨天 09:01，非今日，未采用。国内签到仍由 Magpie 负责。")}</div>
  </details>`);
  // Place the two values side by side in the original daily briefing.
  $(".demo-brief-activity").querySelector("summary").insertAdjacentHTML("beforeend",'<span class="wb-sub">活动 11/11 – 11/24 · 成长连登 12 天</span>');
}
function jobRow(j,history) {
  const a=accounts.find(a=>a.name===j.person), unavailable=j.status==="已安排重试"||a.paused||inQueue(a);
  const tone=history?(j.tone==="danger"?"urgent demo-pill-urgent":"go"):(j.status==="执行中"?"go":"demo-pill-quiet");
  return `<details class="job" data-job="${j.id}" ${expandedJobs.has(j.id)?"open":""}>
    <summary class="job-summary">
      <span><strong>${j.person}</strong> · ${j.title}${sub(j.reason||j.step)}</span>
      <span class="demo-flex">${!history?`<progress class="demo-progress" max="${j.total}" value="${j.done}" aria-label="${j.person}进度"></progress><span class="job-when">${j.done}/${j.total}</span>`:`<span class="job-when">${j.at}</span>`}${pill(j.status,tone)}<span class="job-chevron"></span></span>
    </summary>${history?`<ol class="demo-timeline">${j.attempts.map(([t,by,msg])=>`<li><span class="job-when">${t}</span> · ${by}${sub(msg)}</li>`).join("")}</ol><div class="demo-flex">${btn("重试失败步骤","retry",j.id,unavailable?"disabled":"")}${link("查看相关日志","job-log",j.id)}</div>`:`<p class="wb-sub">${j.at} 入队 · 已完成 ${j.done} / ${j.total} 个步骤。</p>`}</details>`;
}
function runs() {
  const active=queue(), running=active.filter(j=>j.status==="执行中").length;
  const recent=jobs.filter(j=>j.attempts);
  const completed=fixture.jobs.map(j=>`<div class="demo-line demo-flex"><span class="job-when">${WBBoard.when(Date.parse(j.finished)).slice(6)}</span>${pill("已完成","ok")}<span>${j.last}</span></div>`).join("");
  return `<div class="demo-runs">
    <div class="section-head"><h2>执行队列</h2><div class="demo-flex"><span class="wb-sub">${running}/${parallel} 个账号执行中 · ${active.length-running} 个排队</span>${link("执行设置","settings")}</div></div>
    <div class="demo-panel">${active.length?active.map(j=>jobRow(j,false)).join(""):'<div class="demo-line wb-sub">当前没有待执行的任务。</div>'}</div>
    <div class="section-head"><h2>执行记录</h2><span class="wb-sub">展开失败行可查看每次尝试</span></div>
    <div class="demo-panel">${recent.map(j=>jobRow(j,true)).join("")}<details class="job"><summary>查看已完成记录</summary>${completed}</details></div>
    <div class="section-head" id="preview-logs"><h2>日志</h2><div class="wb-segs demo-channel" aria-label="日志频道">${["任务","对话","系统"].map(c=>seg(c,"channel",c,c===channel)).join("")}</div></div>
    <div class="demo-panel">${logAccount?`<div class="demo-line demo-flex split"><span class="wb-sub">仅显示 ${logAccount}</span>${link("取消筛选","channel",channel)}</div>`:""}${logs.filter(([,c,a])=>c===channel&&(!logAccount||a===logAccount)).map(([t,c,a,m])=>`<div class="demo-log"><time class="job-time">${t}</time><span class="job-account">${a}</span><span>${m}</span></div>`).join("")}</div>
  </div>`;
}
function ask(title, description, label, run) {
  const d=$("#confirm"); approval=run;
  d.innerHTML=`<h2 id="confirm-title">${title}</h2><p>${description}</p><div class="demo-flex">${btn("取消","cancel","","autofocus")}${btn(label,"apply","","","demo-btn primary")}</div>`;
  d.showModal();
}
function addLog(c,a,m){logs.unshift([time(),c,a,m]);}
function recalc(){
  const occupied=new Set(queue().filter(j=>j.status==="执行中").map(j=>j.person));
  for(const j of queue().filter(j=>j.status==="排队中")){
    if(occupied.size>=parallel)break;
    if(occupied.has(j.person))continue;
    occupied.add(j.person); j.status="执行中"; j.step="检查当前状态";
  }
}
function operate(op,requested,bulk=false) {
  const targets=requested.filter(a=>accountScope(op,a));
  if(!targets.length){notice("所选账号目前没有可执行的项。");return;}
  const run=()=>{
    for(const a of targets){
      if(op==="pause"||op==="resume"){
        a.paused=op==="pause"; if(a.paused) for(const j of queue().filter(j=>j.person===a.name))j.status="任务已暂停";
        addLog("系统",a.name,a.paused?"已暂停任务，续期与看板照常运行。":"已恢复任务。");
      }else if(op==="run"||op==="travel"){
        jobs.push({id:`new-${jobs.length}`,person:a.name,title:opNames[op],status:"排队中",at:time(),done:0,total:op==="travel"?3:5,step:"等待空闲位置"});
        addLog("任务",a.name,`${opNames[op]}已入队。`);
      }else{
        if(op==="balance")refreshed=time().slice(0,5);
        addLog("系统",a.name,op==="balance"?"已刷新余额。":"已检查续期状态。");
      }
    }
    recalc(); show();
    notice(op==="renew"&&targets.some(a=>a.state==="expired")?"有账号无法续期，请在 Magpie「供应商」确认登录状态。":`${opNames[op]}：${targets.length} 个账号已${["run","travel"].includes(op)?"入队":"处理"}。`);
  };
  if(bulk||["pause","run","travel"].includes(op)){
    const message=op==="pause"?"正在运行的任务在当前步骤结束后停止；保留续期和看板。":op==="travel"&&autoOpen?"若满足条件，旅行流程会消耗能量自动开盒。":"";
    ask(`${opNames[op]} · ${targets.length} 个账号`,targets.map(a=>a.name).join("、")+"。"+message+(requested.length>targets.length?`跳过 ${requested.length-targets.length} 个当前不可操作的账号。`:""),opNames[op],run);
  }else run();
}
function claim(targets){
  const amount=targets.reduce((n,a)=>n+a.credit,0);
  ask(`领取 ${num(amount)} 积分？`,`${targets.map(a=>a.name).join("、")}。执行时逐号重查活动、额度和是否已领。`,"确认领取",()=>{
    for (const a of targets){a.comp="claimed";addLog("任务",a.name,`已领取官方补偿 ${a.credit} 积分。`);}
    show();notice(`已领取 ${num(amount)} 积分。`);
  });
}
function box(a){
  const count=Math.min(a.boxes,Math.max(1,a.cap));
  if(!count||a.paused){notice("该账号目前无法开盒。");return;}
  ask(`开启 ${count} 个 Buddy 盲盒？`,`${a.name}将消耗 ${count*10} 成长能量。`,"确认开盒",()=>{
    a.energy-=count*10;a.boxes-=count;a.buddies=count===2?"小栗、桃酥":"小栗";
    addLog("任务",a.name,`开启 ${count} 个 Buddy 盲盒：${a.buddies}。`);
    show();notice(`开出 ${a.buddies}。`);
  });
}
function retry(j) {
  ask(`重试${j.person}的失败步骤？`,`${j.title}将重新排队。成功步骤及原有记录保留。`,"加入队列",()=>{
    j.status="已安排重试";j.attempts.push([time(),"手动重试","已加入队列"]);
    jobs.push({...j,id:`retry-${j.id}`,status:"排队中",reason:undefined,attempts:undefined,done:0,total:1,step:"重试失败步骤"});
    addLog(j.id==="web"?"对话":"任务",j.person,`${j.title}：失败步骤已加入重试队列。`);
    recalc();show();notice("已加入重试队列。");
  });
}
function hydrate() {
  for(const a of accounts){
    a.native.growth = a.energy===undefined ? a.native.growth : {...a.native.growth,energy:a.energy,rarity:a.native.growth?.rarity||{}};
    a.native.buddy = a.boxes===undefined ? undefined : {affordable:a.boxes,maxOpen:a.cap||1};
    a.native.compensation = {active:["pending","claimed"].includes(a.comp),claimed:a.comp==="claimed",credit:a.credit||0,end:"2026-11-18 21:10:00"};
    if(a.comp==="error")a.native.errors.compensation="请求超时";else delete a.native.errors.compensation;
  }
}
let revision=0;
const hooks={
  onTab(tab){
    page=tab;
    const expected=++revision;
    queueMicrotask(()=>{
      if(expected!==revision)return;
      if(page==="board")boardAdditions();
      if(page==="tasks")tasksAdditions();
      $("#jobs-preview").innerHTML=page==="schedule"?runs():"";
      if(focusJob&&page==="schedule"){$(`[data-job="${focusJob}"]`)?.scrollIntoView({block:"center"});focusJob=null;}
    });
  },
  onOpenSettings:()=>settings(true),
  onSchedule(intl,on){
    fixture[intl?"intlEnabled":"enabled"]=on;show();
  },
  async onTask(id){operate("run",accounts.filter(a=>a.native.id===id));},
  async onQueue(ids){operate("run",accounts.filter(a=>ids.includes(a.native.id)),true);},
  async onRunAction(op,ids){
    const targets=accounts.filter(a=>ids?.includes(a.native.id));
    if(op==="compensation"){
      const a=targets[0];
      if(a.comp==="error"){compOpen=true;WBBoard.goTab("board");}
      else claim(claimable().filter(b=>b===a));
    }else if(op==="buddy")box(targets[0]);
    else if (op==="travel")operate("travel",targets);
    else notice("已提交演示操作。");
  }
};
function show(focus="") {
  hydrate();
  $("#state").textContent=`余额更新于 11/17 ${refreshed}`;
  const b=$("#sched-pill");b.hidden=false;b.textContent="定时运行中 · 下次 21:01";
  WBBoard.render($("#board"),fixture,now,hooks);
  if(focus)queueMicrotask(()=>$(focus)?.focus({preventScroll:true}));
}
function settings(open) {
  document.body.classList.toggle("in-settings",open); $("#settings").hidden=!open;
  if(open){$("#parallel").value=parallel;$('#settings-form [name="buddy-auto"]').checked=autoOpen;$("#close-settings").focus();}
  else $("#open-settings").focus();
}
const field=$("#settings-form .group");
field.insertAdjacentHTML("afterbegin",'<label class="short">同时执行的账号数<select id="parallel"><option>1</option><option>2</option><option>3</option></select><small class="hint">默认 1。同号内始终逐项执行；并发数越高，越容易遇到限流。</small></label>');
const toggleHelp=$('#settings-form [name="buddy-auto"]').parentElement.querySelector("small");
toggleHelp.textContent="消耗成长能量，默认关闭。猫猫领奖后或空闲并准备出发时开盒，再刷新旅行状态。手动开盒不受此开关影响。";
for(const toggle of ["skill-share","intl-web-on"])$(`#settings-form [name="${toggle}"]`).checked=true;
const form=$("#settings-form");
for(const [k,v] of Object.entries(fixture.schedules))if(form.elements[k])form.elements[k].value=v.join(", ");
for(const [k,v] of Object.entries(fixture.intlSchedules))if(form.elements[`intl-${k}`])form.elements[`intl-${k}`].value=v.join(", ");
form.elements.timezone.value=fixture.settings.timezone;

document.addEventListener("click",e=>{
  if(e.target.closest(".wb-view-switch .wb-seg-btn:not([data-op])")){
    mode="native";
    // The native selected view still works when returning from health.
    const b=e.target.closest(".wb-seg-btn"), views=["list","rings","widgets"];
    WBBoard.setMode(views[[...b.parentElement.children].indexOf(b)]);
    return;
  }
  if(e.target.closest('[aria-label="版本筛选"] button'))selected.clear();
},true);
document.addEventListener("click",e=>{
  const b=e.target.closest("button,summary");
  if(!b)return;
  const {op,id,action}=b.dataset;
  if(b.id==="open-settings"||op==="settings")settings(true);
  else if(b.id==="close-settings")settings(false);
  else if(b.id==="sched-pill"||op==="schedule")WBBoard.goTab("schedule");
  else if(b.id==="save-settings"){
    parallel=+$("#parallel").value;autoOpen=form.elements["buddy-auto"].checked;recalc();
    $("#save-status").textContent=`样稿已保存：并发 ${parallel}，自动开盲盒${autoOpen?"开":"关"}。`;show();
  }
  else if(action==="refresh"){refreshed=time().slice(0,5);show();notice("样稿余额已刷新。");}
  else if(action){
    b.closest(".run-menu")?.removeAttribute("open");
    if(["login","login-intl"].includes(action))notice("这是本地样稿，未打开登录流程。");
    else if(action==="all"||action==="tasks"||action==="travel")operate(action==="travel"?"travel":"run",accounts.filter(a=>action!=="travel"||personal(a)),true);
    else notice("演示操作已提交。");
  }
  else if(op==="health"){mode="health";show('[data-op="health"]');}
  else if(op==="filter"){filter=id;selected.clear();show(`[data-op="filter"][data-id="${id}"]`);}
  else if(op==="detail"){
    if(expandedAccounts.has(id))expandedAccounts.delete(id);else expandedAccounts.add(id);
    show(`[data-op="detail"][data-id="${id}"]`);
  }
  else if(op==="clear"){selected.clear();show();}
  else if(op==="bulk")operate(id,[...selected].map(byId),true);
  else if(op in opNames)operate(op,[byId(id)]);
  else if(op==="comp"){
    compOpen=true;
    if(page!=="board")WBBoard.goTab("board");
    queueMicrotask(()=>{$(".demo-comp").open=true;$(".demo-comp").scrollIntoView({block:"nearest"});});
  }
  else if(op==="claim")claim(claimable().filter(a=>a.id===id));
  else if(op==="claim-all")claim(claimable());
  else if(op==="comp-check"){
    byId(id).comp="none";compOpen=true;addLog("系统",byId(id).name,"重查补偿：当前无补偿。");show();
  }
  else if(op==="box")box(byId(id));
  else if(op==="cancel")$("#confirm").close();
  else if(op==="apply"){$("#confirm").close();approval();}
  else if(op==="retry")retry(jobs.find(j=>j.id===id));
  else if(op==="job"){
    expandedJobs.add(id);focusJob=id;WBBoard.goTab("schedule");
  }
  else if(op==="job-log"||op==="channel"){
    const j=op==="job-log"?jobs.find(j=>j.id===id):null;
    logAccount=j?.person||null;channel=j?(id==="web"?"对话":"任务"):id;
    $("#jobs-preview").innerHTML=runs();$("#preview-logs").scrollIntoView({block:"nearest"});
  }
});
document.addEventListener("change",e=>{
  const b=e.target;
  if(b.dataset.select){
    if(b.checked)selected.add(b.dataset.select);else selected.delete(b.dataset.select);
    show(`[data-select="${b.dataset.select}"]`);
  }else if(b.hasAttribute("data-all")){
    for(const a of shownAccounts().filter(a=>!a.disabled)){if(b.checked)selected.add(a.id);else selected.delete(a.id);}
    show("[data-all]");
  }
});
document.addEventListener("toggle",e=>{
  const el=e.target;
  if(!el.isConnected)return;
  if(el.dataset?.job){if(el.open)expandedJobs.add(el.dataset.job);else expandedJobs.delete(el.dataset.job);}
  if(el.classList.contains("demo-comp")) {
    compOpen=el.open;
    el.querySelector("summary .wb-link-btn").textContent=compOpen?"收起 ↑":"查看与领取 ↓";
  }
},true);
show();
