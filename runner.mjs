import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { accounts, calendar, checkins, initialize, intlAccount, intlSchedules, magpieDir, maskProxy, plan, proxyFor, publicAccount, publicConfig, readJSON, settle, validateConfig, version, writeJSON } from "./storage.mjs";
import { WorkBuddyClient } from "./client.mjs";
import { actions, perform } from "./engine.mjs";
import { checkin, collect, usageSince, writePage } from "./board.mjs";
import { ledger } from "./history.mjs";
import { routingRefusals } from "./limits.mjs";
import { chinaModels, enterpriseModels, intlModels } from "./models.mjs";
import { dropped } from "./network.mjs";
import { syncChoices, syncView } from "./sync/view.mjs";

class PageRejection extends Error {} // Validation before a job is created, never an execution error.

const NETWORK_FAILURES = 3, NETWORK_PAUSE_MS = 10 * 60_000;
const actionNames = { all: "全部任务", activity: "连登活跃", tasks: "成长任务", sweep: "补领奖励", task: "单项任务", travel: "猫猫旅行", buddy: "Buddy 盲盒", compensation: "官方补偿", bonus: "连登福利", night: "夜猫子", web: "网页会话", inspect: "状态查询" };
const logChannel = action => action === "web" ? "chat" : action === "inspect" ? "system" : "task";
const visibleJob = job => !(job.actions?.length === 1 && job.actions[0] === "keepalive");

// A LaunchAgent's PATH is only the system's, so the usual install places
// (Magpie's own ~/.local/bin link, Homebrew, the app) are looked in too. On
// Windows the command is magpie.com (the console build beside magpie.exe),
// which the installer puts in %LOCALAPPDATA%\Programs\Magpie or its registered InstallLocation.
export function magpieBin(env = process.env, platform = process.platform, query = spawnSync) {
  const win = platform === "win32";
  const names = win ? ["magpie.com", "magpie.exe"] : ["magpie"];
  const dirs = (env.PATH || "").split(win ? ";" : delimiter).filter(Boolean);
  if (win) {
    const data = env.WORKBUDDY_PLUS_HOST_CONFIG;
    if (data && basename(data).toLowerCase() === "data") {
      // A portable copy keeps its data beside the downloaded executable.
      dirs.unshift(dirname(data));
      names.push("magpie-windows-amd64.exe", "magpie-windows-arm64.exe", "magpie-cli-windows-amd64.exe", "magpie-cli-windows-arm64.exe");
    }
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, "Programs", "Magpie"));
  } else dirs.push(join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/Applications/magpie.app/Contents/MacOS");
  const places = [env.WORKBUDDY_PLUS_MAGPIE_BIN, ...dirs.flatMap(d => names.map(name => join(d, name)))];
  const found = places.find(f => f && existsSync(f));
  if (found || !win) return found || "";
  const { stdout } = query("reg.exe", ["query", "HKCU\\Software\\magpie", "/v", "InstallLocation"], { encoding: "utf8", windowsHide: true });
  const installed = /^\s*InstallLocation[ \t]+REG_SZ[ \t]+([^\r\n]+)/im.exec(stdout || "")?.[1].trim();
  return installed && names.map(name => join(installed, name)).find(f => existsSync(f)) || "";
}

// Magpie's routing trace records the official plugin's quota refusals. Read
// today's and yesterday's traces so a model it was refused for shows here too;
// a later success from the same account clears that model.
export function routingLimits(config, list, now = Date.now()) {
  const byWho = new Map(list.map(a => [`${a.realm === "intl" ? "workbuddy-ai" : "workbuddy"}@${a.name.toLowerCase()}`, a.id]));
  const dir = join(config.magpieDir, "routing");
  let names;
  try { names = readdirSync(dir); } catch { return {}; }
  const days = [calendar(new Date(now - 86400_000), config.timezone).day, calendar(new Date(now), config.timezone).day];
  const events = [];
  for (const name of names) {
    if (!days.some(d => name.startsWith(d) && /^(?:\.\d+)?\.jsonl(?:\.gz)?$/.test(name.slice(d.length)))) continue;
    try {
      const body = readFileSync(join(dir, name));
      const text = name.endsWith(".gz") ? gunzipSync(body).toString("utf8") : body.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.includes('"tries"')) continue;
        try { const event = JSON.parse(line); if (Array.isArray(event?.tries)) events.push(event); } catch {}
      }
    } catch {}
  }
  events.sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0));
  const found = {};
  for (const event of events) for (const r of routingRefusals(event)) {
    const id = byWho.get(`${r.provider}@${r.account.toLowerCase()}`);
    if (!id) continue;
    const mine = found[id] ||= {};
    if (r.ok) { mine[r.model] = { clear: true, at: r.at || 0 }; continue; }
    if (r.until > now) mine[r.model] = { checked: r.at || now, resets: r.until };
  }
  return found;
}

// A slot runs at a moment within ±spread minutes of its set time, different
// each day and on each install, so installs don't all reach WorkBuddy at
// 09:00 on the dot. The night task keeps to its 23:00–08:00 window.
export function shifted(day, kind, at, spread, salt) {
  if (!(spread > 0)) return at;
  const [h, m] = at.split(":").map(Number), n = parseInt(createHash("sha256").update(`${salt}:${day}:${kind}:${at}`).digest("hex").slice(0, 8), 16);
  let minutes = h * 60 + m + (n % (2 * spread + 1)) - spread;
  const [low, high] = kind === "night" ? (at >= "23:00" ? [23 * 60, 1439] : [0, 8 * 60 - 1]) : [0, 1439];
  minutes = Math.min(high, Math.max(low, minutes));
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// A job mixes account/action results, and a growth-task round can itself mix
// completed tasks with failures. Keep both levels in the row's status and counts.
export function jobOutcome(results, aborted = false) {
  const counts = { succeeded: 0, failed: 0, limited: 0, total: 0 };
  for (const result of results) {
    const add = result.counts || {
      succeeded: result.ok ? 1 : 0,
      failed: result.ok ? 0 : 1,
      limited: result.ok ? 0 : Number(!!result.limited),
      total: 1
    };
    for (const key of Object.keys(counts)) counts[key] += Number(add[key]) || 0;
  }
  const status = aborted ? "cancelled"
    : !counts.failed ? "succeeded"
    : counts.succeeded ? "partial"
    : counts.limited === counts.failed ? "deferred"
    : "failed";
  return { status, counts };
}

export class Runner {
  // pace: the wait between accounts in a scheduled run, 5–45 s.
  constructor(dir, clientOptions = {}, { pageFile, panel = "", hostConfig = process.env.WORKBUDDY_PLUS_HOST_CONFIG, spawner = spawn, magpie = magpieBin, pace = () => 5000 + Math.random() * 40_000 } = {}) {
    this.pace = pace;
    this.panel = panel;
    initialize(dir);
    this.spawner = spawner;
    this.magpie = magpie;
    this.signin = null;
    this.dir = dir;
    this.clientOptions = clientOptions;
    this.hostConfig = hostConfig;
    this.pageFile = pageFile;
    this.board = { at: 0, accounts: [] };
    this.boardStale = true;
    this.state = readJSON(join(dir, "state.json"));
    this.controllers = new Map();
    this.active = 0;
    this.waiters = [];
    this.taskCache = new Map();
    for (const job of this.state.jobs) if (["running", "queued"].includes(job.status)) {
      job.status = "interrupted";
      job.finished = new Date().toISOString();
      for (const row of job.queue || []) if (["queued", "running"].includes(row.status)) row.status = "interrupted";
      job.logs.push({ at: job.finished, message: "服务重启中断了执行；定时任务会在重试窗口补跑" });
    }
    this.save();
  }
  config() {
    const config = readJSON(join(this.dir, "config.json"));
    if (this.hostConfig && !process.env.WORKBUDDY_PLUS_MAGPIE_DIR && config.magpieDir === magpieDir) config.magpieDir = this.hostConfig;
    return settle(config);
  }
  updateConfig(changes) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("设置应为对象");
    const file = join(this.dir, "config.json"), current = settle(readJSON(file));
    const config = validateConfig({ ...current, ...changes }, current);
    writeJSON(file, config);
    this.wake();
    return publicConfig(config);
  }
  // Minutes a slot may move either way; settings from before it have 10.
  spread(config = this.config()) { return Number.isInteger(config.spread) ? config.spread : 10; }
  // The install's own seed for its slot moments, kept with its state.
  salt() { if (!this.state.salt) { this.state.salt = randomUUID(); this.save(); } return this.state.salt; }
  save() { writeJSON(join(this.dir, "state.json"), this.state); }
  list() { return accounts(this.config(), this.dir); }
  status() {
    const config = this.config();
    return { version, config: publicConfig(config), syncPaused: syncView(config.magpieDir)?.paused === true, intlSchedules: intlSchedules(config), intlModels: (this.board.models?.intl?.models || []).map(({ id, name, rate, promo, tier }) => ({ id, name, rate, promo, tier })), accounts: this.list().map(publicAccount), jobs: this.state.jobs.filter(visibleJob), daily: this.state.daily, slots: this.state.slots };
  }
  // A job queued or running: the service must not be swapped out under it.
  working() { return this.controllers.size > 0 || this.state.jobs.some(j => ["running", "queued"].includes(j.status)); }
  // The check-in is read on every publish: Magpie claims it at midnight,
  // between board refreshes.
  boardView() {
    const config = this.config(), found = checkins(config), { day } = calendar(new Date(), config.timezone);
    const sync = syncView(config.magpieDir), syncPaused = sync?.paused === true;
    if (sync?.target) {
      try { sync.choices = syncChoices(readJSON(join(config.magpieDir, "plugin-auth.json")), sync.target); } catch { sync.choices = []; }
    }
    const onDay = value => value && calendar(new Date(value), config.timezone).day === day;
    const network = this.state.network;
    const jobs = [], prizeReminders = [], pastPrizeJobs = [];
    const personal = new Set(this.board.accounts.filter(a => !a.enterprise).map(a => a.id));
    for (const job of this.state.jobs) {
      if (!visibleJob(job)) continue;
      const today = onDay(job.created) || onDay(job.started) || onDay(job.finished);
      const prior = prizeReminders.length;
      for (const entry of job.logs) {
        if ((entry.action !== "bonus" && entry.action !== "all") || !personal.has(entry.account)) continue;
        // Match the persisted v0.7.8 draw log so existing wins still surface.
        const win = entry.message.match(/^成长抽奖 \d+\/\d+：(.+)（实物奖，请到成长中心填写收件信息）$/s);
        if (win) prizeReminders.push({ job: job.id, account: entry.account, at: entry.at, prize: win[1] });
      }
      if (!today && prior === prizeReminders.length) continue;
      const outcome = job.results?.length ? jobOutcome(job.results, job.status === "cancelled") : { status: job.status, counts: job.counts };
      (today ? jobs : pastPrizeJobs).push({ id: job.id, actions: job.actions, ...(job.task ? { task: job.task } : {}), status: ["queued", "running", "interrupted"].includes(job.status) ? job.status : outcome.status, accounts: job.accounts, queue: job.queue, retries: job.retries, retryOf: job.retryOf, attempt: job.attempt, counts: outcome.counts, trigger: job.trigger, created: job.created, started: job.started, finished: job.finished, logs: job.logs });
    }
    return {
      version, generated: new Date().toISOString(), panel: this.panel, at: this.board.at, refreshing: !!this.boarding, enabled: config.enabled && !syncPaused, intlEnabled: config.intlEnabled && !syncPaused, schedules: config.schedules, intlSchedules: intlSchedules(config), sync,
      // What Magpie's page shows in its settings, for installs whose local panel can't be reached (Docker).
      settings: { timezone: config.timezone, spread: this.spread(config), proxy: maskProxy(config.proxy), intlProxy: maskProxy(config.intlProxy || ""), intlWebModel: config.intlWebModel || "auto", intlWeb: config.intlWeb !== false, campaignApp: config.campaignApp === true, skillShare: config.skillShare, buddyAuto: config.buddyAuto === true, concurrency: config.concurrency, tasksCacheTtl: config.tasksCacheTtl, progressCacheHours: config.progressCacheHours },
      accounts: this.board.accounts.map(({ key, ...a }) => {
        const row = this.withLedger(a, key, found, day);
        const restricted = this.state.restricted?.[a.id], webPaused = this.state.webPaused?.[a.id];
        return {
          ...row,
          enabled: !config.disabledAccounts.includes(a.id),
          health: this.accountHealth(a, config, day),
          paused: (config.pausedAccounts || []).includes(a.id),
          ...(restricted?.day === day ? { restricted: { at: restricted.at, message: restricted.message } } : {}),
          ...(webPaused?.day === day ? { webPaused: { at: webPaused.at, message: webPaused.message } } : {})
        };
      }), models: this.board.models || null,
      intl: { enabled: config.intlEnabled && !syncPaused, web: config.intlWeb !== false, accounts: this.board.accounts.filter(a => a.realm === "intl").length }, request: this.state.pageRequest || null, today: this.today(config, new Date(), syncPaused), signin: this.signin,
      networkPaused: network?.pausedUntil > Date.now() ? { until: network.pausedUntil, at: network.last?.at, message: network.last?.message } : null,
      jobs, prizeReminders, pastPrizeJobs
    };
  }
  accountHealth(account, config, day) {
    const rounds = this.state.jobs.filter(job => job.results?.some(r => r.account === account.id)).map(job => ({ job, results: job.results.filter(r => r.account === account.id) }));
    const successful = rounds.find(r => r.results.some(result => result.ok));
    let failures = 0;
    for (const round of rounds) { if (round.results.every(r => r.ok)) break; failures++; }
    const latest = rounds[0], limited = latest?.results.some(r => r.limited), limits = this.state.limits?.[account.id] || {};
    const expires = account.expires, now = Date.now();
    const state = config.disabledAccounts.includes(account.id) ? "disabled" : config.pausedAccounts.includes(account.id) ? "paused"
      : expires && expires <= now ? "expired" : this.state.restricted?.[account.id]?.day === day ? "restricted"
      : limited ? "limited" : Object.values(limits).some(l => l.resets > now) ? "quota" : failures >= 3 ? "failed" : failures ? "attention" : "normal";
    const active = this.state.jobs.flatMap(j => j.queue || []).find(r => r.account === account.id && r.status === "running");
    const next = this.today(config).slots.find(s => s.kind.startsWith("intl-") === (account.realm === "intl") && s.status === "upcoming" && !s.paused);
    return { state, failures, lastSuccess: successful?.results.find(r => r.ok)?.at || successful?.job.finished || successful?.job.started || null, cooldownUntil: Math.max(active?.retryAt || 0, this.state.network?.pausedUntil || 0), next: !account.enterprise && !["disabled", "paused", "restricted"].includes(state) && next ? next.runAt : null };
  }
  // Magpie may load the plugin from a folder other than the one this service
  // runs from (a GitHub install beside the LaunchAgent copy); its page reads
  // only its own folder, so the snapshot goes there too.
  addPageTarget(file) {
    const dir = typeof file === "string" && isAbsolute(file) && basename(file) === "data.js" ? dirname(file) : "";
    let name = "";
    try { name = readJSON(join(dir, "..", "package.json")).name; } catch {}
    if (!dir || basename(dir) !== "page" || name !== "magpie-workbuddy-plus" || !["index.html", "board.js"].every(f => existsSync(join(dir, f)))) throw new Error("不是 WorkBuddy Plus 的页面目录");
    if (file !== this.pageFile) this.state.pageTargets = [file, ...(this.state.pageTargets || []).filter(f => f !== file)].slice(0, 4);
    this.save();
    if (!this.publish().includes(file)) throw new Error("当前页面快照写入失败");
    return { targets: [this.pageFile, ...(this.state.pageTargets || [])].filter(Boolean) };
  }
  // Signing in belongs to Magpie's WorkBuddy plugin; this only starts its
  // browser sign-in, `magpie plugin login workbuddy 1`, which adds the account,
  // or replaces it when that account is already signed in. No token passes
  // through here. One sign-in at a time; the command itself gives up after 10
  // minutes.
  // 添加账号 only points to Magpie's own WorkBuddy plugin: its browser sign-in
  // for China (workbuddy) or WorkBuddy AI (workbuddy-ai). Magpie keeps the login.
  login(realm = "cn") {
    if (this.signin?.status === "waiting") return this.signin;
    if (!["cn", "intl"].includes(realm)) throw new Error("未知的登录版本");
    const bin = this.magpie();
    if (!bin) throw new Error("找不到 magpie 命令，请在 Magpie 的供应商页登录 WorkBuddy");
    const started = new Date().toISOString();
    let out = "";
    const child = this.spawner(bin, ["plugin", "login", realm === "intl" ? "workbuddy-ai" : "workbuddy", "1"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const keep = data => {
      out = (out + data).replace(/\x1b\[[0-9;]*m/g, "").slice(-4000);
      const url = out.match(/https:\/\/\S+/)?.[0];
      if (url && this.signin?.status === "waiting" && !this.signin.url) { this.signin.url = url; this.publish(); }
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const end = (ok, message) => {
      if (this.signin?.started !== started || this.signin.status !== "waiting") return;
      this.signin = { status: ok ? "done" : "failed", realm, started, finished: new Date().toISOString(), ...(message ? { message } : {}) };
      if (ok) { this.boardStale = true; this.refreshBoard().catch(e => console.error(e)); }
      this.publish();
    };
    child.on("error", e => end(false, e.message));
    child.on("exit", code => end(code === 0, code === 0 ? "" : out.trim().split("\n").filter(Boolean).at(-1) || `magpie 退出码 ${code}`));
    this.signin = { status: "waiting", realm, started };
    this.publish();
    return this.signin;
  }

  // Today's slots in time order, each with the job tick() gave it, if any,
  // and runAt, the moment it runs today.
  today(config = this.config(), now = new Date(), syncPaused = syncView(config.magpieDir, +now)?.paused === true) {
    const { day, time } = calendar(now, config.timezone);
    const slots = plan(config).flatMap(({ kind, times, on }) => times.map(at => {
      const record = this.state.slots[`${day}:${kind}:${at}`], job = record && this.state.jobs.find(j => j.id === record.job), runAt = shifted(day, kind, at, this.spread(config), this.salt());
      // The night task only counts 23:00–08:00; past that window a missed slot is gone.
      const status = job ? job.status : runAt > time ? "upcoming" : kind === "night" && time >= "08:00" ? "missed" : "pending";
      return { kind, at, runAt, status, attempts: record?.attempts || 0, ...(on && !syncPaused ? {} : { paused: true }) };
    })).sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));
    return { timezone: config.timezone, spread: this.spread(config), slots, next: slots.find(s => s.status === "upcoming" && !s.paused) || null };
  }
  publish() {
    const view = this.boardView(), targets = this.state.pageTargets || [];
    const written = [], removed = [];
    for (const [index, file] of [...new Set([this.pageFile, ...targets].filter(Boolean))].entries()) {
      try {
        // Don't recreate removed installs. Keep temporarily inaccessible targets for the next publish.
        if (file !== this.pageFile && !statSync(join(dirname(file), "index.html"), { throwIfNoEntry: false })) {
          removed.push(file);
          continue;
        }
        writePage(file, view);
        written.push(file);
      } catch (e) {
        if (!e.syscall || !e.code) throw e;
        console.warn(`[workbuddy-plus] 快照目标 ${index + 1} 写入失败：${e.code}`);
      }
    }
    if (removed.length) { this.state.pageTargets = targets.filter(f => !removed.includes(f)); this.save(); }
    return written;
  }
  refreshBoard(maxAge = 0, ids) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !this.list().some(a => a.id === id)))) throw new Error("账号列表无效");
    if (this.boarding) return this.boarding;
    // A login added or removed in Magpie itself, not through the page, shows
    // at the next beat instead of when the board is next due.
    const shown = this.board.accounts.map(a => a.id).sort().join();
    let current = shown;
    try { current = this.list().map(a => a.id).sort().join(); } catch {}
    if (!this.boardStale && current === shown && Date.now() - this.board.at < maxAge) return Promise.resolve(this.board);
    this.boardStale = false;
    const config = this.config();
    this.boarding = (async () => {
      const list = this.list(), rows = ids?.length ? this.board.accounts.filter(row => !ids.includes(row.id) && list.some(a => a.id === row.id)) : [];
      // What each account's model limits were found to be, kept across refreshes and restarts.
      const memory = this.state.limits ||= {};
      for (const k of Object.keys(memory)) if (!list.some(a => a.id === k)) delete memory[k];
      const fromRouting = routingLimits(config, list);
      for (const [id, found] of Object.entries(fromRouting)) {
        const mine = memory[id] ||= {};
        for (const [model, entry] of Object.entries(found)) {
          if (entry.clear) {
            if (mine[model] && entry.at >= (mine[model].checked || 0)) delete mine[model];
          } else if (!mine[model] || entry.checked >= (mine[model].checked || 0)) mine[model] = entry;
        }
      }
      for (const account of list.filter(a => !ids?.length || ids.includes(a.id))) {
        const row = await collect(account, new WorkBuddyClient(account, config, { gap: 300, ...this.clientOptions, taskCache: this.taskCache }), config, memory[account.id] ||= {});
        // The long cache is display-only, used on a failed read. Execution never
        // trusts it for accepting or claiming tasks.
        const snapshots = this.state.taskSnapshots ||= {};
        if (row.tasks) snapshots[account.id] = { at: Date.now(), tasks: row.tasks };
        else if (row.errors.tasks && snapshots[account.id] && Date.now() - snapshots[account.id].at < config.progressCacheHours * 3600_000) {
          row.tasks = { ...snapshots[account.id].tasks, cachedAt: snapshots[account.id].at };
        }
        rows.push({ ...row, key: account.key });
      }
      for (const id of Object.keys(this.state.taskSnapshots || {})) if (!list.some(a => a.id === id)) delete this.state.taskSnapshots[id];
      this.save();
      // One personal login reads China's list; an enterprise login reads its enterprise's own.
      const models = { at: Date.now() }, china = list.filter(a => a.realm !== "intl"), mine = china.find(a => !a.enterprise), firm = china.find(a => a.enterprise), abroad = intlAccount(config);
      if (firm) {
        try { models.ent = await enterpriseModels(new WorkBuddyClient(firm, config, { gap: 300, ...this.clientOptions })); }
        catch (e) { models.ent = { error: e.message.slice(0, 160) }; }
      }
      if (mine) {
        try { models.cn = await chinaModels(new WorkBuddyClient(mine, config, { gap: 300, ...this.clientOptions })); }
        catch (e) { models.cn = { error: e.message.slice(0, 160) }; }
      }
      if (abroad) {
        try { models.intl = await intlModels(abroad, { proxy: proxyFor(config, "intl"), ...(this.clientOptions.fetcher ? { fetcher: this.clientOptions.fetcher } : {}) }); }
        catch (e) { models.intl = { error: e.message.slice(0, 160) }; }
      }
      this.board = { at: Date.now(), accounts: rows, models };
      return this.board;
    })().finally(() => { this.boarding = null; this.publish(); });
    this.publish();
    return this.boarding;
  }
  // The minute-by-minute read that keeps deductions fresh between the heavier
  // full refreshes. It pulls only the requests since each account's cursor,
  // folds them into state.usage, and rewrites the board's recent list in place
  // — no re-reading balances, travel, tasks or the seven-day paging. A 429 or
  // a refused read parks that account for a few minutes instead of retrying.
  usage_() { return (this.state.usage ||= {}); }
  async heartbeat() {
    if (this.boarding) return this.board; // a full refresh is already reading; skip this beat
    const config = this.config(), board = this.board;
    if (!board?.accounts?.length) return board;
    // The board carries no credentials, so the reads run over the real logins;
    // each is matched back to its board row by id to fold the result on.
    let logins;
    try { logins = this.list(); } catch { return board; }
    const enabled = new Set(logins.filter(a => a.enabled !== false).map(a => a.id));
    const usage = this.usage_(), skipped = this.state.usageSkip ||= {};
    const keyOf = a => String(a.key || a.id);
    const pad5 = t => { const c = calendar(new Date(t - 5 * 60_000), config.timezone); return `${c.day} ${c.time}`; };
    const day7 = new Date(Date.now() - 6 * 86400_000).setHours(0, 0, 0, 0);
    const next = await Promise.all(logins.map(async login => {
      const k = keyOf(login);
      if (!enabled.has(login.id) || Date.now() < (skipped[k] || 0)) return;
      const rec = usage[k] ||= { rows: [], lastAt: "", synced: 0 };
      // A cursor older than an hour, or none at all, starts a fresh window.
      const since = rec.lastAt && Date.now() - rec.synced < 3600_000 ? rec.lastAt : pad5(Date.now());
      try {
        const { rows } = await usageSince(new WorkBuddyClient(login, config, { gap: 300, ...this.clientOptions }), config.timezone, since);
        if (!rows.length) { rec.synced = Date.now(); delete skipped[k]; return; }
        const known = new Set(rec.rows.map(r => r.rid));
        const fresh = rows.filter(r => !known.has(r.rid));
        if (fresh.length) {
          rec.rows = [...fresh.map(({ rid, at, credit, model, client }) => ({ rid, at, credit, ...(model ? { model } : {}), ...(client ? { client } : {}) })), ...rec.rows];
          rec.rows.sort((x, y) => y.at - x.at);
          rec.rows = rec.rows.filter(r => r.at >= day7).slice(0, 500);
          rec.lastAt = rows[0].when || rec.lastAt;
        }
        rec.synced = Date.now();
        delete skipped[k];
      } catch (e) {
        // 429 (or any refusal) parks the account; one stuck login shouldn't
        // keep hammering upstream or drag the rest of the beat down.
        if (/\b429\b|too many|频繁|限流/i.test(String(e?.message || e))) skipped[k] = Date.now() + 5 * 60_000;
        else skipped[k] = Date.now() + 60_000;
      }
    }));
    await Promise.all(next);
    // Fold the merged rows back onto the board's accounts (recent list only).
    let touched = false;
    for (const a of board.accounts) {
      const rec = usage[keyOf(a)];
      if (!rec || !rec.rows.length || !a.usage) continue;
      const keep = (a.usage.recent || []).length || 50;
      const merged = rec.rows.slice(0, Math.max(keep, 10)).map(({ rid, when, ...rest }) => rest);
      // Personal accounts can count their charged requests from the rows.
      if (!a.enterprise) a.usage = { ...a.usage, recent: merged, charges: Math.max(a.usage.charges || 0, rec.rows.length), free: a.usage.free };
      else a.usage = { ...a.usage, recent: merged };
      a.usage.synced = new Date(rec.synced).toISOString();
      touched = true;
    }
    if (touched) { this.board = { ...board, at: board.at }; this.publish(); }
    return this.board;
  }
  // An account as the board shows it: its check-in (Magpie's for China, its
  // own for WorkBuddy AI) and its credit history. The raw grants stay here.
  withLedger({ balance, checkinUpstream, ...a }, key, found, day) {
    const signed = found.records[`workbuddy|${key}`];
    const checkinGrant = signed?.outcome === "claimed" ? { at: Date.parse(signed.claimed || signed.at), credit: Number(signed.credit) } : null;
    const logs = this.state.jobs.flatMap(job => job.accounts.includes(a.id) ? job.logs.filter(l => l.account === a.id) : []);
    const shown = balance ? (({ grants, ...rest }) => rest)(balance) : balance;
    return { ...a, balance: shown, checkin: a.realm === "intl" ? a.checkin : checkin(found, key, day, checkinUpstream, this.config().timezone), ...(balance?.grants ? { ledger: ledger(balance, a.usage, logs, checkinGrant, Date.now(), 7, a.realm) } : {}) };
  }
  // Magpie hands the page's last request back on every plugin restart, so
  // a consecutive repeat only republishes the last receipt.
  pageRequest(request) {
    if (!request?.id) return this.state.pageRequest;
    if (String(request.id) === this.state.pageRequest?.id) {
      this.publish();
      return this.state.pageRequest;
    }
    const note = { id: String(request.id), action: request.action, at: new Date().toISOString(), ok: false };
    try {
      if (!(Date.now() - Number(request.at) < 10 * 60_000)) throw new PageRejection("页面请求已过期");
      if (request.action === "refresh") { this.boardStale = true; this.refreshBoard(0, request.accounts).catch(e => console.error(e)); }
      else if (["login", "login-intl"].includes(request.action)) this.login(request.action === "login-intl" ? "intl" : "cn");
      else if (["pause", "resume"].includes(request.action)) this.updateConfig({ enabled: request.action === "resume" });
      else if (request.action === "config") {
        // The sidebar can edit these settings. Account and schedule switches
        // have their own actions, and the host configuration path stays local.
        const given = request.config || {}, changes = {};
        for (const key of ["schedules", "intlSchedules", "intlWebModel", "timezone"]) if (given[key]) changes[key] = given[key];
        for (const key of ["intlWeb", "campaignApp", "skillShare", "buddyAuto"]) if (typeof given[key] === "boolean") changes[key] = given[key];
        for (const key of ["proxy", "intlProxy", "concurrency", "tasksCacheTtl", "progressCacheHours", "spread"]) if (given[key] !== undefined) changes[key] = given[key];
        this.updateConfig(changes);
      }
      else if (request.action === "retry") note.job = this.retry(request.job).id;
      else if (request.action === "cancel") this.cancel(request.job);
      else if (["pause-tasks", "resume-tasks"].includes(request.action)) {
        const ids = request.accounts;
        if (!Array.isArray(ids) || !ids.length || ids.some(id => !this.list().some(a => a.id === id))) throw new Error("账号不存在");
        const list = new Set(this.config().pausedAccounts);
        for (const id of ids) { if (request.action === "pause-tasks") list.add(id); else list.delete(id); }
        this.updateConfig({ pausedAccounts: [...list] });
      }
      else if (["intl-on", "intl-off"].includes(request.action)) this.updateConfig({ intlEnabled: request.action === "intl-on" });
      else note.job = this.submit([request.action], request.accounts, "page", { task: request.task }).id;
      note.ok = true;
    } catch (e) { note.error = e.message; if (e instanceof PageRejection) note.beforeDispatch = true; }
    this.state.pageRequest = note;
    this.save();
    this.publish();
    return note;
  }
  busy(ids) {
    return this.state.jobs.some(job => ["queued", "running"].includes(job.status) && job.accounts.some(a => ids.includes(a)));
  }
  submit(requestedActions, ids, trigger = "manual", { task, retryOf, accountActions } = {}) {
    if (!Array.isArray(requestedActions) || !requestedActions.length || requestedActions.some(a => !actions.includes(a))) throw new PageRejection("无效的操作");
    if (requestedActions.includes("task") && (typeof task !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(task))) throw new PageRejection("无效的任务");
    const single = requestedActions.includes("task") ? task : undefined;
    const list = this.list().filter(a => a.enabled);
    const selected = ids?.length ? list.filter(a => ids.includes(a.id)) : list;
    if (!selected.length || (ids?.length && selected.length !== new Set(ids).size)) throw new PageRejection("所选账号不存在或已停用");
    if (this.busy(selected.map(a => a.id))) throw new PageRejection("所选账号已有任务正在执行或排队");
    const job = { id: randomUUID(), actions: requestedActions, ...(single ? { task: single } : {}), accounts: selected.map(a => a.id), trigger, status: "queued", created: new Date().toISOString(), logs: [], results: [], retries: [], ...(retryOf ? { retryOf } : {}), queue: selected.map(a => ({ account: a.id, actions: accountActions?.[a.id] || requestedActions, status: "queued", completed: 0, total: (accountActions?.[a.id] || requestedActions).length })) };
    this.state.jobs.unshift(job);
    this.state.jobs = this.state.jobs.filter((j, i) => i < 100 || ["queued", "running"].includes(j.status));
    this.save();
    this.run(job, selected).catch(e => {
      // A persistence/programming failure must remain visible to the process
      // supervisor; normal per-action upstream errors are recorded by run().
      console.error(e);
      process.exit(1);
    });
    return job;
  }
  // One FIFO controls all jobs. Changing the limit affects free slots without
  // interrupting accounts already running; each account's actions stay serial.
  wake() {
    const limit = this.config().concurrency;
    while (this.active < limit && this.waiters.length) {
      const next = this.waiters.shift();
      next.signal.removeEventListener("abort", next.abort);
      this.active++;
      next.resolve(true);
    }
  }
  acquire(signal) {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const entry = { signal, resolve, abort: () => {
        this.waiters.splice(this.waiters.indexOf(entry), 1);
        resolve(false);
      } };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.waiters.push(entry);
      this.wake();
    });
  }
  retry(id) {
    const previous = this.state.jobs.find(j => j.id === id);
    if (!previous || !["failed", "partial", "deferred", "interrupted"].includes(previous.status)) throw new PageRejection("没有需要重试的操作");
    const accountActions = {};
    for (const account of previous.accounts) {
      const failures = previous.results.filter(r => r.account === account && !r.ok).map(r => r.action);
      const pending = previous.queue?.find(r => r.account === account);
      if (pending && ["interrupted", "queued"].includes(pending.status)) failures.push(...pending.actions.filter(action => !previous.results.some(r => r.account === account && r.action === action && r.ok)));
      if (failures.length || previous.status === "interrupted") accountActions[account] = [...new Set(failures.length ? failures : previous.actions)];
    }
    const ids = Object.keys(accountActions);
    if (!ids.length) throw new PageRejection("没有需要重试的操作");
    return this.submit([...new Set(Object.values(accountActions).flat())], ids, "manual", { task: previous.task, retryOf: previous.id, accountActions });
  }
  async run(job, list) {
    const controller = new AbortController(), round = { stop: false };
    this.controllers.set(job.id, controller);
    const pending = [];
    for (const [index, snapshot] of list.entries()) {
      if (index && job.trigger.startsWith("schedule:") && this.spread() > 0) {
        try { await delay(this.pace(), undefined, { signal: controller.signal }); }
        catch (e) { if (!controller.signal.aborted) throw e; break; }
      }
      if (round.stop || controller.signal.aborted) break;
      pending.push(this.runAccount(job, snapshot, controller, round));
    }
    await Promise.all(pending);
    for (const row of job.queue) if (row.status === "queued") row.status = controller.signal.aborted ? "cancelled" : "interrupted";
    const outcome = jobOutcome(job.results, controller.signal.aborted);
    job.status = outcome.status;
    job.counts = outcome.counts;
    job.finished = new Date().toISOString();
    this.controllers.delete(job.id);
    this.boardStale = true;
    this.save();
    this.publish();
  }
  async runAccount(job, snapshot, controller, round) {
    const row = job.queue.find(r => r.account === snapshot.id);
    const acquired = await this.acquire(controller.signal);
    if (!acquired) { row.status = "cancelled"; return; }
    try {
      if (controller.signal.aborted || round.stop) { row.status = controller.signal.aborted ? "cancelled" : "interrupted"; return; }
      const config = this.config();
      const scheduled = job.trigger.startsWith("schedule:");
      if (scheduled && syncView(config.magpieDir)?.paused) { row.status = "interrupted"; return; }
      const account = this.list().find(a => a.id === snapshot.id);
      if (!account || !account.enabled || account.paused) { row.status = account?.paused ? "paused" : "skipped"; return; }
      if (this.state.taskSnapshots) delete this.state.taskSnapshots[account.id];
      row.status = "running";
      row.started = new Date().toISOString();
      job.status = "running";
      job.started ||= row.started;
      this.save(); this.publish();
      // Real refusals during this run are remembered for the board.
      const remembered = (this.state.limits ||= {})[account.id] ||= {};
      const client = new WorkBuddyClient(account, config, { ...this.clientOptions, signal: controller.signal, limits: remembered, taskCache: this.taskCache, onRetry: event => {
        job.retries.push({ ...event, account: account.id, action: row.action });
        job.retries = job.retries.slice(-500);
        row.retryAt = event.waitMs ? Date.parse(event.at) + event.waitMs : 0;
        this.save(); this.publish();
      } });
      const log = (message, level = "info") => {
        row.message = message;
        job.logs.push({ at: new Date().toISOString(), account: account.id, message, channel: logChannel(row.action), level, action: row.action });
        job.logs = job.logs.slice(-500);
        this.save(); this.publish();
      };
      // WorkBuddy AI's model list picks the web conversation's model.
      const context = { account, config, state: this.state, trigger: job.trigger, task: job.task, log, checkpoint: () => this.save(), signal: controller.signal, ...(account.realm === "intl" ? { models: this.board.models?.intl } : {}) };
      for (const action of row.actions) {
        if (controller.signal.aborted) break;
        if (scheduled && syncView(config.magpieDir)?.paused) { row.status = "paused"; log("账号同步已暂停定时，跳过后续操作"); break; }
        if (this.list().find(a => a.id === account.id)?.paused) { row.status = "paused"; log("任务已暂停，跳过后续操作"); break; }
        row.action = action; row.retryAt = 0;
        log(`开始${actionNames[action]}`);
        const result = { account: account.id, action, ok: false };
        let stop = false;
        try {
          result.data = await perform(action, client, context);
          result.ok = true;
          if (job.trigger === "manual" && this.state.restricted?.[account.id]) {
            delete this.state.restricted[account.id];
            this.save();
            log("账号限制标记已清除");
          }
          if (this.state.network) {
            this.state.network.failures = 0;
            if (this.state.network.pausedUntil) {
              delete this.state.network.pausedUntil;
              delete this.state.network.last;
              log("网络/代理已恢复，自动任务暂停已解除");
            }
          }
        } catch (e) {
          if (controller.signal.aborted) break;
          result.error = e.message;
          result.limited = !!e.limited;
          if (e.partial) { result.partial = true; result.counts = e.counts; }
          if (dropped(e)) {
            result.network = true;
            const network = this.state.network ||= { failures: 0 };
            network.failures = (network.failures || 0) + 1;
            network.last = { at: new Date().toISOString(), message: e.message.slice(0, 240), ...(e.diagnostic ? { diagnostic: String(e.diagnostic).slice(0, 240) } : {}) };
            if (network.failures >= NETWORK_FAILURES) {
              network.pausedUntil = Date.now() + NETWORK_PAUSE_MS;
              network.failures = 0;
              log(`网络/代理连续失败 ${NETWORK_FAILURES} 次，自动任务暂停到 ${calendar(new Date(network.pausedUntil), config.timezone).time}；手动执行仍可`, "error");
            } else {
              log(`${actionNames[action]}网络/代理失败（${network.failures}/${NETWORK_FAILURES}）：${e.message}${e.diagnostic ? `（${e.diagnostic}）` : ""}`, "error");
            }
            this.save();
            stop = true;
            round.stop = true;
          } else if (e.restricted) {
            result.restricted = true;
            this.state.restricted ||= {};
            this.state.restricted[account.id] = { day: job.day || calendar(new Date(job.started), config.timezone).day, at: new Date().toISOString(), message: e.message.slice(0, 240) };
            this.save();
            log(`${actionNames[action]}被上游限制：${e.message}；今天暂停这个账号的自动任务`, "error");
            stop = true;
          } else log(`${action} ${e.partial ? "部分失败" : e.limited ? "被限流" : "失败"}：${e.message}`, "error");
        }
        result.at = new Date().toISOString();
        job.results.push(result);
        row.completed++;
        if (result.ok) log(`${actionNames[action]}已完成`);
        this.save(); this.publish();
        if (stop) break;
      }
      if (row.status !== "paused") row.status = controller.signal.aborted ? "cancelled" : row.completed < row.total ? "interrupted" : jobOutcome(job.results.filter(r => r.account === account.id)).status;
      row.finished = new Date().toISOString();
      row.retryAt = 0;
    } finally {
      this.active--;
      this.save(); this.publish();
      this.wake();
    }
  }
  cancel(id) {
    const controller = this.controllers.get(id);
    if (!controller) throw new Error("该执行记录未在运行");
    controller.abort(new Error("用户停止了执行"));
  }
  tick(now = new Date()) {
    const config = this.config();
    if (syncView(config.magpieDir, +now)?.paused) return;
    const { day, time } = calendar(now, config.timezone);
    if (this.state.network?.pausedUntil > now.getTime()) return;
    if (this.state.network?.pausedUntil) {
      delete this.state.network.pausedUntil;
      this.save();
    }
    // Each build keeps its own slots for personal accounts.
    for (const { kind, times, realm, actions: group, on } of plan(config)) {
      if (!on) continue;
      const ids = this.list().filter(a => a.enabled && !a.paused && !a.enterprise && a.realm === realm && this.state.restricted?.[a.id]?.day !== day).map(a => a.id);
      if (!ids.length || this.busy(ids)) continue;
      for (const slot of times) {
        if (shifted(day, kind, slot, this.spread(config), this.salt()) > time) continue;
        // A late wake-up at noon cannot make the 01:00 night event count.
        if (kind === "night" && time >= "08:00" && time < "23:00") continue;
        const key = `${day}:${kind}:${slot}`;
        const previous = this.state.slots[key];
        if (previous) {
          const old = this.state.jobs.find(j => j.id === previous.job);
          if (old && !["failed", "partial", "deferred", "interrupted"].includes(old.status)) continue;
          if (previous.attempts >= 3 || (old && now - new Date(old.finished) < 15 * 60_000)) continue;
        }
        const job = this.submit(group, ids, `schedule:${kind}:${slot}`);
        job.day = day;
        job.attempt = (previous?.attempts || 0) + 1;
        if (previous) job.retryOf = previous.job;
        this.state.slots[key] = { job: job.id, attempts: (previous?.attempts || 0) + 1 };
        // Retain a week of slot/event deduplication, rather than an unbounded ledger.
        const cutoff = calendar(new Date(now - 7 * 86400_000), config.timezone).day;
        for (const k of Object.keys(this.state.slots)) if (k.slice(0, 10) < cutoff) delete this.state.slots[k];
        for (const k of Object.keys(this.state.reports)) if (k.slice(-10) < cutoff) delete this.state.reports[k];
        this.save();
        break;
      }
    }
  }
}
