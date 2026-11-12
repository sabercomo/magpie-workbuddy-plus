import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, closeSync, openSync, mkdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dataDir, newer, version } from "./storage.mjs";
import { answering, portTaken } from "./server.mjs";

// The service's port: the plugin option "port" (set with `magpie plugin options`,
// since Magpie starts plugins with no environment of the user's), else
// WORKBUDDY_PLUS_PORT, else 3439. Windows may reserve 3439 for itself.
export function portOf(options, env = process.env) {
  for (const value of [options?.port, env.WORKBUDDY_PLUS_PORT]) {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return 3439;
}
let port = portOf();
const base = () => `http://127.0.0.1:${port}`;
const refused = e => ["ECONNREFUSED", "ConnectionRefused"].includes(e.cause?.code || e.code);
const lastLine = file => { try { return readFileSync(file, "utf8").trim().split("\n").at(-1) || ""; } catch { return ""; } };

async function rpc(path, body) {
  const request = () => fetch(base() + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-WorkBuddy-Plus": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
  });
  let response;
  try { response = await request(); }
  catch (e) {
    if (!refused(e)) throw e;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, "service.log"), log = openSync(file, "a", 0o600);
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "server.mjs")], { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: { ...process.env, WORKBUDDY_PLUS_PORT: String(port) } });
    closeSync(log);
    child.unref();
    // A service that can't have the port says why in its log and exits.
    let exited = false;
    child.once("exit", () => { exited = true; });
    for (let attempt = 0; attempt < 40 && !exited; attempt++) {
      await delay(100);
      try { response = await request(); break; }
      catch (e) { if (!refused(e)) throw e; }
    }
    if (!response) throw new Error(exited && lastLine(file) || `后台服务未启动，请查看 ${file}`);
  }
  const value = await response.json().catch(() => undefined);
  if (response.ok && value !== undefined) return value;
  // Another program answering on the port (Windows' own http.sys serves some)
  // means no service of ours can start there: say so where the page points.
  if (!(await answering(port))) {
    const reason = portTaken(port, `HTTP ${response.status}`);
    try { appendFileSync(join(dataDir, "service.log"), reason + "\n", { mode: 0o600 }); } catch {}
    throw new Error(reason);
  }
  throw new Error(value?.error || `后台服务返回 HTTP ${response.status}`);
}

const pageFile = join(dirname(fileURLToPath(import.meta.url)), "page", "data.js");

// Updating the plugin replaces its files, not the service already running:
// that one keeps the old code until it stops. So a newer plugin, when loaded,
// asks an older service to step aside and starts its own (rpc does, once
// nothing answers). With a job in flight the old one says busy, and this asks
// again a minute later. Services before 0.5.5 can't be asked; they need one
// restart.
export async function handoff({ fetcher = fetch, wait = delay, mine = version, retry = (f, ms) => setTimeout(f, ms).unref?.(), tries = 10 } = {}) {
  let running;
  try { running = await (await fetcher(base() + "/api/status", { signal: AbortSignal.timeout(3000) })).json(); } catch { return "none"; }
  if (!running?.config || !newer(mine, running.version)) return "current";
  let response;
  try { response = await fetcher(base() + "/api/handoff", { method: "POST", headers: { "Content-Type": "application/json", "X-WorkBuddy-Plus": "1" }, body: JSON.stringify({ version: mine }), signal: AbortSignal.timeout(5000) }); }
  catch { return "old"; }
  if (response.status === 202) {
    for (let i = 0; i < 50; i++) {
      await wait(100);
      try { await fetcher(base() + "/api/status", { signal: AbortSignal.timeout(500) }); }
      catch (e) { if (refused(e)) return "stopped"; }
    }
    return "stopping";
  }
  const reply = await response.json().catch(() => ({}));
  if (reply.busy && tries > 1) retry(() => handoff({ fetcher, wait, mine, retry, tries: tries - 1 }).then(() => rpc("/api/page-target", { file: pageFile })).catch(() => {}), 60_000);
  return reply.busy ? "busy" : "old";
}

// Magpie starts its plugin host at launch and again after each restart, so
// loading the plugin is when the service is brought up (rpc starts it when
// nothing answers) and told where this copy's page reads its snapshot.
// Magpie also restarts its plugins with new options whenever the page's
// buttons save a request into them; the service runs each request id once.
export const WorkBuddyPlusPlugin = async (input, options) => {
  port = portOf(options);
  const ready = handoff().then(() => rpc("/api/page-target", { file: pageFile })).catch(e => console.error("[workbuddy-plus]", e.message));
  if (options?.request) ready.then(() => rpc("/api/page", options.request)).catch(e => console.error("[workbuddy-plus]", e.message));
  return { tool: {
    status: {
      description: "WorkBuddy Plus 的国内版与国际版账号、执行记录、定时设置。成长任务、猫猫旅行、连登福利；本机面板默认 http://127.0.0.1:3439（端口可在插件选项 port 中修改）。不会返回登录密钥。",
      args: { type: "object", properties: {}, additionalProperties: false },
      execute: () => rpc("/api/status")
    },
    run: {
      description: "启动 WorkBuddy Plus 账号操作（国内版与国际版），返回执行编号，随后用 status 查看结果。all 包含连登活跃、成长任务、猫猫旅行和连登福利（国际版另含签到和领每日活跃奖励的网页会话；web 只跑这次网页会话，每天一次）；国内版每日签到由 Magpie 的 WorkBuddy 插件负责。",
      args: { type: "object", properties: { action: { type: "string", enum: ["all", "activity", "tasks", "travel", "bonus", "night", "keepalive", "web", "inspect"] }, accounts: { type: "array", items: { type: "string" }, description: "status 返回的账号 id；不填代表全部已启用账号" } }, required: ["action"], additionalProperties: false },
      execute: args => rpc("/api/run", args)
    },
    board: {
      description: "WorkBuddy Plus 国内版与国际版账号的积分余额与积分包到期、近 7 天官方用量、猫猫旅行状态和连登天数。约每 10 分钟刷新；不会返回登录密钥。",
      args: { type: "object", properties: {}, additionalProperties: false },
      execute: () => rpc("/api/board")
    },
    schedules: {
      description: "查看或开关 WorkBuddy Plus 的定时执行：enabled 是国内版的定时，intlEnabled 是国际版的定时，关掉只停定时、手动执行不受影响。国内版与国际版各有自己的时段（schedules 与 intlSchedules），在本地面板的「定时与设置」或 Magpie 页面的「设置」中调整，已开始的手动任务不受开关影响。",
      args: { type: "object", properties: { enabled: { type: "boolean" }, intlEnabled: { type: "boolean" } }, additionalProperties: false },
      async execute(args) {
        const { config } = await rpc("/api/status");
        return args.enabled === undefined && args.intlEnabled === undefined ? config : rpc("/api/config", { ...config, ...args });
      }
    }
  } };
};
