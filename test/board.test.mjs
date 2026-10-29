import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, initialize, readJSON, writeJSON } from "../storage.mjs";
import { WorkBuddyClient } from "../client.mjs";
import { summarize, usage, collect, taskBoard, pageBuild, allowance } from "../board.mjs";
import { Runner } from "../runner.mjs";

const ok = data => Response.json({ code: 0, data });
const clientFor = serve => {
  const seen = [];
  const account = { id: "cn:u1", name: "fixture", auth: { uid: "u1", access: "private-access", expires: Date.now() + 86400_000 } };
  const client = new WorkBuddyClient(account, defaults, { gap: 0, fetcher: async (url, init = {}) => {
    seen.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return serve(new URL(url), seen.at(-1));
  } });
  return { account, client, seen };
};

test("packages merge by name, drop ended cycles and treat placeholder expiry as long-term", () => {
  const now = Date.parse("2026-10-29T12:00:00+08:00");
  const got = summarize([
    { PackageName: "活动赠送", CapacityRemain: 10, CapacitySize: 20, ExpiredTime: "2026-11-01 00:00:00" },
    { PackageName: "活动赠送", CapacityRemain: 5, CapacitySize: 5, ExpiredTime: "2026-10-30 00:00:00" },
    { PackageName: "活动赠送", CapacityRemain: 0, CapacitySize: 5, DeductionEndTime: Date.parse("2026-10-29T13:00:00+08:00") },
    { PackageName: "旧周期", CapacityRemain: 99, CapacitySize: 99, CycleEndTime: "2026-10-28 00:00:00" },
    { PackageName: "长期", CapacityRemain: 1, CapacitySize: 1, ExpiredTime: "2049-12-31 23:59:59" },
    { PackageName: "月度体验", CapacityRemain: 4, CapacitySize: 4, CycleEndTime: "2026-10-31 23:59:59", DeductionEndTime: Date.parse("2034-12-31T00:00:00Z") },
    { PackageName: "用完", CapacityRemain: 0, CapacitySize: 50 },
    { PackageName: "按扣费截止", CapacityRemain: 2, CapacitySize: 2, ExpiredTime: "", DeductionEndTime: Date.parse("2026-11-22T01:20:04+08:00") }
  ], now);
  assert.equal(got.balance, 22);
  assert.equal(got.size, 87);
  assert.deepEqual(got.packages.map(p => [p.name, p.balance, p.expires]), [
    ["活动赠送", 15, Date.parse("2026-10-30T00:00:00+08:00")], ["月度体验", 4, Date.parse("2026-10-31T23:59:59+08:00")],
    ["按扣费截止", 2, Date.parse("2026-11-22T01:20:04+08:00")], ["长期", 1, 0]
  ]);
});

test("usage pages past the 3000-row cap, deduplicates and keeps no prompt text", async () => {
  const row = (i, day) => ({ requestId: `r${i}`, model: i % 2 ? "glm" : "kimi", credit: 1, requestTime: `${day} 10:${String(i % 60).padStart(2, "0")}:00`, input: "private prompt" });
  const first = Array.from({ length: 3000 }, (_, i) => row(i, "2026-10-28"));
  const { client, seen } = clientFor((url, { body }) => ok({ total: 3001, data: body.startTime.endsWith("00:00:00") ? first : [first.at(-1), row(3000, "2026-10-29")] }));
  const got = await usage(client, "Asia/Shanghai", 7, new Date("2026-10-29T04:00:00Z"));
  assert.equal(seen.length, 2);
  assert.equal(seen[1].body.startTime, "2026-10-28 10:59:00");
  assert.equal(got.count, 3001);
  assert.deepEqual(got.days.slice(-2).map(d => [d.date, d.credit]), [["2026-10-28", 3000], ["2026-10-29", 1]]);
  assert.equal(got.days.length, 7);
  assert.ok(!JSON.stringify(got).includes("private prompt"));
});

test("one failing part leaves the rest of an account's board readable", async () => {
  const { account, client } = clientFor(url => {
    if (url.pathname === "/billing/meter/get-user-resource") return ok({ Response: { Data: { Accounts: [{ PackageName: "赠送", CapacityRemain: 3, CapacitySize: 3 }] } } });
    if (url.pathname === "/billing/meter/get-user-request-usage") return Response.json({ code: 403, msg: "denied" }, { status: 403 });
    if (url.pathname === "/activity/growth/buddy/info") return ok({ buddy: { name: "团子" } });
    if (url.pathname === "/activity/growth/buddy/travel/status") return ok({ state: "traveling", location: { name: "咖啡馆" }, depart_at: 100, arrive_at: 200, daily_limit_reached: false });
    if (url.pathname === "/activity/growth/streak") return ok({ streak: { days: 8, next_tier: "14d", next_tier_remaining: 6 }, makeup_cards: { balance: 1 }, redemption_status: { tiers: [{ tier: "14d", days: 14, credit: 50, energy: 3 }] } });
    if (url.pathname === "/billing/meter/get-enterprise-user-usage") return ok({ credit: 597.21, limitNum: 2000, cycleStartTime: "2026-10-01 00:00:00", cycleResetTime: "2026-11-01 00:00:00" });
    if (url.pathname === "/activity/growth/heatmap") return ok({ today: { date: "2026-10-29", is_active: true } });
    if (url.pathname === "/v2/activity/growth/energy") return ok({ balance: 30, total_earned: 110, total_consumed: 80 });
    if (url.pathname === "/activity/growth/lottery/summary") return ok({ chances: 1 });
    if (url.pathname === "/activity/growth/buddy/list") return ok({ buddies: [{ name: "团子", rarity: "R", current_buddy: true }, { name: "暗影", rarity: "SR" }] });
    throw new Error("unexpected endpoint " + url.pathname);
  });
  const row = await collect(account, client, defaults);
  assert.equal(row.balance.balance, 3);
  assert.match(row.errors.usage, /denied/);
  assert.deepEqual(row.travel, { state: "traveling", name: "团子", location: "咖啡馆", departAt: 100_000, arriveAt: 200_000, limitReached: false, reward: 0 });
  assert.deepEqual(row.streak, { days: 8, makeupCards: 1, active: true, nextTier: { days: 14, remaining: 6, credit: 50, energy: 3 } });
  assert.deepEqual(row.growth, { energy: 30, earned: 110, spent: 80, draws: 1, buddies: 2, rarity: { R: 1, SR: 1 }, current: ["团子"] });
  assert.match(row.errors.tasks, /unexpected endpoint/);
  const enterprise = await collect({ ...account, enterprise: true }, client, defaults);
  assert.equal(enterprise.travel, undefined);
  assert.deepEqual(enterprise.balance.packages, [{ name: "企业月度额度", balance: 1402.79, size: 2000, expires: Date.parse("2026-11-01T00:00:00+08:00"), resets: true }]);
  assert.equal(row.balance.balance, 3, "a personal account never reads the enterprise meter");
});

test("page snapshot carries no credentials and each page request runs once", async t => {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-board-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initialize(dir); mkdirSync(join(dir, "magpie"));
  writeJSON(join(dir, "magpie", "plugin-auth.json"), { "workbuddy#u1": { type: "oauth", uid: "u1", accountId: "fixture", access: "private-access", refresh: "private-refresh", expires: Date.now() + 86400_000 } });
  writeJSON(join(dir, "config.json"), { ...defaults, magpieDir: join(dir, "magpie") });
  const pageFile = join(dir, "page", "data.js");
  const runner = new Runner(dir, { gap: 0, fetcher: async url => ({
    "/billing/meter/get-user-resource": ok({ Accounts: [] }), "/billing/meter/get-user-request-usage": ok({ data: [] }),
    "/activity/growth/buddy/info": ok({ buddy: {} }), "/activity/growth/streak": ok({ streak: { days: 1 } }),
    "/v2/plugin/auth/token/refresh": Response.json({ code: 1 })
  })[new URL(url).pathname] ?? Response.json({ code: 0, data: {} }) }, { pageFile });
  await runner.refreshBoard();
  const page = readFileSync(pageFile, "utf8");
  assert.match(page, /globalThis\.WBPLUS = /);
  assert.ok(!/private-access|private-refresh/.test(page));
  const build = page.match(/"build":"([0-9a-f]{12})"/)?.[1];
  assert.ok(build, "snapshot carries the page fingerprint");
  writeFileSync(join(dir, "page", "board.js"), "// updated");
  assert.notEqual(pageBuild(join(dir, "page"), "data.js"), build);
  assert.equal(runner.boardView().accounts[0].travel.state, "none");

  // Another copy of the plugin gets the snapshot in its own page folder, and
  // nothing is written outside a WorkBuddy Plus page folder.
  assert.throws(() => runner.addPageTarget(join(dir, "elsewhere", "data.js")), /页面目录/);
  const copy = join(dir, "copy");
  mkdirSync(join(copy, "page"), { recursive: true });
  writeJSON(join(copy, "package.json"), { name: "magpie-workbuddy-plus" });
  for (const f of ["index.html", "board.js"]) writeFileSync(join(copy, "page", f), "");
  runner.addPageTarget(join(copy, "page", "data.js"));
  assert.match(readFileSync(join(copy, "page", "data.js"), "utf8"), /globalThis\.WBPLUS = /);
  rmSync(copy, { recursive: true });
  runner.publish();
  assert.ok(!existsSync(copy), "a removed plugin folder is not recreated");
  assert.deepEqual(runner.state.pageTargets, []);

  const request = { id: "a1", action: "resume", at: Date.now() };
  assert.equal(runner.pageRequest(request).ok, true);
  assert.equal(readJSON(join(dir, "config.json")).enabled, true);
  writeJSON(join(dir, "config.json"), { ...runner.config(), enabled: false });
  runner.pageRequest(request); // Magpie restarting with the same options
  assert.equal(readJSON(join(dir, "config.json")).enabled, false);
  assert.match(runner.pageRequest({ id: "a2", action: "pause", at: Date.now() - 3600_000 }).error, /过期/);
  assert.match(runner.pageRequest({ id: "a3", action: "checkin", at: Date.now() }).error, /无效的操作/);
});

test("task board puts claimable first, then what the scheduler does, then manual tasks", () => {
  const now = Date.parse("2026-10-29T12:00:00+08:00");
  const got = taskBoard([
    { task_code: "wb_wechat_oa_subscribe_task", title: "关注公众号", accept_status: "accepted", progress: { current: 0, target: 1 }, reward_credit: 100 },
    { task_code: "chat_5", title: "聊天 5 次", accept_status: "accepted", progress: { current: 2, target: 5 }, reward_credit: 100, valid_end: "2026-11-02T23:59:00+08:00" },
    { task_code: "skill_1", title: "尝鲜技能", accept_status: "accepted", progress: { current: 1, target: 1 }, reward_credit: 50 },
    { task_code: "template_5", title: "已领", accept_status: "claimed", progress: { current: 5, target: 5 }, reward_credit: 100 },
    { task_code: "expert_5", title: "已过期", accept_status: "accepted", progress: { current: 0, target: 5 }, valid_end: "2026-10-01T00:00:00+08:00" }
  ], now);
  assert.equal(got.total, 4);
  assert.equal(got.claimed, 1);
  assert.equal(got.credit, 250);
  assert.deepEqual(got.open.map(t => [t.title, t.state]), [["尝鲜技能", "claimable"], ["聊天 5 次", "auto"], ["关注公众号", "manual"]]);
  assert.match(got.open[2].note, /公众号/);
});

test("an enterprise allowance is what's left of the month, and none when it grants nothing", () => {
  assert.deepEqual(allowance({ credit: 2100, limitNum: 2000, cycleResetTime: "2026-11-01 00:00:00" }), { balance: 0, size: 2000, used: 2100, resets: Date.parse("2026-11-01T00:00:00+08:00"), packages: [] });
  assert.equal(allowance({ credit: 3, limitNum: 0 }), null);
  assert.equal(allowance(null), null);
});
