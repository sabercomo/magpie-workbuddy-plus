import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
  if (file.endsWith(".mjs") || ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "public"].includes(file)) cpSync(join(source, file), join(destination, file), { recursive: true });
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
const target = `gui/${process.getuid()}/${label}`;
const existing = spawnSync("launchctl", ["print", target], { stdio: "ignore" });
if (existing.status === 0) execFileSync("launchctl", ["bootout", target]);
execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist]);
execFileSync("magpie", ["plugin", "add", destination], { stdio: "inherit" });
console.log(`已安装 WorkBuddy Plus：${destination}\n面板：http://127.0.0.1:${process.env.WORKBUDDY_PLUS_PORT || 3439}`);
