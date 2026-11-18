import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [url, width, height, out] = process.argv.slice(2);
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9400 + Math.floor(Math.random() * 300);
const browser = spawn(chrome, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=/tmp/wb-redesign-cdp-${process.pid}`,
  "about:blank"
], { stdio: "ignore" });

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); ready = true; break; }
    catch { await delay(100); }
  }
  if (!ready) throw new Error("Chrome did not start");

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let seq = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable");
  if (process.env.SCHEME === "dark") {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: Number(width), height: Number(height), deviceScaleFactor: 2, mobile: Number(width) < 600
  });
  await send("Page.navigate", { url });
  await delay(1200);
  const metrics = await send("Runtime.evaluate", {
    expression: "JSON.stringify({ width: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth })",
    returnByValue: true
  });
  console.error(`${width}x${height} ${metrics.result.value}`);
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  socket.close();
} finally {
  browser.kill("SIGKILL");
}
