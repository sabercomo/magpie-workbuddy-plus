import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { calendar } from "./storage.mjs";
import { specs, manualTasks } from "./events.mjs";

// Read-only account board: credit packages, official request usage, the
// Buddy's trip, growth tasks, energy and the login streak. Package merging and usage paging are
// adapted from zseeu1/wbkit (lib/quota.mjs, lib/usage.mjs; MIT).
const farFuture = 730 * 86400_000; // upstream uses 2049-style placeholders for "no expiry"
const round = n => Math.round(n * 100) / 100;
const beijing = text => {
  if (!String(text || "").trim()) return 0;
  const t = Date.parse(`${String(text).trim().replace(" ", "T")}+08:00`);
  return Number.isFinite(t) ? t : 0;
};

export function summarize(rows, now = Date.now()) {
  const groups = new Map();
  for (const a of rows) {
    const end = beijing(a.CycleEndTime);
    if (end && end <= now) continue;
    const name = a.PackageName || a.ProductName || "积分包";
    const g = groups.get(name) || { name, balance: 0, size: 0, expires: 0 };
    const remain = Number(a.CapacityRemain) || 0;
    g.balance += remain;
    g.size += Number(a.CapacitySize) || 0;
    // A spent row's end date says nothing about when the remaining credit lapses.
    if (remain > 0) for (const t of [end, Number(a.DeductionEndTime) || 0, beijing(a.ExpiredTime)]) if (t > 0 && t <= now + farFuture && (!g.expires || t < g.expires)) g.expires = t;
    groups.set(name, g);
  }
  const all = [...groups.values()].map(g => ({ ...g, balance: round(g.balance), size: round(g.size) }));
  const packages = all.filter(g => g.balance > 0).sort((a, b) => (a.expires || Infinity) - (b.expires || Infinity) || b.balance - a.balance);
  return { balance: round(all.reduce((s, g) => s + g.balance, 0)), size: round(all.reduce((s, g) => s + g.size, 0)), packages };
}

// An enterprise login has no packages; its credits are a monthly allowance on
// the enterprise meter, the one WorkBuddy's own usage page reads (as Magpie's
// WorkBuddy plugin does, magpie #1904). What's left lapses when it resets.
export function allowance(u) {
  const limit = Number(u?.limitNum) || 0;
  if (!(limit > 0)) return null;
  const used = Number(u.credit) || 0, left = round(Math.max(0, limit - used)), resets = beijing(u.cycleResetTime);
  return {
    balance: left, size: round(limit), used: round(used), resets,
    packages: left > 0 ? [{ name: "企业月度额度", balance: left, size: round(limit), expires: resets, resets: true }] : []
  };
}

async function balance(client, account) {
  if (account?.enterprise) {
    const got = allowance(await client.request("/billing/meter/get-enterprise-user-usage", { body: {} }));
    if (got) return got;
  }
  let data;
  try { data = await client.request("/billing/meter/get-user-resource", { body: {} }); }
  catch { data = await client.request("/v2/billing/meter/get-user-resource", { body: {}, base: "https://copilot.tencent.com" }); }
  const found = data?.Response?.Data ?? data;
  // Enterprise logins answer Accounts: null with TotalCount 0: no personal packages.
  const rows = found?.Accounts ?? (found?.TotalCount === 0 ? [] : undefined);
  if (!Array.isArray(rows)) throw new Error("积分接口缺少 Accounts 列表");
  return summarize(rows);
}

// The server returns at most 3000 rows per window and keeps the earliest,
// so a full page moves the window start to its newest row and asks again.
export async function usage(client, timezone, span = 7, now = new Date()) {
  const dates = Array.from({ length: span }, (_, i) => calendar(new Date(now - (span - 1 - i) * 86400_000), timezone).day);
  const end = `${dates.at(-1)} 23:59:59`, seen = new Set(), byDay = new Map(dates.map(d => [d, { date: d, credit: 0, count: 0 }])), byModel = new Map();
  let start = `${dates[0]} 00:00:00`;
  for (let pass = 0; pass < 20; pass++) {
    const page = (await client.request("/billing/meter/get-user-request-usage", { body: { startTime: start, endTime: end, pageNum: 1, pageSize: 3000 } }))?.data;
    if (!Array.isArray(page)) throw new Error("用量接口缺少 data 列表");
    let newest = "";
    for (const r of page) {
      const time = String(r.requestTime || ""), key = `${r.requestId}@${time}`;
      if (!r.requestId || seen.has(key)) continue;
      seen.add(key);
      const credit = Number(r.credit) || 0, day = byDay.get(time.slice(0, 10)), model = byModel.get(r.model) || { model: String(r.model || "未知"), credit: 0, count: 0 };
      if (day) { day.credit += credit; day.count++; }
      model.credit += credit; model.count++;
      byModel.set(r.model, model);
      if (time > newest) newest = time;
    }
    if (page.length < 3000 || !newest) break;
    start = newest;
  }
  const days = [...byDay.values()].map(d => ({ ...d, credit: round(d.credit) }));
  return {
    days, credit: round(days.reduce((s, d) => s + d.credit, 0)), count: days.reduce((s, d) => s + d.count, 0),
    models: [...byModel.values()].sort((a, b) => b.credit - a.credit).slice(0, 4).map(m => ({ ...m, credit: round(m.credit) }))
  };
}

export async function travel(client) {
  const info = await client.request("/activity/growth/buddy/info");
  const buddy = info?.buddy && Object.keys(info.buddy).length ? info.buddy : null;
  if (!buddy) return { state: "none" };
  const s = await client.request("/activity/growth/buddy/travel/status");
  return {
    state: s.state, name: buddy.name || buddy.nickname || "", location: s.location?.name || "",
    departAt: (Number(s.depart_at) || 0) * 1000, arriveAt: (Number(s.arrive_at) || 0) * 1000,
    limitReached: !!s.daily_limit_reached, reward: Number(s.reward_credit) || 0
  };
}

async function streak(client) {
  const s = await client.request("/activity/growth/streak");
  const next = s?.redemption_status?.tiers?.find(t => t.tier === s?.streak?.next_tier);
  const heatmap = await client.request("/activity/growth/heatmap");
  return {
    days: s?.streak?.days ?? 0, makeupCards: s?.makeup_cards?.balance ?? 0, active: !!heatmap?.today?.is_active,
    nextTier: next ? { days: next.days, remaining: s.streak.next_tier_remaining ?? 0, credit: next.credit || 0, energy: next.energy || 0 } : null
  };
}

// Growth tasks as the board shows them: what waits for a claim, what the
// scheduler will finish, and what needs a person at the desktop client.
export function taskBoard(list, now = Date.now()) {
  const live = list.filter(t => !t.valid_end || Date.parse(t.valid_end) > now);
  const done = t => t.accept_status === "completed" || (t.progress?.target > 0 && t.progress.current >= t.progress.target);
  const order = { claimable: 0, auto: 1, manual: 2, locked: 3 };
  const open = live.filter(t => t.accept_status !== "claimed").map(t => ({
    title: t.title || t.task_code,
    state: done(t) ? "claimable" : t.locked === true ? "locked" : specs[t.task_code] ? "auto" : "manual",
    note: manualTasks[t.task_code] || "", current: t.progress?.current ?? 0, target: t.progress?.target ?? 0,
    credit: Number(t.reward_credit) || 0, energy: Number(t.reward_energy) || 0, ends: t.valid_end ? Date.parse(t.valid_end) : 0
  })).sort((a, b) => order[a.state] - order[b.state] || (a.ends || Infinity) - (b.ends || Infinity));
  return { total: live.length, claimed: live.length - open.length, credit: open.reduce((s, t) => s + t.credit, 0), open };
}

async function tasks(client) {
  const list = (await client.request("/v2/activity/growth/tasks"))?.tasks;
  if (!Array.isArray(list)) throw new Error("成长任务接口缺少 tasks 列表");
  return taskBoard(list);
}

// Energy is what the growth center's Buddy draws spend.
async function growth(client) {
  const energy = await client.request("/v2/activity/growth/energy");
  const lottery = await client.request("/activity/growth/lottery/summary");
  const buddies = (await client.request("/activity/growth/buddy/list"))?.buddies || [];
  const rarity = {};
  for (const b of buddies) rarity[b.rarity || "?"] = (rarity[b.rarity || "?"] || 0) + 1;
  return {
    energy: Number(energy?.balance) || 0, earned: Number(energy?.total_earned) || 0, spent: Number(energy?.total_consumed) || 0,
    draws: Number(lottery?.chances) || 0, buddies: buddies.length, rarity, current: buddies.filter(b => b.current_buddy).map(b => b.name)
  };
}

// Each part fails alone: a refused usage query still shows the balance.
export async function collect(account, client, config) {
  const row = { id: account.id, name: account.name, enterprise: account.enterprise, expires: account.auth.expires, errors: {} };
  const parts = { balance: () => balance(client, account), usage: () => usage(client, config.timezone) };
  if (!account.enterprise) Object.assign(parts, { travel: () => travel(client), streak: () => streak(client), tasks: () => tasks(client), growth: () => growth(client) });
  for (const [name, run] of Object.entries(parts)) {
    try { row[name] = await run(); }
    catch (e) { row.errors[name] = e.message.slice(0, 160); }
  }
  return row;
}

// Magpie's page runs sandboxed without network access; this file is all it sees.
// An open page keeps the scripts it loaded and only re-reads data.js, so the
// snapshot carries a fingerprint of the page's files: when an update changes
// them, the page reloads itself.
export function pageBuild(dir, skip) {
  const hash = createHash("sha1");
  for (const name of readdirSync(dir).filter(n => n !== skip && !n.endsWith(".tmp")).sort()) hash.update(name).update(readFileSync(join(dir, name)));
  return hash.digest("hex").slice(0, 12);
}

export function writePage(file, view) {
  mkdirSync(dirname(file), { recursive: true });
  view = { ...view, build: pageBuild(dirname(file), file.split(/[\\/]/).at(-1)) };
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `/* WorkBuddy Plus 后台服务生成：只有余额、用量与旅行状态，没有登录凭证 */\nglobalThis.WBPLUS = ${JSON.stringify(view)};\n`);
  renameSync(temporary, file);
}
