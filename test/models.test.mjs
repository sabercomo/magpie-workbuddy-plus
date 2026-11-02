import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, creditsOf, intlModels } from "../models.mjs";

const now = Date.parse("2026-11-02T15:00:00+08:00");
const config = {
  agents: [{ name: "cli", models: ["auto", "hy3", "hy3-x", "glm-5.2", "gpt-x", "glm-5.3"] }, { name: "other", models: ["video"] }],
  models: [
    { id: "auto", name: "Auto", credits: "", maxInputTokens: 256000, isDefault: true, descriptionZh: "自动选择" },
    { id: "hy3", name: "Hy3", credits: "x0.00", maxInputTokens: 192000 },
    { id: "hy3-x", name: "Hy3", credits: "x0.05" },
    { id: "glm-5.2", name: "GLM-5.2", credits: "x0.79 credits" },
    { id: "gpt-x", name: "GPT-X", credits: "x1.33" },
    { id: "glm-5.3", name: "GLM-5.3", credits: "x0.69" },
    { id: "video", name: "Video", credits: "x9" }
  ],
  modelTiers: [
    { enabled: true, badge: { label: "Pro Only" }, hover: { textZh: "模型仅面向 Pro 用户开放。" }, modelIds: ["gpt-x"] },
    { enabled: true, badge: { label: "订阅优先" }, hover: { textZh: "资源紧张，会员优先调度。" }, modelIds: ["glm-5.3"] }
  ],
  modelPromotions: [
    { kind: "discount", enabled: true, badge: { label: "限时免费" }, discount: { discountedCredits: "0x" }, modelIds: ["hy3"], schedule: { validUntil: "2026-11-16T00:00:00+08:00" } },
    { kind: "discount", enabled: true, badge: { label: "过期" }, discount: { factor: 0 }, modelIds: ["hy3-x"], schedule: { validUntil: "2026-11-01T00:00:00+08:00" } },
    { kind: "discount", enabled: true, badge: { label: "夜间折扣" }, modelIds: ["glm-5.2"], schedule: { daily: [{ start: "7:50", end: "23:00" }] } },
    { kind: "discount", enabled: true, badge: { label: "夜间折扣" }, discount: { discountedCredits: "0.50x" }, modelIds: ["glm-5.2"], schedule: { daily: [{ start: "23:00", end: "7:50" }] } }
  ]
};

test("credit multipliers read in each spelling WorkBuddy uses; Auto's empty one floats", () => {
  assert.deepEqual(["x0.34 credits", "x0.00", "0.50x", "0x", 0, "", null, "abc"].map(creditsOf), [0.34, 0, 0.5, 0, 0, null, null, null]);
});

test("the catalog is the CLI's list in order, with tiers, live promotions and names told apart", () => {
  const list = catalog(config, now);
  assert.deepEqual(list.map(m => [m.id, m.name, m.rate]), [["auto", "Auto", null], ["hy3", "Hy3", 0], ["hy3-x", "Hy3 (X)", 0.05], ["glm-5.2", "GLM-5.2", 0.79], ["gpt-x", "GPT-X", 1.33], ["glm-5.3", "GLM-5.3", 0.69]]);
  assert.equal(list[0].isDefault, true);
  // "Pro Only" shuts free plans out; 「订阅优先」 only queues them.
  assert.deepEqual([list[4].tier.exclusive, list[5].tier.exclusive], [true, false]);
  assert.equal(list[2].promo, undefined, "an ended promotion is dropped");
  assert.deepEqual({ ...list[1].promo, note: undefined }, { label: "限时免费", note: undefined, hours: "", until: Date.parse("2026-11-16T00:00:00+08:00"), rate: 0 });
  // The badge-only daytime promotion and the priced night one read as one offer.
  assert.deepEqual([list[3].promo.label, list[3].promo.hours, list[3].promo.rate], ["夜间折扣", "23:00–07:50", 0.5]);
});

test("the international list reads with the plan, and an expired login is reported, not renewed", async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push([new URL(url).pathname, init.method, init.headers.Authorization]);
    return Response.json({ code: 0, data: url.endsWith("/v3/config") ? config : { SubscriptionPackageName: "Free", IsPaidUser: false } });
  };
  const account = { name: "abroad", auth: { uid: "u9", access: "intl-access", expires: now + 86400_000 } };
  const got = await intlModels(account, { fetcher, now });
  assert.deepEqual(got.plan, { name: "Free", paid: false });
  assert.equal(got.models.length, 6);
  assert.deepEqual(seen, [["/v3/config", "GET", "Bearer intl-access"], ["/billing/meter/get-user-resource-summary", "POST", "Bearer intl-access"]]);
  await assert.rejects(intlModels({ ...account, auth: { ...account.auth, expires: now - 1 } }, { fetcher, now }), /国际版登录已过期/);
  assert.equal(seen.length, 2);
});
