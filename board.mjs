import { limits } from "./limits.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { calendar } from "./storage.mjs";
import { specs, manualTasks, growthTasks } from "./events.mjs";

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

// One package name holds many grants, each lapsing on its own date (every
// growth reward is a 20-day grant of 「国内运营裂变包」), so each keeps its
// lots: what lapses when. The package's own expiry is its earliest lot's.
//
// Each row is also one grant, made when the credit was given: a check-in, a
// task's reward, a Buddy's trip. The last 30 days of them are the account's
// credit history (grants), newest first, with what's left of each.
export function summarize(rows, now = Date.now()) {
  const groups = new Map(), grants = [];
  for (const a of rows) {
    const end = beijing(a.CycleEndTime);
    const made = Number(a.CreateTime) || beijing(a.CycleStartTime);
    // A grant may be written minutes after it was given (a draw's prize): its
    // cycle's start is the moment itself.
    const start = beijing(a.CycleStartTime);
    if (made > now - 30 * 86400_000) grants.push({ at: made, ...(start && start !== made ? { start } : {}), credit: round(Number(a.CapacitySize) || 0), name: a.PackageName || a.ProductName || "积分包", left: round(Number(a.CapacityRemain) || 0), ...(end ? { ends: end } : {}) });
    if (end && end <= now) continue;
    const name = a.PackageName || a.ProductName || "积分包";
    const g = groups.get(name) || { name, balance: 0, size: 0, expires: 0, lots: new Map() };
    const remain = Number(a.CapacityRemain) || 0;
    g.balance += remain;
    g.size += Number(a.CapacitySize) || 0;
    // A spent row's end date says nothing about when the remaining credit lapses.
    if (remain > 0) {
      const lapse = Math.min(...[end, Number(a.DeductionEndTime) || 0, beijing(a.ExpiredTime)].filter(t => t > 0 && t <= now + farFuture));
      const at = Number.isFinite(lapse) ? lapse : 0;
      g.lots.set(at, (g.lots.get(at) || 0) + remain);
      if (at && (!g.expires || at < g.expires)) g.expires = at;
    }
    groups.set(name, g);
  }
  const all = [...groups.values()].map(g => ({ ...g, balance: round(g.balance), size: round(g.size),
    lots: [...g.lots].map(([expires, balance]) => ({ balance: round(balance), expires })).sort((x, y) => (x.expires || Infinity) - (y.expires || Infinity)) }));
  const packages = all.filter(g => g.balance > 0).sort((a, b) => (a.expires || Infinity) - (b.expires || Infinity) || b.balance - a.balance);
  return { balance: round(all.reduce((s, g) => s + g.balance, 0)), size: round(all.reduce((s, g) => s + g.size, 0)), packages,
    grants: grants.filter(g => g.credit > 0).sort((x, y) => y.at - x.at).slice(0, 120) };
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
  // China's second billing host knows nothing of a WorkBuddy AI login: its first error stands.
  catch (e) { if (account?.realm === "intl") throw e; data = await client.request("/v2/billing/meter/get-user-resource", { body: {}, base: "https://copilot.tencent.com" }); }
  const found = data?.Response?.Data ?? data;
  // Enterprise logins answer Accounts: null with TotalCount 0: no personal packages.
  const rows = found?.Accounts ?? (found?.TotalCount === 0 ? [] : undefined);
  if (!Array.isArray(rows)) throw new Error("积分接口缺少 Accounts 列表");
  return summarize(rows);
}

// The server returns at most 3000 rows per window and keeps the earliest,
// so a full page moves the window start to its newest row and asks again.
//
// Each row is one request and what it cost. The newest charged ones are kept
// as the board's deductions (扣分明细): when, how much, which model, from
// which client; never the request's text (input / inputTrunc).
export async function usage(client, timezone, span = 7, now = new Date(), keep = 50) {
  const dates = Array.from({ length: span }, (_, i) => calendar(new Date(now - (span - 1 - i) * 86400_000), timezone).day);
  const end = `${dates.at(-1)} 23:59:59`, seen = new Set(), byDay = new Map(dates.map(d => [d, { date: d, credit: 0, count: 0 }])), byModel = new Map(), charged = [], used = {};
  let free = 0;
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
      if (day && credit > 0) charged.push({ at: beijing(time), credit: round(credit), model: String(r.model || "未知"), ...(r.client ? { client: String(r.client) } : {}) });
      else if (day) free++;
      model.credit += credit; model.count++;
      byModel.set(r.model, model);
      // When each model was last used: the model limits ask only about those.
      if (r.model && time) used[r.model] = Math.max(used[r.model] || 0, beijing(time));
      if (time > newest) newest = time;
    }
    if (page.length < 3000 || !newest) break;
    start = newest;
  }
  const days = [...byDay.values()].map(d => ({ ...d, credit: round(d.credit) }));
  return {
    days, credit: round(days.reduce((s, d) => s + d.credit, 0)), count: days.reduce((s, d) => s + d.count, 0),
    models: [...byModel.values()].sort((a, b) => b.credit - a.credit).slice(0, 4).map(m => ({ ...m, credit: round(m.credit) })),
    charges: charged.length, free, recent: charged.sort((x, y) => y.at - x.at).slice(0, keep), used
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
    title: t.title || t.task_code, ...(t.intl ? { intl: true } : {}),
    state: done(t) ? "claimable" : t.locked === true ? "locked" : specs[t.task_code] ? "auto" : "manual",
    note: manualTasks[t.task_code] || t.note || "", current: t.progress?.current ?? 0, target: t.progress?.target ?? 0,
    credit: Number(t.reward_credit) || 0, energy: Number(t.reward_energy) || 0, ends: t.valid_end ? Date.parse(t.valid_end) : 0
  })).sort((a, b) => order[a.state] - order[b.state] || (a.ends || Infinity) - (b.ends || Infinity));
  return { total: live.length, claimed: live.length - open.length, credit: open.reduce((s, t) => s + t.credit, 0), open };
}

async function tasks(client) {
  const list = (await client.request("/v2/activity/growth/tasks"))?.tasks;
  if (!Array.isArray(list)) throw new Error("成长任务接口缺少 tasks 列表");
  return taskBoard(growthTasks(list));
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

// Today's check-in for one login as Magpie recorded it. Another day's record
// says nothing about today: Magpie hasn't run yet, or its switch is off.
export function checkin(found, key, day) {
  const r = found.records[`workbuddy|${key}`];
  if (r?.day !== day) return { outcome: found.on ? "waiting" : "off" };
  return { outcome: String(r.outcome || "failed"), credit: Number(r.credit) || 0, streak: Number(r.streak) || 0, at: Date.parse(r.claimed || r.at) || 0, ...(r.msg ? { message: String(r.msg).slice(0, 160) } : {}) };
}

// WorkBuddy AI's check-in, which this plugin claims itself: "closed" while
// no check-in campaign runs there. China's is read from Magpie's record.
async function intlCheckin(client) {
  const s = await client.request("/v2/billing/meter/checkin-activity-status", { billing: true, body: {} });
  if (!s?.active) return { outcome: "closed" };
  return s.today_checked_in ? { outcome: "done", credit: Number(s.today_credit) || 0, streak: Number(s.streak_days) || 0 } : { outcome: "waiting" };
}

// A connection dropped or timed out on the way (a proxy resetting it, a
// network blip), as opposed to an answer WorkBuddy gave.
export const dropped = e => !e?.status && !e?.limited && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket|fetch failed|network|timed out/i.test(`${e?.code || ""} ${e?.message || ""}`);

// Each part fails alone: a refused usage query still shows the balance. These
// are all reads, so a dropped connection is tried once more before it shows.
export async function collect(account, client, config, memory, pause = ms => new Promise(r => setTimeout(r, ms))) {
  const row = { id: account.id, name: account.name, realm: account.realm, enterprise: account.enterprise, expires: account.auth.expires, errors: {} };
  const parts = { balance: () => balance(client, account), usage: () => usage(client, config.timezone) };
  if (!account.enterprise) Object.assign(parts, { ...(account.realm === "intl" ? {} : { travel: () => travel(client) }), streak: () => streak(client), tasks: () => tasks(client), growth: () => growth(client) });
  if (!account.enterprise && account.realm === "intl") parts.checkin = () => intlCheckin(client);
  for (const [name, run] of Object.entries(parts)) {
    try { row[name] = await run(); }
    catch (e) {
      if (dropped(e)) {
        await pause(2000);
        try { row[name] = await run(); continue; } catch (again) { e = again; }
      }
      row.errors[name] = e.message.slice(0, 160);
    }
  }
  // Model limits need the usage above; without a memory (tests, one-off reads) none are asked.
  if (memory && row.usage) row.limits = await limits(client, row.usage.used, memory);
  return row;
}

// Magpie's page runs sandboxed without network access; this file is all it sees.
// An open page keeps the scripts it loaded and only re-reads data.js, so the
// snapshot carries a fingerprint of the page's files: when an update changes
// them, the page reloads itself.
export function pageBuild(dir, skip) {
  const hash = createHash("sha1");
  for (const name of readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && f.name !== skip && !f.name.endsWith(".tmp")).map(f => f.name).sort()) hash.update(name).update(readFileSync(join(dir, name)));
  return hash.digest("hex").slice(0, 12);
}

export function writePage(file, view) {
  mkdirSync(dirname(file), { recursive: true });
  view = { ...view, build: pageBuild(dirname(file), file.split(/[\\/]/).at(-1)) };
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `/* WorkBuddy Plus 后台服务生成：只有余额、用量与旅行状态，没有登录凭证 */\nglobalThis.WBPLUS = ${JSON.stringify(view)};\n`);
  renameSync(temporary, file);
}
