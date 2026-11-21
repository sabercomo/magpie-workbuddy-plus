import test from "node:test";
import assert from "node:assert/strict";
import { defaults, proxyFor, settle, validateConfig } from "../storage.mjs";
import { WorkBuddyClient } from "../client.mjs";
import { intlModels } from "../models.mjs";

const account = realm => ({ id: `${realm}:a`, name: "A", realm, auth: { access: "secret", uid: "a" } });

test("the international proxy follows the shared one unless it has its own", () => {
  assert.equal(proxyFor({ proxy: "http://127.0.0.1:1082", intlProxy: "" }, "cn"), "http://127.0.0.1:1082");
  assert.equal(proxyFor({ proxy: "http://127.0.0.1:1082", intlProxy: "" }, "intl"), "http://127.0.0.1:1082");
  assert.equal(proxyFor({ proxy: "http://127.0.0.1:1082", intlProxy: "http://127.0.0.1:7890" }, "intl"), "http://127.0.0.1:7890");
  assert.equal(proxyFor({ proxy: "http://127.0.0.1:1082", intlProxy: "direct" }, "intl"), "");
  assert.equal(proxyFor({ proxy: "", intlProxy: "direct" }, "cn"), "");
});

test("the international proxy is validated without changing saved configs", () => {
  const base = { ...defaults, enabled: true, disabledAccounts: [], pausedAccounts: [] };
  assert.equal(validateConfig({ ...base, intlProxy: "" }).intlProxy, "");
  assert.equal(validateConfig({ ...base, intlProxy: "direct" }).intlProxy, "direct");
  assert.equal(validateConfig({ ...base, intlProxy: "http://127.0.0.1:1082" }).intlProxy, "http://127.0.0.1:1082");
  assert.throws(() => validateConfig({ ...base, intlProxy: "127.0.0.1:1082" }), /国际版代理需要/);
  assert.throws(() => validateConfig({ ...base, intlProxy: 1 }), /国际版代理无效/);
  assert.equal(settle({ ...base, intlProxy: undefined }).intlProxy, "", "an older config follows the shared proxy");
});

test("a client sends China's and WorkBuddy AI's requests through their own proxy", async () => {
  const seen = [];
  const fetcher = async (url, init) => { seen.push([url, init.proxy]); return new Response("{}", { status: 200 }); };
  const config = { proxy: "http://127.0.0.1:1082", intlProxy: "" };
  const cn = new WorkBuddyClient(account("cn"), config, { gap: 0, wait: async () => {}, fetcher });
  const intl = new WorkBuddyClient(account("intl"), config, { gap: 0, wait: async () => {}, fetcher });
  await cn.fetch("https://www.workbuddy.cn/v2/test");
  await intl.fetch("https://www.workbuddy.ai/v2/test");
  assert.deepEqual(seen, [
    ["https://www.workbuddy.cn/v2/test", "http://127.0.0.1:1082"],
    ["https://www.workbuddy.ai/v2/test", "http://127.0.0.1:1082"]
  ]);
});

test("the international proxy can differ from China's or be direct", async () => {
  const seen = [];
  const fetcher = async (url, init) => { seen.push([url, init.proxy]); return new Response("{}", { status: 200 }); };
  const config = { proxy: "", intlProxy: "http://127.0.0.1:1082" };
  const cn = new WorkBuddyClient(account("cn"), config, { gap: 0, wait: async () => {}, fetcher });
  const intl = new WorkBuddyClient(account("intl"), config, { gap: 0, wait: async () => {}, fetcher });
  await cn.fetch("https://www.workbuddy.cn/v2/test");
  await intl.fetch("https://www.workbuddy.ai/v2/test");
  assert.deepEqual(seen, [
    ["https://www.workbuddy.cn/v2/test", false],
    ["https://www.workbuddy.ai/v2/test", "http://127.0.0.1:1082"]
  ]);
  const direct = new WorkBuddyClient(account("intl"), { proxy: "http://127.0.0.1:1082", intlProxy: "direct" }, { gap: 0, wait: async () => {}, fetcher });
  await direct.fetch("https://www.workbuddy.ai/v2/test");
  assert.equal(seen.at(-1)[1], false, "direct explicitly disables inherited environment proxies");
});

test("direct requests ignore a dead inherited proxy, including international model reads", async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    // Bun falls back to HTTP(S)_PROXY when the option is absent or empty.
    if (init.proxy !== false) throw Object.assign(new Error("inherited proxy refused"), { code: "ECONNREFUSED" });
    seen.push(new URL(url).pathname);
    return Response.json({ code: 0, data: {} });
  };
  await new WorkBuddyClient(account("cn"), { proxy: "" }, { gap: 0, fetcher }).request("/v2/activity/growth/tasks");
  await intlModels(account("intl"), { fetcher });
  assert.deepEqual(seen, ["/v2/activity/growth/tasks", "/v3/config", "/billing/meter/get-user-resource-summary"]);
});
