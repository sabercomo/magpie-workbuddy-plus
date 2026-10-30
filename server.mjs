import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Runner } from "./runner.mjs";
import { dataDir, defaults, writeJSON } from "./storage.mjs";

export function validateConfig(value) {
  if (typeof value.enabled !== "boolean" || typeof value.proxy !== "string" || typeof value.magpieDir !== "string") throw new Error("开关、代理或 Magpie 路径无效");
  if (value.proxy && !/^https?:\/\//.test(value.proxy)) throw new Error("代理需要 http:// 或 https:// 地址");
  new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  if (!Array.isArray(value.disabledAccounts) || value.disabledAccounts.some(a => typeof a !== "string")) throw new Error("账号停用列表无效");
  if (!value.schedules || Object.keys(value.schedules).sort().join() !== Object.keys(defaults.schedules).sort().join()) throw new Error("定时任务类别无效");
  for (const times of Object.values(value.schedules)) {
    if (!Array.isArray(times) || times.length > 24 || times.some(t => typeof t !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error("时间应为 HH:MM，每类最多 24 个；留空可关闭该类定时");
  }
  return value;
}

export function createService({ dir = dataDir, runner = new Runner(dir) } = {}) {
  const root = new URL("./public/", import.meta.url), shared = new URL("./page/", import.meta.url);
  const handler = async (request, response) => {
    const send = (code, body) => {
      response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(body));
    };
    try {
      const host = request.headers.host;
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host || "")) return send(403, { error: "只接受本机访问" });
      const origin = request.headers.origin;
      if (origin && ![`http://${host}`].includes(origin)) return send(403, { error: "拒绝跨站请求" });
      const url = new URL(request.url, `http://${host}`);
      if (request.method === "GET" && url.pathname === "/api/status") return send(200, runner.status());
      if (request.method === "GET" && url.pathname === "/api/board") return send(200, runner.boardView());
      if (request.method === "GET" && ["/", "/app.js", "/style.css", "/board.js", "/board.css"].includes(url.pathname)) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const type = { html: "text/html", js: "text/javascript", css: "text/css" }[file.split(".").pop()];
        response.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
        // The board renderer is shared with Magpie's page, which may only load files from page/.
        return response.end(readFileSync(new URL(file, file.startsWith("board.") ? shared : root)));
      }
      if (request.method !== "POST") return send(404, { error: "未知地址" });
      if (request.headers["x-workbuddy-plus"] !== "1" || !request.headers["content-type"]?.startsWith("application/json")) return send(403, { error: "缺少操作请求头" });
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) return send(413, { error: "请求过大" });
      }
      const value = JSON.parse(body);
      if (url.pathname === "/api/run") {
        if (value.accounts !== undefined && (!Array.isArray(value.accounts) || value.accounts.some(a => typeof a !== "string"))) throw new Error("账号列表无效");
        return send(202, runner.submit(value.actions || [value.action], value.accounts));
      }
      if (url.pathname === "/api/config") {
        const config = validateConfig(value);
        writeJSON(join(dir, "config.json"), config);
        return send(200, config);
      }
      if (url.pathname === "/api/cancel") { runner.cancel(value.id); return send(200, { cancelled: true }); }
      if (url.pathname === "/api/board") {
        runner.boardStale = true;
        runner.refreshBoard().catch(e => console.error(e));
        return send(202, runner.boardView());
      }
      if (url.pathname === "/api/page") return send(200, runner.pageRequest(value));
      if (url.pathname === "/api/login") return send(202, runner.login());
      if (url.pathname === "/api/page-target") return send(200, runner.addPageTarget(value.file));
      return send(404, { error: "未知地址" });
    } catch (e) { send(400, { error: e.message }); }
  };
  return { server: createServer(handler), runner, handler };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WORKBUDDY_PLUS_PORT || 3439);
  // The port is taken before the runner is made: making one marks running
  // jobs interrupted, which must not happen to another service's jobs. Both
  // the LaunchAgent and the Magpie plugin may start a service at login; the
  // one that loses waits instead of exiting, so launchd doesn't respawn it in
  // a loop, and takes over if the other stops.
  const server = createServer();
  let interval, waiting = false;
  server.on("error", e => {
    if (e.code !== "EADDRINUSE") throw e;
    if (!waiting) console.log(`端口 ${port} 已有 WorkBuddy Plus 在运行，本进程待命，等它退出后接手`);
    waiting = true;
    setTimeout(() => server.listen(port, "127.0.0.1"), 5000);
  });
  server.once("listening", () => {
    const { runner, handler } = createService({ runner: new Runner(dataDir, {}, { pageFile: fileURLToPath(new URL("./page/data.js", import.meta.url)) }) });
    server.on("request", handler);
    console.log(`WorkBuddy Plus: http://127.0.0.1:${port}`);
    // Missing/malformed local files are startup errors, not empty account lists.
    runner.list();
    const beat = () => {
      runner.tick();
      // A wake from sleep shows a stale board until this catches up.
      runner.refreshBoard(10 * 60_000).catch(e => console.error(e));
    };
    interval = setInterval(beat, 30_000);
    beat();
  });
  server.listen(port, "127.0.0.1");
  // A waiting process has nothing in flight; a serving one lets its calls finish.
  process.on("SIGTERM", () => { if (!interval) process.exit(0); clearInterval(interval); server.close(); });
}
