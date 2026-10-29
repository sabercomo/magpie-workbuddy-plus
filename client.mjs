import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readJSON, writeJSON, withLock } from "./storage.mjs";

const origin = "https://www.workbuddy.cn";

export class UpstreamError extends Error {
  constructor(path, status, payload) {
    super(`${path}: HTTP ${status}，${payload.msg || payload.message || `code=${payload.code}`}`);
    this.code = payload.code;
    this.status = status;
  }
}

export class WorkBuddyClient {
  constructor(account, config, { fetcher = fetch, gap = 1000, signal } = {}) {
    this.account = account;
    this.config = config;
    this.fetcher = fetcher;
    this.gap = gap;
    this.signal = signal;
    this.lastRequest = 0;
  }

  headers() {
    const a = this.account.auth;
    const headers = {
      Authorization: `Bearer ${a.access}`, "X-User-Id": a.uid,
      "Content-Type": "application/json", Accept: "application/json, text/plain, */*",
      Origin: origin, Referer: `${origin}/profile/growth-center`
    };
    Object.assign(headers, {
      "X-Domain": a.domain || new URL(origin).host, "X-Product": "SaaS",
      "X-IDE-Type": "WorkBuddy", "X-IDE-Name": "WorkBuddy", "X-IDE-Version": "5.9.3",
      "X-Requested-With": "XMLHttpRequest", "X-Agent-Intent": "craft", "X-Agent-Purpose": "conversation",
      "User-Agent": "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0",
      ...(a.enterpriseId ? { "X-Enterprise-Id": a.enterpriseId, "X-Tenant-Id": a.enterpriseId } : { "X-No-Enterprise-Id": "1" })
    });
    return headers;
  }

  async fetch(url, init = {}) {
    if (this.config.proxy && !globalThis.Bun && this.fetcher === globalThis.fetch) throw new Error("HTTP 代理需要使用 Bun 启动 WorkBuddy Plus");
    const wait = this.gap - (Date.now() - this.lastRequest);
    if (wait > 0) await delay(wait, undefined, { signal: this.signal });
    this.lastRequest = Date.now();
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    return this.fetcher(url, { ...init, signal, ...(this.config.proxy ? { proxy: this.config.proxy } : {}) });
  }

  async request(path, { body, billing = false, renew = true, envelope = false, base = billing ? "https://www.codebuddy.cn" : origin } = {}) {
    if (renew) await this.refresh();
    const response = await this.fetch(base + path, {
      method: body === undefined ? "GET" : "POST", headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new Error(`${path}: HTTP ${response.status}，上游返回 ${response.headers.get("content-type") || "未知类型"}，不是 JSON`); }
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) throw new UpstreamError(path, response.status, payload);
    return envelope ? payload : payload.data;
  }

  async refresh(force = false) {
    const account = this.account;
    if (!force && (!account.auth.expires || account.auth.expires > Date.now() + 2 * 3600_000)) return false;
    const refreshLocked = async () => {
      const rows = readJSON(account.file);
      const auth = rows[account.key];
      account.auth = auth;
      if (!force && auth.expires > Date.now() + 2 * 3600_000) return false;
      if (!auth.refresh) throw new Error("账号登录已过期，请在 Magpie 重新登录");
      const response = await this.fetch(origin + "/v2/plugin/auth/token/refresh", {
        method: "POST", headers: { ...this.headers(), "X-Refresh-Token": auth.refresh, "X-Auth-Refresh-Source": "plugin" }, body: "{}"
      });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw new UpstreamError("刷新登录", response.status, result);
      const got = result.data;
      if (!got?.accessToken) throw new Error("刷新响应缺少 accessToken");
      const next = { ...auth, access: got.accessToken, refresh: got.refreshToken || auth.refresh, expires: got.expiresAt || Date.now() + got.expiresIn * 1000 };
      if (!Number.isFinite(next.expires)) throw new Error("刷新响应缺少有效到期时间");
      for (const key of ["domain", "tokenType", "refreshExpiresAt"]) if (got[key] !== undefined) next[key] = got[key];
      if (got.refreshExpiresIn) next.refreshExpiresAt = Date.now() + got.refreshExpiresIn * 1000;
      await withLock(account.file + ".lock", 10_000, async () => {
          const current = readJSON(account.file);
          if (current[account.key].refresh !== auth.refresh) throw new Error("账号在刷新期间被修改，请重试");
          writeJSON(account.file + ".bak", current);
          current[account.key] = next;
          writeJSON(account.file, current);
      });
      account.auth = next;
      return true;
    };
    const digest = createHash("sha256").update(account.key).digest("hex").slice(0, 16);
    return withLock(`${account.file}.renew-${digest}.lock`, 60_000, refreshLocked);
  }
}
