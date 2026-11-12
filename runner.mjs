import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { accounts, calendar, checkins, initialize, intlAccount, intlSchedules, maskProxy, plan, publicAccount, readJSON, settle, validateConfig, version, writeJSON } from "./storage.mjs";
import { WorkBuddyClient } from "./client.mjs";
import { actions, perform } from "./engine.mjs";
import { checkin, collect, writePage } from "./board.mjs";
import { ledger } from "./history.mjs";
import { chinaModels, enterpriseModels, intlModels } from "./models.mjs";

// A LaunchAgent's PATH is only the system's, so the usual install places
// (Magpie's own ~/.local/bin link, Homebrew, the app) are looked in too. On
// Windows the command is magpie.com (the console build beside magpie.exe),
// which Magpie's installer puts in %LOCALAPPDATA%\Programs\Magpie, off the PATH.
export function magpieBin(env = process.env) {
  const names = process.platform === "win32" ? ["magpie.com", "magpie.exe"] : ["magpie"];
  const dirs = [...(env.PATH || "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/Applications/magpie.app/Contents/MacOS",
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Programs", "Magpie")] : [])];
  const places = [env.WORKBUDDY_PLUS_MAGPIE_BIN, ...dirs.flatMap(d => names.map(name => join(d, name)))];
  return places.find(f => f && existsSync(f)) || "";
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

export class Runner {
  // pace: the wait between accounts in a scheduled run, 5–45 s.
  constructor(dir, clientOptions = {}, { pageFile, panel = "", spawner = spawn, magpie = magpieBin, pace = () => 5000 + Math.random() * 40_000 } = {}) {
    this.pace = pace;
    this.panel = panel;
    initialize(dir);
    this.spawner = spawner;
    this.magpie = magpie;
    this.signin = null;
    this.dir = dir;
    this.clientOptions = clientOptions;
    this.pageFile = pageFile;
    this.board = { at: 0, accounts: [] };
    this.boardStale = true;
    this.state = readJSON(join(dir, "state.json"));
    this.controllers = new Map();
    for (const job of this.state.jobs) if (["running", "queued"].includes(job.status)) {
      job.status = "interrupted";
      job.finished = new Date().toISOString();
      job.logs.push({ at: job.finished, message: "服务重启中断了执行；定时任务会在重试窗口补跑" });
    }
    this.save();
  }
  config() { return settle(readJSON(join(this.dir, "config.json"))); }
  // Minutes a slot may move either way; settings from before it have 10.
  spread(config = this.config()) { return Number.isInteger(config.spread) ? config.spread : 10; }
  // The install's own seed for its slot moments, kept with its state.
  salt() { if (!this.state.salt) { this.state.salt = randomUUID(); this.save(); } return this.state.salt; }
  save() { writeJSON(join(this.dir, "state.json"), this.state); }
  list() { return accounts(this.config(), this.dir); }
  status() {
    const config = this.config();
    return { version, config, intlSchedules: intlSchedules(config), intlModels: (this.board.models?.intl?.models || []).map(({ id, name, rate, promo, tier }) => ({ id, name, rate, promo, tier })), accounts: this.list().map(publicAccount), jobs: this.state.jobs, daily: this.state.daily, slots: this.state.slots };
  }
  // A job queued or running: the service must not be swapped out under it.
  working() { return this.controllers.size > 0 || this.state.jobs.some(j => ["running", "queued"].includes(j.status)); }
  // The check-in is read on every publish: Magpie claims it at midnight,
  // between board refreshes.
  boardView() {
    const config = this.config(), found = checkins(config), { day } = calendar(new Date(), config.timezone);
    return {
      generated: new Date().toISOString(), panel: this.panel, at: this.board.at, refreshing: !!this.boarding, enabled: config.enabled, intlEnabled: config.intlEnabled, schedules: config.schedules, intlSchedules: intlSchedules(config),
      // What Magpie's page shows in its settings, for installs whose local panel can't be reached (Docker).
      settings: { timezone: config.timezone, spread: this.spread(config), proxy: maskProxy(config.proxy), intlWebModel: config.intlWebModel || "auto", intlWeb: config.intlWeb !== false },
      accounts: this.board.accounts.map(({ key, ...a }) => this.withLedger(a, key, found, day)), models: this.board.models || null,
      intl: { enabled: config.intlEnabled, web: config.intlWeb !== false, accounts: this.board.accounts.filter(a => a.realm === "intl").length }, request: this.state.pageRequest || null, today: this.today(config), signin: this.signin,
      jobs: this.state.jobs.slice(0, 6).map(j => ({ id: j.id, actions: j.actions, status: j.status, trigger: j.trigger, created: j.created, finished: j.finished, last: j.logs.at(-1)?.message || "" }))
    };
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
    this.publish();
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
  today(config = this.config(), now = new Date()) {
    const { day, time } = calendar(now, config.timezone);
    const slots = plan(config).flatMap(({ kind, times, on }) => times.map(at => {
      const record = this.state.slots[`${day}:${kind}:${at}`], job = record && this.state.jobs.find(j => j.id === record.job), runAt = shifted(day, kind, at, this.spread(config), this.salt());
      // The night task only counts 23:00–08:00; past that window a missed slot is gone.
      const status = job ? job.status : runAt > time ? "upcoming" : kind === "night" && time >= "08:00" ? "missed" : "pending";
      return { kind, at, runAt, status, attempts: record?.attempts || 0, ...(on ? {} : { paused: true }) };
    })).sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));
    return { timezone: config.timezone, spread: this.spread(config), slots, next: slots.find(s => s.status === "upcoming" && !s.paused) || null };
  }
  publish() {
    const view = this.boardView(), targets = this.state.pageTargets || [];
    if (this.pageFile) writePage(this.pageFile, view);
    // A removed plugin's folder is left removed, not recreated.
    const live = targets.filter(f => existsSync(join(dirname(f), "index.html")));
    for (const f of live) if (f !== this.pageFile) writePage(f, view);
    if (live.length !== targets.length) { this.state.pageTargets = live; this.save(); }
  }
  refreshBoard(maxAge = 0) {
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
      const rows = [], list = this.list();
      // What each account's model limits were found to be, kept across refreshes and restarts.
      const memory = this.state.limits ||= {};
      for (const k of Object.keys(memory)) if (!list.some(a => a.id === k)) delete memory[k];
      for (const account of list) rows.push({ ...await collect(account, new WorkBuddyClient(account, config, { gap: 300, ...this.clientOptions }), config, memory[account.id] ||= {}), key: account.key });
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
        try { models.intl = await intlModels(abroad, { proxy: config.proxy, ...(this.clientOptions.fetcher ? { fetcher: this.clientOptions.fetcher } : {}) }); }
        catch (e) { models.intl = { error: e.message.slice(0, 160) }; }
      }
      this.board = { at: Date.now(), accounts: rows, models };
      return this.board;
    })().finally(() => { this.boarding = null; this.publish(); });
    this.publish();
    return this.boarding;
  }
  // An account as the board shows it: its check-in (Magpie's for China, its
  // own for WorkBuddy AI) and its credit history, the grants named from this
  // plugin's run logs and Magpie's check-in time. The raw grants stay here.
  withLedger({ balance, ...a }, key, found, day) {
    const signed = found.records[`workbuddy|${key}`], at = signed?.outcome === "claimed" ? Date.parse(signed.claimed || signed.at) : 0;
    const logs = this.state.jobs.flatMap(job => job.accounts.includes(a.id) ? job.logs.filter(l => l.account === a.id) : []);
    const shown = balance ? (({ grants, ...rest }) => rest)(balance) : balance;
    return { ...a, balance: shown, checkin: a.realm === "intl" ? a.checkin : checkin(found, key, day), ...(balance?.grants ? { ledger: ledger(balance, a.usage, logs, at, Date.now(), 7, a.realm) } : {}) };
  }
  // Magpie hands the page's last request back on every plugin restart, so
  // each request id runs once and an old one is only acknowledged.
  pageRequest(request) {
    if (!request?.id || String(request.id) === this.state.pageRequest?.id) return this.state.pageRequest;
    const note = { id: String(request.id), action: request.action, at: new Date().toISOString(), ok: false };
    try {
      if (!(Date.now() - Number(request.at) < 10 * 60_000)) throw new Error("页面请求已过期，请重新点击");
      if (request.action === "refresh") { this.boardStale = true; this.refreshBoard().catch(e => console.error(e)); }
      else if (["login", "login-intl"].includes(request.action)) this.login(request.action === "login-intl" ? "intl" : "cn");
      else if (["pause", "resume"].includes(request.action)) writeJSON(join(this.dir, "config.json"), { ...this.config(), enabled: request.action === "resume" });
      else if (request.action === "config") {
        // Settings saved from Magpie's page: times, spread, time zone, proxy,
        // the web conversation and model-limit switches. A
        // proxy shown masked and sent back unchanged keeps the saved one.
        const current = this.config(), given = request.config || {};
        const next = { ...current, ...(given.schedules ? { schedules: given.schedules } : {}), ...(given.intlSchedules ? { intlSchedules: given.intlSchedules } : {}), ...(given.intlWebModel ? { intlWebModel: given.intlWebModel } : {}), ...(typeof given.intlWeb === "boolean" ? { intlWeb: given.intlWeb } : {}), ...(given.spread !== undefined ? { spread: given.spread } : {}), ...(given.timezone ? { timezone: given.timezone } : {}),
          ...(given.proxy !== undefined && given.proxy !== maskProxy(current.proxy) ? { proxy: given.proxy } : {}) };
        writeJSON(join(this.dir, "config.json"), validateConfig(next));
      }
      else if (["intl-on", "intl-off"].includes(request.action)) writeJSON(join(this.dir, "config.json"), { ...this.config(), intlEnabled: request.action === "intl-on" });
      else note.job = this.submit([request.action], undefined, "page").id;
      note.ok = true;
    } catch (e) { note.error = e.message; }
    this.state.pageRequest = note;
    this.save();
    this.publish();
    return note;
  }
  busy(ids) {
    return this.state.jobs.some(job => ["queued", "running"].includes(job.status) && job.accounts.some(a => ids.includes(a)));
  }
  submit(requestedActions, ids, trigger = "manual") {
    if (!Array.isArray(requestedActions) || !requestedActions.length || requestedActions.some(a => !actions.includes(a))) throw new Error("无效的操作");
    const list = this.list().filter(a => a.enabled);
    const selected = ids?.length ? list.filter(a => ids.includes(a.id)) : list;
    if (!selected.length || (ids?.length && selected.length !== new Set(ids).size)) throw new Error("所选账号不存在或已停用");
    if (this.busy(selected.map(a => a.id))) throw new Error("所选账号已有任务正在执行或排队");
    const job = { id: randomUUID(), actions: requestedActions, accounts: selected.map(a => a.id), trigger, status: "queued", created: new Date().toISOString(), logs: [], results: [] };
    this.state.jobs.unshift(job);
    this.state.jobs = this.state.jobs.slice(0, 100);
    this.save();
    this.run(job, selected).catch(e => {
      // A persistence/programming failure must remain visible to the process
      // supervisor; normal per-action upstream errors are recorded by run().
      console.error(e);
      process.exit(1);
    });
    return job;
  }
  async run(job, list) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = "running";
    job.started = new Date().toISOString();
    this.save();
    this.publish();
    for (const [index, snapshot] of list.entries()) {
      // A scheduled run doesn't reach WorkBuddy for every account in the same second.
      if (index && job.trigger.startsWith("schedule:") && this.spread() > 0) {
        try { await delay(this.pace(), undefined, { signal: controller.signal }); } catch { break; }
      }
      const config = this.config();
      const account = this.list().find(a => a.id === snapshot.id);
      // Real refusals during this run are remembered for the board.
      const remembered = (this.state.limits ||= {})[account.id] ||= {};
      const client = new WorkBuddyClient(account, config, { ...this.clientOptions, signal: controller.signal, limits: remembered });
      const log = message => {
        job.logs.push({ at: new Date().toISOString(), account: account.id, message });
        job.logs = job.logs.slice(-500);
        this.save();
      };
      // WorkBuddy AI's model list picks the web conversation's model.
      const context = { account, config, state: this.state, trigger: job.trigger, log, checkpoint: () => this.save(), signal: controller.signal, ...(account.realm === "intl" ? { models: this.board.models?.intl } : {}) };
      for (const action of job.actions) {
        if (controller.signal.aborted) break;
        const result = { account: account.id, action, ok: false };
        try {
          result.data = await perform(action, client, context);
          result.ok = true;
        } catch (e) { result.error = e.message; result.limited = !!e.limited; log(`${action} ${e.limited ? "被限流" : "失败"}：${e.message}`); }
        job.results.push(result);
        this.save();
      }
      if (controller.signal.aborted) break;
    }
    const failed = job.results.filter(r => !r.ok);
    job.status = controller.signal.aborted ? "cancelled" : !failed.length ? "succeeded" : failed.every(r => r.limited) ? "deferred" : "failed";
    job.finished = new Date().toISOString();
    this.controllers.delete(job.id);
    this.boardStale = true;
    this.save();
    this.publish();
  }
  cancel(id) {
    const controller = this.controllers.get(id);
    if (!controller) throw new Error("该执行记录未在运行");
    controller.abort(new Error("用户停止了执行"));
  }
  tick(now = new Date()) {
    const config = this.config();
    const { day, time } = calendar(now, config.timezone);
    // Each build keeps its own slots; enterprise logins only renew theirs.
    for (const { kind, times, realm, actions: group, on } of plan(config)) {
      if (!on) continue;
      const ids = this.list().filter(a => a.enabled && a.realm === realm && (group.includes("keepalive") || !a.enterprise)).map(a => a.id);
      if (!ids.length || this.busy(ids)) continue;
      for (const slot of times) {
        if (shifted(day, kind, slot, this.spread(config), this.salt()) > time) continue;
        // A late wake-up at noon cannot make the 01:00 night event count.
        if (kind === "night" && time >= "08:00" && time < "23:00") continue;
        const key = `${day}:${kind}:${slot}`;
        const previous = this.state.slots[key];
        if (previous) {
          const old = this.state.jobs.find(j => j.id === previous.job);
          if (old && !["failed", "deferred", "interrupted"].includes(old.status)) continue;
          if (previous.attempts >= 3 || (old && now - new Date(old.finished) < 15 * 60_000)) continue;
        }
        const job = this.submit(group, ids, `schedule:${kind}:${slot}`);
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
