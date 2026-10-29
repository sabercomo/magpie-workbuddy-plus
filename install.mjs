import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { dataDir, initialize } from "./storage.mjs";

if (process.platform !== "darwin") throw new Error("此自用安装器目前支持 macOS；其他平台可直接运行 server.mjs 并自行配置后台服务");
const source = dirname(fileURLToPath(import.meta.url));
const destination = join(homedir(), "Applications", "Magpie-WorkBuddy-Plus");
initialize();
mkdirSync(destination, { recursive: true });
if (source !== destination) for (const file of readdirSync(source)) {
  if (file.endsWith(".mjs") || ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "public", "page"].includes(file)) cpSync(join(source, file), join(destination, file), { recursive: true });
}
const label = "io.github.sabercomo.magpie-workbuddy-plus";
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
mkdirSync(dirname(plist), { recursive: true });
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(destination, "server.mjs"))}</string></array>
<key>WorkingDirectory</key><string>${xml(destination)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(dataDir, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(dataDir, "service.log"))}</string>
<key>EnvironmentVariables</key><dict><key>WORKBUDDY_PLUS_DIR</key><string>${xml(dataDir)}</string><key>WORKBUDDY_PLUS_PORT</key><string>${xml(process.env.WORKBUDDY_PLUS_PORT || 3439)}</string></dict>
</dict></plist>\n`, { mode: 0o600 });
writeFileSync(join(destination, "WorkBuddy Plus.webloc"), `<?xml version="1.0"?><plist version="1.0"><dict><key>URL</key><string>http://127.0.0.1:${process.env.WORKBUDDY_PLUS_PORT || 3439}</string></dict></plist>\n`);
// An agent set up by hand for the same folder would start a second server on the same port.
const server = `<string>${xml(join(destination, "server.mjs"))}</string>`;
for (const file of readdirSync(dirname(plist))) {
  const other = join(dirname(plist), file);
  if (!file.endsWith(".plist") || other === plist || !readFileSync(other, "utf8").includes(server)) continue;
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, other], { stdio: "ignore" });
  renameSync(other, `${other}.replaced`);
  console.log(`已停用重复的后台服务：${file}（原文件改名为 ${file}.replaced）`);
}
const target = `gui/${process.getuid()}/${label}`;
const loaded = () => spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status === 0;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// bootout returns before the old service has gone; bootstrapping too early
// fails with an I/O error and leaves no service running.
if (loaded()) {
  spawnSync("launchctl", ["bootout", target], { stdio: "ignore" });
  for (let i = 0; i < 50 && loaded(); i++) pause(100);
}
for (let attempt = 1; ; attempt++) {
  const started = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { encoding: "utf8" });
  if (started.status === 0) break;
  if (attempt === 5) throw new Error(`后台服务启动失败：${(started.stderr || "").trim() || `launchctl 退出码 ${started.status}`}`);
  pause(500 * attempt);
}
execFileSync("magpie", ["plugin", "add", destination], { stdio: "inherit" });
console.log(`已安装 WorkBuddy Plus：${destination}\n面板：http://127.0.0.1:${process.env.WORKBUDDY_PLUS_PORT || 3439}`);
