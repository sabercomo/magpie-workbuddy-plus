import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, closeSync, openSync, mkdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dataDir } from "./storage.mjs";
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

// Magpie starts its plugin host at launch and again after each restart, so
// loading the plugin is when the service is brought up (rpc starts it when
// nothing answers) and told where this copy's page reads its snapshot.
// Magpie also restarts its plugins with new options whenever the page's
// buttons save a request into them; the service runs each request id once.
export const WorkBuddyPlusPlugin = async (input, options) => {
  port = portOf(options);
  const ready = rpc("/api/page-target", { file: pageFile }).catch(e => console.error("[workbuddy-plus]", e.message));
  if (options?.request) ready.then(() => rpc("/api/page", options.request)).catch(e => console.error("[workbuddy-plus]", e.message));
  return { tool: {
    status: {
      description: "WorkBuddy Plus 的国内账号、执行记录、定时设置。成长任务、猫猫旅行、连登福利；本机面板默认 http://127.0.0.1:3439（端口可在插件选项 port 中修改）。不会返回登录密钥。",
      args: { type: "object", properties: {}, additionalProperties: false },
      execute: () => rpc("/api/status")
    },
    run: {
      description: "启动 WorkBuddy Plus 国内账号操作，返回执行编号，随后用 status 查看结果。all 包含连登活跃、成长任务、猫猫旅行和连登福利；每日签到由 Magpie 的 WorkBuddy 插件负责。",
      args: { type: "object", properties: { action: { type: "string", enum: ["all", "activity", "tasks", "travel", "bonus", "night", "keepalive", "inspect"] }, accounts: { type: "array", items: { type: "string" }, description: "status 返回的账号 id；不填代表全部已启用账号" } }, required: ["action"], additionalProperties: false },
      execute: args => rpc("/api/run", args)
    },
    board: {
      description: "WorkBuddy Plus 国内账号的积分余额与积分包到期、近 7 天官方用量、猫猫旅行状态和连登天数。约每 10 分钟刷新；不会返回登录密钥。",
      args: { type: "object", properties: {}, additionalProperties: false },
      execute: () => rpc("/api/board")
    },
    schedules: {
      description: "查看或开关 WorkBuddy Plus 的定时执行。具体时段在本地面板中调整，已开始的手动任务不受开关影响。",
      args: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false },
      async execute(args) {
        const { config } = await rpc("/api/status");
        return args.enabled === undefined ? config : rpc("/api/config", { ...config, enabled: args.enabled });
      }
    }
  } };
};
