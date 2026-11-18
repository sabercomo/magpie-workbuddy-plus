import test from "node:test";
import assert from "node:assert/strict";
import { WorkBuddyClient } from "../client.mjs";
import { dropped } from "../network.mjs";

const account = { id: "cn:a", name: "A", realm: "cn", auth: { access: "secret", uid: "a" } };
const client = (proxy, error) => new WorkBuddyClient(account, { proxy }, {
  gap: 0,
  wait: async () => {},
  fetcher: async () => { throw error; }
});

async function call(subject) {
  try { await subject.fetch("https://www.workbuddy.cn/v2/test"); }
  catch (error) { return error; }
  assert.fail("fetch should fail");
}

test("a proxy that refuses the connection says so without leaking its login", async () => {
  const raw = Object.assign(new Error("ECONNREFUSED: Unable to connect. Is the computer able to access the url?"), { code: "ECONNREFUSED" });
  const error = await call(client("http://user:secret@127.0.0.1:1082", raw));
  assert.equal(error.message, "代理 127.0.0.1:1082 连不上，检查代理设置或清空代理");
  assert.equal(error.diagnostic, "http://127.0.0.1:1082 · ECONNREFUSED");
  assert.equal(error.cause, raw);
  assert.ok(!/user|secret/.test(`${error.message} ${error.diagnostic}`));
  assert.ok(dropped(error), "the short proxy error still counts as a network failure");
});

test("a proxy marked down keeps counting as a network failure without an error code", async () => {
  const raw = new Error("Unable to connect. Is the computer able to access the url?");
  const error = await call(client("http://127.0.0.1:1082", raw));
  assert.equal(error.message, "代理 127.0.0.1:1082 连不上，检查代理设置或清空代理");
  assert.equal(error.diagnostic, "http://127.0.0.1:1082 · Error");
  assert.ok(dropped(error));
});

test("without a proxy the upstream error is left as it is", async () => {
  const raw = Object.assign(new Error("ECONNREFUSED: Unable to connect. Is the computer able to access the url?"), { code: "ECONNREFUSED" });
  const error = await call(client("", raw));
  assert.equal(error, raw);
});

test("an upstream refusal with a status is not called a proxy failure", async () => {
  const raw = Object.assign(new Error("HTTP 403，denied"), { status: 403 });
  const error = await call(client("http://127.0.0.1:1082", raw));
  assert.equal(error, raw);
  assert.ok(!dropped(error));
});

test("the existing tunnel refusal keeps its own explanation", async () => {
  const raw = new Error("Proxy refused to open a tunnel: 503 Service Unavailable");
  const error = await call(client("http://127.0.0.1:1082", raw));
  assert.match(error.message, /^HTTP 代理无法连接 www\.workbuddy\.cn（503 Service Unavailable）/);
  assert.equal(error.cause, raw);
});
