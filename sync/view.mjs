import { join } from "node:path";
import { readJSON } from "../storage.mjs";

export const marker = "workbuddyPlusSync";
export const uuid = value => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
export const keyRealm = key => key.split("#", 1)[0] === "workbuddy-ai" ? "intl" : "cn";
export const providerKey = key => /^workbuddy(?:-ai)?(?:#[a-zA-Z0-9._-]+)?$/.test(key);
export const accountIdentity = (key, auth) => providerKey(key) && typeof auth?.uid === "string" && auth.uid && `${keyRealm(key)}:${auth.uid}`;
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

const results = ["waiting", "published", "received", "unconfigured", "missing", "other-master", "failed"];
const errors = ["invalid", "empty", "unavailable"];

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
    ...(uuid(config.machine) ? { target: config.machine } : {}),
    picks: (config.picks || []).filter(id => typeof id === "string"),
    reply: uuid(config.reply?.id) ? { id: config.reply.id, error: errors.includes(config.reply.error) ? config.reply.error : "" } : null,
    code: role === "off" || role === "unavailable" ? role : current && results.includes(result?.code) ? result.code : "waiting",
    count: current && Number.isSafeInteger(result?.count) ? result.count : 0,
    skipped: current && Number.isSafeInteger(result?.skipped) ? result.skipped : 0,
    at: current && Number.isFinite(result?.at) ? result.at : 0
  };
}

export function syncChoices(list) {
  return list.filter(({ key, auth, enterprise }) => !enterprise && providerKey(key) && typeof auth?.uid === "string" &&
    typeof auth.access === "string" && auth.access && auth.source !== "desktop" && !auth[marker])
    .map(({ id, name, realm }) => ({ id, name, realm }));
}
