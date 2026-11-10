import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { open, stat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const dataDir = process.env.WORKBUDDY_PLUS_DIR || join(homedir(), ".config", "workbuddy-plus");
export const magpieDir = process.env.WORKBUDDY_PLUS_MAGPIE_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie");
export const defaults = {
  // Each build's schedule has its own switch: China's, then WorkBuddy AI's.
  // Off, its slots don't run; its buttons still do.
  enabled: false,
  intlEnabled: false,
  // …and their daily web conversation for the activity reward (30/50 credits),
  // on a model free right now ("auto") or the one named.
  intlWeb: true,
  intlWebModel: "auto",
  // Scheduled slots run within ±spread minutes of their set time.
  spread: 10,
  timezone: "Asia/Shanghai",
  magpieDir,
  proxy: "",
  // China's slots; WorkBuddy AI keeps its own below.
  schedules: {
    daily: ["09:00", "21:00"],
    tasks: ["09:10", "21:10"],
    night: ["01:00"],
    keepalive: ["22:00"]
  },
  intlSchedules: {
    daily: ["09:00", "21:00"],
    tasks: ["09:10", "21:10"],
    web: ["10:30"],
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
    const realm = { workbuddy: "cn", "workbuddy-ai": "intl" }[key.split("#")[0]];
    if (!realm || auth.type !== "oauth") continue;
    if (!auth.access || !auth.uid) continue;
    const id = `${realm}:${auth.uid}`;
    found.set(id, { id, realm, name: auth.accountId || auth.uid, auth, source: "magpie", file, key });
  }
  return [...found.values()].map(a => ({ ...a, enabled: !config.disabledAccounts.includes(a.id), enterprise: !!a.auth.enterpriseId }));
}

// The international login the models view reads its list and plan with.
export function intlAccount(config) {
  const file = join(config.magpieDir, "plugin-auth.json");
  const saved = existsSync(file) ? readJSON(file) : {};
  const [key, auth] = Object.entries(saved).find(([k, a]) => k.split("#")[0] === "workbuddy-ai" && a?.type === "oauth" && a.access) || [];
  return key ? { id: `intl:${auth.uid}`, realm: "intl", name: auth.accountId || auth.uid, auth, key, file } : null;
}

// The daily check-in is Magpie's: its switch, and what it recorded per login
// under "workbuddy|<plugin-auth key>". Read only; nothing here claims it.
export function checkins(config) {
  const read = name => { try { return readJSON(join(config.magpieDir, name)); } catch { return {}; } };
  const settings = read("settings.json");
  return { on: (settings.pluginCheckins?.workbuddy ?? settings.workbuddyCheckin) === true, records: read("plugin-checkin.json") };
}

export function publicAccount(a) {
  return { id: a.id, name: a.name, realm: a.realm, source: a.source, enabled: a.enabled, ...(a.intlOff ? { intlOff: true } : {}), enterprise: a.enterprise, expires: a.auth.expires };
}

export function calendar(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour) };
}

// This copy's version, which the plugin compares with the running service's.
export const version = (() => { try { return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version || "0"; } catch { return "0"; } })();
// Whether version a is newer than b (plain x.y.z).
export const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b || "0").split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

// WorkBuddy AI's slots. Settings from before they were split ran it with
// China's, its web conversation inside the activity slot: they carry on from
// China's times, the web conversation at 10:30 unless activity was off.
export function intlSchedules(config) {
  if (config.intlSchedules) return config.intlSchedules;
  const s = config.schedules || defaults.schedules;
  return { daily: s.daily || [], tasks: s.tasks || [], web: s.daily?.length ? [...defaults.intlSchedules.web] : [], keepalive: s.keepalive || [] };
}

// Settings as they read now. Before 0.5.7 one switch ran both builds'
// schedules and `intl: false` stopped WorkBuddy AI altogether: its schedule
// switch takes over both, and its slots carry on from China's times.
export function settle(config) {
  const { intl: _, ...rest } = config;
  return { ...rest, intlEnabled: intlOn(config), intlSchedules: intlSchedules(config) };
}

// Every kind of slot, the build it serves and what it runs. WorkBuddy AI's
// kinds are prefixed, so their slots are their own.
export const slotKinds = {
  daily: { realm: "cn", actions: ["activity", "travel", "bonus"] },
  tasks: { realm: "cn", actions: ["tasks"] },
  night: { realm: "cn", actions: ["night"] },
  keepalive: { realm: "cn", actions: ["keepalive"] },
  "intl-daily": { realm: "intl", actions: ["activity", "bonus"] },
  "intl-tasks": { realm: "intl", actions: ["tasks"] },
  "intl-web": { realm: "intl", actions: ["web"] },
  "intl-keepalive": { realm: "intl", actions: ["keepalive"] }
};
// Whether WorkBuddy AI's schedule runs, for settings saved before it had a switch.
export const intlOn = config => typeof config.intlEnabled === "boolean" ? config.intlEnabled : config.enabled === true && config.intl !== false;
export function plan(config) {
  const intl = intlSchedules(config);
  return [
    ...Object.entries(config.schedules || {}).map(([kind, times]) => ({ kind, times })),
    ...Object.entries(intl).filter(([kind]) => kind !== "web" || config.intlWeb !== false).map(([kind, times]) => ({ kind: `intl-${kind}`, times }))
  ].filter(s => slotKinds[s.kind]).map(s => ({ ...s, ...slotKinds[s.kind], on: slotKinds[s.kind].realm === "intl" ? intlOn(config) : config.enabled === true }));
}

const times = (value, name) => {
  if (!value || Object.keys(value).sort().join() !== Object.keys(defaults[name]).sort().join()) throw new Error("定时任务类别无效");
  for (const list of Object.values(value)) {
    if (!Array.isArray(list) || list.length > 24 || list.some(t => typeof t !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error("时间应为 HH:MM，每类最多 24 个；留空可关闭该类定时");
  }
};

export function validateConfig(value) {
  if (typeof value.enabled !== "boolean" || typeof value.proxy !== "string" || typeof value.magpieDir !== "string") throw new Error("开关、代理或 Magpie 路径无效");
  if (value.proxy && !/^https?:\/\//.test(value.proxy)) throw new Error("代理需要 http:// 或 https:// 地址");
  new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  if (value.intlEnabled !== undefined && typeof value.intlEnabled !== "boolean") throw new Error("国际版定时开关无效");
  if (value.intlWeb !== undefined && typeof value.intlWeb !== "boolean") throw new Error("国际版网页会话开关无效");
  if (value.spread !== undefined && !(Number.isInteger(value.spread) && value.spread >= 0 && value.spread <= 60)) throw new Error("随机错开应为 0–60 分钟");
  if (!Array.isArray(value.disabledAccounts) || value.disabledAccounts.some(a => typeof a !== "string")) throw new Error("账号停用列表无效");
  if (value.intlWebModel !== undefined && !(typeof value.intlWebModel === "string" && /^[\w.:-]{1,80}$/.test(value.intlWebModel))) throw new Error("国际版网页会话模型无效");
  times(value.schedules, "schedules");
  if (value.intlSchedules !== undefined) times(value.intlSchedules, "intlSchedules");
  return value;
}

// A proxy's credentials never reach the page: it sees user:pass as ***.
export const maskProxy = proxy => String(proxy || "").replace(/\/\/[^/@]*@/, "//***@");
