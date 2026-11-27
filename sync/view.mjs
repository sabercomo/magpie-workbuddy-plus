import { join } from "node:path";
import { createHash } from "node:crypto";
import { readJSON } from "../storage.mjs";
import { followerOfflineMs } from "./presence.mjs";

export const marker = "workbuddyPlusSync";
export const uuid = value => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
export const keyRealm = key => key.split("#", 1)[0] === "workbuddy-ai" ? "intl" : "cn";
export const providerKey = key => /^workbuddy(?:-ai)?(?:#[a-zA-Z0-9._-]+)?$/.test(key);
const stableId = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function accountKind(key, auth) {
  if (!providerKey(key)) return "";
  if (auth?.type === "api" && typeof auth.key === "string" && auth.key.trim()) return "api";
  if (auth?.type !== "oauth" || typeof auth.uid !== "string" || !auth.uid) return "";
  if (auth.enterpriseId && typeof auth.enterpriseId !== "string") return "";
  return typeof auth.enterpriseId === "string" && auth.enterpriseId ? "enterprise" : "personal";
}
export function accountIdentity(key, auth) {
  const kind = accountKind(key, auth), realm = keyRealm(key);
  if (kind === "api") return `api:${realm}:${stableId(key)}`;
  if (kind === "enterprise") return `enterprise:${realm}:${stableId([auth.uid, auth.enterpriseId])}`;
  if (kind === "personal") return `${realm}:${auth.uid}`;
  return "";
}
export function shareableKind(key, auth, machine) {
  if (!auth || auth.source === "desktop") return "";
  const kind = accountKind(key, auth);
  // A locally imported API key can be reused. A marked OAuth entry only
  // becomes shareable once Magpie has saved a local renewable sign-in.
  if (kind === "api") return !auth[marker] || (uuid(machine) && auth[marker] === machine) ? kind : "";
  if (auth[marker] && (typeof auth.refresh !== "string" || !auth.refresh.trim())) return "";
  return typeof auth.access === "string" && auth.access ? kind : "";
}
export const roles = ["off", "master", "follower"];
export const configPath = dir => join(dir, "workbuddy-plus-sync.json");
export const resultPath = dir => join(dir, "workbuddy-plus-sync-state.json");

export function syncConfig(dir) {
  let data;
  try { data = readJSON(configPath(dir)); }
  catch (e) { if (e.code === "ENOENT") return null; }
  if (!uuid(data?.machine) || !roles.includes(data.role) || !Array.isArray(data.picks)) return { role: "unavailable" };
  return data;
}

export function syncResult(dir) {
  try { return readJSON(resultPath(dir)); }
  catch { return null; }
}

const results = ["waiting", "published", "received", "cleared", "unconfigured", "missing", "other-master", "failed"];
const errors = ["invalid", "empty", "unavailable"];
const nameOf = id => `设备 ${id.slice(0, 8).toUpperCase()}`;
const timeOf = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000 ? value : 0;
const generationOf = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

function deviceView(config, result, now) {
  const { snapshot, presence } = result || {};
  const { owner, until, seen, generation } = snapshot || {};
  const leader = uuid(owner) && timeOf(until) && generationOf(generation) ? {
    name: nameOf(owner), local: owner === config.machine, online: until > now, until, generation
  } : null;
  const devices = leader ? [{
    name: leader.name, local: leader.local, online: leader.online, role: "master", seen: timeOf(seen), generation: 0
  }] : [];
  const followers = new Map();
  for (const entry of Array.isArray(presence?.followers) ? presence.followers : []) {
    if (uuid(entry?.id)) followers.set(entry.id, entry);
  }
  if (config.role === "follower" && presence?.heartbeat) followers.set(config.machine, {
    seen: presence.heartbeat.seen, generation: result.generation || presence.heartbeat.generation
  });
  for (const [id, follower] of [...followers].sort(([, a], [, b]) => timeOf(b.seen) - timeOf(a.seen))) {
    const seen = timeOf(follower.seen), generation = generationOf(follower.generation);
    if (!seen || id === owner || (id === config.machine && config.role !== "follower")) continue;
    devices.push({ name: nameOf(id), local: id === config.machine, role: "follower", seen, generation, online: seen + followerOfflineMs > now });
  }
  return {
    snapshot: leader, devices,
    applied: config.role === "follower" ? generationOf(result?.generation) : 0,
    devicesUnavailable: presence?.unavailable === true,
    heartbeatFailed: config.role === "follower" && presence?.heartbeatFailed === true
  };
}

// Explicit public allowlist: never forward a Magpie sync file or raw error.
export function syncView(dir, now = Date.now()) {
  const config = syncConfig(dir);
  if (!config) return null;
  const result = syncResult(dir), current = result?.revision === (config.revision || "");
  const role = config.role;
  const paused = role === "follower" || role === "unavailable" ||
    (role === "master" && !(current && Number.isFinite(result?.leaseUntil) && result.leaseUntil > now));
  return {
    role, paused,
    // A newer page hides these when an older service cannot handle them.
    actions: { clear: true, now: true },
    ...(uuid(config.machine) ? { target: config.machine } : {}),
    picks: (config.picks || []).filter(id => typeof id === "string"),
    reply: uuid(config.reply?.id) ? { id: config.reply.id, error: errors.includes(config.reply.error) ? config.reply.error : "" } : null,
    code: role === "off" || role === "unavailable" ? role : current && results.includes(result?.code) ? result.code : "waiting",
    count: current && Number.isSafeInteger(result?.count) ? result.count : 0,
    skipped: current && Number.isSafeInteger(result?.skipped) ? result.skipped : 0,
    at: current && Number.isFinite(result?.at) ? result.at : 0,
    ...deviceView(config, current && ["master", "follower"].includes(role) ? result : null, now)
  };
}

export function syncChoices(auth, machine) {
  return Object.entries(auth).flatMap(([key, entry]) => {
    const kind = shareableKind(key, entry, machine);
    if (!kind) return [];
    const id = accountIdentity(key, entry), realm = keyRealm(key);
    // API keys do not have a UID; identify the slot, never the key itself.
    const name = kind === "api" ? `密钥 ${id.split(":").at(-1).slice(0, 6).toUpperCase()}`
      : (typeof entry.accountId === "string" && entry.accountId) || entry.uid;
    return [{ id, name, realm, kind }];
  });
}
