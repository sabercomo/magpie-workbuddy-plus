import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeJSON } from "../storage.mjs";
import { accountSnapshotVersion, clearImported, collectWorkBuddy, mergeForFollower, readAuthFile, validAccounts, validClearedAccounts, writeAuthFile } from "./auth-store.mjs";
import { remoteIdentity, transport } from "./config.mjs";
import { openData, sealData } from "./crypto.mjs";
import { acquireEngineLock } from "./engine-lock.mjs";
import { GitHubContents } from "./github.mjs";
import { S3Contents, WebDAVContents } from "./object-store.mjs";
import { syncPresence } from "./presence.mjs";
import { configPath, resultPath, roles, syncConfig, syncResult, uuid } from "./view.mjs";

const leaseMs = 10 * 60_000, renewMs = 3 * 60_000, pollMs = 30_000;
const requestMs = 10 * 60_000;
const stores = { github: GitHubContents, webdav: WebDAVContents, s3: S3Contents };
const storeFor = (config, signal) => new stores[config.kind]({ ...config, signal });

function validSnapshot(data) {
  const lease = data?.lease;
  if (!uuid(lease?.owner) || !Number.isSafeInteger(lease.until) ||
      !Number.isSafeInteger(data.generation) || data.generation <= 0) return false;
  // Version 3 is the explicit empty snapshot: an older follower only knows 1
  // and 2, so it rejects the clear instead of keeping a revoked account.
  if (data.version === 3) return data.cleared === true && validClearedAccounts(data.accounts);
  if (data.cleared !== undefined) return false;
  return [1, 2].includes(data.version) && validAccounts(data.accounts, data.version);
}

export async function syncOnce(dir, config, { now = Date.now, storeFactory = storeFor, state } = {}) {
  if (config.role !== "master" && config.role !== "follower") return { code: "off" };
  const remote = transport(dir);
  if (!remote) return { code: "unconfigured" };
  const authFile = join(dir, "plugin-auth.json");
  const cleared = config.role === "master" && config.cleared === true && config.picks.length === 0;
  let own = null;
  if (config.role === "master") {
    own = cleared ? {} : collectWorkBuddy(await readAuthFile(authFile), config.picks, config.machine);
    if (!cleared && !Object.keys(own).length) return { code: "missing" };
  }
  const signal = AbortSignal.timeout(80_000);
  const store = await storeFactory(remote, signal);
  await store.checkPrivate(remote.path);
  const latest = await store.read(remote.path);
  const prior = latest ? await openData(latest.data, remote.passphrase) : null;
  if (latest && !validSnapshot(prior)) throw new Error("Invalid synchronized accounts snapshot");
  const time = now();
  const remoteKey = remoteIdentity(remote);
  const remembered = state?.remoteKey === remoteKey ? state : null;
  const observe = async (result, snapshot = prior) => {
    const applied = result.generation ?? remembered?.generation;
    const heartbeat = config.role === "follower" ? (Number.isSafeInteger(applied) && applied > 0 ? applied : 0) : null;
    const previous = remembered?.presence;
    // Diagnostics never decide who owns the lease or whether an apply succeeded.
    let presence;
    try {
      const diagnostics = await storeFactory(remote, AbortSignal.any([signal, AbortSignal.timeout(6000)]));
      presence = await syncPresence(diagnostics, remote.path, config.machine, time, heartbeat, previous);
    } catch { presence = { ...previous, unavailable: true }; }
    const lease = snapshot?.lease;
    return {
      ...result, remoteKey, presence,
      ...(lease ? { snapshot: { owner: lease.owner, until: lease.until, seen: lease.until - leaseMs, generation: snapshot.generation } } : {})
    };
  };
  if (config.role === "follower") {
    if (!prior || prior.lease.until <= time) return observe({ code: "waiting" });
    if (prior.generation < remembered?.generation) return observe({ code: "waiting" }, null);
    if (prior.version === 3 && prior.cleared === true) {
      let skipped;
      try { ({ skipped } = await writeAuthFile(authFile, clearImported)); }
      catch { return observe({ code: "failed" }); }
      return observe({ code: "cleared", count: 0, skipped, generation: prior.generation });
    }
    let applied, skipped;
    try { ({ applied, skipped } = await writeAuthFile(authFile, current => mergeForFollower(current, prior.accounts, config.machine))); }
    catch { return observe({ code: "failed" }); }
    return observe({ code: "received", count: applied.length, skipped, generation: prior.generation });
  }

  // Adapted from Sync's publish path: a single owner, and SHA-conditional
  // writes. A conflict is retried on the next poll, never written blindly.
  if (!cleared && !validAccounts(own)) return { code: "missing" };
  if (cleared && !validClearedAccounts(own)) return { code: "missing" };
  if (prior && prior.lease.owner !== config.machine && prior.lease.until > time) return observe({ code: "other-master" });
  const same = cleared ? prior?.version === 3 && prior.cleared === true
    : prior ? JSON.stringify(prior.accounts) === JSON.stringify(own) : false;
  if (prior?.lease.owner === config.machine && prior.lease.until > time + leaseMs - renewMs && same) {
    return observe({ code: cleared ? "cleared" : "published", count: cleared ? 0 : Object.keys(own).length, leaseUntil: prior.lease.until });
  }
  const lease = { owner: config.machine, until: time + leaseMs };
  const snapshot = cleared
    ? { version: 3, cleared: true, generation: (prior?.generation || 0) + 1, lease, accounts: {} }
    : { version: accountSnapshotVersion(own), generation: (prior?.generation || 0) + 1, lease, accounts: own };
  const sealed = await sealData(snapshot, remote.passphrase);
  await store.writeIf(remote.path, sealed, "workbuddy-plus: publish account snapshot", latest?.sha || null);
  return observe({ code: cleared ? "cleared" : "published", count: cleared ? 0 : Object.keys(own).length, leaseUntil: lease.until }, snapshot);
}

async function saveRequest(dir, config, request, now) {
  if (!uuid(request?.id) || request.target !== config.machine || request.id === config.reply?.id ||
      !Number.isFinite(request.at) || request.at > now || now - request.at >= requestMs ||
      request.at <= (config.reply?.at || 0)) return config;
  if (request.now === true) {
    const next = { ...config, reply: { id: request.id, at: request.at, error: "" } };
    writeJSON(configPath(dir), next);
    return next;
  }
  let error = "";
  const { role, picks } = request;
  const clear = request.clear === true;
  if (!roles.includes(role) || !Array.isArray(picks) || picks.length > 100 || picks.some(id => typeof id !== "string" || id.length > 256)) error = "invalid";
  else if (clear) {
    if (config.role !== "master" || role !== "master" || picks.length) error = "invalid";
  } else if (role === "master") {
    if (!picks.length) error = "empty";
    else try {
      const present = collectWorkBuddy(await readAuthFile(join(dir, "plugin-auth.json")), picks, config.machine);
      if (!validAccounts(present) || new Set(picks).size !== Object.keys(present).length) error = "unavailable";
    } catch { error = "unavailable"; }
  }
  const next = { ...config, ...(error ? {} : {
    role, cleared: clear,
    picks: clear || role !== "master" ? [] : [...new Set(picks)],
    revision: request.id
  }), reply: { id: request.id, at: request.at, error } };
  writeJSON(configPath(dir), next);
  return next;
}

// Commands arrive via synced Magpie plugin options, so a per-machine target
// and expiring request ID are mandatory. Role and acknowledgement stay local.
export async function hostTick(dir, request, { now = Date.now, storeFactory, onChange = () => {}, force = false } = {}) {
  const local = syncConfig(dir);
  if (local?.role === "off" && (!request || request.target !== local.machine || request.at <= (local.reply?.at || 0))) return "off";
  const unlock = await acquireEngineLock(dir);
  if (!unlock) return "busy";
  try {
    let config = syncConfig(dir), changed = false;
    if (config?.role === "unavailable") return "unavailable";
    if (!config) {
      config = { machine: randomUUID(), role: "off", picks: [] };
      writeJSON(configPath(dir), config);
      changed = true;
    }
    const previous = config;
    config = await saveRequest(dir, config, request, now());
    if (changed || previous !== config) await onChange();
    if (config.role === "off") return "off";
    const state = syncResult(dir), revision = config.revision || "";
    const forced = force || (previous !== config && request?.now === true);
    if (!forced && state?.revision === revision && now() - state.checkedAt < pollMs - 1000) return "idle";
    let result;
    try { result = await syncOnce(dir, config, { now, storeFactory, state }); }
    catch { result = { code: "failed" }; }
    const success = result.code === "received" || result.code === "published" || result.code === "cleared";
    // Keep a still-valid lease across a transport error; never extend it
    // without a successful publication/read-back of our current ownership.
    if (result.code === "failed" && state?.revision === revision && state.leaseUntil > now()) {
      const remote = transport(dir);
      if (remote && state.remoteKey === remoteIdentity(remote)) result.leaseUntil = state.leaseUntil;
    }
    if (config.role === "follower" && result.generation === undefined && state?.remoteKey &&
        (!result.remoteKey || result.remoteKey === state.remoteKey)) {
      result.remoteKey = state.remoteKey;
      result.generation = state.generation;
    }
    const publicChanged = previous !== config || state?.revision !== revision ||
      ["code", "count", "skipped", "leaseUntil", "generation"].some(k => result[k] !== state?.[k]);
    writeJSON(resultPath(dir), { ...result, revision, checkedAt: now(), at: success ? (publicChanged ? now() : state?.at || now()) : 0 });
    const diagnostics = state => [state?.snapshot, state?.presence?.followers, state?.presence?.heartbeat, state?.presence?.unavailable, state?.presence?.heartbeatFailed];
    if (publicChanged || JSON.stringify(diagnostics(result)) !== JSON.stringify(diagnostics(state))) await onChange();
    return result.code;
  } finally { await unlock(); }
}

export function startSync(dir, request, onChange) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await hostTick(dir, request, { onChange }); }
    catch { console.error("[workbuddy-plus] 无法读取或保存账号同步状态"); }
    finally { running = false; }
  };
  void run();
  // A second host can be started with a new settings command while the old
  // host is completing a poll. Retry without keeping short-lived CLIs alive.
  return setInterval(run, pollMs).unref();
}
