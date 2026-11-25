import { join } from "node:path";
import { readJSON } from "../storage.mjs";

// parseGithubURL accepts the github://owner/repo[/folder] form Magpie's own
// GitHub sync uses. It returns the repository and the optional folder.
export function parseGithubURL(raw) {
  const rawText = String(raw || "").trim();
  // URL() collapses dot segments; Magpie sync refuses them, so reject the
  // spelling before the parser can turn it into another path.
  if (/\/\.\.?(?:\/|$)/.test(rawText)) throw new Error("the GitHub folder in sync.json is not valid");
  let u;
  try {
    u = new URL(rawText);
  } catch {
    throw new Error("sync.json does not hold a github:// URL");
  }
  if (u.protocol !== "github:" || !u.host || u.username || u.password || u.port || u.search || u.hash) {
    throw new Error("only Magpie's github:// sync address is supported");
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (!u.host || parts.length < 1) throw new Error("sync.json needs github://owner/repo");
  const bad = (s) => !s || s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/.test(s);
  if (bad(u.host) || bad(parts[0])) throw new Error("sync.json needs github://owner/repo");
  for (const p of parts.slice(1)) {
    if (bad(p)) throw new Error("the GitHub folder in sync.json is not valid");
  }
  return {
    repo: `${u.host}/${parts[0]}`,
    prefix: parts.slice(1).join("/"),
  };
}

// Only the Magpie-host sync engine calls this, after an explicit local opt-in.
export function transport(dir) {
  try {
    const sync = readJSON(join(dir, "sync.json"));
    const github = parseGithubURL(sync.url);
    let token = typeof sync.password === "string" ? sync.password.trim() : "";
    if (!token) {
      const settings = readJSON(join(dir, "settings.json"));
      token = typeof settings.githubToken === "string" ? settings.githubToken.trim() : "";
    }
    if (!token || typeof sync.passphrase !== "string" || !sync.passphrase) return null;
    return {
      repo: github.repo, branch: typeof sync.branch === "string" ? sync.branch.trim() : "",
      path: [github.prefix, "workbuddy-plus", "accounts-v1.magpie-data"].filter(Boolean).join("/"),
      token, passphrase: sync.passphrase
    };
  } catch { return null; }
}
