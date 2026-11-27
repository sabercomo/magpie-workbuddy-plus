import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { channel } from "./events.mjs";
import { note as noteLimit, forget as forgetLimit } from "./limits.mjs";
import { proxyFor } from "./storage.mjs";

// What an error may say about the proxy: its address for the message, its
// origin for diagnostics. A login in the URL is never shown.
const proxyParts = proxy => {
  try {
    const url = new URL(proxy);
    return { host: url.host, origin: url.origin };
  } catch {
    const plain = String(proxy).replace(/\/\/[^/@]*@/, "//").replace(/^[^/@]*@/, "");
    return { host: plain, origin: plain };
  }
};

// Each build answers on its own site; WorkBuddy AI keeps its billing there too.
const sites = {
  cn: { origin: "https://www.workbuddy.cn", billing: "https://www.codebuddy.cn", app: "WorkBuddy" },
  intl: { origin: "https://www.workbuddy.ai", billing: "https://www.workbuddy.ai", app: "workbuddy-ai" }
};

export class UpstreamError extends Error {
  constructor(path, status, payload) {
    super(`${path}: HTTP ${status}，${payload.msg || payload.message || `code=${payload.code}`}`);
    this.code = payload.code;
    this.status = status;
    this.restricted = isRestricted(status, payload);
  }
}

// Upstream tells an account it has been blocked or its channel is no longer
// accepted with these codes/messages. Retrying the same account only makes it
// worse, so the scheduler stops automatic runs for the rest of the day.
export function isRestricted(status, payload = {}) {
  // 11140 is shared by account restrictions and model/provider refusals.
  if (status === 429) return false;
  const code = String(payload?.code ?? "");
  const message = String(payload?.msg || payload?.message || "");
  if (code === "11-128" || /(?:\b11-128\b|\bunapproved channel\b)/i.test(message)) return true;
  if (/(?:\baccount (?:is |has been )?(?:restricted|blocked|suspended|banned)\b|账号(?:存在异常行为|受限|已被限制|已被封禁))/i.test(message)) return true;
  return code.trim() === "11140" && /\b(?:request illegal|unusual activity)\b/i.test(message);
}

// Too many requests: the upstream turned the call away without acting on it,
// so it is safe to send again later. Jobs that only hit this are deferred,
// not failed.
export class RateLimited extends UpstreamError {
  constructor(path, payload) {
    super(path, 429, payload);
    this.message = `${path}: 上游限流（HTTP 429），稍后会自动重试`;
    this.limited = true;
  }
}

// Retry-After is seconds or an HTTP date; without one, back off 5 s then 20 s.
export function backoff(response, attempt) {
  const header = response.headers.get("retry-after");
  const seconds = header == null ? NaN : /^\d+$/.test(header.trim()) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
  return Math.min(60_000, Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : [5000, 20_000][attempt] ?? 20_000));
}

export class WorkBuddyClient {
  constructor(account, config, { fetcher = fetch, gap = 1000, signal, wait = delay, limits = null, taskCache, onRetry } = {}) {
    this.account = account;
    this.taskCache = taskCache;
    this.onRetry = onRetry;
    this.wait = wait;
    this.config = config;
    this.proxy = proxyFor(config, account.realm);
    this.fetcher = fetcher;
    this.gap = gap;
    this.signal = signal;
    this.limits = limits;
    this.lastRequest = 0;
    this.site = sites[account.realm] || sites.cn;
  }

  headers() {
    const a = this.account.auth, { origin, app } = this.site;
    const headers = {
      Authorization: `Bearer ${a.access}`, "X-User-Id": a.uid,
      "Content-Type": "application/json", Accept: "application/json, text/plain, */*",
      Origin: origin, Referer: `${origin}/profile/growth-center`
    };
    Object.assign(headers, {
      "X-Domain": a.domain || new URL(origin).host, "X-Product": "SaaS",
      "X-IDE-Type": "WorkBuddy", "X-IDE-Name": "WorkBuddy", "X-IDE-Version": "5.9.3",
      "X-Requested-With": "XMLHttpRequest", "X-Agent-Intent": "craft", "X-Agent-Purpose": "conversation",
      "User-Agent": `WorkBuddy/5.9.3 ${app}/5.9.3 CLI/2.165.0`,
      ...(a.enterpriseId ? { "X-Enterprise-Id": a.enterpriseId, "X-Tenant-Id": a.enterpriseId } : { "X-No-Enterprise-Id": "1" })
    });
    return headers;
  }

  // A real chat refused with 6004/6020 is remembered for the board.
  recordLimit(model, payload) { noteLimit(this.limits, model, payload); }
  clearLimit(model) { forgetLimit(this.limits, model); }

  async fetch(url, init = {}, timeout = 30_000) {
    if (this.proxy && !globalThis.Bun && this.fetcher === globalThis.fetch) throw new Error("HTTP 代理需要使用 Bun 启动 WorkBuddy Plus");
    const wait = this.gap - (Date.now() - this.lastRequest);
    if (wait > 0) await delay(wait, undefined, { signal: this.signal });
    this.lastRequest = Date.now();
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    try {
      // Omitting proxy lets Bun inherit HTTP(S)_PROXY, even for saved direct mode.
      return await this.fetcher(url, { ...init, signal, proxy: this.proxy || false });
    } catch (error) {
      const refused = /^Proxy refused to open a tunnel: (\d{3}\b.*)/i.exec(error.message);
      if (refused) throw new Error(`HTTP 代理无法连接 ${new URL(url).hostname}（${refused[1]}）。请检查代理节点和分流；可直连时，到设置清空对应代理再刷新。`, { cause: error });
      // A local proxy that isn't listening is not an account failure. Keep the
      // raw error for logs and diagnostics, and say what the user can check.
      const down = this.proxy && /ECONNREFUSED|Unable to connect|proxyconnect/i.test(`${error.code || ""} ${error.name || ""} ${error.message || ""}`);
      if (!down) throw error;
      const { host, origin } = proxyParts(this.proxy);
      throw Object.assign(new Error(`代理 ${host} 连不上，检查代理设置或清空代理`, { cause: error }), {
        code: error.code, name: error.name, proxy: true, diagnostic: `${origin} · ${error.code || error.name || "error"}`
      });
    }
  }

  // `extra` adds headers to this client's own; `headers` replaces them (a
  // report sent as the desktop, web or mini-program client would).
  async request(path, { body, billing = false, envelope = false, base = billing ? this.site.billing : this.site.origin, extra, headers } = {}) {
    const cacheable = body === undefined && path === "/v2/activity/growth/tasks" && this.taskCache && this.config.tasksCacheTtl > 0;
    const scope = `${this.account.id}:${base}:`;
    const fingerprint = headers ? headers() : extra || {};
    const cacheKey = scope + JSON.stringify(Object.fromEntries(["X-IDE-Type", "X-IDE-Name", "X-Client-Platform", "X-Client-Product", "User-Agent"].map(key => [key, fingerprint[key] || ""])));
    if (cacheable) {
      const saved = this.taskCache.get(cacheKey);
      if (saved && Date.now() - saved.at < this.config.tasksCacheTtl * 1000) return structuredClone(envelope ? saved.payload : saved.payload.data);
    }
    const cacheTicket = { at: 0 };
    if (cacheable) this.taskCache.set(cacheKey, cacheTicket);
    // Mutations invalidate both desktop and mini-program task lists, including
    // ambiguous failures: a write may have reached upstream before it timed out.
    const changesTasks = path === "/v2/report" || /^\/(?:v2\/)?activity\/growth\/.*(?:accept|claim|depart|open|redeem|use)$/.test(path);
    if (body !== undefined && changesTasks && this.taskCache) for (const key of this.taskCache.keys()) if (key.startsWith(`${this.account.id}:`)) this.taskCache.delete(key);
    const request = randomUUID();
    let response, retried = false, finalAttempt;
    for (let attempt = 0; ; attempt++) {
      response = await this.fetch(base + path, {
        method: body === undefined ? "GET" : "POST", headers: headers ? headers() : { ...this.headers(), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      finalAttempt = attempt + 1;
      if (response.status !== 429) break;
      retried = true;
      let payload = {};
      try { payload = JSON.parse(await response.text()); } catch {}
      this.recordLimit(body?.model, payload);
      const waitMs = attempt === 2 ? 0 : backoff(response, attempt);
      this.onRetry?.({ request, path, at: new Date().toISOString(), status: 429, attempt: attempt + 1, waitMs, error: true });
      if (attempt === 2) throw new RateLimited(path, payload);
      await this.wait(waitMs, undefined, { signal: this.signal });
    }
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw Object.assign(new Error(`${path}: HTTP ${response.status}，上游返回 ${response.headers.get("content-type") || "未知类型"}，不是 JSON`), { status: response.status }); }
    const refused = !response.ok || (payload.code !== undefined && payload.code !== 0);
    if (retried) this.onRetry?.({ request, path, at: new Date().toISOString(), status: response.status, attempt: finalAttempt, waitMs: 0, error: refused });
    if (refused) throw new UpstreamError(path, response.status, payload);
    if (body?.model) this.clearLimit(body.model);
    if (cacheable && this.taskCache.get(cacheKey) === cacheTicket) this.taskCache.set(cacheKey, { at: Date.now(), payload: structuredClone(payload) });
    return envelope ? payload : payload.data;
  }

  // Events for a growth task, sent as the client that task counts: this
  // one's own (the CLI) when `via` names none.
  async report(events, via) {
    const as = via && channel(via, this.account);
    if (!as) return this.request("/v2/report", { body: events });
    return this.request("/v2/report", { body: events.map(e => ({ ...as.stamp, ...e })), base: as.base, headers: () => channel(via, this.account).headers });
  }
}
