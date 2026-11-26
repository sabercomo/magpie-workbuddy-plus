import { join } from "node:path";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
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

const snapshot = "workbuddy-plus/accounts-v1.magpie-data";
const plain = u => !!u.hostname && !u.username && !u.password && !u.search && !u.hash;
const loopback = host => ["127.0.0.1", "localhost", "[::1]"].includes(host);
const address = u => plain(u) && (u.protocol === "https:" || (u.protocol === "http:" && loopback(u.hostname)));
const text = value => typeof value === "string" ? value : "";

function s3Config(url, config) {
  if (!plain(url) || url.port || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(url.hostname)) return null;
  const accessKeyId = text(config.user).trim(), secretAccessKey = text(config.password);
  if (!accessKeyId || !secretAccessKey) return null;
  const given = text(config.endpoint).trim();
  const custom = given ? new URL(given.includes("://") ? given : `https://${given}`) : null;
  const region = text(config.region).trim() || (custom?.hostname.endsWith(".r2.cloudflarestorage.com") ? "auto" : "us-east-1");
  if (!/^[a-z0-9-]+$/.test(region)) return null;
  const endpoint = custom || new URL(`https://s3.${region}.amazonaws.com`);
  if (!address(endpoint)) return null;
  const host = endpoint.hostname, bucket = url.hostname;
  const pathStyle = config.pathStyle === true || !host.includes(".") || !!isIP(host) || bucket.includes(".");
  const prefix = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (prefix.some(p => !p || p === "." || p === ".." || /[\/\\\u0000-\u001f]/.test(p))) return null;
  return { kind: "s3", endpoint: endpoint.href, bucket, region, pathStyle, accessKeyId, secretAccessKey, path: [...prefix, snapshot].join("/") };
}

export function remoteIdentity(remote) {
  const target = remote.kind === "github" ? [remote.repo, remote.branch, remote.path]
    : [remote.kind, remote.endpoint, remote.bucket || remote.user, remote.path];
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

// Only the Magpie-host sync engine calls this, after an explicit local opt-in.
export function transport(dir) {
  try {
    const sync = readJSON(join(dir, "sync.json"));
    const { passphrase } = sync;
    if (typeof passphrase !== "string" || !passphrase) return null;
    const url = new URL(text(sync.url).trim());
    if (url.protocol === "s3:") {
      const s3 = s3Config(url, sync);
      return s3 && { ...s3, passphrase };
    }
    if (address(url)) {
      if (!text(sync.user) || !text(sync.password)) return null;
      return { kind: "webdav", endpoint: url.href, user: sync.user, password: sync.password, path: snapshot, passphrase };
    }
    const github = parseGithubURL(sync.url);
    let token = typeof sync.password === "string" ? sync.password.trim() : "";
    if (!token) {
      const settings = readJSON(join(dir, "settings.json"));
      token = typeof settings.githubToken === "string" ? settings.githubToken.trim() : "";
    }
    if (!token) return null;
    return {
      kind: "github", repo: github.repo, branch: text(sync.branch).trim(),
      path: [github.prefix, snapshot].filter(Boolean).join("/"), token, passphrase
    };
  } catch { return null; }
}
