const $ = id => document.getElementById(id);
const names = { all:"全部执行",checkin:"加油站签到",activity:"连登活跃",tasks:"成长任务",travel:"猫猫旅行",bonus:"连登福利",night:"夜猫子",keepalive:"登录续期",inspect:"查询状态" };
const scheduleNames = { daily:"签到 / 活跃 / 旅行 / 连登",tasks:"成长任务",night:"夜猫子任务",keepalive:"登录续期检查" };
const statuses = { running:"执行中",queued:"排队中",succeeded:"已完成",failed:"有失败项目",interrupted:"重启中断",cancelled:"已停止" };
let current, filled = false;
const selected = new Set(), opened = new Set();
function element(tag, text, className) { const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node; }
async function api(path, body) {
  const response=await fetch(path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json","X-WorkBuddy-Plus":"1"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
function failure(error) { $("error").textContent=error.message;$("error").hidden=false; }
async function save(config) { await api("/api/config",config);await refresh(); }
async function refresh() {
  current=await api("/api/status");
  $("schedule-state").textContent=current.config.enabled?"定时运行中":"定时已暂停";
  $("toggle-schedule").textContent=current.config.enabled?"暂停定时":"开启定时";
  $("accounts").replaceChildren();
  for(const account of current.accounts){
    const row=element("div",undefined,"account"), checkbox=element("input");checkbox.type="checkbox";checkbox.checked=selected.has(account.id);checkbox.disabled=!account.enabled;checkbox.setAttribute("aria-label",`选择 ${account.name}`);
    checkbox.onchange=()=>checkbox.checked?selected.add(account.id):selected.delete(account.id);
    const info=element("div",undefined,"account-info"),title=element("div",account.name,"account-name"),meta=element("div");
    meta.append(element("span",account.enterprise?"企业":"个人","tag"),element("span",account.enterprise?"无个人成长奖励":"复用 Magpie 登录","muted"));
    info.append(title,meta);
    const toggle=element("button",account.enabled?"停用":"启用");toggle.onclick=async()=>{try{const config={...current.config,disabledAccounts:account.enabled?[...current.config.disabledAccounts,account.id]:current.config.disabledAccounts.filter(id=>id!==account.id)};selected.delete(account.id);await save(config);}catch(e){failure(e);}};
    row.append(checkbox,info,toggle);$("accounts").append(row);
  }
  $("jobs").replaceChildren();
  for(const job of current.jobs){
    const details=element("details",undefined,"job");details.open=opened.has(job.id)||job.status==="running";details.ontoggle=()=>details.open?opened.add(job.id):opened.delete(job.id);
    const summary=element("summary"),status=element("span",statuses[job.status]||job.status,`status ${job.status}`);
    summary.append(status,element("span",`${job.actions.map(a=>names[a]).join(" / ")} · ${job.accounts.length} 个账号`,"job-name"),element("span",new Date(job.created).toLocaleString(),"muted"));
    const logs=element("div",job.logs.map(log=>`${new Date(log.at).toLocaleTimeString()}  ${current.accounts.find(a=>a.id===log.account)?.name||""}  ${log.message}`).join("\n")||"等待执行…","log");
    details.append(summary,logs);
    if(job.actions.includes("inspect")&&job.results.length)details.append(element("pre",JSON.stringify(job.results,null,2),"log"));
    if(job.status==="running"){const cancel=element("button","停止当前执行","cancel");cancel.onclick=()=>api("/api/cancel",{id:job.id}).then(refresh).catch(failure);details.append(cancel);}
    $("jobs").append(details);
  }
  if(!current.jobs.length)$("jobs").append(element("p","还没有执行记录。可以先选择一个账号试运行。","empty"));
  if(!filled){
    for(const [key,times] of Object.entries(current.config.schedules)){const label=element("label",scheduleNames[key]);const input=element("input");input.name=`schedule-${key}`;input.value=times.join(", ");input.placeholder="HH:MM, HH:MM";label.append(input);$("schedule-fields").append(label);}
    for(const key of ["timezone","proxy"])$("config-form").elements[key].value=current.config[key];
    filled=true;
  }
  $("updated").textContent=`更新于 ${new Date().toLocaleTimeString()}`;
}
$("toggle-schedule").onclick=()=>save({...current.config,enabled:!current.config.enabled}).catch(failure);
for(const button of document.querySelectorAll("[data-action]"))button.onclick=async()=>{
  button.disabled=true;$("error").hidden=true;
  try{await api("/api/run",{action:button.dataset.action,accounts:[...selected]});await refresh();}catch(e){failure(e);}finally{button.disabled=false;}
};
$("config-form").onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget, config={...current.config,schedules:{}};
  for(const key of Object.keys(scheduleNames))config.schedules[key]=[...new Set(form.elements[`schedule-${key}`].value.split(",").map(s=>s.trim()).filter(Boolean))].sort();
  for(const key of ["timezone","proxy"])config[key]=form.elements[key].value.trim();
  try{await save(config);$("saved").textContent="已保存";}catch(e){failure(e);}
};
refresh().catch(failure);
setInterval(()=>refresh().catch(failure),4000);
