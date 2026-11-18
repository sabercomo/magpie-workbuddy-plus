import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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
  // An App conversation is a real model call, so it stays off unless asked for.
  campaignApp: false,
  // Opening Buddy blind boxes spends growth energy; only do it when the user
  // has asked, after a trip's reward and before the next departure.
  buddyAuto: false,
  concurrency: 1,
  tasksCacheTtl: 20,
  progressCacheHours: 6,
  // Sharing a skill creates a real link on WorkBuddy's side; off, only the
  // task center's one-task button runs it.
  skillShare: true,
  // Marks schedules already moved to the minute-01 defaults of 0.7.2.
  scheduleDefaults: 2,
  // Scheduled slots run within ±spread minutes of their set time.
  spread: 10,
  timezone: "Asia/Shanghai",
  magpieDir,
  proxy: "",
  // WorkBuddy AI's own proxy: "" follows proxy, "direct" uses none.
  intlProxy: "",
  // China's slots; WorkBuddy AI keeps its own below. Every default minute is
  // 01, so scheduled work does not start on the hour. Entries that need their
  // own place keep 10 minutes between them.
  schedules: {
    daily: ["09:01", "21:01"],
    tasks: ["09:11", "21:11"],
    sweep: ["10:01", "22:11"],
    night: ["01:01"]
  },
  // No growth-task slot: WorkBuddy AI's tasks count real use of its client.
  intlSchedules: {
    daily: ["09:01", "21:01"],
    web: ["10:31"]
  },
  disabledAccounts: [],
  // Accounts whose tasks stay paused while the board keeps updating.
  pausedAccounts: []
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
  const file = join(dir, "config.json"), config = readJSON(file), migrated = migrateSchedules(config);
  if (JSON.stringify(migrated) !== JSON.stringify(config)) writeJSON(file, migrated);
}

// The 0.7.2 defaults put every slot at minute 01. An install that never changed
// its saved defaults is moved with it; a custom schedule is left exactly as it
// is, and is marked so a later rollback of the minutes stays custom too.
export const legacySchedules = {
  schedules: { daily: ["09:00", "21:00"], tasks: ["09:10", "21:10"], sweep: ["10:00", "22:10"], night: ["01:00"] },
  intlSchedules: { daily: ["09:00", "21:00"], web: ["10:30"] }
};

// Drop the former renewal slot without disturbing the remaining saved times.
function withoutKeepalive(value = {}) {
  const { keepalive: _, ...slots } = value;
  return slots;
}

export function migrateSchedules(config) {
  const next = { ...config, scheduleDefaults: 2 };
  if (next.schedules) next.schedules = withoutKeepalive(next.schedules);
  if (next.intlSchedules) next.intlSchedules = withoutKeepalive(next.intlSchedules);
  if (config.scheduleDefaults === 2) return next;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(next.schedules, legacySchedules.schedules)) next.schedules = defaults.schedules;
  if (same(next.intlSchedules, legacySchedules.intlSchedules)) next.intlSchedules = defaults.intlSchedules;
  return next;
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
    found.set(id, { id, realm, name: auth.accountId || auth.uid, auth, source: "magpie", key });
  }
  // Personal accounts first, enterprise last; the board still groups by realm.
  const rank = a => (a.realm === "intl" ? 2 : 0) + (a.enterprise ? 1 : 0);
  return [...found.values()]
    .map(a => ({ ...a, enabled: !config.disabledAccounts.includes(a.id), paused: (config.pausedAccounts || []).includes(a.id), enterprise: !!a.auth.enterpriseId }))
    .sort((a, b) => rank(a) - rank(b));
}

// The international login the models view reads its list and plan with.
export function intlAccount(config) {
  const file = join(config.magpieDir, "plugin-auth.json");
  const saved = existsSync(file) ? readJSON(file) : {};
  const [key, auth] = Object.entries(saved).find(([k, a]) => k.split("#")[0] === "workbuddy-ai" && a?.type === "oauth" && a.access) || [];
  return key ? { id: `intl:${auth.uid}`, realm: "intl", name: auth.accountId || auth.uid, auth } : null;
}

// The daily check-in is Magpie's: its switch, and what it recorded per login
// under "workbuddy|<plugin-auth key>". Read only; nothing here claims it.
export function checkins(config) {
  const read = name => { try { return readJSON(join(config.magpieDir, name)); } catch { return {}; } };
  const settings = read("settings.json");
  return { on: (settings.pluginCheckins?.workbuddy ?? settings.workbuddyCheckin) === true, records: read("plugin-checkin.json") };
}

export function publicAccount(a) {
  return { id: a.id, name: a.name, realm: a.realm, source: a.source, enabled: a.enabled, paused: !!a.paused, ...(a.intlOff ? { intlOff: true } : {}), enterprise: a.enterprise, expires: a.auth.expires };
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
// Its growth-task slot (through 0.5.8) is dropped: it never had a task it could do.
export function intlSchedules(config) {
  if (config.intlSchedules) { const { tasks: _, ...kept } = withoutKeepalive(config.intlSchedules); return kept; }
  const s = config.schedules || defaults.schedules;
  return { daily: s.daily || [], web: s.daily?.length ? [...defaults.intlSchedules.web] : [] };
}

// Settings as they read now. Before 0.5.7 one switch ran both builds'
// schedules and `intl: false` stopped WorkBuddy AI altogether: its schedule
// switch takes over both, and its slots carry on from China's times.
export function settle(config) {
  const { intl: _, ...rest } = config;
  const schedules = { ...defaults.schedules, ...withoutKeepalive(rest.schedules || {}) };
  return { ...rest, concurrency: rest.concurrency ?? 1, tasksCacheTtl: rest.tasksCacheTtl ?? 20, progressCacheHours: rest.progressCacheHours ?? 6, campaignApp: rest.campaignApp === true, skillShare: rest.skillShare !== false, intlProxy: typeof rest.intlProxy === "string" ? rest.intlProxy : "", schedules, intlEnabled: intlOn(config), intlSchedules: intlSchedules({ ...rest, schedules }), disabledAccounts: Array.isArray(rest.disabledAccounts) ? rest.disabledAccounts : [], pausedAccounts: Array.isArray(rest.pausedAccounts) ? rest.pausedAccounts : [] };
}

// Every kind of slot, the build it serves and what it runs. WorkBuddy AI's
// kinds are prefixed, so their slots are their own.
export const slotKinds = {
  daily: { realm: "cn", actions: ["activity", "travel", "bonus"] },
  tasks: { realm: "cn", actions: ["tasks"] },
  sweep: { realm: "cn", actions: ["sweep"] },
  night: { realm: "cn", actions: ["night"] },
  "intl-daily": { realm: "intl", actions: ["activity", "bonus"] },
  "intl-web": { realm: "intl", actions: ["web"] }
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
  if (value.intlProxy !== undefined && typeof value.intlProxy !== "string") throw new Error("国际版代理无效");
  if (value.intlProxy && value.intlProxy !== "direct" && !/^https?:\/\//.test(value.intlProxy)) throw new Error("国际版代理需要 http:// 或 https:// 地址，或留空 / direct");
  new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  if (value.intlEnabled !== undefined && typeof value.intlEnabled !== "boolean") throw new Error("国际版定时开关无效");
  if (value.intlWeb !== undefined && typeof value.intlWeb !== "boolean") throw new Error("国际版网页会话开关无效");
  if (value.campaignApp !== undefined && typeof value.campaignApp !== "boolean") throw new Error("活动 App 对话开关无效");
  if (value.buddyAuto !== undefined && typeof value.buddyAuto !== "boolean") throw new Error("自动开盲盒开关无效");
  if (value.skillShare !== undefined && typeof value.skillShare !== "boolean") throw new Error("自动分享技能开关无效");
  if (value.concurrency !== undefined && ![1, 2, 3].includes(value.concurrency)) throw new Error("账号并发应为 1–3");
  if (value.tasksCacheTtl !== undefined && !(Number.isInteger(value.tasksCacheTtl) && value.tasksCacheTtl >= 0 && value.tasksCacheTtl <= 120)) throw new Error("任务列表缓存应为 0–120 秒");
  if (value.progressCacheHours !== undefined && !(Number.isInteger(value.progressCacheHours) && value.progressCacheHours >= 0 && value.progressCacheHours <= 24)) throw new Error("展示进度缓存应为 0–24 小时");
  if (value.spread !== undefined && !(Number.isInteger(value.spread) && value.spread >= 0 && value.spread <= 60)) throw new Error("随机错开应为 0–60 分钟");
  if (!Array.isArray(value.disabledAccounts) || value.disabledAccounts.some(a => typeof a !== "string")) throw new Error("账号停用列表无效");
  if (!Array.isArray(value.pausedAccounts) || value.pausedAccounts.some(a => typeof a !== "string")) throw new Error("暂停任务列表无效");
  if (value.intlWebModel !== undefined && !(typeof value.intlWebModel === "string" && /^[\w.:-]{1,80}$/.test(value.intlWebModel))) throw new Error("国际版网页会话模型无效");
  const schedules = { ...defaults.schedules, ...withoutKeepalive(value.schedules || {}) };
  times(schedules, "schedules");
  if (value.intlSchedules === undefined) return { ...value, schedules };
  const intl = intlSchedules({ ...value, schedules });
  times(intl, "intlSchedules");
  return { ...value, schedules, intlSchedules: intl };
}

// A proxy's credentials never reach the page: it sees user:pass as ***.
export const maskProxy = proxy => String(proxy || "").replace(/\/\/[^/@]*@/, "//***@");

// The proxy a realm's requests use: China keeps the saved proxy; WorkBuddy
// AI follows it unless its own is set. "direct" means no proxy.
export const proxyFor = (config, realm) => {
  if (realm !== "intl") return config.proxy || "";
  const own = String(config.intlProxy ?? "").trim();
  return own === "direct" ? "" : own || config.proxy || "";
};
