import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSync, openSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dataDir } from "./storage.mjs";

const base = () => `http://127.0.0.1:${process.env.WORKBUDDY_PLUS_PORT || 3439}`;
async function rpc(path, body) {
  const request = () => fetch(base() + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-WorkBuddy-Plus": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
  });
  let response;
  try { response = await request(); }
  catch (e) {
    if (!["ECONNREFUSED", "ConnectionRefused"].includes(e.cause?.code || e.code)) throw e;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(dataDir, "service.log"), "a", 0o600);
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "server.mjs")], { detached: true, stdio: ["ignore", log, log], env: process.env });
    closeSync(log);
    child.unref();
    for (let attempt = 0; attempt < 40; attempt++) {
      await delay(100);
      try { response = await request(); break; }
      catch (e) { if (!["ECONNREFUSED", "ConnectionRefused"].includes(e.cause?.code || e.code)) throw e; }
    }
    if (!response) throw new Error(`后台服务未启动，请查看 ${join(dataDir, "service.log")}`);
  }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}

export const WorkBuddyPlusPlugin = async () => ({
  tool: {
    status: {
      description: "WorkBuddy Plus 的国内账号、执行记录、定时设置。成长任务、猫猫旅行、Buddy 加油站；面板 http://127.0.0.1:3439。不会返回登录密钥。",
      args: { type: "object", properties: {}, additionalProperties: false },
      execute: () => rpc("/api/status")
    },
    run: {
      description: "启动 WorkBuddy Plus 国内账号操作，返回执行编号，随后用 status 查看结果。all 包含签到、连登活跃、成长任务、猫猫旅行和连登福利。",
      args: { type: "object", properties: { action: { type: "string", enum: ["all", "checkin", "activity", "tasks", "travel", "bonus", "night", "keepalive", "inspect"] }, accounts: { type: "array", items: { type: "string" }, description: "status 返回的账号 id；不填代表全部已启用账号" } }, required: ["action"], additionalProperties: false },
      execute: args => rpc("/api/run", args)
    },
    schedules: {
      description: "查看或开关 WorkBuddy Plus 的定时执行。具体时段在本地面板中调整，已开始的手动任务不受开关影响。",
      args: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false },
      async execute(args) {
        const { config } = await rpc("/api/status");
        return args.enabled === undefined ? config : rpc("/api/config", { ...config, enabled: args.enabled });
      }
    }
  }
});
