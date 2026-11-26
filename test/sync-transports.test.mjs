import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJSON } from "../storage.mjs";
import { remoteIdentity, transport } from "../sync/config.mjs";
import { S3Contents, WebDAVContents } from "../sync/object-store.mjs";

const snapshot = "workbuddy-plus/accounts-v1.magpie-data";
const fixture = (t, config) => {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-transport-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeJSON(join(dir, "sync.json"), { passphrase: "test phrase", user: "fixture", password: "test-secret", ...config });
  return transport(dir);
};

test("uses Magpie's active WebDAV and S3 configuration without a second set of credentials", t => {
  const dav = fixture(t, { url: "https://dav.example.test/drive/" });
  assert.equal(dav.kind, "webdav");
  assert.equal(dav.path, snapshot);
  assert.equal(dav.user, "fixture");
  assert.notEqual(remoteIdentity(dav), remoteIdentity({ ...dav, user: "someone-else" }));
  const s3 = fixture(t, { url: "s3://fixtures/part%20one", endpoint: "fixture.r2.cloudflarestorage.com", pathStyle: true });
  assert.equal(s3.path, "part one/" + snapshot);
  assert.equal(s3.region, "auto");
  assert.equal(s3.accessKeyId, "fixture");
  assert.equal(s3.pathStyle, true);
  assert.equal(remoteIdentity(s3), remoteIdentity({ ...s3, secretAccessKey: "new-secret" }));
  assert.equal(fixture(t, { url: "http://dav.example.test/" }), null);
  assert.equal(fixture(t, { url: "s3://fixtures", endpoint: "https://bad:secret@example.test/" }), null);
});

test("S3 signs the configured endpoint and never falls back from conditional writes", async t => {
  const cfg = fixture(t, { url: "s3://fixtures/folder", endpoint: "https://storage.example.test/api", region: "eu-west-1", pathStyle: true });
  const seen = []; let responseCode = 200, readable = false;
  const store = new S3Contents({ ...cfg, fetcher: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
    assert.equal(request.redirect, "error");
    assert.equal(url.origin, "https://storage.example.test");
    const auth = request.headers.get("authorization");
    seen.push({ method: request.method, auth, url, headers: request.headers });
    if (!auth) return new Response(null, { status: readable ? 200 : 403 });
    assert.match(auth, /^AWS4-HMAC-SHA256 Credential=fixture\/\d{8}\/eu-west-1\/s3\/aws4_request,/);
    if (url.search) return new Response("<ListBucketResult><Contents><LastModified>ignored</LastModified><Key>folder/workbuddy-plus/followers/unit.json</Key><Size>12</Size></Contents></ListBucketResult>");
    assert.equal(url.pathname, "/api/fixtures/folder/" + snapshot);
    return request.method === "PUT" ? new Response(null, { status: responseCode }) : new Response("ciphertext", { headers: { etag: '"first"' } });
  } });
  await store.checkPrivate(cfg.path);
  const current = await store.read(cfg.path);
  assert.equal(current.sha, '"first"');
  assert.equal(current.data.toString(), "ciphertext");
  assert.deepEqual(await store.list("folder/workbuddy-plus/followers"), [{ name: "unit.json", size: 12 }]);
  await store.writeIf(cfg.path, Buffer.from("first"), "", null);
  assert.equal(seen.at(-1).headers.get("if-none-match"), "*");
  responseCode = 412;
  await assert.rejects(store.writeIf(cfg.path, Buffer.from("second"), "", current.sha), error => error.conflict);
  assert.equal(seen.at(-1).headers.get("if-match"), '"first"');
  assert.doesNotMatch(seen.at(-1).auth, /if-match/i, "providers may normalize ETags before verifying SigV4");
  assert.equal(seen.filter(r => r.method === "PUT").length, 2);
  responseCode = 501;
  await assert.rejects(store.writeIf(cfg.path, Buffer.from("x"), "", current.sha), /conditional write.*501/);
  assert.equal(seen.filter(r => r.method === "PUT").length, 3);
  readable = true;
  await assert.rejects(store.checkPrivate(cfg.path), /not confirmed private/);
});

test("WebDAV serializes creators with a server lock and verifies the ETag while holding it", async t => {
  const cfg = fixture(t, { url: "https://dav.example.test/dav/" });
  const calls = []; let locked = false, current = null, putRejected = false;
  const lockToken = "<opaquelocktoken:test-token>";
  const store = new WebDAVContents({ ...cfg, fetcher: async (url, init) => {
    const req = new Request(url, init), method = req.method;
    calls.push([method, url.pathname]);
    assert.equal(req.redirect, "error");
    assert.equal(url.origin, "https://dav.example.test");
    if (!req.headers.has("authorization")) return new Response(null, { status: 401 });
    assert.equal(req.headers.get("authorization"), "Basic " + Buffer.from("fixture:test-secret").toString("base64"));
    if (method === "MKCOL") return new Response(null, { status: 201 });
    if (method === "LOCK") {
      assert.equal(req.headers.get("depth"), "infinity");
      if (locked) return new Response(null, { status: 423 });
      locked = true;
      return new Response(null, { status: 200, headers: { "lock-token": lockToken.slice(1, -1) } });
    }
    if (method === "UNLOCK") {
      assert.equal(req.headers.get("lock-token"), lockToken);
      locked = false;
      return new Response(null, { status: 204 });
    }
    if (method === "GET") return current ? new Response(current, { headers: { etag: '"old"' } }) : new Response(null, { status: 404 });
    if (method === "PROPFIND") return new Response(' <d:multistatus><d:href>/dav/workbuddy-plus/followers/unit.json</d:href><d:href>https://foreign.example.test/dav/workbuddy-plus/followers/other.json</d:href></d:multistatus>', { status: 207 });
    assert.equal(method, "PUT");
    assert.equal(url.pathname, "/dav/" + snapshot);
    assert.equal(locked, true);
    assert.equal(req.headers.get("if"), `(${lockToken})`);
    if (putRejected) return new Response(null, { status: 501 });
    assert.equal(req.headers.get("if-none-match"), "*");
    current = await req.text();
    return new Response(null, { status: 201 });
  } });
  await store.checkPrivate(snapshot);
  assert.deepEqual(await store.list("workbuddy-plus/followers"), [{ name: "unit.json", size: 0 }]);
  await store.writeIf(snapshot, Buffer.from("ciphertext"), "", null);
  assert.equal(current, "ciphertext");
  await assert.rejects(store.writeIf(snapshot, Buffer.from("stale"), "", null), e => e.conflict);
  assert.equal(calls.filter(([method]) => method === "PUT").length, 1);
  assert.equal(locked, false, "conflicts still release the lock");
  putRejected = true;
  await assert.rejects(store.writeIf(snapshot, Buffer.from("unsafe"), "", '"old"'), /conditional write/);
  assert.equal(calls.filter(([method]) => method === "PUT").length, 2);
  assert.equal(locked, false);
});

test("a denied directory listing and a missing object do not prove a new snapshot will be private", async t => {
  for (const [Store, params] of [[S3Contents, { url: "s3://fixtures" }], [WebDAVContents, { url: "https://dav.example.test/" }]]) {
    const cfg = fixture(t, params);
    let objectStatus = 404;
    const calls = [];
    const store = new Store({ ...cfg, fetcher: async (url, options) => {
      const req = new Request(url, options);
      calls.push(req);
      return new Response(null, { status: req.url.endsWith(snapshot) ? objectStatus : 403 });
    } });
    await assert.rejects(store.checkPrivate(snapshot), /not confirmed private/);
    objectStatus = 403;
    await store.checkPrivate(snapshot);
    assert(calls.every(req => !req.headers.has("authorization")));
    assert(calls.filter(req => req.url.endsWith(snapshot)).every(req => req.method === "GET"),
      "test anonymous object reads, not just HEAD permissions");
  }
});
