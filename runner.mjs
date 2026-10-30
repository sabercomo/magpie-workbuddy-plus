import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { accounts, calendar, initialize, publicAccount, readJSON, writeJSON } from "./storage.mjs";
import { WorkBuddyClient } from "./client.mjs";
import { actions, perform } from "./engine.mjs";
import { collect, writePage } from "./board.mjs";

// A LaunchAgent's PATH is only the system's, so the usual install places
// (Magpie's own ~/.local/bin link, Homebrew, the app) are looked in too.
export function magpieBin(env = process.env) {
  const places = [env.WORKBUDDY_PLUS_MAGPIE_BIN, ...(env.PATH || "").split(delimiter).filter(Boolean).map(d => join(d, "magpie")),
    join(homedir(), ".local", "bin", "magpie"), "/opt/homebrew/bin/magpie", "/usr/local/bin/magpie", "/Applications/magpie.app/Contents/MacOS/magpie"];
  return places.find(f => f && existsSync(f)) || "";
}

export class Runner {
  constructor(dir, clientOptions = {}, { pageFile, spawner = spawn, magpie = magpieBin } = {}) {
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
  config() { return readJSON(join(this.dir, "config.json")); }
  save() { writeJSON(join(this.dir, "state.json"), this.state); }
  list() { return accounts(this.config(), this.dir); }
  status() {
    return { config: this.config(), accounts: this.list().map(publicAccount), jobs: this.state.jobs, daily: this.state.daily, slots: this.state.slots };
  }
  boardView() {
    const config = this.config();
    return {
      generated: new Date().toISOString(), at: this.board.at, refreshing: !!this.boarding, enabled: config.enabled, schedules: config.schedules,
      accounts: this.board.accounts, request: this.state.pageRequest || null, today: this.today(config), signin: this.signin,
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
  login() {
    if (this.signin?.status === "waiting") return this.signin;
    const bin = this.magpie();
    if (!bin) throw new Error("找不到 magpie 命令，请在 Magpie 的供应商页登录 WorkBuddy");
    const started = new Date().toISOString();
    let out = "";
    const child = this.spawner(bin, ["plugin", "login", "workbuddy", "1"], { stdio: ["ignore", "pipe", "pipe"] });
    const keep = data => {
      out = (out + data).replace(/\x1b\[[0-9;]*m/g, "").slice(-4000);
      const url = out.match(/https:\/\/\S+/)?.[0];
      if (url && this.signin?.status === "waiting" && !this.signin.url) { this.signin.url = url; this.publish(); }
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const end = (ok, message) => {
      if (this.signin?.started !== started || this.signin.status !== "waiting") return;
      this.signin = { status: ok ? "done" : "failed", started, finished: new Date().toISOString(), ...(message ? { message } : {}) };
      if (ok) { this.boardStale = true; this.refreshBoard().catch(e => console.error(e)); }
      this.publish();
    };
    child.on("error", e => end(false, e.message));
    child.on("exit", code => end(code === 0, code === 0 ? "" : out.trim().split("\n").filter(Boolean).at(-1) || `magpie 退出码 ${code}`));
    this.signin = { status: "waiting", started };
    this.publish();
    return this.signin;
  }

  // Today's slots in time order, each with the job tick() gave it, if any.
  today(config = this.config(), now = new Date()) {
    const { day, time } = calendar(now, config.timezone);
    const slots = Object.entries(config.schedules).flatMap(([kind, times]) => times.map(at => {
      const record = this.state.slots[`${day}:${kind}:${at}`], job = record && this.state.jobs.find(j => j.id === record.job);
      // The night task only counts 23:00–08:00; past that window a missed slot is gone.
      const status = job ? job.status : at > time ? "upcoming" : kind === "night" && time >= "08:00" ? "missed" : "pending";
      return { kind, at, status, attempts: record?.attempts || 0 };
    })).sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));
    return { timezone: config.timezone, slots, next: config.enabled ? slots.find(s => s.status === "upcoming") || null : null };
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
    if (!this.boardStale && Date.now() - this.board.at < maxAge) return Promise.resolve(this.board);
    this.boardStale = false;
    const config = this.config();
    this.boarding = (async () => {
      const rows = [];
      for (const account of this.list()) rows.push(await collect(account, new WorkBuddyClient(account, config, { gap: 300, ...this.clientOptions }), config));
      this.board = { at: Date.now(), accounts: rows };
      return this.board;
    })().finally(() => { this.boarding = null; this.publish(); });
    this.publish();
    return this.boarding;
  }
  // Magpie hands the page's last request back on every plugin restart, so
  // each request id runs once and an old one is only acknowledged.
  pageRequest(request) {
    if (!request?.id || String(request.id) === this.state.pageRequest?.id) return this.state.pageRequest;
    const note = { id: String(request.id), action: request.action, at: new Date().toISOString(), ok: false };
    try {
      if (!(Date.now() - Number(request.at) < 10 * 60_000)) throw new Error("页面请求已过期，请重新点击");
      if (request.action === "refresh") { this.boardStale = true; this.refreshBoard().catch(e => console.error(e)); }
      else if (request.action === "login") this.login();
      else if (["pause", "resume"].includes(request.action)) writeJSON(join(this.dir, "config.json"), { ...this.config(), enabled: request.action === "resume" });
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
    for (const snapshot of list) {
      const config = this.config();
      const account = this.list().find(a => a.id === snapshot.id);
      const client = new WorkBuddyClient(account, config, { ...this.clientOptions, signal: controller.signal });
      const log = message => {
        job.logs.push({ at: new Date().toISOString(), account: account.id, message });
        job.logs = job.logs.slice(-500);
        this.save();
      };
      const context = { account, config, state: this.state, log, checkpoint: () => this.save(), signal: controller.signal };
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
    if (!config.enabled) return;
    const { day, time } = calendar(now, config.timezone);
    const groups = {
      daily: { realm: "cn", actions: ["activity", "travel", "bonus"] },
      tasks: { realm: "cn", actions: ["tasks"] },
      night: { realm: "cn", actions: ["night"] },
      keepalive: { actions: ["keepalive"] }
    };
    for (const [kind, times] of Object.entries(config.schedules)) {
      const group = groups[kind];
      const ids = this.list().filter(a => a.enabled && (!group.realm || a.realm === group.realm) && (kind === "keepalive" || !a.enterprise)).map(a => a.id);
      if (!ids.length || this.busy(ids)) continue;
      for (const slot of times) {
        if (slot > time) continue;
        // A late wake-up at noon cannot make the 01:00 night event count.
        if (kind === "night" && time >= "08:00" && time < "23:00") continue;
        const key = `${day}:${kind}:${slot}`;
        const previous = this.state.slots[key];
        if (previous) {
          const old = this.state.jobs.find(j => j.id === previous.job);
          if (old && !["failed", "deferred", "interrupted"].includes(old.status)) continue;
          if (previous.attempts >= 3 || (old && now - new Date(old.finished) < 15 * 60_000)) continue;
        }
        const job = this.submit(group.actions, ids, `schedule:${kind}:${slot}`);
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
