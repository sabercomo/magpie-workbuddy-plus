import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { open, stat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const dataDir = process.env.WORKBUDDY_PLUS_DIR || join(homedir(), ".config", "workbuddy-plus");
export const magpieDir = process.env.WORKBUDDY_PLUS_MAGPIE_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie");
export const defaults = {
  enabled: false,
  timezone: "Asia/Shanghai",
  magpieDir,
  proxy: "",
  schedules: {
    daily: ["09:00", "21:00"],
    tasks: ["09:10", "21:10"],
    night: ["01:00"],
    keepalive: ["22:00"]
  },
  disabledAccounts: []
};

export function readJSON(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJSON(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, file);
}

export function initialize(dir = dataDir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries({
    "config.json": defaults,
    "state.json": { daily: {}, reports: {}, slots: {}, jobs: [] }
  })) {
    if (!existsSync(join(dir, name))) writeJSON(join(dir, name), value);
  }
}

// Uses Magpie's own lock filenames. A refresh and the following merge must
// not race its gateway/CLI, both of which can rotate the same refresh token.
export async function withLock(file, staleMs, run) {
  const started = Date.now();
  for (;;) {
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - (await stat(file)).mtimeMs > staleMs) await unlink(file);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (Date.now() - started > staleMs * 2) throw new Error(`等待账号锁超时：${file}`);
      await delay(50);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      return await run();
    } finally {
      await unlink(file);
    }
  }
}

export function accounts(config) {
  const file = join(config.magpieDir, "plugin-auth.json");
  const saved = existsSync(file) ? readJSON(file) : {};
  const found = new Map();
  for (const [key, auth] of Object.entries(saved)) {
    const provider = key.split("#")[0];
    if (provider !== "workbuddy" || auth.type !== "oauth") continue;
    if (!auth.access || !auth.uid) continue;
    const realm = "cn";
    const id = `${realm}:${auth.uid}`;
    found.set(id, { id, realm, name: auth.accountId || auth.uid, auth, source: "magpie", file, key });
  }
  return [...found.values()].map(a => ({ ...a, enabled: !config.disabledAccounts.includes(a.id), enterprise: !!a.auth.enterpriseId }));
}

export function publicAccount(a) {
  return { id: a.id, name: a.name, realm: a.realm, source: a.source, enabled: a.enabled, enterprise: a.enterprise, expires: a.auth.expires };
}

export function calendar(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour) };
}
