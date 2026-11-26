import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { accountIdentity, marker, providerKey, shareableKind } from "./view.mjs";

// Adapted from WorkBuddy Sync. Do not publish or modify a corrupt live file,
// and leave Magpie's own backup alone rather than copying unrelated secrets.
export async function readAuthFile(file) {
  let text;
  try { text = await readFile(file, "utf8"); }
  catch (e) {
    if (e.code !== "ENOENT") throw e;
    try { await stat(file + ".bak"); } catch (backup) { if (backup.code === "ENOENT") return {}; throw backup; }
    throw new Error("Auth file is missing but a backup exists");
  }
  const auth = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("Invalid auth file");
  return auth;
}

const baseFields = ["access", "uid", "accountId", "domain", "tokenType", "plan"];
const fields = [...baseFields, "enterpriseId"];
function portable(auth) {
  if (auth.type === "api") return { type: "api", key: auth.key };
  return { type: "oauth", ...Object.fromEntries(fields.filter(key => typeof auth[key] === "string" && auth[key]).map(key => [key, auth[key]])) };
}

// Like upstream WorkBuddy Sync, carry explicitly selected API entries and
// enterprise context; unlike upstream, never carry OAuth refresh or expiry.
export function collectWorkBuddy(auth, picked, machine) {
  const keys = new Set(picked);
  return Object.fromEntries(Object.entries(auth).sort(([a], [b]) => a.localeCompare(b))
    .filter(([key, value]) => shareableKind(key, value, machine) && keys.has(accountIdentity(key, value)))
    .map(([key, value]) => [key, portable(value)]));
}

export const accountSnapshotVersion = accounts => Object.values(accounts).some(a => a.type === "api" || a.enterpriseId) ? 2 : 1;

export function validAccounts(accounts, version = 2) {
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return false;
  const entries = Object.entries(accounts);
  const allowed = version === 1 ? baseFields : fields;
  return entries.length > 0 && entries.length <= 100 && entries.every(([key, auth]) => {
    if (!accountIdentity(key, auth)) return false;
    if (auth.type === "api") return version === 2 && Object.keys(auth).every(k => k === "type" || k === "key");
    return auth.type === "oauth" && typeof auth.access === "string" && !!auth.access &&
      Object.keys(auth).every(k => k === "type" || (allowed.includes(k) && typeof auth[k] === "string"));
  });
}

// A clear snapshot carries no accounts. It is a separate version so an older
// follower that only knows 1 or 2 rejects it instead of silently keeping a
// revoked account.
export function validClearedAccounts(accounts) {
  return !!accounts && typeof accounts === "object" && !Array.isArray(accounts) && Object.keys(accounts).length === 0;
}

// Only entries imported by this installation are ours to replace or remove.
// An official sign-in (even under a different key for the same UID) wins.
export function mergeForFollower(current, accounts, owner) {
  const isOurs = (key, auth) => providerKey(key) && auth?.[marker] === owner &&
    (auth.type === "api" ? Object.keys(auth).every(name => name === marker || name === "type" || name === "key")
      : auth.type === "oauth" && auth.expires === 0 &&
        Object.keys(auth).every(name => name === marker || name === "type" || name === "expires" || fields.includes(name)));
  const locals = Object.entries(current).filter(([key, auth]) => !isOurs(key, auth));
  const localIds = new Set(locals.map(([key, auth]) => accountIdentity(key, auth)).filter(Boolean));
  const next = Object.fromEntries(locals), applied = [];
  let skipped = 0;
  for (const [key, auth] of Object.entries(accounts)) {
    if (Object.hasOwn(next, key) || localIds.has(accountIdentity(key, auth))) { skipped++; continue; }
    next[key] = { ...portable(auth), ...(auth.type === "oauth" ? { expires: 0 } : {}), [marker]: owner };
    applied.push(key);
  }
  return { next, applied, skipped };
}

// A clear removes every entry this module ever imported on this installation,
// not only the ones carrying the current machine's marker: a reset config
// must not strand an older import. Official local sign-ins have no marker and
// stay untouched.
export function clearImported(current) {
  const next = {};
  let removed = 0;
  for (const [key, auth] of Object.entries(current)) {
    if (providerKey(key) && auth && typeof auth === "object" && auth[marker]) {
      removed++;
      continue;
    }
    next[key] = auth;
  }
  return { next, applied: [], skipped: 0, removed };
}

// Same .lock file as Magpie. Read fresh under it, and never unlink the
// original file as a fallback if replacement fails (including on Windows).
export async function writeAuthFile(file, change) {
  const lock = file + ".lock", start = Date.now();
  for (let wait = 10; ; wait = Math.min(wait * 2, 500)) {
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (e) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(e.code)) throw e;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 10_000) {
        const pid = Number(await readFile(lock, "utf8").catch(() => ""));
        let dead = !Number.isInteger(pid) || pid <= 0;
        if (!dead) try { process.kill(pid, 0); } catch (error) { dead = error.code === "ESRCH"; }
        if (dead && (await stat(lock).catch(() => null))?.ino === info.ino) {
          await rm(lock, { force: true });
          continue;
        }
      }
      if (Date.now() - start > 20_000) throw new Error("Auth file is locked");
      await delay(wait);
      continue;
    }
    const temp = `${file}.${randomUUID()}.tmp`, info = await handle.stat();
    const ownsLock = async () => {
      const current = await stat(lock).catch(() => null);
      return current?.ino === info.ino && await readFile(lock, "utf8").catch(() => "") === String(process.pid);
    };
    try {
      await handle.writeFile(String(process.pid));
      await handle.close();
      const current = await readAuthFile(file);
      const output = change(current);
      if (JSON.stringify(output.next) !== JSON.stringify(current)) {
        await writeFile(temp, JSON.stringify(output.next, null, 2) + "\n", { mode: 0o600, flag: "wx", flush: true });
        if (!await ownsLock()) throw new Error("Auth file lock changed during write");
        await rename(temp, file);
      }
      return output;
    } finally {
      await handle.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
      // Magpie may have reclaimed the file after a suspended process wakes.
      if (await ownsLock()) await rm(lock, { force: true });
    }
  }
}
