import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { accounts, calendar, initialize, publicAccount, readJSON, writeJSON } from "./storage.mjs";
import { WorkBuddyClient } from "./client.mjs";
import { actions, perform } from "./engine.mjs";

export class Runner {
  constructor(dir, clientOptions = {}) {
    initialize(dir);
    this.dir = dir;
    this.clientOptions = clientOptions;
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
        } catch (e) { result.error = e.message; log(`${action} 失败：${e.message}`); }
        job.results.push(result);
        this.save();
      }
      if (controller.signal.aborted) break;
    }
    job.status = controller.signal.aborted ? "cancelled" : job.results.every(r => r.ok) ? "succeeded" : "failed";
    job.finished = new Date().toISOString();
    this.controllers.delete(job.id);
    this.save();
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
      daily: { realm: "cn", actions: ["checkin", "activity", "travel", "bonus"] },
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
          if (old && !["failed", "interrupted"].includes(old.status)) continue;
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
