// Account board shared by the local panel and Magpie's page, in three views:
// a list (what needs a person, totals, one expandable row per account), rings
// (one account at a time around today's rings) and widgets (one fact each,
// summed across accounts). Package merging and the travel states follow
// zseeu1/wbkit's page (MIT).
(() => {
  const DAY = 86400_000, NS = "http://www.w3.org/2000/svg";
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const svg = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
  const num = n => n == null ? "—" : Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  const pad = n => String(n).padStart(2, "0");
  const when = ms => { if (!ms) return "—"; const d = new Date(ms); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const date = ms => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
  const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const days = (ms, now) => Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  const left = (ms, now) => { const d = days(ms, now); return d <= 0 ? `今天 ${clock(ms)}` : d === 1 ? `明天 ${clock(ms)}` : `${d} 天后`; };
  const tone = (ms, now) => { if (!ms) return "long"; const d = (ms - now) / DAY; return d <= 2 ? "urgent" : d <= 10 ? "soon" : ""; };
  // "CodeBuddy个人版国内运营裂变包" says nothing the card doesn't already.
  const short = name => String(name).replace(/^CodeBuddy\s*/i, "").replace(/^个人版(?=.)/, "") || name;
  // An enterprise's monthly allowance resets rather than lapses.
  const lapse = p => p.resets ? "重置" : "作废";
  const line = (...children) => { const n = el("div", "wb-line"); n.append(...children); return n; };
  const parts = { balance: "积分", usage: "用量", travel: "猫猫旅行", streak: "连登", tasks: "成长任务", growth: "能量与 Buddy" };
  const expanded = new Set();
  const saved = { get() { try { return localStorage.getItem("wb-view"); } catch { return null; } }, set(v) { try { localStorage.setItem("wb-view", v); } catch {} } };
  const views = [["list", "列表"], ["rings", "圆环"], ["widgets", "小组件"]];
  let seeded = false, mode = views.some(([k]) => k === saved.get()) ? saved.get() : "list", focus = "all", last = null, switched = false;

  function trip(t, now) {
    if (!t) return null;
    if (t.state === "none") return { label: "还没有猫", note: "执行成长任务时会领养首只猫", tone: "", done: 0 };
    if (t.state === "arrived" || (t.state === "traveling" && t.arriveAt && now >= t.arriveAt)) return { label: "已归来，待领奖", note: `${t.location || "旅行"}结束，下一次「猫猫旅行」会领取${t.reward ? ` ${t.reward} 积分` : "奖励"}`, tone: "warn", done: 1 };
    if (t.state === "traveling") {
      const span = t.arriveAt - t.departAt, done = span > 0 ? Math.min(1, Math.max(0, (now - t.departAt) / span)) : 0;
      return { label: `在${t.location || "路上"}`, note: `约 ${clock(t.arriveAt)} 归来`, tone: "go", done, progress: done };
    }
    if (t.state === "idle") return t.limitReached ? { label: "今日已旅行", note: "明天的第一次定时会再出发", tone: "ok", done: 1 } : { label: "在家", note: "下一次「猫猫旅行」会派出", tone: "", done: 0 };
    return { label: t.state || "未知", note: "", tone: "", done: 0 };
  }

  // Today's three rings, outside in: active, trip, growth tasks. The task ring
  // counts only what the scheduler can finish; manual ones are listed above.
  const doable = t => t ? t.total - t.open.filter(o => o.state === "manual" || o.state === "locked").length : 0;
  const today = (a, now) => a.enterprise ? null : { active: a.streak?.active ? 1 : 0, trip: trip(a.travel, now)?.done || 0, tasks: doable(a.tasks) ? Math.min(1, a.tasks.claimed / doable(a.tasks)) : 1 };
  const closed = r => r && r.active >= 1 && r.trip >= 1 && r.tasks >= 1;

  function rings(r, big) {
    const [box, radii] = big ? [132, [58, 43, 28]] : [32, [13.5, 9, 4.5]], c = box / 2;
    const s = svg("svg", { viewBox: `0 0 ${box} ${box}`, class: big ? "wb-rings wb-rings-big" : "wb-rings", "aria-hidden": "true" });
    for (const [radius, value, k] of [[radii[0], r.active, "a"], [radii[1], r.trip, "b"], [radii[2], r.tasks, "c"]]) {
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

  // Packages that lapse at the same moment under the same name read as one line.
  function lapsing(rows) {
    const groups = new Map();
    for (const a of rows) for (const p of a.balance?.packages || []) {
      if (!p.expires) continue;
      const key = `${short(p.name)}|${p.expires}`, g = groups.get(key) || { name: short(p.name), expires: p.expires, resets: !!p.resets, balance: 0, count: 0 };
      g.balance += p.balance; g.count++; groups.set(key, g);
    }
    return [...groups.values()].sort((x, y) => x.expires - y.expires);
  }

  function segs(options, current, pick, label) {
    const box = el("div", "wb-segs");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", label);
    for (const [key, text] of options) {
      const b = el("button", key === current ? "wb-seg-btn on" : "wb-seg-btn", text);
      b.type = "button";
      b.setAttribute("aria-pressed", String(key === current));
      b.onclick = () => { if (key !== current) pick(key); };
      box.append(b);
    }
    return box;
  }

  const kinds = { daily: "活跃 · 旅行 · 福利", tasks: "成长任务", night: "夜猫子", keepalive: "登录续期" };
  const slotStates = { succeeded: ["完成", "ok"], failed: ["失败", "urgent"], deferred: ["稍后重试", "warn"], running: ["执行中", "go"], queued: ["排队中", "go"], interrupted: ["中断", "warn"], cancelled: ["已停止", ""], upcoming: ["待执行", ""], pending: ["等待补跑", "warn"], missed: ["已错过", ""] };

  // Today's slots: what each does and how it went, the next one marked.
  function schedule(view) {
    const t = view?.today;
    if (!t?.slots) return null;
    const box = el("section", "wb-sched"), next = t.next;
    box.setAttribute("aria-label", "今日定时");
    box.append(line(el("span", "wb-label", `今日定时 · 每天 ${t.slots.length} 次`), el("span", "wb-sub", !view.enabled ? "定时已暂停" : next ? `下一次 ${next.at} ${kinds[next.kind] || next.kind}` : "今天的时段都已过")));
    const row = el("div", "wb-slots");
    for (const s of t.slots) {
      let [label, cls] = slotStates[s.status] || [s.status, ""];
      if (s.status === "pending" && !view.enabled) [label, cls] = ["已暂停", ""];
      if (s.status === "failed" && s.attempts) label = `失败 ${s.attempts}/3`;
      const isNext = next && next.at === s.at && next.kind === s.kind, chip = el("div", isNext ? "wb-slot next" : "wb-slot");
      chip.append(line(el("strong", undefined, s.at), el("span", `wb-pill ${cls}`, isNext ? "下一次" : label)), el("span", "wb-sub", kinds[s.kind] || s.kind));
      row.append(chip);
    }
    box.append(row, el("div", "wb-sub", "时段在本机面板 http://127.0.0.1:3439 调整，每类最多 24 个；电脑睡眠时不执行，唤醒后补跑当天已到点的时段。"));
    return box;
  }

  const again = () => { if (last) { switched = true; render(last[0], last[1]); } };

  function spark(u) {
    const s = svg("svg", { viewBox: "0 0 56 20", class: "wb-spark", "aria-hidden": "true" });
    if (!u?.days.length) return s;
    const top = Math.max(...u.days.map(d => d.credit), 1), step = 52 / Math.max(1, u.days.length - 1);
    s.append(svg("polyline", { points: u.days.map((d, i) => `${2 + i * step},${18 - d.credit / top * 16}`).join(" ") }));
    return s;
  }

  // Each package is a segment, ordered by when it lapses; the track is what's spent.
  function meter(b, now) {
    const m = el("div", "wb-meter");
    for (const p of b.packages) { const seg = el("span", `wb-seg ${tone(p.expires, now)}`); seg.style.width = `${p.balance / b.size * 100}%`; seg.title = `${short(p.name)} ${num(p.balance)} 积分 · ${p.expires ? `${when(p.expires)} ${lapse(p)}` : "长期有效"}`; m.append(seg); }
    return m;
  }

  function attention(rows, now) {
    const items = [], manual = new Map();
    for (const a of rows) {
      for (const t of a.tasks?.open || []) {
        if (t.state !== "manual") continue;
        const e = manual.get(t.title) || { ...t, count: 0 };
        e.count++; manual.set(t.title, e);
      }
      for (const [part, message] of Object.entries(a.errors || {})) items.push({ tone: "urgent", text: `${a.name}：${parts[part] || part}读取失败`, aside: message, order: 0 });
      if (a.expires && a.expires - now < DAY) items.push({ tone: "urgent", text: `${a.name} 的登录${a.expires <= now ? "已过期" : `${left(a.expires, now)}过期`}`, aside: "请在 Magpie 重新登录", order: 0 });
    }
    for (const e of lapsing(rows).filter(g => g.expires - now <= 10 * DAY)) items.push({ tone: tone(e.expires, now), text: e.resets ? `${e.name}还剩 ${num(e.balance)} 积分，用不完会清零` : `${num(e.balance)} 积分（${e.name}${e.count > 1 ? ` ×${e.count}` : ""}）将作废`, aside: `${when(e.expires)}${e.resets ? " 重置" : ""} · ${left(e.expires, now)}`, order: e.expires });
    for (const e of manual.values()) items.push({ tone: "soon", text: `「${e.title}」需手动完成${e.count > 1 ? ` ×${e.count}` : ""}`, aside: e.credit ? `+${num(e.credit * e.count)} 积分` : "", title: e.note, order: Infinity });
    return items.sort((x, y) => x.order - y.order);
  }

  function alerts(items) {
    if (!items.length) return el("div", "wb-calm", "没有需要你处理的事");
    const box = el("section", `wb-alerts ${items.some(i => i.tone === "urgent") ? "urgent" : ""}`);
    box.setAttribute("aria-label", "需要你留意");
    box.append(el("div", "wb-alerts-head", `需要你留意 ${items.length} 件`));
    for (const i of items) { const row = line(el("span", "wb-alert-text", i.text), el("span", "wb-alert-aside", i.aside)); row.className = `wb-line wb-alert ${i.tone}`; if (i.title) row.title = i.title; box.append(row); }
    return box;
  }

  function kpis(rows, now) {
    const personal = rows.filter(a => !a.enterprise), credit = rows.reduce((s, a) => s + (a.usage?.credit || 0), 0);
    const claimed = personal.reduce((s, a) => s + (a.tasks?.claimed || 0), 0), total = personal.reduce((s, a) => s + (a.tasks?.total || 0), 0), pending = personal.reduce((s, a) => s + (a.tasks?.credit || 0), 0);
    const done = personal.filter(a => closed(today(a, now))).length;
    const strip = el("div", "wb-kpis");
    for (const [k, v, sub] of [
      ["可用积分", num(rows.reduce((s, a) => s + (a.balance?.balance || 0), 0)), `${rows.length} 个账号`],
      ["近 7 天消耗", num(credit), `日均 ${num(credit / 7)}`],
      ["成长任务", total ? `${claimed}/${total}` : "—", pending ? `待拿 ${num(pending)} 积分` : "全部已领奖"],
      ["今日", !personal.length ? "—" : done === personal.length ? "全部完成" : `${done}/${personal.length} 完成`, "活跃 · 旅行 · 任务"]
    ]) {
      const t = el("div", "wb-kpi");
      t.append(el("span", "wb-sub", k), el("strong", undefined, v), el("span", "wb-sub", sub));
      strip.append(t);
    }
    return strip;
  }

  function detail(a, now) {
    const grid = el("div", "wb-detail-grid"), left_ = el("div", "wb-col-l"), right = el("div", "wb-col-r");
    left_.append(el("div", "wb-label", "积分包"));
    for (const p of a.balance?.packages || []) {
      const k = tone(p.expires, now);
      left_.append(line(el("span", "wb-name", `${short(p.name)} ${num(p.balance)}`), el("span", `wb-when ${k}`, p.expires ? `${left(p.expires, now)}${p.resets ? "重置" : ""}` : "长期有效")));
    }
    if (a.balance && !a.balance.packages.length) left_.append(el("div", "wb-sub", a.enterprise ? (a.balance.size ? "本月企业额度已用完" : "没有企业额度") : "没有可用积分包"));
    const u = a.usage;
    left_.append(line(el("span", "wb-label", "近 7 天用量"), el("span", "wb-sub", u ? `${num(u.credit)} 积分 · ${u.count} 次` : "")));
    if (u) {
      left_.append(bars(u));
      if (u.models.length) left_.append(el("div", "wb-sub", u.models.map(m => `${m.model} ${num(m.credit)}`).join(" · ")));
    }
    grid.append(left_);
    if (a.enterprise) return grid;

    const g = a.growth, s = a.streak, t = a.tasks, top = g && ["UR", "SSR", "SR"].find(r => g.rarity[r]);
    right.append(line(el("span", "wb-label", "成长"), el("span", "wb-sub", t ? `任务 ${t.claimed}/${t.total}` : "")));
    right.append(el("div", "wb-stats", [g && `能量 ${num(g.energy)}`, g && `Buddy ${g.buddies}${top ? `（含 ${top}）` : ""}`, g && `抽奖 ${g.draws}`, s && `补签卡 ${s.makeupCards}`].filter(Boolean).join(" · ")));
    if (s?.nextTier) right.append(el("div", "wb-sub", `再连登 ${s.nextTier.remaining} 天到 ${s.nextTier.days} 天档：${[s.nextTier.credit && `+${s.nextTier.credit} 积分`, s.nextTier.energy && `+${s.nextTier.energy} 能量`].filter(Boolean).join(" · ") || "奖励"}`));
    const states = { claimable: ["可领奖", "ok"], auto: ["定时会完成", "go"], manual: ["需手动", "warn"], locked: ["未解锁", ""] };
    for (const task of t?.open || []) {
      const [label, cls] = states[task.state] || [task.state, ""];
      const row = line(el("span", "wb-name", task.title), el("span", `wb-pill ${cls}`, label));
      row.title = [task.target ? `${task.current}/${task.target}` : "", task.credit ? `+${task.credit} 积分` : "", task.ends ? `${date(task.ends)} 截止` : "", task.note].filter(Boolean).join(" · ");
      right.append(row);
    }
    const tr = trip(a.travel, now);
    if (tr) {
      right.append(line(el("span", "wb-label", "猫猫旅行"), el("span", `wb-pill ${tr.tone}`, a.travel?.name ? `${a.travel.name} · ${tr.label}` : tr.label)), el("div", "wb-sub", tr.note));
      if (tr.progress !== undefined) { const b = el("div", "wb-bar"), f = el("span"); f.style.width = `${Math.max(2, tr.progress * 100)}%`; b.append(f); right.append(b); }
    }
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
    who.append(el("strong", undefined, a.name), el("span", "wb-sub", a.enterprise ? `企业${a.balance?.size ? ` · 每月 ${num(a.balance.size)} 积分` : ""}` : `个人${a.streak ? ` · 连登 ${a.streak.days} 天` : ""}`));
    const money = el("span", "wb-money");
    if (a.balance?.size) { const n = line(el("strong", undefined, num(a.balance.balance)), el("span", "wb-sub", `/ ${num(a.balance.size)}`)); n.className = "wb-line wb-amount"; money.append(n, meter(a.balance, now)); }
    else money.append(el("span", "wb-sub", a.errors.balance ? "积分读取失败" : a.enterprise ? "没有企业额度" : "没有积分包"));
    const glance = el("span", "wb-glance"), r = today(a, now);
    if (r) { const holder = el("span", "wb-rings-box"); holder.title = `今日活跃${r.active ? "✓" : "✗"} · 猫猫旅行 ${Math.round(r.trip * 100)}% · 成长任务 ${a.tasks ? `${a.tasks.claimed}/${a.tasks.total}` : "—"}`; holder.append(rings(r)); glance.append(holder); }
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

  function listView(rows, now, extra) {
    const box = el("div", "wb-view-list"), list = el("div", "wb-list"), head = el("div", "wb-row wb-list-head");
    head.append(el("span"), el("span", undefined, "账号"), el("span", undefined, "积分 · 按作废先后"), el("span", undefined, "今日 · 7 天"), el("span"));
    list.append(head);
    for (const a of rows) list.append(account(a, now));
    box.append(kpis(rows, now), list, el("p", "wb-legend", "圆环由外到内：今日活跃、猫猫旅行、成长任务。积分条：红 = 2 天内作废，橙 = 10 天内，浅色 = 长期有效。"), ...(extra ? [extra] : []), alerts(attention(rows, now)));
    return box;
  }

  // Packages on a line from today to the last dated lapse; dot size follows the credit.
  function timeline(b, now) {
    const dated = b.packages.filter(p => p.expires), lasting = b.packages.filter(p => !p.expires), wrap = el("div", "wb-timeline");
    if (dated.length) {
      const end = Math.max(...dated.map(p => p.expires)), span = Math.max(end - now, DAY), most = Math.max(...dated.map(p => p.balance), 1);
      const track = el("div", "wb-track");
      dated.forEach((p, i) => {
        const x = Math.min(100, Math.max(0, (p.expires - now) / span * 100)), size = Math.round(8 + 10 * Math.sqrt(p.balance / most));
        const dot = el("span", `wb-pkg-dot ${tone(p.expires, now)}`), label = el("span", `wb-tl-label ${tone(p.expires, now)}${i % 2 ? " low" : ""}${x > 75 ? " end" : x < 12 ? " start" : ""}`, `${date(p.expires)} · ${num(p.balance)}`);
        dot.style.left = label.style.left = `${x}%`;
        dot.style.width = dot.style.height = `${size}px`;
        dot.title = `${short(p.name)} ${num(p.balance)} 积分 · ${when(p.expires)} ${lapse(p)} · ${left(p.expires, now)}`;
        track.append(dot, label);
      });
      wrap.append(track, line(el("span", "wb-sub", "今天"), el("span", "wb-sub", "积分作废时间线 · 圆点越大积分越多")));
    }
    if (lasting.length) wrap.append(el("div", "wb-sub", `长期有效：${lasting.map(p => `${short(p.name)} ${num(p.balance)}`).join("、")}`));
    return wrap;
  }

  function ringsView(rows, now) {
    const box = el("div", "wb-view-rings");
    if (focus !== "all" && !rows.some(a => a.id === focus)) focus = "all";
    box.append(segs([["all", "全部"], ...rows.map(a => [a.id, a.enterprise ? "企业" : a.name])], focus, v => { focus = v; again(); }, "选择账号"));
    if (focus === "all") {
      const grid = el("div", "wb-ringcards");
      for (const a of rows) {
        const card = el("button", "wb-ringcard"), r = today(a, now);
        card.type = "button";
        const done = r ? [r.active, r.trip, r.tasks].filter(v => v >= 1).length : 0;
        card.append(r ? rings(r, true) : el("div", "wb-ring-none", "企业账号"), el("strong", undefined, a.name),
          el("span", "wb-sub", a.balance?.size ? `${num(a.balance.balance)} 积分${a.enterprise ? ` / 每月 ${num(a.balance.size)}` : ""}` : a.enterprise ? "没有企业额度" : "没有积分包"),
          el("span", "wb-sub", r ? (done === 3 ? "今日全部完成" : `今日完成 ${done}/3`) : `近 7 天 ${num(a.usage?.credit)} 积分`));
        card.onclick = () => { focus = a.id; again(); };
        grid.append(card);
      }
      box.append(grid);
      return box;
    }
    const a = rows.find(x => x.id === focus), r = today(a, now), top = el("div", r ? "wb-b-top" : "wb-b-top solo");
    if (r) {
      const card = el("div", "wb-card wb-b-rings"), legend = el("div", "wb-keys"), tr = trip(a.travel, now);
      for (const [k, label, value] of [["a", "今日活跃", a.streak ? (a.streak.active ? `连登 ${a.streak.days} 天` : "今天还没活跃") : "—"], ["b", "猫猫旅行", tr ? tr.label : "—"], ["c", "成长任务", a.tasks ? `${a.tasks.claimed}/${a.tasks.total}` : "—"]]) {
        const name = el("span", "wb-key"); name.append(el("i", `wb-dot wb-dot-${k}`), label);
        legend.append(line(name, el("span", "wb-sub", value)));
      }
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
      todo.append(el("span", "wb-label", "待处理"), el("span", manual.length ? "wb-warn-text" : "wb-sub", manual.length ? manual.map(t => `${t.title}${t.credit ? ` · +${t.credit} 积分` : ""}`).join("；") : "没有需要手动完成的任务"));
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
    rings_.title = "外环活跃 · 中环旅行 · 内环任务";
    const trips = personal.map(a => ({ a, t: trip(a.travel, now) })).filter(x => x.t), out = trips.filter(x => x.t.progress !== undefined);
    const labels = [...new Set(trips.map(x => x.t.label))];
    const cats = widget("s", "", "猫猫", el("strong", "wb-w-mid", !trips.length ? "—" : labels.length === 1 ? `${trips.length} 只${labels[0]}` : out.length ? `${out.length} 只在旅行` : `${trips.length} 只猫`));
    const notes = el("div", "wb-w-foot");
    for (const x of trips.slice(0, 3)) notes.append(el("div", undefined, `${x.a.travel?.name || x.a.name} · ${x.t.progress !== undefined ? x.t.note : x.t.label}`));
    cats.append(notes);

    const sum = k => personal.reduce((s, a) => s + (a.growth?.[k] || 0), 0);
    widget("s", "", "能量", el("strong", "wb-w-big", num(sum("energy"))), el("span", "wb-w-foot", `Buddy ${num(sum("buddies"))} 只 · 抽奖 ${num(sum("draws"))} 次${personal.length > 1 ? ` · ${personal.length} 个号` : ""}`));

    const credits = widget("m", "", "可用积分");
    credits.append(el("strong", "wb-w-corner", num(rows.reduce((s, a) => s + (a.balance?.balance || 0), 0))));
    for (const a of rows) {
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

    const tasks = personal.filter(a => a.tasks), claimed = tasks.reduce((s, a) => s + a.tasks.claimed, 0), all = tasks.reduce((s, a) => s + a.tasks.total, 0), pending = tasks.reduce((s, a) => s + a.tasks.credit, 0);
    const growth = widget("w", "", "成长任务");
    growth.append(el("strong", "wb-w-corner", all ? `${claimed}/${all}` : "—"));
    const manual = new Map();
    for (const a of tasks) for (const t of a.tasks.open) if (t.state === "manual") manual.set(t.title, (manual.get(t.title) || 0) + 1);
    for (const [title, count] of manual) growth.append(line(el("span", "wb-name", title), el("span", "wb-pill warn", `需手动${count > 1 ? ` ×${count}` : ""}`)));
    if (!manual.size) growth.append(el("div", "wb-sub", pending ? `待拿 ${num(pending)} 积分，定时会完成` : "当前任务全部已领奖"));
    const tier = personal.map(a => a.streak?.nextTier && { ...a.streak.nextTier, days: a.streak.days, target: a.streak.nextTier.days }).find(Boolean);
    if (tier) growth.append(line(el("span", "wb-sub", `连登 ${tier.days} 天 · 再 ${tier.remaining} 天到 ${tier.target} 天档`), el("span", "wb-sub", tier.credit ? `+${tier.credit} 积分` : "")));

    return grid;
  }

  function render(host, view, now = Date.now()) {
    last = [host, view];
    host.replaceChildren();
    const rows = view?.accounts || [];
    if (!rows.length) { host.append(el("p", "wb-sub", view?.at ? "没有国内账号。请先在 Magpie 登录 WorkBuddy 国内版。" : "正在读取余额与旅行状态…")); return; }
    if (!seeded) { seeded = true; const first = rows.find(a => !a.enterprise) || rows[0]; expanded.add(first.id); }
    const bar = el("div", "wb-viewbar");
    bar.append(segs(views, mode, v => { mode = v; saved.set(v); again(); }, "切换视图"));
    const plan = schedule(view), body = (mode === "rings" ? ringsView : mode === "widgets" ? widgetsView : listView)(rows, now, plan);
    if (plan && mode !== "list") body.append(plan);
    if (switched) { body.className += " wb-enter"; switched = false; }
    host.append(bar, body);
  }

  globalThis.WBBoard = { render, when };
})();
