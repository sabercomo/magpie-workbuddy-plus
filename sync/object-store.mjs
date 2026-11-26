import { AwsClient } from "./vendor/aws4fetch.mjs";

const maxBytes = 2 * 1024 * 1024;
const strongETag = tag => /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(tag || "");
const contents = file => file.split("/").map(encodeURIComponent).join("/");
const conflict = () => Object.assign(new Error("Remote version changed"), { conflict: true });
const discard = res => res.body?.cancel().catch(() => {});

async function bytes(response) {
  const chunks = [], reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      if ((total += value.byteLength) > maxBytes) throw new Error("Remote file is too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function fail(where, status) { return new Error(`${where}: HTTP ${status}`); }

class Objects {
  constructor({ endpoint, fetcher = fetch, signal }) {
    this.endpoint = new URL(endpoint);
    this.fetcher = fetcher;
    this.signal = signal;
  }

  async request(url, method, headers, body, anonymous = false) {
    const timeout = AbortSignal.timeout(15_000);
    const opts = { method, headers, body, cache: "no-store", redirect: "error", signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout };
    return anonymous ? this.fetcher(url, opts) : this.send(url, opts);
  }

  async privateCheck(url, method, headers) {
    const res = await this.request(url, method, headers, undefined, true);
    await discard(res);
    // A missing object says nothing about who could read it after the first write.
    if (![401, 403].includes(res.status)) throw new Error("Sync storage is not confirmed private");
  }

  async read(file) {
    const res = await this.request(this.url(file), "GET", { "Accept-Encoding": "identity" });
    if (res.status === 404) { await discard(res); return null; }
    if (!res.ok) { await discard(res); throw fail("Remote read failed", res.status); }
    const sha = res.headers.get("etag");
    if (!strongETag(sha)) { await discard(res); throw new Error("Sync storage did not provide a strong ETag"); }
    return { sha, data: await bytes(res) };
  }

  async put(file, data, expected, headers = {}) {
    if (expected !== null && !strongETag(expected)) throw new Error("Invalid ETag for conditional write");
    const res = await this.request(this.url(file), "PUT", {
      ...headers, "Content-Type": "application/octet-stream",
      ...(expected === null ? { "If-None-Match": "*" } : { "If-Match": expected })
    }, data);
    await discard(res);
    if (res.status === 409 || res.status === 412 || res.status === 423) throw conflict();
    if (!res.ok) throw fail("Remote conditional write failed", res.status);
  }
}

// Uses Magpie's S3 endpoint/path-style convention, with the AWS signing
// implementation vendored verbatim. Never use Magpie's blind-write fallback.
export class S3Contents extends Objects {
  constructor(config) {
    super(config);
    this.bucket = config.bucket;
    this.pathStyle = config.pathStyle;
    this.signer = new AwsClient({ ...config, service: "s3" });
  }

  url(file = "") {
    const url = new URL(this.endpoint);
    if (!this.pathStyle) url.hostname = `${this.bucket}.${url.hostname}`;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${this.pathStyle ? this.bucket + "/" : ""}${contents(file)}`;
    return url;
  }

  async send(url, opts) {
    // Magpie also leaves HTTP preconditions outside SignedHeaders: some
    // compatible servers normalize ETags before checking a signature.
    const headers = new Headers(opts.headers), conditions = [];
    for (const key of ["If-Match", "If-None-Match"]) {
      if (headers.has(key)) { conditions.push([key, headers.get(key)]); headers.delete(key); }
    }
    const signed = await this.signer.sign(url, { ...opts, headers });
    for (const [key, value] of conditions) signed.headers.set(key, value);
    return this.fetcher(signed);
  }

  listing(dir) {
    const url = this.url();
    url.search = new URLSearchParams({ "list-type": "2", "max-keys": "100", prefix: `${dir}/` }).toString();
    return url;
  }

  async checkPrivate(file) {
    await this.privateCheck(this.listing(file.slice(0, file.lastIndexOf("/"))), "GET");
    await this.privateCheck(this.url(file), "GET");
  }

  async list(dir) {
    const res = await this.request(this.listing(dir), "GET");
    if (!res.ok) { await discard(res); throw fail("S3 list failed", res.status); }
    const xml = (await bytes(res)).toString("utf8"), prefix = dir + "/";
    return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].flatMap(([, entry]) => {
      const key = (entry.match(/<Key>([^<]+)<\/Key>/)?.[1] || "").replace(/&(amp|lt|gt|quot|apos);/g,
        (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]);
      const name = key.startsWith(prefix) ? key.slice(prefix.length) : "", size = Number(entry.match(/<Size>(\d+)<\/Size>/)?.[1]);
      return name && !name.includes("/") && Number.isSafeInteger(size) ? [{ name, size }] : [];
    });
  }

  writeIf(file, data, _message, expected = null) { return this.put(file, data, expected); }
}

const lockXML = '<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>';

// Uses Magpie's WebDAV address/auth and MKCOL convention. Require an exclusive
// collection lock as well as ETags: some DAV servers check If-None-Match
// separately from creating the file, which cannot safely grant a master lease.
export class WebDAVContents extends Objects {
  constructor(config) {
    super(config);
    this.authorization = "Basic " + Buffer.from(`${config.user}:${config.password}`, "utf8").toString("base64");
  }

  url(file = "") {
    const url = new URL(this.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${contents(file)}`;
    return url;
  }

  send(url, opts) { return this.fetcher(url, { ...opts, headers: { ...opts.headers, Authorization: this.authorization } }); }

  async checkPrivate(file) {
    await this.privateCheck(this.url(), "PROPFIND", { Depth: "0" });
    await this.privateCheck(this.url(file), "GET");
  }

  async mkdir(dir, headers) {
    const res = await this.request(this.url(dir + "/"), "MKCOL", headers);
    await discard(res);
    if (!res.ok && res.status !== 405) throw fail("WebDAV collection creation failed", res.status);
  }

  async writeIf(file, data, _message, expected = null) {
    const root = file.split("/")[0], locked = this.url(root + "/");
    await this.mkdir(root);
    const res = await this.request(locked, "LOCK", { Depth: "infinity", Timeout: "Second-45", "Content-Type": "application/xml; charset=utf-8" }, lockXML);
    await discard(res);
    if (res.status === 423) throw conflict();
    if (!res.ok) throw fail("WebDAV exclusive lock is required", res.status);
    const rawToken = (res.headers.get("lock-token") || "").trim();
    const lockUri = rawToken.startsWith("<") && rawToken.endsWith(">") ? rawToken.slice(1, -1) : rawToken;
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]+$/.test(lockUri)) throw new Error("WebDAV lock token missing");
    const token = `<${lockUri}>`;
    try {
      const current = await this.read(file);
      if ((current?.sha || null) !== expected) throw conflict();
      const headers = { If: `(${token})` }, parent = file.slice(0, file.lastIndexOf("/"));
      if (parent !== root) await this.mkdir(parent, headers);
      await this.put(file, data, expected, headers);
    } finally {
      try { await discard(await this.request(locked, "UNLOCK", { "Lock-Token": token })); } catch {}
    }
  }

  async list(dir) {
    const base = this.url(dir + "/"), res = await this.request(base, "PROPFIND", { Depth: "1" });
    if (res.status === 404) { await discard(res); return []; }
    if (!res.ok) { await discard(res); throw fail("WebDAV list failed", res.status); }
    const xml = (await bytes(res)).toString("utf8");
    return [...xml.matchAll(/<(?:[\w-]+:)?href\b[^>]*>([^<]+)<\//gi)].flatMap(([, href]) => {
      try {
        const child = new URL(href.trim(), base);
        if (child.origin !== base.origin || !child.pathname.startsWith(base.pathname)) return [];
        const name = decodeURIComponent(child.pathname.slice(base.pathname.length));
        return name && !name.includes("/") ? [{ name, size: 0 }] : [];
      } catch { return []; }
    });
  }
}
