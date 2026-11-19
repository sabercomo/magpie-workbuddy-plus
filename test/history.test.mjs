import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledger, sourceOf } from "../history.mjs";
import { summarize } from "../board.mjs";
import { defaults, initialize, writeJSON } from "../storage.mjs";
import { Runner } from "../runner.mjs";

const at = s => Date.parse(`${s}+08:00`);
const log = (time, message, account = "cn:a") => ({ at: new Date(at(time)).toISOString(), account, message });

test("every package row is a grant: when it was made, how much, what's left", () => {
  const got = summarize([
    { PackageName: "国内运营裂变包", CapacitySize: 100, CapacityRemain: 100, CreateTime: at("2026-11-07T00:01:59"), CycleEndTime: "2026-11-27 00:01:59" },
    { PackageName: "国内运营裂变包", CapacitySize: 10, CapacityRemain: 0, CreateTime: at("2026-11-06T21:01:18"), CycleEndTime: "2026-11-26 21:01:18" },
    { PackageName: "国内运营裂变包", CapacitySize: 100, CapacityRemain: 0, CreateTime: at("2026-09-01T00:00:00"), CycleEndTime: "2026-09-21 00:00:00" }
  ], at("2026-11-07T20:00:00"));
  assert.deepEqual(got.grants.map(g => [g.credit, g.left]), [[100, 100], [10, 0]], "newest first, a month back");
  assert.equal(got.balance, 100);
});

test("a grant is named by the run-log line that gave its amount, else Magpie's check-in", () => {
  const logs = [
    log("2026-11-06T21:01:10", "猫猫归来：已领取 10 积分"),
    log("2026-11-07T09:07:20", "体验「资料库」：已领奖，100 积分 / 5 能量"),
    log("2026-11-07T09:07:40", "猫猫归来：已领取 7 积分")
  ];
  const grant = (time, credit) => ({ at: at(time), credit });
  assert.equal(sourceOf(grant("2026-11-06T21:01:18", 10), logs), "猫猫旅行");
  assert.equal(sourceOf(grant("2026-11-07T09:07:15", 100), logs), "成长任务", "the amount picks the line, not only the time");
  assert.equal(sourceOf(grant("2026-11-07T09:07:41", 7), logs), "猫猫旅行");
  assert.equal(sourceOf(grant("2026-11-07T13:06:38", 5), logs), "", "nothing near: unnamed");
  // A draw's prize is written minutes later; its start time is the draw's.
  const draw = [log("2026-11-07T09:00:29", "成长抽奖 1/1：{\"prize_name\":\"100 积分\"}")];
  assert.equal(sourceOf({ at: at("2026-11-07T09:07:15"), start: at("2026-11-07T09:00:29"), credit: 100 }, draw), "成长抽奖");
  const checkin = { at: at("2026-11-07T00:01:50"), credit: 100 };
  assert.equal(sourceOf(grant("2026-11-07T00:01:59", 100), [], checkin), "每日签到");
  assert.equal(sourceOf(grant("2026-11-07T00:01:59", 50), [], checkin), "", "a different credit amount is not the check-in");
  assert.equal(sourceOf(grant("2026-11-05T00:07:07", 100), []), "", "time and amount alone do not establish a check-in");
  const week = ledger({ grants: [{ ...grant("2026-11-07T09:07:15", 100), name: "国内运营裂变包", left: 100 }, { ...grant("2026-11-06T21:01:18", 10), name: "国内运营裂变包", left: 0 }, { ...grant("2026-10-20T09:00:00", 50), name: "x", left: 0 }] },
    { credit: 36.5 }, logs, 0, at("2026-11-07T20:00:00"));
  assert.deepEqual([week.gained, week.used, week.sources, week.entries.map(e => e.source)], [110, 36.5, [["成长任务", 100], ["猫猫旅行", 10]], ["成长任务", "猫猫旅行"]]);
  // Both grants lack evidence, even if one looks like a late check-in.
  const late = ledger({ grants: [{ at: at("2026-11-04T09:00:00"), credit: 100, name: "x", left: 0 }, { at: at("2026-11-04T02:14:11"), credit: 100, name: "x", left: 0 }] }, {}, [], 0, at("2026-11-07T20:00:00"));
  assert.deepEqual(late.entries.map(e => e.source), ["来源未确认", "来源未确认"]);
});

test("the grant reason from a resource row takes precedence and other attributes stay private", () => {
  const now = at("2026-11-07T12:00:00"), made = at("2026-11-07T09:00:00");
  const row = { PackageName: "国内运营裂变包", CapacitySize: 100, CapacityRemain: 100, CreateTime: made };
  const balance = summarize([
    { ...row, AccountAttributes: [{ Key: "private", Value: "private-attribute" }, { Key: "grantReason", Value: " 官方活动发放 " }] },
    { ...row, CreateTime: made + 20_000, AccountAttributes: [{ Key: "grantReason", Value: {} }] },
    { ...row, CreateTime: made + 40_000, AccountAttributes: {} }
  ], now);
  const logs = [log("2026-11-07T09:00:00", "成长抽奖 1/1：纪念杯（实物奖，请到成长中心填写收件信息）"),
    log("2026-11-07T09:00:20", "成长抽奖未开放，已跳过"), log("2026-11-07T09:00:40", "已兑换连登 7d 档位")];
  const got = ledger(balance, {}, logs, 0, now);
  assert.deepEqual(got.entries.map(e => e.source), ["来源未确认", "来源未确认", "官方活动发放"]);
  assert.equal(ledger(balance, {}, [], { at: made, credit: 100 }, now).entries.at(-1).source, "官方活动发放", "upstream supersedes the Magpie record");
  assert.doesNotMatch(JSON.stringify({ balance, got }), /AccountAttributes|private-attribute/);
});

test("the board view carries each account's ledger, not its raw grants", t => {
  const dir = mkdtempSync(join(tmpdir(), "wb-plus-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initialize(dir); mkdirSync(join(dir, "magpie"));
  writeJSON(join(dir, "config.json"), { ...defaults, spread: 0, magpieDir: join(dir, "magpie") });
  const runner = new Runner(dir);
  runner.state.jobs.unshift({ id: "j", actions: ["travel"], accounts: ["cn:a"], status: "succeeded", logs: [log("2026-11-07T21:01:10", "猫猫归来：已领取 10 积分")] });
  runner.board = { at: Date.now(), accounts: [{ id: "cn:a", key: "workbuddy#a", name: "a", realm: "cn", errors: {}, usage: { credit: 3 }, balance: { balance: 10, size: 10, packages: [], grants: [{ at: Date.now() - 60_000, credit: 10, name: "国内运营裂变包", left: 10 }] } }] };
  const [row] = runner.boardView().accounts;
  assert.equal(row.balance.grants, undefined);
  assert.deepEqual([row.ledger.gained, row.ledger.used, row.ledger.entries.length], [10, 3, 1]);
});

// WorkBuddy AI gives its daily activity reward as a reasonless Bonus Pack of 30 or 50.
test("a WorkBuddy AI Bonus Pack of 30 or 50 is its daily activity reward; elsewhere it stays unnamed", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  const balance = { grants: [
    { at: now - 3600_000, credit: 30, name: "Bonus Pack", left: 30 },
    { at: now - 2 * 86400_000, credit: 50, name: "Bonus Pack", left: 50 },
    { at: now - 3 * 86400_000, credit: 250, name: "Bonus Pack", left: 0 }
  ] };
  const intl = ledger(balance, null, [], 0, now, 7, "intl");
  assert.deepEqual(intl.entries.map(e => e.source), ["每日活跃奖励", "每日活跃奖励", "来源未确认"]);
  assert.deepEqual(intl.sources, [["来源未确认", 250], ["每日活跃奖励", 80]]);
  assert.deepEqual(ledger(balance, null, [], 0, now).entries.map(e => e.source), ["来源未确认", "来源未确认", "来源未确认"]);
  balance.grants[0].grantReason = "活动发放";
  assert.deepEqual(ledger(balance, null, [], 0, now, 7, "intl").entries.map(e => [e.source, e.activityReward]),
    [["活动发放", true], ["每日活跃奖励", undefined], ["来源未确认", undefined]]);
});

// 获得 and 用掉 sit side by side, so both cover the same seven calendar days.
test("the ledger's week is seven calendar days in Beijing, the days its usage total covers", () => {
  const now = at("2026-11-10T22:00:00"), grant = time => ({ at: at(time), credit: 5, name: "x", left: 5 });
  const got = ledger({ grants: [grant("2026-11-10T20:56:00"), grant("2026-11-04T00:00:30"), grant("2026-11-03T23:30:00")] }, { credit: 1 }, [], 0, now);
  assert.deepEqual([got.entries.length, got.gained], [2, 10], "11-03 23:30 is inside the last 168 hours but before the week's first day");
});
