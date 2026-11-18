// Account board shared by the local panel and Magpie's page.
// Primary navigation separates functional modules (board / accounts / tasks /
// schedule / models) from the board's three display modes (list / rings / widgets).
// The nav is horizontal by default and can fold into a left sidebar (wb-nav).
// Package merging and the travel states follow zseeu1/wbkit's page (MIT).
(() => {
  const DAY = 86400_000, NS = "http://www.w3.org/2000/svg";
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const svg = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
  const num = n => n == null ? "—" : Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  const fine = n => Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const pad = n => String(n).padStart(2, "0");
  const when = ms => { if (!ms) return "—"; const d = new Date(ms); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const date = ms => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
  const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const days = (ms, now) => Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  const queueNote = q => `${when(q.at)} 查到这个模型算力不足在排队：第 ${q.position} 位${q.size ? `（队列 ${q.size}）` : ""}，预计 ${when(q.until)} 排到。企业账号也一样，可以先换别的模型`;
  const left = (ms, now) => { const d = days(ms, now); return d <= 0 ? `今天 ${clock(ms)}` : d === 1 ? `明天 ${clock(ms)}` : `${d} 天后`; };
  const tone = (ms, now) => { if (!ms) return "long"; const d = (ms - now) / DAY; return d <= 2 ? "urgent" : d <= 10 ? "soon" : ""; };
  const short = name => String(name).replace(/^CodeBuddy\s*/i, "").replace(/^个人版(?=.)/, "") || name;
  const lapse = p => p.resets ? "重置" : "作废";
  const line = (...children) => { const n = el("div", "wb-line"); n.append(...children); return n; };
  const parts = { balance: "积分", usage: "用量", travel: "猫猫旅行", streak: "连登", tasks: "成长任务", campaigns: "活动", growth: "能量与 Buddy", checkin: "签到", compensation: "官方补偿", buddy: "Buddy 盲盒", checkinUpstream: "官方签到" };

  const store = key => ({ get() { try { return localStorage.getItem(key); } catch { return null; } }, set(v) { try { localStorage.setItem(key, v); } catch {} } });
  const savedTab = store("wb-tab"), savedView = store("wb-view"), orderSaved = store("wb-order"), remembered = store("wb-realm"), navSaved = store("wb-nav");
  let navSide = navSaved.get() === "side", layout;

  const tabs = [["board", "看板"], ["accounts", "账号与健康"], ["tasks", "任务"], ["schedule", "定时与记录"], ["models", "模型"]];
  const boardViews = [["list", "列表"], ["rings", "圆环"], ["widgets", "小组件"]];
  const abroad = a => a.realm === "intl";
  let order = orderSaved.get() === "intl" ? "intl" : "cn", both = false;
  // Personal logins first, enterprise last inside each realm; the chosen realm leads.
  const rank = a => (abroad(a) === (order === "intl") ? 0 : 2) + (a.enterprise ? 1 : 0);
  const ordered = list => [...list].sort((a, b) => rank(a) - rank(b));

  // Migrate legacy wb-view values ("tasks" / "models") cleanly into wb-tab.
  const initRawView = savedView.get(), initRawTab = savedTab.get();
  let tab = tabs.some(([k]) => k === initRawTab) ? initRawTab : (["tasks", "models"].includes(initRawView) ? initRawView : "board");
  let mode = boardViews.some(([k]) => k === initRawView) ? initRawView : "list";
  let realmFilter = "all", focus = null, last = null, switched = false;
  let alertsOpen = false, taskFilter = "all", taskGroup = "account";
  let realm = ["intl", "ent"].includes(remembered.get()) ? remembered.get() : "cn", byRate = false, onlyPromo = false, modelSearch = "", lockedOpen = true;
  const expanded = new Set(), unfolded = new Set(), grown = new Set();
  const seenCharges = new Map(), firstPaint = new Set();
  const chargeKey = e => `${e.at}|${e.credit}|${e.model}|${e.client || ""}`;
  let hooks = {};

  const icon = (path, size = 13) => {
    const s = svg("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
    s.innerHTML = path;
    return s;
  };
  const copyIcon = '<rect x="5" y="5" width="8.5" height="8.5" rx="2"/><path d="M10.5 5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/>';
  const tabIcons = {
    board: '<rect x="2" y="2.5" width="5" height="5" rx="1.2"/><rect x="9" y="2.5" width="5" height="5" rx="1.2"/><rect x="2" y="9.5" width="5" height="4" rx="1.2"/><rect x="9" y="9.5" width="5" height="4" rx="1.2"/>',
    accounts: '<circle cx="6" cy="5.5" r="2.3"/><path d="M2 13c0-2.2 1.8-4 4-4s4 1.8 4 4"/><path d="M10.5 7.5a2 2 0 1 0 0-4"/><path d="M12 13c0-1.6-.6-3-1.7-3.8"/>',
    tasks: '<path d="M2.5 4.5h11M2.5 8h6M2.5 11.5h5"/><path d="M10.2 10.5l1.5 1.5 2.8-3"/>',
    schedule: '<circle cx="8" cy="8.2" r="5.5"/><path d="M8 5.2v3.2l2.1 1.2"/>',
    models: '<path d="M8 2l5.2 3v6L8 14l-5.2-3V5L8 2z"/><path d="M2.8 5L8 8l5.2-3M8 8v6"/>'
  };
  const viewIcons = {
    list: '<path d="M3 4h10M3 8h10M3 12h10"/>',
    rings: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.4"/>',
    widgets: '<rect x="2.2" y="2.2" width="5" height="5" rx="1"/><rect x="8.8" y="2.2" width="5" height="5" rx="1"/><rect x="2.2" y="8.8" width="11.6" height="5" rx="1"/>'
  };

  function trip(t, now, a) {
    if (!t || a?.realm === "intl") return null;
    if (t.state === "none") return { label: "还没有猫", note: "执行成长任务时会领养首只猫", tone: "", done: 0 };
    if (t.state === "arrived" || (t.state === "traveling" && t.arriveAt && now >= t.arriveAt)) return { label: "已归来，待领奖", note: `${t.location || "旅行"}结束，下一次「猫猫旅行」会领取${t.reward ? ` ${t.reward} 积分` : "奖励"}`, tone: "warn", done: 1, arrived: true };
    if (t.state === "traveling") {
      const span = t.arriveAt - t.departAt, done = span > 0 ? Math.min(1, Math.max(0, (now - t.departAt) / span)) : 0;
      return { label: `在${t.location || "路上"}`, note: `约 ${clock(t.arriveAt)} 归来`, tone: "go", done, progress: done };
    }
    if (t.state === "idle") return t.limitReached ? { label: "今日已旅行", note: "明天的第一次定时会再出发", tone: "ok", done: 1 } : { label: "在家", note: "下一次「猫猫旅行」会派出", tone: "", done: 0 };
    return { label: t.state || "未知", note: "", tone: "", done: 0 };
  }

  function checked(a) {
    const c = a.checkin;
    if (!c || a.enterprise) return null;
    const streak = c.streak ? `${a.realm === "intl" ? "连续签到" : "加油站连签"} ${c.streak} 天` : "";
    if (a.realm === "intl" && c.outcome === "closed") return null;
    if (a.realm === "intl") return {
      done: { label: `已签到${c.credit ? ` +${num(c.credit)}` : ""}`, tone: "ok", note: streak || "由 WorkBuddy Plus 签到" },
      waiting: { label: "未签到", tone: "", note: last?.[1]?.intlEnabled === false ? "国际版定时已暂停" : "下一次国际版「活跃 · 福利」定时会签到" }
    }[c.outcome] || { label: "签到读取失败", tone: "warn", note: c.message || "" };
    const via = c.source === "upstream" ? "来自上游签到" : c.at ? `${clock(c.at)} 由 Magpie 签到` : "";
    return {
      claimed: { label: `已签到${c.credit ? ` +${num(c.credit)}` : ""}`, tone: "ok", note: [via, streak].filter(Boolean).join(" · ") },
      done: { label: "已签到", tone: "ok", note: [via, streak].filter(Boolean).join(" · ") || "今天已经签过" },
      pending: { label: "签到中", tone: "go", note: "" },
      waiting: { label: "未签到", tone: "", note: "Magpie 开着时会在当天自动签到" },
      closed: { label: "活动未开放", tone: "", note: "Buddy 加油站当前没有签到活动" },
      off: { label: "签到未开启", tone: "warn", note: "在 Magpie 设置 › 用量 › 插件 打开 WorkBuddy 签到" },
      inactive: { label: "今天没签上", tone: "warn", note: "签到时账号今天还没活跃，Magpie 今天不会再试" },
      ineligible: { label: "需在客户端签到", tone: "warn", note: "WorkBuddy 不接受从 Magpie 给这个账号签到" }
    }[c.outcome] || { label: "签到失败", tone: "urgent", note: c.message || "在 Magpie 设置 › 用量 › 插件 查看原因" };
  }

  function earned(a, now) {
    const got = (a.ledger?.entries || []).filter(e => e.source === "每日活跃奖励").sort((x, y) => y.at - x.at)[0];
    if (got && days(got.at, now) === 0) return { label: `今日到账 +${num(got.credit)}`, tone: "ok", note: `${clock(got.at)} 到账；奖励在活跃后的次日凌晨发放` };
    const why = last?.[1]?.intlEnabled === false ? "国际版定时已暂停" : last?.[1]?.intl?.web === false ? "网页会话已关闭，需要在 workbuddy.ai 网页端自己完成一次对话" : "奖励在活跃后的次日凌晨发放，通常 02:00 到 07:00 到账";
    return { label: "今日未到账", tone: "", note: `${why}${got ? `；上次 ${when(got.at)} +${num(got.credit)}` : ""}` };
  }

  const doable = t => t ? t.total - t.open.filter(o => o.state === "manual" || o.state === "locked").length : 0;
  const today = (a, now) => a.enterprise ? null : { active: a.streak?.active ? 1 : 0, trip: a.realm === "intl" ? null : trip(a.travel, now, a)?.done || 0, tasks: doable(a.tasks) ? Math.min(1, a.tasks.claimed / doable(a.tasks)) : 1 };
  const goals = r => [r.active, r.trip, r.tasks].filter(v => v !== null);
  const closed = r => r && goals(r).every(v => v >= 1);

  function rings(r, big) {
    const [box, radii] = big ? [132, [58, 43, 28]] : [32, [13.5, 9, 4.5]], c = box / 2;
    const s = svg("svg", { viewBox: `0 0 ${box} ${box}`, class: big ? "wb-rings wb-rings-big" : "wb-rings", "aria-hidden": "true" });
    const shown = [[r.active, "a"], [r.trip, "b"], [r.tasks, "c"]].filter(([v]) => v !== null);
    for (const [[value, k], radius] of shown.map((x, i) => [x, radii[i]])) {
      s.append(svg("circle", { cx: c, cy: c, r: radius, class: "wb-ring-track" }));
      if (value > 0) s.append(svg("circle", { cx: c, cy: c, r: radius, class: `wb-ring wb-ring-${k}`, pathLength: 100, "stroke-dasharray": `${Math.round(value * 100)} 100`, transform: `rotate(-90 ${c} ${c})` }));
    }
    return s;
  }

  function bars(u) {
    const top = Math.max(...u.days.map(d => d.credit), 0), chart = el("div", "wb-chart");
    for (const d of u.days) {
      const col = el("div", "wb-col"), fill = el("span");
      fill.style.height = `${top ? Math.max(3, d.credit / top * 100) : 3}%`;
      col.title = `${d.date}：${num(d.credit)} 积分，${d.count} 次`;
      col.append(fill, el("small", undefined, d.date.slice(8)));
      chart.append(col);
    }
    return chart;
  }

  const lotsOf = p => p.lots?.length ? p.lots : [{ balance: p.balance, expires: p.expires }];
  function lapsing(rows) {
    const groups = new Map();
    for (const a of rows) for (const p of a.balance?.packages || []) for (const l of lotsOf(p)) {
      if (!l.expires || !(l.balance > 0)) continue;
      const key = `${short(p.name)}|${date(l.expires)}`, g = groups.get(key) || { name: short(p.name), expires: l.expires, resets: !!p.resets, balance: 0, accounts: new Set() };
      g.balance += l.balance; g.accounts.add(a.id); if (l.expires < g.expires) g.expires = l.expires; groups.set(key, g);
    }
    return [...groups.values()].map(g => ({ ...g, count: g.accounts.size })).sort((x, y) => x.expires - y.expires);
  }

  function segs(options, current, pick, label, withIcon, dataAttr) {
    const box = el("div", "wb-segs");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", label);
    for (const [key, text] of options) {
      const b = el("button", key === current ? "wb-seg-btn on" : "wb-seg-btn");
      b.type = "button";
      b.setAttribute("aria-pressed", String(key === current));
      if (dataAttr) b.dataset[dataAttr] = key;
      if (withIcon?.[key]) b.append(icon(withIcon[key], 13));
      b.append(text);
      b.onclick = () => { if (key !== current) pick(key); };
      box.append(b);
    }
    return box;
  }

  const again = () => { if (last) { switched = true; render(last[0], last[1]); } };
  const goTab = next => { tab = next; savedTab.set(next); switched = true; again(); };
  const setMode = next => { mode = next; savedView.set(next); if (next !== "rings") focus = null; again(); };

  const kinds = { daily: "活跃 · 旅行 · 福利", tasks: "成长任务", sweep: "补领清扫", night: "夜猫子", "intl-daily": "活跃 · 签到 · 福利", "intl-web": "网页会话" };
  const slotStates = { succeeded: ["完成", "ok"], partial: ["部分失败", "warn"], failed: ["失败", "urgent"], deferred: ["稍后重试", "warn"], running: ["执行中", "go"], queued: ["排队中", "go"], interrupted: ["中断", "warn"], cancelled: ["已停止", ""], upcoming: ["待执行", ""], pending: ["等待补跑", "warn"], missed: ["已错过", ""] };

  function scheduleSwitch(name, intl, on) {
    const b = el("button", "wb-switch"), state = el("span", "wb-switch-state", on ? "运行中" : "已暂停");
    b.type = "button";
    b.setAttribute("role", "switch");
    b.setAttribute("aria-checked", String(on));
    b.setAttribute("aria-label", `${name}定时`);
    b.title = on ? `暂停${name}的定时，手动执行不受影响` : `开启${name}的定时`;
    b.append(state, el("span", "wb-knob"));
    b.onclick = () => {
      const next = b.getAttribute("aria-checked") !== "true";
      b.setAttribute("aria-checked", String(next));
      state.textContent = next ? "运行中" : "已暂停";
      hooks.onSchedule?.(intl, next);
    };
    return b;
  }

  function schedule(view) {
    const t = view?.today;
    if (!t?.slots) return null;
    const box = el("section", "wb-sched"), next = t.next;
    const isIntl = s => s.kind.startsWith("intl-"), groups = [["国内版", t.slots.filter(s => !isIntl(s))], ["国际版", t.slots.filter(isIntl)]].filter(([, list]) => list.length);
    const kind = k => `${groups.length > 1 ? `${k.startsWith("intl-") ? "国际版" : "国内版"} ` : ""}${kinds[k] || k}`;
    box.setAttribute("aria-label", "今日定时");
    const headRight = el("span", "wb-sched-head-r");
    headRight.append(el("span", "wb-sub", t.slots.length && t.slots.every(s => s.paused) ? "定时已暂停" : next ? `下一次 ${next.runAt || next.at} ${kind(next.kind)}` : "今天的时段都已过"));
    if (hooks.onOpenSettings) {
      const adj = el("button", "wb-link-btn", "调整时段与错开");
      adj.type = "button";
      adj.onclick = () => hooks.onOpenSettings();
      headRight.append(adj);
    }
    box.append(line(el("span", "wb-label", `今日定时 · 每天 ${t.slots.length} 次`), headRight));
    for (const [name, list] of groups) {
      const intl = name === "国际版", on = intl ? view.intlEnabled !== false : view.enabled !== false;
      if (groups.length > 1 || hooks.onSchedule) box.append(line(el("span", "wb-sched-realm", name), hooks.onSchedule ? scheduleSwitch(name, intl, on) : el("span", "wb-sub", on ? "" : "定时已暂停")));
      const row = el("div", on ? "wb-slots" : "wb-slots wb-paused");
      const mine = list.find(s => s.status === "upcoming" && !s.paused);
      for (const s of list) {
        let [label, cls] = slotStates[s.status] || [s.status, ""];
        if (s.paused && ["pending", "upcoming"].includes(s.status)) [label, cls] = ["已暂停", ""];
        if (["partial", "failed"].includes(s.status) && s.attempts) label = `${label} ${s.attempts}/3`;
        const isNext = s === mine, chip = el("div", isNext ? "wb-slot next" : "wb-slot");
        if (s.runAt && s.runAt !== s.at) chip.title = `设定 ${s.at}，今天 ${s.runAt} 执行`;
        chip.append(line(el("strong", undefined, s.runAt || s.at), el("span", `wb-pill ${cls}`, isNext ? "下一次" : label)), el("span", "wb-sub", kinds[s.kind] || s.kind));
        row.append(chip);
      }
      box.append(row);
    }
    box.append(el("div", "wb-sub", `时段在「设置」里调整，每类最多 24 个；${t.spread ? `每个时段在设定时间前后 ${t.spread} 分钟内随机执行，每天不同；` : ""}电脑睡眠时不执行，唤醒后补跑当天已到点的时段。`));
    return box;
  }

  const actionNames = { all: "全部任务", activity: "连登活跃", tasks: "成长任务", sweep: "补领奖励", task: "单项任务", travel: "猫猫旅行", buddy: "Buddy 盲盒", compensation: "官方补偿", bonus: "连登福利", night: "夜猫子", web: "网页会话", inspect: "状态查询" };
  const channelNames = [["all", "全部"], ["task", "任务"], ["chat", "对话"], ["system", "系统"]];
  const actionChannel = action => action === "web" ? "chat" : action === "inspect" ? "system" : "task";
  const badJob = job => ["failed", "partial", "deferred", "interrupted"].includes(job.status);
  const jobChannels = job => [...new Set((job.actions || []).map(actionChannel))];
  const jobLabel = job => job.actions.map(a => actionNames[a] || a).join(" · ");
  const logFailed = entry => entry.level === "error" || (!entry.level && /失败|限流|中断|错误|HTTP [45]/.test(entry.message));
  let workTab = "queue", recordChannel = "all", logsChannel = "all", recordsFailed = false, logsFailed = false, cacheDraft = null;
  const recordsOpen = new Set();

  function workButton(label, run, status) {
    const button = el("button", "wb-work-button", label);
    button.type = "button";
    button.onclick = async () => {
      button.disabled = true;
      status.textContent = "正在提交…";
      status.classList.remove("urgent");
      try { status.textContent = await run() || "已提交"; }
      catch (e) { status.textContent = e.message; status.classList.add("urgent"); }
      finally { button.disabled = false; }
    };
    return button;
  }
  function workStatus() {
    const node = el("p", "wb-sub wb-work-status");
    node.setAttribute("role", "status");
    return node;
  }
  function taskSettings(view) {
    const box = el("aside", "wb-work-card wb-task-settings"), settings = view.settings || {}, feedback = workStatus();
    box.setAttribute("aria-label", "任务设置");
    box.append(el("h2", "wb-work-title", "任务设置"));
    const concurrency = el("div", "wb-work-setting"), label = el("div");
    label.append(el("strong", undefined, "账号并发"), el("div", "wb-sub", "同时处理几个账号，默认 1"));
    const choices = segs([[1, "1"], [2, "2"], [3, "3"]], settings.concurrency || 1, async value => {
      feedback.textContent = "正在保存…"; feedback.classList.remove("urgent");
      for (const b of choices.children) b.disabled = true;
      try { feedback.textContent = await hooks.onConfig({ concurrency: value }) || "已保存"; }
      catch (e) { feedback.textContent = e.message; feedback.classList.add("urgent"); }
      finally { for (const b of choices.children) b.disabled = false; }
    }, "账号并发");
    concurrency.append(label, choices); box.append(concurrency);
    const auto = el("label", "wb-work-setting"), autoLabel = el("span"), input = el("input");
    autoLabel.append(el("strong", undefined, "旅行后自动开盲盒"), el("div", "wb-sub", "消耗成长能量，默认关闭"));
    input.type = "checkbox"; input.checked = settings.buddyAuto === true;
    input.className = "wb-pill-switch"; input.setAttribute("role", "switch");
    input.onchange = async () => {
      input.disabled = true; feedback.textContent = "正在保存…"; feedback.classList.remove("urgent");
      try { feedback.textContent = await hooks.onConfig({ buddyAuto: input.checked }) || "已保存"; }
      catch (e) { input.checked = !input.checked; feedback.textContent = e.message; feedback.classList.add("urgent"); }
      finally { input.disabled = false; }
    };
    auto.append(autoLabel, input); box.append(auto);
    const policy = el("div", "wb-work-setting"), policyLabel = el("div");
    policyLabel.append(el("strong", undefined, "补偿先查后领"), el("div", "wb-sub", "查询失败单独提示，剩 48 小时标红"));
    policy.append(policyLabel, el("span", "wb-work-check", "✓")); box.append(policy);
    const cache = el("details", "wb-work-cache"), summary = el("summary"), form = el("form");
    summary.append(el("strong", undefined, "缓存"), el("span", "wb-sub", `列表 ${settings.tasksCacheTtl ?? 20} 秒 · 展示进度 ${settings.progressCacheHours ?? 6} 小时`));
    const values = cacheDraft || { tasksCacheTtl: settings.tasksCacheTtl ?? 20, progressCacheHours: settings.progressCacheHours ?? 6 }, inputs = {};
    for (const [key, title, max] of [["tasksCacheTtl", "任务列表（秒）", 120], ["progressCacheHours", "展示进度（小时）", 24]]) {
      const row = el("label", "wb-work-setting", title), field = el("input");
      field.type = "number"; field.min = "0"; field.max = String(max); field.step = "1"; field.required = true; field.value = values[key];
      inputs[key] = field;
      field.oninput = () => { cacheDraft = Object.fromEntries(Object.entries(inputs).map(([k, n]) => [k, n.value])); };
      row.append(field); form.append(row);
    }
    form.onsubmit = e => e.preventDefault();
    form.append(el("p", "wb-sub", "读取失败时展示缓存进度并标记时间；执行任务仍查询实时进度。设为 0 关闭。"));
    form.append(workButton("保存缓存设置", async () => {
      if (!form.reportValidity()) throw new Error("请检查缓存时长");
      const message = await hooks.onConfig(Object.fromEntries(Object.entries(inputs).map(([k,n]) => [k, Number(n.value)])));
      cacheDraft = null; return message || "已保存";
    }, feedback));
    cache.append(summary, form); box.append(cache, feedback);
    if (!hooks.onConfig) for (const control of [input, ...choices.children]) control.disabled = true;
    return box;
  }
  function executionRecord(job, view, showActions = true) {
    const detail = el("details", "wb-execution-record"), summary = el("summary"), body = el("div", "wb-record-body"), content = el("div", "wb-record-detail");
    detail.dataset.job = job.id;
    detail.open = recordsOpen.has(job.id) || job.status === "running";
    detail.ontoggle = () => detail.open ? recordsOpen.add(job.id) : recordsOpen.delete(job.id);
    const [state, tone] = slotStates[job.status] || [job.status, ""], channels = jobChannels(job);
    const channel = channels.length === 1 ? channelNames.find(([k]) => k === channels[0])[1] : "混合";
    const counts = job.counts?.total ? `成功 ${job.counts.succeeded} / 失败 ${job.counts.failed}` : `${job.accounts?.length || 0} 个账号`;
    body.append(el("span", "wb-record-channel", channel), el("strong", undefined, jobLabel(job)), el("span", "wb-sub", counts));
    summary.append(el("span", `wb-record-state ${tone}`, state), body, el("time", "wb-record-time", when(Date.parse(job.finished || job.started || job.created))));
    if (job.retryOf || job.attempt) content.append(el("p", "wb-sub", job.attempt ? `定时第 ${job.attempt}/3 次执行 · 失败后至少等待 15 分钟补跑` : "本次由失败记录手动重试"));
    const retries = job.retries || [];
    if (retries.length) {
      content.append(el("strong", "wb-sub", "请求重试明细"));
      const chain = el("ol", "wb-retry-chain");
      for (const entry of retries) {
        const step = el("li", entry.error ? "urgent" : "ok"), name = view.accounts.find(a => a.id === entry.account)?.name || "账号";
        step.append(el("strong", undefined, `${name} · ${entry.attempt === 1 ? "首次请求" : `重试 ${entry.attempt - 1}/2`}`), el("span", undefined, `HTTP ${entry.status}`), el("time", "wb-record-time", new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })), el("div", "wb-sub", `${actionNames[entry.action] || "任务请求"}${entry.waitMs ? ` · 等待 ${entry.waitMs / 1000} 秒后重试` : entry.error ? " · 本次请求停止重试" : " · 请求已恢复"}`));
        chain.append(step);
      }
      content.append(chain);
    }
    const logs = (job.logs || []).filter(entry => recordChannel === "all" || (entry.channel || jobChannels(job)[0]) === recordChannel);
    if (!logs.length && !retries.length) content.append(el("p", "wb-sub", job.status === "queued" ? "等待空闲账号槽位…" : "暂无执行明细"));
    for (const entry of logs) content.append(logLine(entry, view, job));
    if (showActions) {
      const controls = el("div", "wb-record-actions"), feedback = workStatus();
      if (badJob(job) && hooks.onRetry) controls.append(workButton("现在重试", () => hooks.onRetry(job.id), feedback));
      if (["queued", "running"].includes(job.status) && hooks.onCancel) controls.append(workButton("停止执行", () => hooks.onCancel(job.id), feedback));
      for (const id of job.accounts || []) {
        const account = view.accounts.find(a => a.id === id);
        if (account && badJob(job) && hooks.onPauseAccount) controls.append(workButton(`${account.paused ? "恢复" : "暂停"} ${account.name} 任务`, () => hooks.onPauseAccount(id, !account.paused), feedback));
      }
      if (controls.children.length) content.append(controls, feedback);
    }
    detail.append(summary, content); return detail;
  }
  function logLine(entry, view, job) {
    const row = el("div", `wb-channel-log${logFailed(entry) ? " urgent" : ""}`);
    row.append(el("time", "wb-record-time", new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })), el("strong", undefined, view.accounts.find(a => a.id === entry.account)?.name || "系统"), el("span", "wb-log-message", entry.message));
    return row;
  }
  function queuePanel(view, now) {
    const panel = el("section", "wb-work-card"), jobs = view.jobs || [], grid = el("div", "wb-queue-grid"), latest = new Map();
    panel.append(line(el("h2", "wb-work-title", "任务队列进度"), el("span", "wb-sub", `并发上限 ${view.settings?.concurrency || 1}`)));
    for (const job of jobs) for (const row of job.queue || []) if (!latest.has(row.account)) latest.set(row.account, row);
    let waiting = 0;
    for (const account of view.accounts) {
      const row = latest.get(account.id), state = account.paused ? "paused" : row?.status || "idle";
      const labels = { ...Object.fromEntries(Object.entries(slotStates).map(([k,[v]]) => [k,v])), idle: account.enterprise ? "只读看板" : "空闲", paused: "已暂停", skipped: "已跳过" };
      const card = el("div", "wb-account-progress"), label = el("span", "wb-account-state"), name = el("strong", undefined, account.name);
      label.dataset.state = state; label.append(el("i", "wb-state-dot"), labels[state] || state);
      const waitSeconds = row?.retryAt > now ? Math.ceil((row.retryAt - now) / 1000) : 0;
      const message = account.paused ? "任务暂停，看板继续更新" : waitSeconds ? `请求退避 · ${waitSeconds} 秒后重试` : state === "queued" ? `等待槽位 #${++waiting}` : row?.message || "等待下一次执行";
      card.append(name, label, el("div", "wb-sub", message));
      if (row && state === "running") {
        const progress = el("progress"); progress.max = row.total; progress.value = row.completed;
        progress.setAttribute("aria-label", `${account.name} 本轮动作 ${row.completed}/${row.total}`);
        card.append(el("span", "wb-sub", `本轮动作 ${row.completed}/${row.total}`), progress);
      }
      if (account.paused && hooks.onPauseAccount) { const feedback = workStatus(); card.append(workButton("恢复任务", () => hooks.onPauseAccount(account.id, false), feedback), feedback); }
      grid.append(card);
    }
    panel.append(grid);
    if (!view.accounts.length) panel.append(el("p", "wb-calm", "还没有读取到账号"));
    const failures = jobs.filter(job => badJob(job) && !jobs.some(next => next.retryOf === job.id));
    const attention = el("div", "wb-queue-records");
    attention.append(el("h2", "wb-work-title", "需要关注的失败"));
    for (const job of failures) attention.append(executionRecord(job, view));
    if (!failures.length) attention.append(el("p", "wb-sub", "当前没有待处理的失败"));
    panel.append(attention); return panel;
  }
  function workRecords(view, logsOnly) {
    const panel = el("section", "wb-work-card"), toolbar = el("div", "wb-records-toolbar");
    const selected = logsOnly ? logsChannel : recordChannel, failed = logsOnly ? logsFailed : recordsFailed;
    toolbar.append(segs(channelNames, selected, value => { if (logsOnly) logsChannel = value; else recordChannel = value; again(); }, "日志频道"));
    const label = el("label", "wb-record-filter"), check = el("input");
    check.type = "checkbox"; check.checked = failed;
    check.onchange = () => { if (logsOnly) logsFailed = check.checked; else recordsFailed = check.checked; again(); };
    label.append(check, "仅看失败"); toolbar.append(label); panel.append(toolbar);
    let count = 0;
    if (logsOnly) {
      const entries = (view.jobs || []).flatMap(job => (job.logs || []).map(entry => ({ entry, job }))).sort((a,b) => Date.parse(b.entry.at) - Date.parse(a.entry.at));
      for (const { entry, job } of entries) {
        if (selected !== "all" && (entry.channel || jobChannels(job)[0]) !== selected || failed && !logFailed(entry)) continue;
        panel.append(logLine(entry, view, job)); count++;
      }
    } else for (const job of view.jobs || []) {
      if (selected !== "all" && !jobChannels(job).includes(selected) || failed && !badJob(job)) continue;
      panel.append(executionRecord(job, view)); count++;
    }
    if (!count) panel.append(el("p", "wb-calm", failed ? "没有符合条件的失败记录" : "暂无记录"));
    return panel;
  }
  function scheduleWorkbench(view, now) {
    const root = el("div", "wb-schedule-workspace"), top = schedule(view);
    if (top) root.append(top);
    root.append(segs([["queue", "队列"], ["runs", "执行记录"], ["logs", "日志"]], workTab, value => { workTab = value; again(); }, "定时与记录视图", null, "workTab"));
    const columns = el("div", "wb-workbench");
    columns.append(workTab === "queue" ? queuePanel(view, now) : workRecords(view, workTab === "logs"), taskSettings(view));
    root.append(columns); return root;
  }

  // Compact bottom summary strip on Board linking to Schedule & Logs tab.
  function scheduleBridge(view) {
    const t = view?.today;
    if (!t?.slots) return null;
    const bar = el("div", "wb-bridge"), leftBox = el("div", "wb-bridge-info");
    leftBox.append(el("span", "wb-label", "今日定时"));
    const cnOn = view.enabled !== false, hasIntl = t.slots.some(s => s.kind.startsWith("intl-"));
    const next = t.next;
    leftBox.append(el("span", `wb-pill ${cnOn ? "ok" : ""}`, `国内版${cnOn ? "运行中" : "已暂停"}`));
    if (hasIntl) {
      const intlOn = view.intlEnabled !== false;
      leftBox.append(el("span", `wb-pill ${intlOn ? "ok" : ""}`, `国际版${intlOn ? "运行中" : "已暂停"}`));
    }
    leftBox.append(el("span", "wb-sub", next ? `下一次 ${next.runAt || next.at} ${kinds[next.kind] || next.kind}` : "今日时段已执行完"));
    const go = el("button", "wb-link-btn", `查看全部 ${t.slots.length} 个时段与执行记录 →`);
    go.type = "button";
    go.onclick = () => goTab("schedule");
    bar.append(leftBox, go);
    return bar;
  }

  function signin(view, now) {
    const s = view?.signin;
    if (!s || (s.status !== "waiting" && now - Date.parse(s.finished) > 10 * 60_000)) return null;
    const box = el("div", `wb-signin ${s.status}`);
    if (s.status === "waiting") {
      box.append(el("div", undefined, `正在等待${s.realm === "intl" ? "国际版 WorkBuddy AI" : "国内版 WorkBuddy"} 登录：请在打开的浏览器页面里完成登录，10 分钟内有效。登录由 Magpie 的 WorkBuddy 插件完成并保存。`));
      if (s.url) box.append(el("div", "wb-sub wb-url", `没有自动打开的话，把这个地址复制到浏览器：${s.url}`));
    } else box.append(el("div", undefined, s.status === "done" ? "登录完成，账号会在看板刷新后出现；同一账号重新登录会替换原来的登录。" : `登录没有完成：${s.message || "未知原因"}`));
    return box;
  }

  function spark(u) {
    const s = svg("svg", { viewBox: "0 0 56 20", class: "wb-spark", "aria-hidden": "true" });
    if (!u?.days.length) return s;
    const top = Math.max(...u.days.map(d => d.credit), 1), step = 52 / Math.max(1, u.days.length - 1);
    s.append(svg("polyline", { points: u.days.map((d, i) => `${2 + i * step},${18 - d.credit / top * 16}`).join(" ") }));
    return s;
  }

  function meter(b, now) {
    const m = el("div", "wb-meter");
    for (const p of b.packages) {
      const parts = [];
      for (const l of lotsOf(p)) { const k = l.expires ? tone(l.expires, now) : "long", tail = parts.at(-1); if (tail?.k === k) tail.balance += l.balance; else parts.push({ k, balance: l.balance, expires: l.expires }); }
      for (const part of parts) { const seg = el("span", `wb-seg ${part.k}`); seg.style.width = `${part.balance / b.size * 100}%`; seg.title = `${short(p.name)} ${num(part.balance)} 积分 · ${part.expires ? `${when(part.expires)} 起${lapse(p)}` : "长期有效"}`; m.append(seg); }
    }
    return m;
  }

  function attention(rows, now) {
    const items = [], manual = new Map();
    const network = last?.[1]?.networkPaused;
    const webEnabled = last?.[1]?.intl?.web !== false;
    if (network) items.push({ tone: "urgent", text: `网络/代理连续失败，自动任务暂停至 ${when(network.until)}`, aside: network.message || "自动重试已暂停，手动执行仍可用", title: "连续网络错误后暂停定时任务，避免整轮卡在超时；修好代理或网络后可以手动执行确认恢复", order: -3 });
    for (const a of rows) {
      if (a.restricted) items.push({ tone: "urgent", text: `${a.name}：账号被上游限制，自动任务今天已暂停`, aside: a.restricted.message || "请先在官方客户端确认账号状态", title: "识别到上游限制后，本插件今天不再自动执行这个账号，避免继续触发风控", order: -2 });
      if (a.webPaused && webEnabled) items.push({ tone: "urgent", text: `${a.name}：国际版网页会话今天已暂停`, aside: "缺 CODEBUDDY_API_KEY，免费账号无法提供；不想看到可在设置关掉「每天跑一次网页会话」", title: `${a.webPaused.message || "缺少 CODEBUDDY_API_KEY"}；修好 Key 或代理后可在「立即执行」里手动重试`, order: -1 });
      for (const t of a.realm === "intl" ? [] : a.tasks?.open || []) {
        if (t.state === "manual") {
          const e = manual.get(t.title) || { ...t, count: 0 };
          e.count++; e.ends = Math.min(e.ends || Infinity, t.ends || Infinity);
          manual.set(t.title, e);
        } else if (t.ends && t.ends > now && t.ends - now <= 7 * DAY) {
          items.push({ tone: tone(t.ends, now), text: `${a.name}：任务「${t.title}」${left(t.ends, now)}截止`, aside: t.credit ? `+${num(t.credit)} 积分` : "", title: t.note, order: t.ends });
        }
      }
      const compensation = a.compensation;
      if (compensation?.active && !compensation.claimed && compensation.credit > 0) items.push({ tone: compensationEnd(compensation) - now <= 48 * 3600_000 ? "urgent" : "soon", text: `${a.name}：官方补偿 ${num(compensation.credit)} 积分待领`, aside: compensationLeft(compensation, now), order: -1 });
      for (const c of a.campaigns || []) {
        // Campaign manual tasks stay in the Tasks tab; they are not things this
        // plugin can do, so they do not raise reminders here.
        if (c.error) items.push({ tone: "soon", text: `${a.name}：${c.label}读取失败`, aside: c.error, order: 0.5 });
      }
      for (const [part, message] of Object.entries(a.errors || {})) items.push({ tone: "urgent", text: `${a.name}：${parts[part] || part}读取失败`, aside: message, order: 0 });
      if (a.expires && a.expires <= now) items.push({ tone: "urgent", text: `${a.name} 的登录已过期`, aside: "请在 Magpie「供应商」确认登录状态", order: 0 });
    }
    const unsigned = rows.map(a => [a, checked(a)]).filter(([, c]) => c && ["warn", "urgent"].includes(c.tone));
    if (unsigned.some(([a]) => a.checkin.outcome === "off")) items.push({ tone: "soon", text: "Magpie 的 WorkBuddy 每日签到没有开启", aside: "设置 › 用量 › 插件", order: 1 });
    for (const [a, c] of unsigned.filter(([a]) => a.checkin.outcome !== "off")) items.push({ tone: c.tone === "urgent" ? "urgent" : "soon", text: `${a.name}：${c.label}`, aside: c.note, order: 1 });
    const spent = new Map();
    for (const a of rows) for (const l of (a.limits || []).filter(l => !l.queued)) { const s = spent.get(l.model); if (s) { s.names.push(a.name); s.resets = Math.min(s.resets, l.resets); s.last = Math.max(s.last, l.resets); } else spent.set(l.model, { names: [a.name], resets: l.resets, last: l.resets }); }
    for (const [model, s] of spent) items.push({ kind: "limit", tone: "soon", text: `${model} 额度已用完（${s.names.join("、")}）`, aside: s.last > s.resets ? `${left(s.resets, now)} 起陆续恢复` : `${left(s.resets, now)} 恢复`, title: "这个模型在该账号上的 24 小时额度用完了，到点前可以换别的模型", order: 2 });
    const queued = new Map();
    for (const a of rows) for (const l of (a.limits || []).filter(l => l.queued)) { const q = queued.get(l.model); if (q) { q.names.push(a.name); if (l.queued.at > q.at) Object.assign(q, l.queued); } else queued.set(l.model, { names: [a.name], ...l.queued }); }
    for (const [model, q] of queued) items.push({ kind: "limit", queued: true, tone: "soon", text: `${model} 排队中（${q.names.join("、")}）`, aside: `预计 ${left(q.until, now)} 排到`, title: queueNote(q), order: 2.5 });
    const soon = new Map();
    for (const e of lapsing(rows).filter(g => g.expires - now <= 10 * DAY)) { const s = soon.get(e.name); if (s) { s.balance += e.balance; s.days++; } else soon.set(e.name, { ...e, first: e.balance, days: 1 }); }
    for (const e of soon.values()) items.push({ tone: tone(e.expires, now), text: e.resets ? `${e.name}还剩 ${num(e.balance)} 积分，用不完会清零` : e.days > 1 ? `${num(e.balance)} 积分（${e.name}）10 天内分 ${e.days} 天作废` : `${num(e.balance)} 积分（${e.name}${e.count > 1 ? ` ×${e.count}` : ""}）将作废`, aside: e.days > 1 ? `最早 ${when(e.expires)} · ${num(e.first)} 积分` : `${when(e.expires)}${e.resets ? " 重置" : ""} · ${left(e.expires, now)}`, order: e.expires });
    for (const e of manual.values()) items.push({ tone: "soon", text: `「${e.title}」${e.intl ? "需在国际版客户端完成" : "需手动完成"}${e.count > 1 ? ` ×${e.count}` : ""}`, aside: [e.credit ? `+${num(e.credit * e.count)} 积分` : "", e.ends !== Infinity && e.ends ? `${date(e.ends)} 截止` : ""].filter(Boolean).join(" · "), title: e.note, order: Infinity });
    return items.sort((x, y) => x.order - y.order);
  }

  let noting = false;
  function alerts(items) {
    if (!items.length) return el("div", "wb-calm", "没有需要你处理的事");
    const group = el("div", "wb-alert-group");
    const row = (i, plain) => { const r = el("div", `wb-alert-row ${plain ? "plain" : i.tone || "plain"}`); r.append(el("span", "wb-alert-text", i.text), el("span", "wb-alert-aside", i.aside)); if (i.title) r.title = i.title; return r; };
    const box = (list, head, cls) => { const b = el("section", `wb-alert-section${cls ? ` ${cls}` : ""}`); b.setAttribute("aria-label", head); b.append(el("div", "wb-alert-section-head", head), ...list.map(i => row(i))); return b; };
    const limited = items.filter(i => i.kind === "limit"), urgent = items.filter(i => i.kind !== "limit" && i.tone === "urgent"), rest = items.filter(i => i.kind !== "limit" && i.tone !== "urgent");
    if (limited.length) {
      const spent = limited.filter(i => !i.queued).length, queued = limited.length - spent;
      group.append(box(limited, [spent && `模型额度用完 ${spent} 个`, queued && `排队中 ${queued} 个`].filter(Boolean).join(" · "), ""));
    }
    if (urgent.length) group.append(box(urgent, "需要你处理", "urgent"));
    if (rest.length) {
      const fold = el("details", "wb-alert-more"), head = el("summary", "wb-alert-more-head");
      head.append(el("span", undefined, "其他提醒"), el("span", "wb-alert-more-count", `${rest.length} 件`));
      fold.open = noting;
      fold.ontoggle = () => { noting = fold.open; };
      const body = el("div", "wb-alert-more-body");
      body.append(...rest.map(i => row(i, true)));
      fold.append(head, body);
      group.append(fold);
    }
    return group;
  }

  // Quiet alert footer at the bottom of Board: one divider, then a flat list.
  function alertFooter(rows, now, skipLimits) {
    let items = attention(rows, now);
    if (skipLimits) items = items.filter(i => i.kind !== "limit");
    if (!items.length) return skipLimits ? null : el("p", "wb-alert-empty", "没有需要你处理的事");
    const limited = items.filter(i => i.kind === "limit"), urgent = items.filter(i => i.kind !== "limit" && i.tone === "urgent"), rest = items.filter(i => i.kind !== "limit" && i.tone !== "urgent");
    const strip = el("section", `wb-alert-footer${urgent.length ? " has-urgent" : limited.length ? " has-warn" : ""}`);
    strip.setAttribute("aria-label", "提醒摘要");
    const bar = el("div", "wb-alert-bar"), chips = el("div", "wb-alert-chips");
    const headline = urgent.length ? `需处理 ${urgent.length} 件` : limited.length ? `限额/排队 ${limited.length} 项` : `提醒 ${rest.length} 件`;
    chips.append(el("span", "wb-alert-mark", headline), el("span", "wb-alert-preview", [...urgent, ...limited, ...rest].slice(0, 2).map(i => i.aside ? `${i.text} · ${i.aside}` : i.text).join(" · ")));
    const toggle = el("button", "wb-alert-toggle", alertsOpen ? "收起 ▴" : `展开全部 ${items.length} 条 ↓`);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(alertsOpen));
    const body = el("div", "wb-alert-drawer");
    body.hidden = !alertsOpen;
    body.append(alerts(items));
    toggle.onclick = () => {
      alertsOpen = !alertsOpen;
      toggle.textContent = alertsOpen ? "收起 ▴" : `展开全部 ${items.length} 条 ↓`;
      toggle.setAttribute("aria-expanded", String(alertsOpen));
      body.hidden = !alertsOpen;
    };
    bar.append(chips, toggle);
    strip.append(bar, body);
    return strip;
  }

  // Read-only quota summary with expandable refusal and queue records.
  function quotaCard(rows, now) {
    const models = new Map();
    for (const a of rows) for (const l of (a.limits || [])) {
      const m = models.get(l.model) || { model: l.model, names: new Set(), resets: [], queued: [] };
      m.names.add(a.name);
      if (l.queued) m.queued.push(l.queued); else if (l.resets) m.resets.push(l.resets);
      models.set(l.model, m);
    }
    const card = el("section", "wb-quota"), head = el("div", "wb-quota-head");
    head.append(el("h2", "wb-quota-title", "模型额度"), el("span", models.size ? "wb-quota-state-summary warn" : "wb-quota-state-summary", models.size ? `${models.size} 个模型有额度或排队记录` : "未记录到额度耗尽或排队"));
    const details = el("details", "wb-quota-details"), summary = el("summary", "wb-quota-summary");
    summary.append(head, el("span", "wb-quota-toggle", models.size ? "查看记录" : "监测说明"));
    details.append(summary);
    for (const m of models.values()) {
      const row = el("div", "wb-quota-row"), q = m.queued[0], reset = m.resets.length ? Math.min(...m.resets) : 0;
      row.append(el("span", "wb-quota-model", m.model), el("span", "wb-quota-desc", `${[...m.names].join("、")} · ${q ? "排队中" : "额度已用完"}`), el("span", "wb-quota-state", q ? `第 ${q.position} 位 · 预计 ${left(q.until, now)} 排到` : reset ? `${left(reset, now)} 恢复` : "额度受限"));
      details.append(row);
    }
    details.append(el("p", "wb-sub", "依据真实请求拒绝和 Magpie 路由日志记录；未发现异常不代表已探测所有模型。"));
    card.append(details);
    return card;
  }

  // Accounts: a health and task matrix. Login renewal stays in Magpie.
  const accountSelection = new Set(), accountExpanded = new Set();
  let accountScope = "all";
  const accountHealthLabels = { normal: "正常", disabled: "已停用", paused: "任务已暂停", expired: "登录已过期", restricted: "账号受限", limited: "请求退避", quota: "模型额度用完", failed: "连续失败", attention: "执行失败" };
  const accountHealthGroup = state => state === "normal" ? "normal" : ["paused", "disabled"].includes(state) ? "paused" : state === "failed" ? "failed" : "attention";
  const accountHealthTone = state => state === "normal" ? "ok" : ["failed", "expired"].includes(state) ? "urgent" : ["paused", "disabled"].includes(state) ? "neutral" : "warn";
  const accountState = (a, now) => a.health?.state || (a.enabled === false ? "disabled" : a.paused ? "paused" : a.expires && a.expires <= now ? "expired" : "normal");
  const accountScopeRows = (rows, now) => rows.filter(a => accountScope === "domestic" ? !a.enterprise && !abroad(a) : accountScope === "abnormal" ? accountHealthGroup(accountState(a, now)) !== "normal" : true);

  function accountNextExpiry(a, now) {
    const lots = [];
    for (const p of a.balance?.packages || []) for (const l of lotsOf(p)) if (l.balance > 0 && l.expires && l.expires > now) lots.push({ ...l, resets: p.resets });
    const next = lots.sort((x, y) => x.expires - y.expires)[0];
    return next ? `最近一笔积分 ${when(next.expires)} ${next.resets ? "重置" : "作废"}` : "暂无可计算的积分到期日";
  }

  function accountFailedJob(view, a) {
    return (view.jobs || []).find(job => {
      if (!badJob(job) || !job.accounts?.includes(a.id)) return false;
      if ((view.jobs || []).some(next => next.retryOf === job.id)) return false;
      const queued = job.queue?.find(row => row.account === a.id);
      return !queued || !["succeeded", "paused", "skipped"].includes(queued.status);
    });
  }

  function accountsView(rows, view, now) {
    const box = el("div", "wb-accounts"), intro = el("div", "wb-accounts-intro"), introText = el("div");
    introText.append(el("h2", undefined, "账号与健康"), el("p", "wb-sub", "查看各号的健康状态与下一次定时。停用后只暂停任务，看板继续更新。"));
    intro.append(introText);

    const states = rows.map(a => accountState(a, now));
    const summary = el("div", "wb-account-summary");
    for (const [key, label] of [["normal", "正常"], ["attention", "需留意"], ["failed", "连续失败"], ["paused", "已暂停"]]) {
      const count = states.filter(state => accountHealthGroup(state) === key).length, item = el("span", `wb-account-summary-item ${key === "normal" ? "ok" : key === "failed" ? "urgent" : key === "paused" ? "neutral" : "warn"}`);
      item.dataset.count = String(count);
      item.append(el("i", "wb-account-status-dot"), label, el("strong", undefined, String(count)));
      summary.append(item);
    }
    const scopeOptions = [
      ["all", `全部账号 ${rows.length}`],
      ["domestic", `国内个人 ${rows.filter(a => !a.enterprise && !abroad(a)).length}`],
      ["abnormal", `仅看异常 ${rows.filter(a => accountHealthGroup(accountState(a, now)) !== "normal").length}`]
    ];
    const toolbar = el("div", "wb-account-toolbar");
    toolbar.append(summary, segs(scopeOptions, accountScope, value => { accountScope = value; again(); }, "账号范围", null, "accountScope"));
    box.append(intro, toolbar);

    const selectedIds = [...accountSelection].filter(id => rows.some(a => a.id === id && a.enabled !== false));
    for (const id of [...accountSelection]) if (!rows.some(a => a.id === id && a.enabled !== false)) accountSelection.delete(id);
    const selectedCount = el("p", "wb-account-selection-count", `已选 ${selectedIds.length} 个账号`);
    selectedCount.setAttribute("role", "status");
    selectedCount.hidden = selectedIds.length === 0;
    box.append(selectedCount);

    const wrap = el("div", "wb-account-table-wrap"), table = el("table", "wb-account-table"), head = el("thead"), body = el("tbody"), headRow = el("tr");
    table.setAttribute("aria-label", "账号健康表");
    const selectHead = el("th"), selectAll = el("input");
    selectAll.type = "checkbox";
    selectAll.setAttribute("aria-label", "选择当前筛选的全部账号");
    selectHead.append(selectAll); headRow.append(selectHead);
    for (const title of ["账号", "健康状态 · 下次定时", "停用账号"]) headRow.append(el("th", undefined, title));
    head.append(headRow);

    const visibleRows = accountScopeRows(rows, now);
    selectAll.checked = visibleRows.length > 0 && visibleRows.every(a => accountSelection.has(a.id));
    selectAll.indeterminate = visibleRows.some(a => accountSelection.has(a.id)) && !selectAll.checked;
    selectAll.onchange = () => { for (const a of visibleRows) selectAll.checked ? accountSelection.add(a.id) : accountSelection.delete(a.id); again(); };

    const feedback = workStatus();
    for (const a of visibleRows) {
      const health = a.health || {}, state = accountState(a, now);
      const healthTone = accountHealthTone(state), detailId = `account-detail-${String(a.id).replace(/[^A-Za-z0-9_-]/g, "-")}`;
      const failedJob = accountFailedJob(view, a);
      const row = el("tr", `wb-account-main-row${accountSelection.has(a.id) ? " selected" : ""}`);
      row.dataset.account = a.id;

      const pick = el("td", "wb-account-pick"), select = el("input");
      select.type = "checkbox"; select.checked = accountSelection.has(a.id); select.disabled = a.enabled === false;
      select.setAttribute("aria-label", `选择 ${a.name}`);
      select.onchange = () => { select.checked ? accountSelection.add(a.id) : accountSelection.delete(a.id); again(); };
      pick.append(select);

      const who = el("td"), account = el("div", "wb-account-identity"), avatar = el("span", "wb-account-avatar", String(a.name || "?").trim().slice(0, 1).toUpperCase());
      const info = el("div", "wb-account-info"), toggle = el("button", "wb-account-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(accountExpanded.has(a.id)));
      toggle.setAttribute("aria-controls", detailId);
      toggle.append(el("span", "wb-account-name", a.name), el("i", undefined, "›"));
      toggle.onclick = () => { accountExpanded.has(a.id) ? accountExpanded.delete(a.id) : accountExpanded.add(a.id); again(); };
      info.append(toggle);
      account.append(avatar, info); who.append(account);

      const healthCell = el("td", "wb-account-health-cell"), status = el("span", `wb-account-status ${healthTone}`);
      const healthText = state === "limited" && health.cooldownUntil > now ? `${accountHealthLabels[state]} · ${Math.ceil((health.cooldownUntil - now) / 1000)} 秒` : state === "failed" ? `${accountHealthLabels[state]} · ${health.failures || 0} 次` : accountHealthLabels[state] || state;
      status.append(el("i", "wb-account-status-dot"), healthText);
      const lastSuccess = health.lastSuccess ? (days(Date.parse(health.lastSuccess), now) === 0 ? clock(Date.parse(health.lastSuccess)) : when(Date.parse(health.lastSuccess))) : "暂无";
      const cooldown = health.cooldownUntil > now ? `冷却 ${Math.ceil((health.cooldownUntil - now) / 1000)} 秒 · ` : "";
      const next = health.next ? `下次 ${health.next}` : a.enterprise ? "仅刷新看板" : ["paused", "disabled"].includes(state) ? "暂停期间不执行" : "等待下一次定时";
      const healthTop = el("div", "wb-account-health-top");
      healthTop.append(status, el("span", "wb-account-cell-meta", `${cooldown}${next}`));
      healthCell.append(healthTop, el("div", "wb-account-cell-meta", `最近成功 ${lastSuccess}${health.failures ? ` · 失败 ${health.failures} 次` : ""}`));

      const actionCell = el("td", "wb-account-pause-cell");
      if (a.enterprise || a.enabled === false) actionCell.append(el("span", "wb-account-readonly", "只读"));
      else if (hooks.onPauseAccount) {
        const pause = workButton(a.paused ? "恢复账号" : "停用账号", () => hooks.onPauseAccount(a.id, !a.paused), feedback);
        pause.className = `wb-account-pause${a.paused ? " paused" : ""}`;
        actionCell.append(pause);
      }

      row.append(pick, who, healthCell, actionCell);
      body.append(row);

      const detailRow = el("tr", "wb-account-detail-row"), detailCell = el("td"), disclosure = el("div", accountExpanded.has(a.id) ? "wb-account-disclosure open" : "wb-account-disclosure"), inner = el("div", "wb-account-disclosure-inner"), diagnostic = el("div", "wb-account-diagnostic");
      detailCell.colSpan = 4;
      disclosure.id = detailId;
      if (!accountExpanded.has(a.id)) { disclosure.inert = true; disclosure.setAttribute("aria-hidden", "true"); }
      const detailHead = el("div", "wb-account-detail-head"), heading = el("div"), balance = a.balance ? `${num(a.balance.balance)}${a.balance.size ? ` / ${num(a.balance.size)}` : ""} 积分` : "积分读取失败";
      heading.append(el("strong", undefined, `${a.name} · 诊断与积分`), el("p", "wb-account-cell-meta", `${balance} · 连续失败 ${health.failures || 0} 次 · ${accountNextExpiry(a, now)}`));
      detailHead.append(heading);
      if (failedJob && hooks.onRetry) {
        const retry = workButton("重试失败操作", () => hooks.onRetry(failedJob.id), feedback);
        retry.className = "wb-account-detail-action";
        detailHead.append(retry);
      }
      diagnostic.append(detailHead);
      const retries = (failedJob?.retries || []).filter(entry => entry.account === a.id);
      if (retries.length) {
        diagnostic.append(el("strong", "wb-account-chain-title", "请求重试明细"));
        const chain = el("ol", "wb-account-retry-chain");
        for (const entry of retries) {
          const step = el("li", entry.error ? "urgent" : "ok");
          step.append(
            el("strong", undefined, entry.attempt === 1 ? "首次请求" : `重试 ${entry.attempt - 1}/2`),
            el("span", undefined, `HTTP ${entry.status}`),
            el("time", undefined, new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })),
            el("div", "wb-account-cell-meta", `${actionNames[entry.action] || "任务请求"}${entry.waitMs ? ` · 等待 ${entry.waitMs / 1000} 秒后重试` : entry.error ? " · 本次请求停止重试" : " · 请求已恢复"}`)
          );
          chain.append(step);
        }
        diagnostic.append(chain);
      } else {
        const errorLog = [...(failedJob?.logs || [])].reverse().find(entry => entry.account === a.id && logFailed(entry));
        if (errorLog) diagnostic.append(el("p", "wb-account-recent-error", `${when(Date.parse(errorLog.at))} · ${errorLog.message}`));
        else diagnostic.append(el("p", "wb-account-cell-meta", "近期没有记录到失败重试。"));
      }
      inner.append(diagnostic); disclosure.append(inner); detailCell.append(disclosure); detailRow.append(detailCell); body.append(detailRow);
    }
    table.append(head, body); wrap.append(table); box.append(wrap);
    box.append(el("p", "wb-account-hint", "点击账号名称展开诊断与最近失败重试链；勾选后批量操作。"), feedback);

    const batch = el("div", "wb-account-batch"), refreshBatch = workButton("刷新余额", () => {
      if (!hooks.onRunAction) throw new Error("当前页面不支持刷新余额");
      return hooks.onRunAction("refresh", selectedIds);
    }, feedback), pauseBatch = workButton("暂停账号任务", () => {
      const ids = selectedIds.filter(id => { const a = rows.find(row => row.id === id); return a && !a.enterprise && a.enabled !== false; });
      if (!ids.length) throw new Error("所选账号没有可暂停的个人任务");
      return hooks.onPauseAccounts(ids, true);
    }, feedback), clear = el("button", "wb-account-batch-button", "取消选择");
    refreshBatch.className = pauseBatch.className = "wb-account-batch-button";
    refreshBatch.disabled = !selectedIds.length || !hooks.onRunAction;
    pauseBatch.disabled = !selectedIds.some(id => { const a = rows.find(row => row.id === id); return a && !a.enterprise && a.enabled !== false; }) || !hooks.onPauseAccounts;
    clear.type = "button";
    clear.onclick = () => { accountSelection.clear(); again(); };
    batch.append(refreshBatch, pauseBatch, clear);
    batch.classList.toggle("visible", selectedIds.length > 0);
    batch.inert = selectedIds.length === 0;
    batch.setAttribute("aria-label", "账号批量操作");
    batch.setAttribute("aria-hidden", String(selectedIds.length === 0));
    box.classList.toggle("has-selection", selectedIds.length > 0);
    layout.floating.append(batch);
    return box;
  }

  function builds(rows) {
    const all = [["cn", rows.filter(a => !abroad(a))], ["intl", rows.filter(abroad)]].filter(([, list]) => list.length);
    return order === "intl" ? all.reverse() : all;
  }

  function groupHead(kind, list, now, first, compact) {
    const head = el("div", "wb-group-head"), name = el("span", "wb-group-name", kind === "intl" ? "国际版" : "国内版");
    if (!first) {
      const up = el("button", "wb-group-move", "移到上面");
      up.type = "button";
      up.onclick = () => { order = kind; orderSaved.set(kind); again(); };
      name.append(up);
    }
    const total = el("span", "wb-group-total");
    const personal = list.filter(a => !a.enterprise), teams = list.filter(a => a.enterprise);
    if (personal.length) total.append(el("strong", undefined, fine(personal.reduce((s, a) => s + (a.balance?.balance || 0), 0))), el("span", "wb-sub", ` 个人积分 · ${personal.length} 个账号`));
    if (teams.length) total.append(el("span", "wb-sub wb-enterprise-note", `${teams.length} 个企业账号 · 额度单独列示`));
    const top = line(name, total);
    top.className += " wb-group-top";
    head.append(top);
    if (compact) return head;
    const credit = list.reduce((s, a) => s + (a.usage?.credit || 0), 0), facts = [];
    if (kind === "cn") {
      const claimed = personal.reduce((s, a) => s + (a.tasks?.claimed || 0), 0), total_ = personal.reduce((s, a) => s + (a.tasks?.total || 0), 0), done = personal.filter(a => closed(today(a, now))).length;
      if (personal.length) facts.push(done === personal.length ? "今日全部完成" : `今日 ${done}/${personal.length} 完成`);
      if (total_) facts.push(`成长 ${claimed}/${total_}`);
    } else if (personal.length) {
      const got = personal.filter(a => earned(a, now).tone === "ok").length;
      facts.push(personal.length === 1 ? `每日奖励${earned(personal[0], now).label.replace(/^今日/, " 今日")}` : `每日奖励 ${got}/${personal.length} 今日到账`);
    }
    facts.push(`近 7 天 ${num(credit)}`);
    head.append(el("div", "wb-sub wb-group-meta", facts.join(" · ")));
    return head;
  }

  function history(l, now) {
    const head = line(el("span", "wb-label", "积分流水 · 近 7 天"), el("span", "wb-sub", l ? `获得 +${num(l.gained)} · 用掉 ${num(l.used)}` : ""));
    if (!l?.entries.length) return [head, el("div", "wb-sub", "近 7 天没有新到账的积分")];
    const list = el("div", "wb-ledger");
    for (const e of l.entries.slice(0, 10)) {
      const row = el("div", "wb-ledger-row");
      row.append(el("span", "wb-sub", when(e.at)), el("strong", "wb-gain", `+${num(e.credit)}`), el("span", "wb-ledger-why", e.source || short(e.name)),
        el("span", `wb-sub wb-when ${e.left > 0 && e.ends ? tone(e.ends, now) : ""}`, e.left <= 0 ? "已用完" : e.ends ? `余 ${num(e.left)} · ${date(e.ends)} 作废` : `余 ${num(e.left)}`));
      row.title = short(e.name);
      list.append(row);
    }
    return [head, el("div", "wb-sub", l.sources.map(([k, v]) => `${k} +${num(v)}`).join(" · ")), list];
  }

  function spending(u, id, account) {
    if (!u) return [];
    const enterprise = !!account?.enterprise;
    const head = line(el("span", "wb-label", `扣分明细 · 近 7 天${enterprise ? "（企业团队）" : ""}`), el("span", "wb-sub", enterprise ? `${num(u.credit)} 积分 · 本账号 ${num(u.charges)} 次请求` : `${num(u.charges)} 次扣分${u.free ? ` · 另有 ${num(u.free)} 次免费` : ""}`));
    if (!u.recent.length && !enterprise) return [head, el("div", "wb-sub", "近 7 天没有扣分的请求")];
    const first = !firstPaint.has(id), sib = first ? null : (seenCharges.get(id) || new Set());
    if (first) firstPaint.add(id);
    const settled = new Set(), row = e => {
      const k = chargeKey(e), isNew = sib && !sib.has(k);
      settled.add(k);
      const r = el("div", `wb-ledger-row${isNew ? " wb-charge-new" : ""}`);
      r.append(el("span", "wb-sub wb-clock", clock(e.at)), el("strong", "wb-spend", `−${fine(e.credit)}`), el("span", "wb-ledger-why", e.model), el("span", "wb-sub", e.client || ""));
      r.title = `${e.model}${e.client ? ` · ${e.client}` : ""} · ${fine(e.credit)} 积分`;
      return r;
    };
    const remember = () => seenCharges.set(id, settled);
    if (enterprise) {
      const daysEl = el("div", "wb-ledger");
      for (const d of [...u.days].reverse().filter(d => d.credit > 0)) {
        const r = el("div", "wb-ledger-row");
        r.append(el("span", "wb-sub", d.date), el("strong", "wb-spend", `−${fine(d.credit)}`), el("span", "wb-ledger-why", "企业团队"), el("span", "wb-sub", d.count ? `本账号 ${num(d.count)} 次` : ""));
        r.title = `${d.date} 企业额度合计 ${fine(d.credit)} 积分${d.count ? `；本账号 ${d.count} 次请求` : ""}`;
        daysEl.append(r);
      }
      const out = [head, daysEl, el("div", "wb-sub", "企业额度由团队共用，按天合计来自企业用量接口；本账号请求只占其中一部分。")];
      if (u.recent.length) {
        const mine = el("details", "wb-more"), inner = el("div", "wb-ledger");
        mine.open = unfolded.has(id);
        mine.ontoggle = () => { if (mine.open) unfolded.add(id); else unfolded.delete(id); };
        inner.append(...u.recent.map(row));
        mine.append(el("summary", "wb-sub", `本账号请求明细（${num(u.charges)} 条）`), inner);
        out.push(mine);
      }
      remember();
      return out;
    }
    const list = el("div", "wb-ledger");
    list.append(...u.recent.slice(0, 10).map(row));
    const out = [head, list];
    if (u.recent.length > 10) {
      const more = el("details", "wb-more"), rest = el("div", "wb-ledger");
      more.open = unfolded.has(id);
      more.ontoggle = () => { if (more.open) unfolded.add(id); else unfolded.delete(id); };
      rest.append(...u.recent.slice(10).map(row));
      more.append(el("summary", "wb-sub", `再显示 ${u.recent.length - 10} 条`), rest);
      out.push(more);
    }
    if (u.charges > u.recent.length) out.push(el("div", "wb-sub", `只保留最近 ${u.recent.length} 条；更早的计入上面的合计`));
    remember();
    return out;
  }

  function timeline(b, now) {
    const byDay = new Map();
    for (const g of lapsing([{ id: "", balance: b }])) { const d = byDay.get(date(g.expires)); if (d) { d.balance += g.balance; d.name += `、${g.name}`; } else byDay.set(date(g.expires), { ...g }); }
    const days_ = [...byDay.values()], lasting = b.packages.filter(p => !p.expires), wrap = el("div", "wb-timeline");
    if (days_.length) {
      const end = Math.max(...days_.map(p => p.expires)), span = Math.max(end - now, DAY), most = Math.max(...days_.map(p => p.balance), 1);
      const track = el("div", "wb-track");
      days_.forEach((p, i) => {
        const x = Math.min(100, Math.max(0, (p.expires - now) / span * 100)), size = Math.round(8 + 10 * Math.sqrt(p.balance / most)), shown = i < 3 || i === days_.length - 1 || p.balance === most;
        const dot = el("span", `wb-pkg-dot ${tone(p.expires, now)}`), label = el("span", `wb-tl-label ${tone(p.expires, now)}${i % 2 ? " low" : ""}${x > 75 ? " end" : x < 12 ? " start" : ""}`, shown ? `${date(p.expires)} · ${num(p.balance)}` : "");
        dot.style.left = label.style.left = `${x}%`;
        dot.style.width = dot.style.height = `${size}px`;
        dot.title = `${p.name} ${num(p.balance)} 积分 · ${when(p.expires)} ${lapse(p)} · ${left(p.expires, now)}`;
        track.append(dot, label);
      });
      wrap.append(track, line(el("span", "wb-sub", "今天"), el("span", "wb-sub", "积分作废时间线 · 圆点越大积分越多")));
    }
    if (lasting.length) wrap.append(el("div", "wb-sub", `长期有效：${lasting.map(p => `${short(p.name)} ${num(p.balance)}`).join("、")}`));
    return wrap;
  }

  // Account detail panel: kept unchanged from the existing expandable layout.
  function detail(a, now) {
    const grid = el("div", "wb-detail-grid"), left_ = el("div", "wb-col-l"), right = el("div", "wb-col-r");
    left_.append(el("div", "wb-label", "积分包"));
    for (const p of a.balance?.packages || []) {
      const k = tone(p.expires, now), lots = lotsOf(p).filter(l => l.expires), soon = lots.filter(l => l.expires - now <= 10 * DAY).reduce((s, l) => s + l.balance, 0);
      const row = line(el("span", "wb-name", `${short(p.name)} ${num(p.balance)}`), el("span", `wb-when ${k}`, !p.expires ? "长期有效" : lots.length > 1 ? `${left(p.expires, now)}起陆续${lapse(p)}` : `${left(p.expires, now)}${p.resets ? "重置" : ""}`));
      if (lots.length > 1) row.title = lots.map(l => `${when(l.expires)} ${num(l.balance)}`).join("\n");
      left_.append(row);
      if (lots.length > 1 && soon > 0 && soon < p.balance) left_.append(el("div", `wb-sub wb-when ${k}`, `其中 ${num(soon)} 积分 10 天内${lapse(p)}`));
    }
    if (a.balance && !a.balance.packages.length) left_.append(el("div", "wb-sub", a.enterprise ? (a.balance.size ? "本月企业额度已用完" : "没有企业额度") : "没有可用积分包"));
    const u = a.usage;
    left_.append(line(el("span", "wb-label", "近 7 天用量"), el("span", "wb-sub", u ? a.enterprise ? `${num(u.credit)} 积分 · 企业团队合计` : `${num(u.credit)} 积分 · ${u.count} 次` : "")));
    if (u) {
      left_.append(bars(u));
      if (u.models.length) left_.append(el("div", "wb-sub", `${a.enterprise ? "本账号模型：" : ""}${u.models.map(m => `${m.model} ${num(m.credit)}`).join(" · ")}`));
    }
    for (const l of a.limits || []) {
      const row = l.queued
        ? line(el("span", "wb-name", `${l.model} 排队中`), el("span", "wb-when soon", `第 ${l.queued.position} 位 · 预计 ${left(l.queued.until, now)}`))
        : line(el("span", "wb-name", `${l.model} 额度已用完`), el("span", "wb-when soon", `${left(l.resets, now)} 恢复`));
      row.title = l.queued ? queueNote(l.queued) : `${when(l.resets)} 恢复；在那之前可以换别的模型`;
      left_.append(row);
    }
    left_.append(...history(a.ledger, now));
    grid.append(left_);

    const spent = spending(u, a.id, a);
    if (a.enterprise) { right.append(...spent); grid.append(right); return grid; }

    const g = a.growth, s = a.streak, t = a.tasks, top = g && ["UR", "SSR", "SR"].find(r => g.rarity[r]);
    const ci = checked(a), intl = a.realm === "intl";
    if (ci) right.append(line(el("span", "wb-label", intl ? "每日签到" : "Buddy 加油站"), el("span", `wb-pill ${ci.tone}`, ci.label)), ...(ci.note ? [el("div", "wb-sub", ci.note)] : []));
    if (intl) { const r = earned(a, now); right.append(line(el("span", "wb-label", "每日活跃奖励"), el("span", `wb-pill ${r.tone}`, r.label)), el("div", "wb-sub", r.note)); }

    const fold = el("details", "wb-fold"), head = el("summary", "wb-line"), body = el("div", "wb-fold-body");
    head.append(el("span", "wb-label", "成长"), el("span", "wb-sub wb-fold-arrow", intl ? (s ? `连登 ${s.days} 天` : "") : t ? `任务 ${t.claimed}/${t.total}` : ""));
    fold.open = grown.has(a.id);
    fold.ontoggle = () => { if (fold.open) grown.add(a.id); else grown.delete(a.id); };
    fold.append(head, body);
    right.append(fold);
    body.append(el("div", "wb-stats", [g && `能量 ${num(g.energy)}`, g && `Buddy ${g.buddies}${top ? `（含 ${top}）` : ""}`, g && `抽奖 ${g.draws}`, s && `补签卡 ${s.makeupCards}`, s && `成长计划连登 ${s.days} 天`].filter(Boolean).join(" · ")));
    if (s?.nextTier) body.append(el("div", "wb-sub", `再连登 ${s.nextTier.remaining} 天到 ${s.nextTier.days} 天档：${[s.nextTier.credit && `+${s.nextTier.credit} 积分`, s.nextTier.energy && `+${s.nextTier.energy} 能量`].filter(Boolean).join(" · ") || "奖励"}`));
    const states = { claimable: ["可领奖", "ok"], auto: ["定时会完成", "go"], manual: ["需手动", "warn"], locked: ["未解锁", ""] };
    for (const task of intl ? [] : t?.open || []) {
      const [label, cls] = states[task.state] || [task.state, ""];
      const status = task.state === "locked" && task.unlockAt > now ? `${when(task.unlockAt)} 解锁` : label;
      const row = line(el("span", "wb-name", task.title), el("span", `wb-pill ${cls}`, status));
      row.title = [task.target ? `${task.current}/${task.target}` : "", task.credit ? `+${task.credit} 积分` : "", task.ends ? `${date(task.ends)} 截止` : "", task.note].filter(Boolean).join(" · ");
      body.append(row);
    }
    if (a.campaigns?.length) {
      const box = el("div", "wb-campaigns");
      box.append(el("div", "wb-label", "活动"));
      for (const c of a.campaigns) {
        if (c.error) { box.append(line(el("span", "wb-name", c.label), el("span", "wb-pill warn", "读取失败"))); continue; }
        const claimed = c.tasks.filter(x => x.claimed).length;
        box.append(line(el("span", "wb-name", c.label), el("span", "wb-sub", `${claimed}/${c.tasks.length} 已领`)));
        for (const task of c.tasks) {
          const [label, cls] = task.claimed ? ["已领取", "ok"] : task.done ? ["可领奖", "ok"] : task.manual ? ["需手动", "warn"] : ["定时会完成", "go"];
          const row = line(el("span", "wb-name", task.label), el("span", `wb-pill ${cls}`, label));
          row.title = [`${task.progress}/${task.target}`, task.credit ? `+${task.credit} 积分` : ""].filter(Boolean).join(" · ");
          box.append(row);
        }
      }
      right.append(box);
    }
    const tr = trip(a.travel, now, a);
    if (tr) {
      right.append(line(el("span", "wb-label", "猫猫旅行"), el("span", `wb-pill ${tr.tone}`, a.travel?.name ? `${a.travel.name} · ${tr.label}` : tr.label)), el("div", "wb-sub", tr.note));
      if (tr.progress !== undefined) { const b = el("div", "wb-bar"), f = el("span"); f.style.width = `${Math.max(2, tr.progress * 100)}%`; b.append(f); right.append(b); }
    }
    right.append(...spent);
    grid.append(right);
    return grid;
  }

  function account(a, now) {
    const wrap = el("div", "wb-acct"), row = el("button", "wb-row"), panel = el("div", "wb-detail"), inner = el("div", "wb-detail-in");
    const id = `wb-detail-${String(a.id).replace(/[^\w-]/g, "_")}`, open = expanded.has(a.id);
    row.type = "button";
    row.setAttribute("aria-expanded", String(open));
    row.setAttribute("aria-controls", id);
    panel.id = id;
    if (open) panel.className = "wb-detail open";
    else panel.setAttribute("aria-hidden", "true");

    const who = el("span", "wb-who");
    who.append(el("strong", undefined, a.name), el("span", "wb-sub", a.enterprise ? `企业${a.balance?.size ? ` · 每月 ${num(a.balance.size)} 积分` : ""}` : `${a.realm === "intl" && !both ? "国际版" : "个人"}${a.streak ? ` · 连登 ${a.streak.days} 天` : ""}${checked(a) ? ` · ${checked(a).label}` : ""}${a.intlOff ? " · 自动任务已关闭" : ""}`));
    const money = el("span", "wb-money");
    if (a.balance?.size) { const n = line(el("strong", undefined, num(a.balance.balance)), el("span", "wb-sub", `/ ${num(a.balance.size)}`)); n.className = "wb-line wb-amount"; money.append(n, meter(a.balance, now)); }
    else money.append(el("span", "wb-sub", a.errors.balance ? "积分读取失败" : a.enterprise ? "没有企业额度" : "没有积分包"));
    const glance = el("span", "wb-glance"), r = today(a, now);
    if (r) { const holder = el("span", "wb-rings-box"); holder.title = `今日活跃${r.active ? "✓" : "✗"}${r.trip === null ? "" : ` · 猫猫旅行 ${Math.round(r.trip * 100)}%`} · 成长任务 ${a.tasks ? `${a.tasks.claimed}/${a.tasks.total}` : "—"}`; holder.append(rings(r)); glance.append(holder); }
    else glance.append(el("span", "wb-rings-box"));
    glance.append(spark(a.usage));
    row.append(el("span", "wb-avatar", Array.from(a.name || "?")[0]), who, money, glance, el("span", "wb-chevron", "›"));

    inner.append(detail(a, now));
    panel.append(inner);
    row.onclick = () => {
      const next = !expanded.has(a.id);
      if (next) expanded.add(a.id); else expanded.delete(a.id);
      row.setAttribute("aria-expanded", String(next));
      panel.className = next ? "wb-detail open" : "wb-detail";
      if (next) panel.removeAttribute("aria-hidden"); else panel.setAttribute("aria-hidden", "true");
    };
    wrap.append(row, panel);
    return wrap;
  }

  function listView(rows, now) {
    const box = el("div", "wb-view-list");
    builds(rows).forEach(([kind, mine], i) => {
      const group = el("section", "wb-group"), list = el("div", "wb-list");
      group.setAttribute("aria-label", kind === "intl" ? "国际版" : "国内版");
      if (i === 0) {
        const head = el("div", "wb-row wb-list-head");
        head.append(el("span"), el("span", undefined, "账号"), el("span", undefined, "积分 · 按作废先后"), el("span", undefined, "今日 · 7 天"), el("span"));
        list.append(head);
      }
      for (const a of mine) list.append(account(a, now));
      group.append(groupHead(kind, mine, now, i === 0), list);
      box.append(group);
    });
    box.append(el("p", "wb-legend", "圆环由外到内：今日活跃、猫猫旅行、成长任务。积分条：红 = 2 天内作废，橙 = 10 天内，浅色 = 长期有效。"));
    return box;
  }

  function ringsView(rows, now) {
    const box = el("div", "wb-view-rings");
    if (focus && !rows.some(a => a.id === focus)) focus = null;
    box.append(segs([["all", "全部"], ...rows.map(a => [a.id, a.enterprise ? "企业" : a.name])], focus || "all", v => { focus = v === "all" ? null : v; again(); }, "选择账号"));
    if (!focus) {
      builds(rows).forEach(([kind, mine], i) => {
        const group = el("section", "wb-group"), grid = el("div", "wb-ringcards");
        group.append(groupHead(kind, mine, now, i === 0, true), grid);
        box.append(group);
        for (const a of mine) {
          const card = el("button", "wb-ringcard"), r = today(a, now);
          card.type = "button";
          const done = r ? goals(r).filter(v => v >= 1).length : 0, all = r ? goals(r).length : 0;
          card.append(r ? rings(r, true) : el("div", "wb-ring-none", "企业账号"), el("strong", undefined, a.name),
            el("span", "wb-sub", a.balance?.size ? `${num(a.balance.balance)} 积分${a.enterprise ? ` / 每月 ${num(a.balance.size)}` : ""}` : a.enterprise ? "没有企业额度" : "没有积分包"),
            el("span", "wb-sub", r ? (done === all ? "今日全部完成" : `今日完成 ${done}/${all}`) : `近 7 天 ${num(a.usage?.credit)} 积分`));
          card.onclick = () => { focus = a.id; again(); };
          grid.append(card);
        }
      });
      return box;
    }
    const a = rows.find(x => x.id === focus), r = today(a, now), top = el("div", r ? "wb-b-top" : "wb-b-top solo");
    if (r) {
      const card = el("div", "wb-card wb-b-rings"), legend = el("div", "wb-keys"), tr = trip(a.travel, now, a);
      for (const [k, label, value] of [["a", "今日活跃", a.streak ? (a.streak.active ? `连登 ${a.streak.days} 天` : "今天还没活跃") : "—"], ...(r.trip === null ? [] : [["b", "猫猫旅行", tr ? tr.label : "—"]]), ["c", "成长任务", a.tasks ? `${a.tasks.claimed}/${a.tasks.total}` : "—"]]) {
        const name = el("span", "wb-key"); name.append(el("i", `wb-dot wb-dot-${k}`), label);
        legend.append(line(name, el("span", "wb-sub", value)));
      }
      const ci = checked(a);
      if (ci) { const name = el("span", "wb-key"); name.append(el("i", "wb-dot wb-dot-none"), "每日签到"); const row = line(name, el("span", `wb-pill ${ci.tone}`, ci.label)); row.title = ci.note; legend.append(row); }
      const fit = el("div", "wb-ring-fit");
      fit.append(rings(r, true));
      card.append(fit, legend);
      top.append(card);
    }
    const side = el("div", "wb-b-side"), money = el("div", "wb-card");
    const amount = el("div", "wb-hero");
    amount.append(el("strong", undefined, a.balance?.size ? num(a.balance.balance) : "—"), el("span", "wb-sub", a.balance?.size ? `/ ${num(a.balance.size)} 积分` : a.enterprise ? "没有企业额度" : "没有积分包"));
    money.append(amount);
    if (a.balance?.packages.length) money.append(timeline(a.balance, now));
    const use = el("div", "wb-card"), u = a.usage;
    use.append(line(el("span", "wb-label", "近 7 天用量"), el("span", "wb-sub", u ? `${num(u.credit)} 积分 · ${u.count} 次` : a.errors.usage || "")));
    if (u) { use.append(bars(u)); if (u.models.length) use.append(el("div", "wb-sub", u.models.map(m => `${m.model} ${num(m.credit)}`).join(" · "))); }
    side.append(money, use);
    top.append(side);
    box.append(top);
    if (!a.enterprise) {
      const foot = el("div", "wb-card wb-b-foot"), manual = (a.tasks?.open || []).filter(t => t.state === "manual"), g = a.growth, s = a.streak;
      const todo = el("span", "wb-b-todo");
      if (manual.length) todo.append(el("span", "wb-label", "待处理"), el("span", "wb-warn-text", manual.map(t => `${t.title}${t.credit ? ` · +${t.credit} 积分` : ""}`).join("；")));
      foot.append(todo, el("span", "wb-sub", [g && `能量 ${num(g.energy)}`, g && `Buddy ${g.buddies}`, g && `抽奖 ${g.draws}`, s?.nextTier && `再 ${s.nextTier.remaining} 天到 ${s.nextTier.days} 天档`].filter(Boolean).join(" · ")));
      box.append(foot);
    }
    return box;
  }

  function widgetsView(rows, now) {
    const grid = el("div", "wb-widgets"), personal = rows.filter(a => !a.enterprise);
    const widget = (size, cls, title, ...children) => { const w = el("section", `wb-w wb-w-${size}${cls ? ` ${cls}` : ""}`); w.setAttribute("aria-label", title); w.append(el("span", "wb-w-title", title), ...children); grid.append(w); return w; };

    const next = lapsing(rows)[0], d = next ? days(next.expires, now) : 0;
    if (next) widget("s", tone(next.expires, now), "即将作废", el("strong", "wb-w-big", d <= 0 ? "今天" : d === 1 ? "明天" : `${d} 天`), el("span", "wb-w-foot", `${num(next.balance)} 积分 · ${date(next.expires)}${next.resets ? " 重置" : ""}`));
    else widget("s", "", "即将作废", el("strong", "wb-w-big", "无"), el("span", "wb-w-foot", "没有会作废的积分"));

    const rings_ = widget("s", "", "今日");
    const ringRow = el("div", "wb-w-rings");
    for (const a of personal) { const r = today(a, now), cell = el("div", "wb-w-ring"); cell.append(rings(r), el("span", "wb-sub", a.name)); ringRow.append(cell); }
    rings_.append(el("strong", "wb-w-mid", personal.length ? `${personal.filter(a => closed(today(a, now))).length}/${personal.length} 完成` : "—"), ringRow);
    const signable = personal.filter(a => checked(a)), signed = signable.filter(a => checked(a).tone === "ok").length;
    if (signable.length) rings_.append(el("span", "wb-w-foot", `签到 ${signed}/${signable.length}`));
    rings_.title = "外环活跃 · 中环旅行 · 内环任务";

    const trips = personal.map(a => ({ a, t: trip(a.travel, now, a) })).filter(x => x.t), out = trips.filter(x => x.t.progress !== undefined);
    const labels = [...new Set(trips.map(x => x.t.label))];
    const cats = widget("s", "", "猫猫", el("strong", "wb-w-mid", !trips.length ? "—" : labels.length === 1 ? `${trips.length} 只${labels[0]}` : out.length ? `${out.length} 只在旅行` : `${trips.length} 只猫`));
    const notes = el("div", "wb-w-foot");
    for (const x of trips.slice(0, 3)) notes.append(el("div", undefined, `${x.a.travel?.name || x.a.name} · ${x.t.progress !== undefined ? x.t.note : x.t.label}`));
    cats.append(notes);
    if (trips.some(x => x.t.arrived)) {
      const go = el("button", "wb-w-corner-btn", "处理 ›");
      go.type = "button";
      go.onclick = () => goTab("tasks");
      cats.append(go);
    }

    const sum = k => personal.reduce((s, a) => s + (a.growth?.[k] || 0), 0);
    widget("s", "", "能量", el("strong", "wb-w-big", num(sum("energy"))), el("span", "wb-w-foot", `Buddy ${num(sum("buddies"))} 只 · 抽奖 ${num(sum("draws"))} 次${personal.length > 1 ? ` · ${personal.length} 个号` : ""}`));

    const credits = widget("m", "", "个人可用积分 · 企业额度另列");
    const hasTwoRealms = rows.some(abroad) && rows.some(a => !abroad(a));
    if (!hasTwoRealms) credits.append(el("strong", "wb-w-corner", fine(personal.reduce((s, a) => s + (a.balance?.balance || 0), 0))));
    let heading = null;
    for (const a of builds(rows).flatMap(([, mine]) => mine)) {
      if (hasTwoRealms && heading !== abroad(a)) {
        heading = abroad(a);
        const mine = rows.filter(x => abroad(x) === heading && !x.enterprise), total = mine.reduce((s, x) => s + (x.balance?.balance || 0), 0), h = line(el("span", "wb-label", heading ? "国际版" : "国内版"), el("strong", "wb-num", fine(total)));
        h.className += " wb-w-realm";
        credits.append(h);
      }
      if (!a.balance?.size) { credits.append(el("div", "wb-sub", `${a.name}：${a.enterprise ? "没有企业额度" : "没有积分包"}`)); continue; }
      const row = el("div", "wb-w-acct");
      row.append(line(el("span", "wb-name", a.name), el("span", "wb-num", num(a.balance.balance))), meter(a.balance, now));
      credits.append(row);
    }

    const used = rows.filter(a => a.usage), total = used.reduce((s, a) => s + a.usage.credit, 0);
    const usage = widget("m", "", "近 7 天用量");
    usage.append(el("strong", "wb-w-corner", `${num(total)} 积分`));
    if (used.length) {
      const span = used[0].usage.days.map(x => x.date), sums = span.map(day => used.reduce((s, a) => s + (a.usage.days.find(x => x.date === day)?.credit || 0), 0)), top = Math.max(...sums, 1);
      const chart = el("div", "wb-chart wb-stack");
      span.forEach((day, i) => {
        const col = el("div", "wb-col"), stack = el("div", "wb-stack-col");
        stack.style.height = `${Math.max(3, sums[i] / top * 100)}%`;
        used.forEach((a, k) => { const credit = a.usage.days.find(x => x.date === day)?.credit || 0; if (!credit) return; const seg = el("span", `wb-acc-${k % 3}`); seg.style.flexGrow = String(credit); seg.title = `${a.name} ${day}：${num(credit)} 积分`; stack.append(seg); });
        col.append(stack, el("small", undefined, day.slice(8)));
        chart.append(col);
      });
      const keys = el("div", "wb-w-keys");
      used.forEach((a, k) => { const key = el("span", "wb-key"); key.append(el("i", `wb-dot wb-acc-${k % 3}`), a.name); keys.append(key); });
      usage.append(chart, keys);
    }

    const tasks = personal.filter(a => a.tasks && a.realm !== "intl"), claimed = tasks.reduce((s, a) => s + a.tasks.claimed, 0), all = tasks.reduce((s, a) => s + a.tasks.total, 0), pending = tasks.reduce((s, a) => s + a.tasks.credit, 0);
    const growth = widget("w", "", "成长任务");
    growth.append(el("strong", "wb-w-corner", all ? `${claimed}/${all}` : "—"));
    if (tasks.length > 1) growth.append(el("div", "wb-sub", `${tasks.length} 个国内账号合计，每个账号 ${tasks.map(a => a.tasks.total).join(" / ")} 个任务`));
    const manual = new Map();
    for (const a of tasks) for (const t of a.tasks.open) if (t.state === "manual") manual.set(t.title, (manual.get(t.title) || 0) + 1);
    for (const [title, count] of manual) growth.append(line(el("span", "wb-name", title), el("span", "wb-pill warn", `需手动${count > 1 ? ` ×${count}` : ""}`)));
    if (!manual.size) growth.append(el("div", "wb-sub", pending ? `待拿 ${num(pending)} 积分，定时会完成` : "当前任务全部已领奖"));
    const tier = personal.map(a => a.streak?.nextTier && { ...a.streak.nextTier, days: a.streak.days, target: a.streak.nextTier.days }).find(Boolean);
    const footLine = line(el("span", "wb-sub", tier ? `连登 ${tier.days} 天 · 再 ${tier.remaining} 天到 ${tier.target} 天档${tier.credit ? ` (+${tier.credit} 积分)` : ""}` : ""));
    const toTasks = el("button", "wb-link-btn", "前往任务中心处理 →");
    toTasks.type = "button";
    toTasks.onclick = () => goTab("tasks");
    footLine.append(toTasks);
    growth.append(footLine);

    return grid;
  }

  // Board tab container: Realm Filter + 3-Mode View Switcher + View Body + Schedule Bridge + Alerts.
  const compensationEnd = c => {
    const raw = c?.end || "";
    return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : raw.replace(" ", "T") + "+08:00");
  };
  const compensationLeft = (c, now) => {
    const end = compensationEnd(c);
    if (!Number.isFinite(end)) return c.end ? `${c.end} 截止` : "";
    const hours = Math.ceil((end - now) / 3600_000);
    return hours <= 0 ? "已截止" : hours <= 48 ? `剩余 ${hours} 小时` : `剩余 ${Math.ceil(hours / 24)} 天`;
  };
  function taskPanels(rows, compRows, unknown, openDetails, now) {
    const mine = rows.filter(a => !a.enterprise && !abroad(a) && !a.paused), group = el("div", "wb-task-panels");
    if (!mine.length) return null;

    const need = el("section", "wb-work-card wb-task-panel"), needHead = el("div", "wb-task-panel-head"), needFeedback = workStatus();
    const needTitle = el("div", "wb-task-panel-title");
    needTitle.append(el("h2", "wb-work-title", unknown.length ? "需要你处理" : "官方补偿"), el("span", "wb-task-count", !compRows.length && !unknown.length ? "暂无待领取" : String(compRows.length + unknown.length)));
    const claimable = compRows.filter(({ c }) => c && !c.claimed && c.credit > 0);
    needHead.append(needTitle);
    if (claimable.length && hooks.onRunAction) {
      const all = workButton("全部领取", () => hooks.onRunAction("compensation", claimable.map(({ a }) => a.id)), needFeedback);
      all.className = "wb-task-head-action";
      needHead.append(all);
    }
    need.append(needHead);

    for (const a of mine) {
      const row = el("div", "wb-task-panel-row"), copy = el("div", "wb-task-row-copy"), error = a.errors?.compensation, c = a.compensation;
      let message = "补偿状态尚未读取", urgent = false, action = null;
      if (error) {
        message = `补偿查询失败 · ${error}`;
        urgent = true;
        if (hooks.onRunAction) {
          action = workButton("重新查询", () => hooks.onRunAction("compensation", [a.id]), needFeedback);
          action.className = "wb-task-row-action";
        }
      } else if (c) {
        if (c.active && !c.claimed && c.credit > 0) {
          message = `官方补偿 +${num(c.credit)} 积分${compensationLeft(c, now) ? ` · ${compensationLeft(c, now)}` : ""}`;
          urgent = compensationEnd(c) - now <= 48 * 3600_000;
          if (hooks.onRunAction) {
            action = workButton("领取", () => hooks.onRunAction("compensation", [a.id]), needFeedback);
            action.className = "wb-task-row-action primary";
          }
        } else message = c.claimed ? "官方补偿已领取" : "当前没有补偿";
      }
      copy.append(el("strong", "wb-task-row-name", a.name), el("span", `wb-task-row-note${urgent ? " urgent" : ""}`, message));
      row.append(copy);
      if (action) row.append(action);
      need.append(row);
    }
    for (const { account, task } of unknown) {
      const row = el("div", "wb-task-panel-row"), copy = el("div", "wb-task-row-copy");
      copy.append(el("strong", "wb-task-row-name", account.name), el("span", "wb-task-row-note", `${task.title} · 需要你处理`));
      const view = el("button", "wb-task-row-action", "查看");
      view.type = "button";
      view.onclick = () => openDetails();
      row.append(copy, view);
      need.append(row);
    }
    need.append(needFeedback);
    group.append(need);

    const buddy = el("section", "wb-work-card wb-task-panel"), buddyHead = el("div", "wb-task-panel-head"), buddyFeedback = workStatus();
    const buddyTitle = el("div", "wb-task-panel-title");
    buddyTitle.append(el("h2", "wb-work-title", "Buddy 盲盒"));
    const available = mine.filter(a => a.buddy?.affordable > 0), total = available.reduce((sum, a) => sum + Math.min(a.buddy.affordable, a.buddy.maxOpen || a.buddy.affordable), 0);
    buddyHead.append(buddyTitle);
    if (available.length && hooks.onRunAction) {
      const all = workButton(`打开全部 · ${total} 个`, () => hooks.onRunAction("buddy", available.map(a => a.id)), buddyFeedback);
      all.className = "wb-task-head-action primary";
      buddyHead.append(all);
    }
    buddy.append(buddyHead);

    for (const a of mine) {
      const row = el("div", "wb-task-panel-row"), copy = el("div", "wb-task-row-copy"), b = a.buddy, error = a.errors?.buddy;
      let message = "盲盒配额尚未读取", action = null;
      if (error) message = `配额查询失败 · ${error}`;
      else if (b) {
        message = `能量 ${num(a.growth?.energy)} · 可开 ${num(b.affordable)} 个`;
        if (b.affordable > 0 && hooks.onRunAction) {
          action = workButton(`开 ${Math.min(b.affordable, b.maxOpen || b.affordable)} 个`, () => hooks.onRunAction("buddy", [a.id]), buddyFeedback);
          action.className = "wb-task-row-action";
        }
      }
      copy.append(el("strong", "wb-task-row-name", a.name), el("span", "wb-task-row-note", message));
      row.append(copy);
      if (action) row.append(action);
      buddy.append(row);
    }

    const auto = el("label", "wb-task-auto"), autoCopy = el("span"), input = el("input");
    autoCopy.append(el("strong", undefined, "旅行领奖后自动开盲盒"), el("span", "wb-task-row-note", "默认关闭，开启后会消耗成长能量"));
    input.type = "checkbox";
    input.checked = last?.[1]?.settings?.buddyAuto === true;
    input.className = "wb-pill-switch"; input.setAttribute("role", "switch");
    input.onchange = async () => {
      if (!hooks.onConfig) return;
      input.disabled = true;
      buddyFeedback.textContent = "正在保存…";
      try { buddyFeedback.textContent = await hooks.onConfig({ buddyAuto: input.checked }) || "已保存"; }
      catch (e) { input.checked = !input.checked; buddyFeedback.textContent = e.message; buddyFeedback.classList.add("urgent"); }
      finally { input.disabled = false; }
    };
    if (!hooks.onConfig) input.disabled = true;
    auto.append(autoCopy, input);
    buddy.append(auto, buddyFeedback);
    group.append(buddy);
    return group;
  }

  function boardTab(rows, view, now) {
    const box = el("div", "wb-tab-board");
    if (!both && realmFilter !== "all") realmFilter = "all";
    const shownRows = realmFilter === "all" ? rows : rows.filter(a => realmFilter === "intl" ? abroad(a) : !abroad(a));

    const toolbar = el("div", "wb-board-toolbar");
    const leftControls = el("div", "wb-board-filters");
    if (both) {
      const cnCount = rows.filter(a => !abroad(a)).length, intlCount = rows.filter(abroad).length;
      leftControls.append(segs([["all", `全部 ${rows.length}`], ["cn", `国内版 ${cnCount}`], ["intl", `国际版 ${intlCount}`]], realmFilter, v => { realmFilter = v; again(); }, "版本筛选"));
      if (realmFilter === "all" && mode !== "widgets") {
        const swap = el("button", "wb-swap-btn", `⇅ ${order === "cn" ? "国内版优先" : "国际版优先"}`);
        swap.type = "button";
        swap.title = "切换国内版与国际版显示先后";
        swap.onclick = () => { order = order === "cn" ? "intl" : "cn"; orderSaved.set(order); again(); };
        leftControls.append(swap);
      }
    } else {
      leftControls.append(el("span", "wb-sub", `共 ${rows.length} 个账号`));
    }

    const rightControls = el("div", "wb-view-switch");
    rightControls.append(el("span", "wb-sub wb-view-label", "显示方式"), segs(boardViews, mode, setMode, "切换显示方式", viewIcons));
    toolbar.append(leftControls, rightControls);
    box.append(toolbar);

    const viewNode = mode === "rings" ? ringsView(shownRows, now) : mode === "widgets" ? widgetsView(shownRows, now) : listView(shownRows, now);
    box.append(viewNode);
    const bridge = scheduleBridge(view);
    if (bridge) box.append(bridge);
    const foot = alertFooter(rows, now, true);
    if (foot) box.append(foot);
    box.append(quotaCard(rows, now));
    return box;
  }

  // Models tab
  const realms = [["ent", "企业"], ["cn", "国内版"], ["intl", "国际版"]], realmName = { ent: "企业", cn: "国内版", intl: "国际版" };

  function levels(r) {
    const cell = el("div", "wb-mreason");
    if (!r) { cell.append(el("span", "wb-sub", "—")); cell.title = "官方配置没有列出推理档位"; return cell; }
    const list = el("span", "wb-levels");
    r.levels.forEach((l, i) => { if (i) list.append(" "); list.append(el(l === r.default && !r.fixed ? "strong" : "span", undefined, l)); });
    cell.append(list);
    if (r.fixed || r.off) cell.append(el("span", "wb-sub", r.fixed ? "固定" : "可关"));
    cell.title = r.fixed ? `只有 ${r.levels[0]} 一档` : `可选 ${r.levels.join(" / ")}${r.default ? `，默认 ${r.default}` : ""}${r.off ? "；可以关闭思考" : "；思考不能关闭"}`;
    return cell;
  }
  const ctx = n => !n ? "—" : n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`;
  const times = r => `×${r.toFixed(2)}`;
  const copyKey = () => { const n = globalThis.navigator; return /Mac|iPhone|iPad/.test(n?.userAgentData?.platform || n?.platform || "") ? "⌘C" : "Ctrl+C"; };

  function copier(id) {
    const b = el("button", "wb-copy"), text = el("span", undefined, id), note = el("span", "wb-copy-note");
    b.type = "button";
    b.setAttribute("aria-label", `复制模型 ID ${id}`);
    b.append(text, icon(copyIcon), note);
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(id); note.textContent = "已复制"; }
      catch {
        const range = document.createRange(), pick = getSelection();
        range.selectNodeContents(text); pick.removeAllRanges(); pick.addRange(range);
        note.textContent = `按 ${copyKey()} 复制`;
      }
      setTimeout(() => { note.textContent = ""; }, 1600);
    };
    return b;
  }

  function modelRow(m, locked, planName) {
    const row = el("div", "wb-mrow"), name = el("div", "wb-mname"), title = el("div", "wb-mtitle"), rate = el("div", "wb-rate");
    title.append(el(locked ? "span" : "strong", locked ? "wb-mlocked-name" : undefined, m.name));
    if (m.isDefault) title.append(el("span", "wb-pill ok", "默认"));
    if (locked) title.append(el("span", "wb-pill outline", "Pro"));
    if (m.promo && !locked) { const p = el("span", "wb-pill promo", m.promo.label); p.title = [m.promo.note, m.promo.until && `至 ${when(m.promo.until)}`].filter(Boolean).join(" · "); title.append(p); }
    if (m.tier && !m.tier.exclusive) { const t = el("span", "wb-pill outline", m.tier.label); t.title = m.tier.note; title.append(t); }
    if (locked) row.title = m.tier?.note || `${planName} 计划不能用`;
    name.append(title, el("span", "wb-mdesc", m.desc));
    if (m.rate === null) rate.append(el("span", "wb-sub", "随任务浮动"));
    else if (m.rate === 0) rate.append(el("span", "wb-pill ok wb-free", "免费"));
    else rate.append(el("strong", !locked && m.rate >= 3 ? "costly" : undefined, times(m.rate)));
    if (!locked && m.promo?.rate !== undefined && m.promo.rate !== m.rate) {
      const off = el("span", "wb-rate-off", `${m.promo.hours ? `${m.promo.hours} ` : ""}${m.promo.approx ? "约 " : ""}${m.promo.rate === 0 ? "免费" : times(m.promo.rate)}`);
      off.title = m.promo.note;
      rate.append(off);
    }
    row.append(name, copier(m.id), levels(m.reasoning), el("span", "wb-num wb-mctx", ctx(m.context)), rate);
    return row;
  }

  function modelHead(label) {
    const head = el("div", "wb-mrow wb-mhead");
    const reason = el("span", "wb-mreason", "推理档位");
    reason.title = "官方配置里的原生推理档位，加粗的是默认档";
    head.append(el("span", undefined, label), el("span", undefined, "模型 ID"), reason, el("span", "wb-num wb-mctx", "上下文"), el("span", "wb-num", "倍率"));
    return head;
  }

  function modelsContent(r, all, where) {
    const host = el("div", "wb-models-body");
    if (!r) { host.append(el("p", "wb-calm", realm === "intl" ? "Magpie 里没有登录 WorkBuddy 国际版（workbuddy-ai）。登录后这里会显示国际版模型和你的计划。" : all.ent ? "没有国内个人账号，国内版列表要用个人账号读取。" : "还没有读到国内版模型，看板刷新后显示。")); return host; }
    if (r.error) { host.append(el("p", "wb-calm", `${where}模型读取失败：${r.error}`)); return host; }

    const plan = r.plan || { name: "Free", paid: false };
    const q = modelSearch.trim().toLowerCase();
    const match = m => (!onlyPromo || m.rate === 0 || !!m.promo) && (!q || String(m.name || "").toLowerCase().includes(q) || String(m.id || "").toLowerCase().includes(q));
    const allLocked = plan.paid ? [] : r.models.filter(m => m.tier?.exclusive), allOpen = r.models.filter(m => !allLocked.includes(m));
    const sort = list => byRate ? [...list].sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity)) : list;
    const open = sort(allOpen).filter(match), locked = sort(allLocked).filter(match);

    const priced = allOpen.filter(m => m.rate !== null).sort((a, b) => a.rate - b.rate), [best, next] = priced;
    const promos = allOpen.filter(m => m.promo), promoKinds = new Map();
    for (const m of promos) promoKinds.set(m.promo.label, (promoKinds.get(m.promo.label) || 0) + 1);
    const queued = allOpen.filter(m => m.tier && !m.tier.exclusive);
    const cells = [
      ["你现在能用", allLocked.length ? `${allOpen.length} 个模型` : `全部 ${allOpen.length} 个`,
        allLocked.length ? `共 ${r.models.length} 个，另外 ${allLocked.length} 个是 Pro-only` : queued.length ? `不开会员也能用；${queued.length} 个高峰时会员优先` : "当前计划全部可用"],
      realm === "intl"
        ? [`${where}账号`, `${plan.name} 计划`, `${r.account || ""}${allLocked.length ? " · 升级 Pro 才能用全部" : ""}`]
        : realm === "ent" ? ["企业账号", r.account || "企业", "模型由企业配置决定，按企业额度扣"]
        : ["正在优惠", promos.length ? `${promos.length} 个模型` : "没有", [...promoKinds].map(([k, n]) => `${k} ${n}`).join(" · ") || "官方没有进行中的优惠"],
      ["最省积分", best ? `${best.name} ${best.rate === 0 ? "免费" : times(best.rate)}` : "—", next ? `其次 ${next.name} ${next.rate === 0 ? "免费" : times(next.rate)}` : ""]
    ];
    const strip = el("div", "wb-kpis wb-kpis-3");
    for (const [k, v, sub] of cells) { const t = el("div", "wb-kpi"); t.append(el("span", "wb-sub", k), el("strong", undefined, v), el("span", "wb-sub", sub)); strip.append(t); }
    host.append(strip);

    const hint = el("div", "wb-models-hint");
    hint.append(el("span", "wb-sub", realm === "intl" ? "倍率是每次请求按基准扣积分的倍数：×0.5 扣一半，×2 扣两倍。点模型 ID 复制。" : realm === "ent" ? "企业账号读到的列表，只能用这里的模型。点模型 ID 复制。" : all.ent ? "个人账号读到的列表；企业账号的模型看「企业」。点模型 ID 复制。" : "个人账号读到的列表；企业账号的模型由企业配置决定，可能不同。点模型 ID 复制。"));
    host.append(hint);

    const table = el("section", "wb-mtable");
    table.setAttribute("aria-label", `${where}可用模型`);
    table.append(modelHead(`${realm === "ent" ? "企业可用模型" : allLocked.length ? `${plan.name} 用户可用模型` : "全部用户可用模型"}：${open.length}`));
    if (open.length) table.append(...open.map(m => modelRow(m, false, plan.name)));
    else table.append(el("p", "wb-calm wb-pad", "没有匹配的模型"));
    host.append(table);

    if (locked.length) {
      const shut = el("section", "wb-mtable wb-locked"), toggle = el("button", "wb-disclosure"), rows = el("div");
      const label = /pro/i.test(locked[0].tier.label) ? "Pro-only" : locked[0].tier.label;
      shut.setAttribute("aria-label", `${label} 模型`);
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(lockedOpen));
      toggle.append(icon('<rect x="3" y="7" width="10" height="7" rx="1.8"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>', 14), el("strong", undefined, `${label} 模型：${locked.length}`),
        el("span", "wb-sub wb-grow", `${plan.name} 账号请求这些模型会被 WorkBuddy 拒绝，选模型时跳过它们`), el("span", "wb-chevron", "›"));
      rows.hidden = !lockedOpen;
      rows.append(...locked.map(m => modelRow(m, true, plan.name)));
      toggle.onclick = () => { lockedOpen = !lockedOpen; toggle.setAttribute("aria-expanded", String(lockedOpen)); rows.hidden = !lockedOpen; };
      shut.append(toggle, rows);
      host.append(shut);
    }
    host.append(el("p", "wb-legend", `读自 WorkBuddy 官方模型配置，与 WorkBuddy 客户端的模型列表一致 · ${when(all.at)} 更新 · 倍率与限制以官方为准`));
    return host;
  }

  function modelsView(view) {
    const box = el("div", "wb-view-models"), all = view?.models || {}, shown = realms.filter(([k]) => k !== "ent" || all.ent);
    if (!shown.some(([k]) => k === realm)) realm = "cn";
    const bar = el("div", "wb-models-bar");
    bar.append(segs(shown.map(([k, t]) => [k, all[k]?.models ? `${t} ${all[k].models.length}` : t]), realm, v => { realm = v; remembered.set(v); again(); }, "选择版本"));

    const tools = el("div", "wb-models-tools");
    const search = el("input", "wb-search");
    search.type = "search";
    search.placeholder = "搜索模型名称或 ID…";
    search.value = modelSearch;
    const promoBtn = el("button", `wb-filter-btn${onlyPromo ? " on" : ""}`, "仅看免费/优惠");
    promoBtn.type = "button";
    promoBtn.onclick = () => { onlyPromo = !onlyPromo; again(); };
    tools.append(search, promoBtn, segs([["official", "官方顺序"], ["rate", "倍率从低到高"]], byRate ? "rate" : "official", v => { byRate = v === "rate"; again(); }, "排序"));
    bar.append(tools);
    box.append(bar);

    const r = all[realm], where = realmName[realm];
    const bodyHost = el("div");
    bodyHost.append(modelsContent(r, all, where));
    search.oninput = () => {
      modelSearch = search.value;
      bodyHost.replaceChildren(modelsContent(r, all, where));
    };
    box.append(bodyHost);
    return box;
  }

  // Tasks Center: growth tasks + filters/grouping + Cat travel & Campaign companions.
  function taskBadgeCount(rows) {
    return rows.filter(a => !a.enterprise && !abroad(a) && !a.paused).reduce((sum, a) =>
      sum + (a.tasks?.open || []).filter(t => t.state === "manual").length +
      (a.errors?.compensation || a.compensation?.active && !a.compensation.claimed && a.compensation.credit > 0 ? 1 : 0), 0);
  }

  // The task center is a daily briefing, not a task database. It answers
  // three questions: what will run, what needs the user, and are the domestic
  // personal accounts okay. Everything else lives in the details below.
  const briefCheckin = a => {
    const c = a.checkin;
    if (!c) return "签到读取失败";
    if (["claimed", "done"].includes(c.outcome)) return "已签到";
    if (["waiting", "pending"].includes(c.outcome)) return "未签到";
    if (c.outcome === "off") return "签到未开启";
    if (c.outcome === "ineligible") return "需在客户端签到";
    if (c.outcome === "inactive") return "今天没签上";
    return "签到读取失败";
  };
  function tasksView(rows, now) {
    const box = el("div", "wb-brief"), mine = rows.filter(a => !a.enterprise && !abroad(a) && !a.paused);
    const all = mine.flatMap(a => (a.tasks?.open || []).map(task => ({ account: a, task })));
    const auto = all.filter(({ task }) => task.state === "auto" || task.state === "claimable");
    const unknown = all.filter(({ task }) => task.state === "manual");
    const locked = all.filter(({ task }) => task.state === "locked");
    const compRows = mine.map(a => {
      if (a.errors?.compensation) return { a, error: true };
      const c = a.compensation;
      return c && c.active && !c.claimed && c.credit > 0 ? { a, c } : null;
    }).filter(Boolean);
    const buddyRows = mine.map(a => a.buddy && a.buddy.affordable > 0 ? { a, b: a.buddy } : null).filter(Boolean);
    const campaignRows = mine.flatMap(a => (a.campaigns || []).flatMap(c => (c.tasks || []).filter(t => !t.claimed).map(t => ({ a, c, t }))));
    const catRows = mine.map(a => ({ a, tr: trip(a.travel, now, a) })).filter(x => x.tr && x.tr.state !== "none");
    const needCount = compRows.length + unknown.length;
    const details = el("details", "wb-brief-details");
    const openDetails = () => {
      if (!details.parentNode) return;
      details.open = true;
      details.scrollIntoView?.({ behavior: "smooth", block: "start" });
    };

    const tz = last?.[1]?.today?.timezone || "Asia/Shanghai";
    let dateLabel = "";
    try {
      const stamp = new Date(now);
      const day = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", timeZone: tz }).format(stamp);
      const week = new Intl.DateTimeFormat("zh-CN", { weekday: "long", timeZone: tz }).format(stamp);
      dateLabel = `${day}，${week}`;
    } catch { dateLabel = new Date(now).toLocaleDateString("zh-CN"); }

    const title = el("div", "wb-brief-head");
    title.append(el("h2", "wb-brief-title", "今天"), el("p", "wb-brief-date", dateLabel));
    const button = (label, run) => {
      const b = el("button", "wb-brief-btn", label);
      b.type = "button";
      b.onclick = async () => {
        b.disabled = true;
        const before = b.textContent;
        b.textContent = "已提交";
        try { await run(); }
        catch (e) { b.disabled = false; b.textContent = before; b.title = e.message; }
      };
      return b;
    };

    const completion = el("section", "wb-task-completion"), completionMain = el("div", "wb-task-completion-main"), mark = el("span", "wb-task-completion-mark");
    mark.append(icon('<path d="m4 8.3 2.6 2.6L12.2 5.3"/>', 18));
    const completionCopy = el("div", "wb-task-completion-copy");
    completionCopy.append(
      el("strong", undefined, needCount ? `有 ${needCount} 件需要你处理` : "当前无需手动处理"),
      el("p", "wb-task-scope", `${mine.length} 个国内个人账号${auto.length ? ` · ${auto.length} 项任务会自动执行` : " · 已达标的奖励可一键补领"}`)
    );
    completionMain.append(mark, completionCopy);
    completion.append(completionMain);
    if (hooks.onRunAction) {
      const sweep = el("button", "wb-task-sweep", "补领奖励");
      sweep.type = "button";
      sweep.onclick = async () => {
        sweep.disabled = true;
        const before = sweep.textContent;
        sweep.textContent = "正在提交…";
        try { await hooks.onRunAction("sweep"); sweep.textContent = "已提交"; }
        catch (e) { sweep.disabled = false; sweep.textContent = before; sweep.title = e.message; }
      };
      completion.append(sweep);
    }

    const detailRow = (name, account, statusText, action) => {
      const r = el("div", "wb-brief-detail-row");
      r.append(el("span", "wb-brief-detail-name", name), el("span", "wb-brief-detail-account", account), el("span", "wb-brief-detail-status", statusText));
      const holder = el("span", "wb-brief-detail-action");
      if (action) holder.append(action);
      r.append(holder);
      return r;
    };
    const taskAction = (account, task) => {
      if (!hooks.onTask || !task.code || !["auto", "claimable"].includes(task.state)) return null;
      return button(task.state === "claimable" ? "领奖" : "执行", () => hooks.onTask(account.id, task.code, task.title));
    };
    const detailList = el("div", "wb-brief-list");
    const group = (name, items) => { if (items.length) detailList.append(el("div", "wb-brief-group", name), ...items); };
    group("自动执行", auto.map(({ account, task }) => detailRow(task.title, account.name, task.state === "claimable" ? "待领奖" : "可自动", taskAction(account, task))));
    group("未解锁", locked.map(({ account, task }) => detailRow(task.title, account.name, task.unlockAt ? `${when(task.unlockAt)} 解锁` : "未解锁", null)));
    group("需要你处理", [
      ...compRows.map(({ a, error }) => detailRow("官方补偿", a.name, error ? "读取失败" : "待领", null)),
      ...unknown.map(({ account, task }) => detailRow(task.title, account.name, "暂不支持", null))
    ]);
    group("可选", buddyRows.map(({ a, b }) => detailRow("Buddy 盲盒", a.name, `可开 ${num(b.affordable)} 个`, null)));
    group("活动与手动", [
      ...campaignRows.map(({ a, c, t }) => {
        const active = !t.manual && !t.disabled;
        const action = active && hooks.onRunAction ? button(t.done ? "领奖" : "处理", () => hooks.onRunAction(t.done ? "sweep" : "tasks", [a.id])) : null;
        const label = t.done ? "可领奖" : t.manual ? "需手动" : t.disabled ? "设置已关闭" : "定时会完成";
        return detailRow(`${c.label} · ${t.label}`, a.name, label, action);
      }),
      ...catRows.map(({ a, tr }) => detailRow("猫猫旅行", a.name, tr.label, tr.arrived && hooks.onRunAction ? button("收派", () => hooks.onRunAction("travel", [a.id])) : null))
    ]);
    const total = auto.length + locked.length + compRows.length + unknown.length + buddyRows.length + campaignRows.length + catRows.length;
    details.append(el("summary", undefined, `查看全部任务（${total} 项）`), detailList);
    const panels = taskPanels(rows, compRows, unknown, openDetails, now);
    box.append(title, completion);
    if (panels) box.append(panels);
    if (total) box.append(details);
    return box;
  }

  function navBar(className) {
    const nav = el("nav", `wb-nav ${className}`);
    nav.setAttribute("aria-label", "主导航");
    for (const [key, label] of tabs) {
      const button = el("button", "wb-nav-tab");
      button.type = "button";
      button.dataset.tab = key;
      button.title = label;
      button.append(icon(tabIcons[key], 14), el("span", "wb-nav-label", label), el("span", "wb-nav-badge"));
      button.onclick = () => { if (key !== tab) goTab(key); };
      nav.append(button);
    }
    return nav;
  }

  function mountLayout(host) {
    const notice = el("div"), shell = el("div", "wb-shell"), side = el("aside", "wb-side");
    const sideClip = el("div", "wb-side-clip"), sideNav = navBar("wb-side-nav"), topNav = navBar("wb-top-nav");
    const main = el("div", "wb-main"), topSlot = el("div", "wb-top-slot"), topClip = el("div", "wb-top-clip");
    const page = el("div", "wb-page"), content = el("div"), divider = el("div", "wb-side-divider");
    const toggle = document.getElementById("wb-nav-toggle");
    const minimum = 144, maximum = 224;
    divider.setAttribute("role", "separator");
    divider.setAttribute("aria-label", "侧栏宽度");
    divider.setAttribute("aria-orientation", "vertical");
    divider.setAttribute("aria-controls", "wb-side");
    divider.setAttribute("aria-valuemin", minimum);
    divider.setAttribute("aria-valuemax", maximum);
    divider.setAttribute("aria-valuenow", 152);
    divider.tabIndex = 0;
    side.id = "wb-side";

    const size = () => side.getBoundingClientRect().width;
    const resize = width => {
      const next = Math.round(Math.max(minimum, Math.min(maximum, width)));
      shell.style.setProperty("--wb-side-width", `${next}px`);
      divider.setAttribute("aria-valuenow", next);
    };
    let grab;
    divider.onpointerdown = event => {
      if (event.button !== 0) return;
      grab = { x: event.clientX, width: size() };
      shell.classList.add("wb-side-dragging");
      resize(grab.width);
      divider.setPointerCapture(event.pointerId);
    };
    divider.onpointermove = event => {
      if (grab) resize(grab.width + event.clientX - grab.x);
    };
    divider.onlostpointercapture = () => {
      grab = undefined;
      shell.classList.remove("wb-side-dragging");
    };
    divider.onkeydown = event => {
      const step = { ArrowLeft: -12, ArrowRight: 12 }[event.key];
      if (!step) return;
      event.preventDefault();
      resize(size() + step);
    };

    const updateLayout = hasRows => {
      const open = navSide && hasRows;
      shell.classList.toggle("wb-side-on", open);
      sideNav.inert = !open;
      topNav.inert = open || !hasRows;
      topSlot.hidden = !hasRows;
      divider.hidden = !open;
      if (toggle) {
        const label = open ? "收起侧边栏" : "显示侧边栏";
        toggle.hidden = !hasRows;
        toggle.setAttribute("aria-pressed", String(open));
        toggle.setAttribute("aria-label", label);
        toggle.title = label;
      }
    };
    if (toggle) {
      toggle.onclick = () => {
        navSide = !navSide;
        navSaved.set(navSide ? "side" : "top");
        updateLayout(true);
      };
    }

    sideClip.append(sideNav);
    side.append(sideClip, divider);
    topClip.append(topNav);
    topSlot.append(topClip);
    page.append(content);
    const extras = document.getElementById("schedule-extras") || document.getElementById("jobs-section");
    if (extras) page.append(extras);
    main.append(topSlot, page);
    shell.append(side, main);
    const floating = el("div", "wb-floating");
    host.replaceChildren(notice, shell, floating);
    return { host, notice, content, sideNav, topNav, updateLayout, floating };
  }

  function render(host, view, now = Date.now(), options) {
    if (options) hooks = options;
    last = [host, view];
    if (layout?.host !== host) layout = mountLayout(host);
    const { notice, content, sideNav, topNav, updateLayout, floating } = layout;
    floating.replaceChildren();
    const rows = ordered(view?.accounts || []);
    both = rows.some(abroad) && rows.some(a => !abroad(a));

    if (typeof document !== "undefined" && document.body?.dataset) document.body.dataset.wbTab = tab;
    hooks.onTab?.(tab);
    updateLayout(rows.length > 0);
    notice.replaceChildren(...[signin(view, now)].filter(Boolean));

    if (!rows.length) {
      content.replaceChildren(el("p", "wb-sub", view?.at ? "没有国内账号。请先在 Magpie 登录 WorkBuddy 国内版。" : "正在读取余额与旅行状态…"));
      return;
    }

    const openCount = taskBadgeCount(rows);
    const badges = { board: `${rows.length} 账号`, tasks: openCount ? `${openCount} 待办` : "" };
    for (const nav of [topNav, sideNav]) {
      for (const button of nav.children) {
        const key = button.dataset.tab, active = key === tab, badge = button.lastChild;
        button.className = `wb-nav-tab${active ? " active" : ""}`;
        button.setAttribute("aria-current", active ? "page" : "false");
        badge.textContent = badges[key] || "";
        badge.hidden = !badge.textContent;
        badge.className = `wb-nav-badge${key === "tasks" ? " hot" : ""}`;
        button.setAttribute("aria-label", [button.title, badge.textContent].filter(Boolean).join(" "));
      }
    }
    let body;
    if (tab === "accounts") body = accountsView(rows, view, now);
    else if (tab === "tasks") body = tasksView(rows, now);
    else if (tab === "schedule") body = scheduleWorkbench(view, now);
    else if (tab === "models") body = modelsView(view);
    else body = boardTab(rows, view, now);

    if (switched) { body.className = `${body.className || ""} wb-enter`.trim(); switched = false; }
    content.replaceChildren(body);
  }

  let openPick = null, listening = false;
  function picker(input, items, onPick) {
    const root = el("details", "wb-pick wb-board"), summary = el("summary"), shown = el("span", "wb-pick-value"), menu = el("div", "wb-pick-menu");
    const rows = items.map(it => typeof it === "string" ? { id: it, label: it } : it), buttons = [];
    menu.setAttribute("role", "listbox");
    const paint = () => {
      const now = rows.find(r => r.id === input.value) || { label: input.value };
      shown.textContent = now.shown || now.label;
      for (const [b, r] of buttons) b.setAttribute("aria-selected", String(r.id === input.value));
    };
    for (const r of rows) {
      const b = el("button"), name = el("span", "wb-pick-name", r.label);
      b.type = "button"; b.setAttribute("role", "option");
      if (r.note) name.append(el("small", "", r.note));
      b.append(el("span", "wb-pick-check", "✓"), name);
      if (r.tag) b.append(el("span", r.free ? "wb-pick-tag wb-pick-free" : "wb-pick-tag", r.tag));
      b.onclick = () => { input.value = r.id; paint(); root.open = false; if (onPick) onPick(r.id); };
      buttons.push([b, r]);
      menu.append(b);
      if (r.rule) menu.append(el("hr"));
    }
    summary.append(shown, el("span", "wb-pick-chev"));
    root.append(summary, menu);
    root.ontoggle = () => { if (root.open) openPick = root; };
    root.sync = paint;
    if (!listening && document.addEventListener) {
      listening = true;
      document.addEventListener("click", event => { if (openPick?.open && !openPick.contains(event.target)) openPick.open = false; });
      document.addEventListener("keydown", event => { if (event.key === "Escape" && openPick?.open) { openPick.open = false; openPick.firstChild?.focus?.(); } });
    }
    paint();
    return root;
  }

  function modelChoices(models, wanted) {
    const rows = (models || []).map(m => typeof m === "string" ? { id: m, label: m } : {
      id: m.id, label: m.name || m.id, ...(m.name && m.name !== m.id ? { note: m.id } : {}),
      ...(m.tier?.exclusive ? { tag: "Pro" } : m.rate === 0 || m.promo?.rate === 0 ? { tag: "免费", free: true } : typeof m.rate === "number" ? { tag: `×${m.rate}` } : {})
    });
    if (wanted && wanted !== "auto" && !rows.some(r => r.id === wanted)) rows.push({ id: wanted, label: wanted });
    return [{ id: "auto", label: "自动", note: "优先当前免费的模型", shown: "自动 · 优先当前免费的模型", rule: rows.length > 0 }, ...rows];
  }

  globalThis.WBBoard = { render, when, picker, modelChoices, goTab, setMode };
})();
