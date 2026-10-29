import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { defaults } from "../storage.mjs";

// Exercise the shipped page script with a small DOM fixture. This checks
// button/account selection and schedule editing without contacting a vendor.
test("panel runs selected accounts and saves deduplicated schedule times", async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.value = ""; this.dataset = {}; this.style = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    removeAttribute() {}
  }
  const nodes = new Map(), buttonNames = [...readFileSync(new URL("../public/index.html", import.meta.url), "utf8").matchAll(/data-action="([^"]+)"/g)].map(m => m[1]);
  const buttons = buttonNames.map(action => { const b = new Element("button"); b.dataset.action = action; return b; });
  for (const id of ["schedule-state", "toggle-schedule", "error", "accounts", "jobs", "updated", "config-form", "schedule-fields", "saved", "board", "board-state", "board-refresh"]) nodes.set(id, new Element("div"));
  const form = nodes.get("config-form"); form.elements = {};
  for (const name of ["timezone", "proxy"]) form.elements[name] = new Element("input");
  nodes.get("schedule-fields").append = function (...labels) { for (const label of labels) { const input = label.children[0]; form.elements[input.name] = input; } this.children.push(...labels); };
  const calls = [], status = { config: structuredClone(defaults), accounts: [
    { id: "cn:a", name: "国内测试", realm: "cn", source: "magpie", enabled: true },
    { id: "cn:b", name: "国内测试二", realm: "cn", source: "magpie", enabled: true }
  ], jobs: [] };
  const board = { at: Date.now(), accounts: [{ id: "cn:a", name: "国内测试", expires: 0, errors: {}, balance: { balance: 120, size: 300, packages: [{ name: "活动赠送", balance: 120, size: 300, expires: Date.now() + 86400_000 }] },
    streak: { days: 8, makeupCards: 1, active: true, nextTier: { days: 14, remaining: 6, credit: 50, energy: 3 } },
    growth: { energy: 30, earned: 110, spent: 80, draws: 0, buddies: 2, rarity: { SR: 1, R: 1 }, current: ["团子"] },
    tasks: { total: 2, claimed: 1, credit: 100, open: [{ title: "关注公众号", state: "manual", note: "需要关注官方公众号", current: 0, target: 1, credit: 100, energy: 5, ends: 0 }] },
    travel: { state: "traveling", location: "咖啡馆", departAt: Date.now() - 3600_000, arriveAt: Date.now() + 3600_000 }, usage: { credit: 3, count: 2, days: [{ date: "2026-10-29", credit: 3, count: 2 }], models: [] } }] };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), querySelectorAll: () => buttons },
    fetch: async (path, init) => { calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined }); return { ok: true, json: async () => path === "/api/status" ? structuredClone(status) : path === "/api/board" ? structuredClone(board) : {} }; },
    setInterval() {}, console
  });
  context.globalThis = context;
  for (const file of ["../page/board.js", "../public/app.js"]) vm.runInContext(readFileSync(new URL(file, import.meta.url), "utf8"), context);
  await setImmediate();
  const text = node => typeof node === "string" ? node : [node.textContent || "", ...node.children.map(text)].join(" ");
  // The list view: the account row and its expanded detail, then what needs a person.
  assert.match(text(nodes.get("board")), /国内测试 个人 · 连登 8 天[\s\S]*120 \/ 300[\s\S]*任务 1\/2[\s\S]*能量 30[\s\S]*关注公众号 需手动[\s\S]*在咖啡馆 约 \d\d:\d\d 归来[\s\S]*需要你留意 2 件[\s\S]*120 积分（活动赠送）将作废[\s\S]*「关注公众号」需手动完成 \+100 积分/);
  const button = (node, label) => typeof node === "string" ? undefined : node.textContent === label && node.onclick ? node : node.children.map(c => button(c, label)).find(Boolean);
  button(nodes.get("board"), "圆环").onclick();
  assert.match(text(nodes.get("board")), /全部[\s\S]*国内测试 120 积分 今日完成 2\/3/);
  button(nodes.get("board"), "国内测试").onclick();
  assert.match(text(nodes.get("board")), /今日活跃 连登 8 天[\s\S]*在咖啡馆[\s\S]*待处理 关注公众号 · \+100 积分/);
  button(nodes.get("board"), "小组件").onclick();
  assert.match(text(nodes.get("board")), /即将作废 明天 120 积分[\s\S]*今日 0\/1 完成[\s\S]*能量 30[\s\S]*成长任务 1\/2[\s\S]*关注公众号 需手动/);
  button(nodes.get("board"), "列表").onclick();
  assert.equal(nodes.get("accounts").children.length, 2);
  const checkbox = nodes.get("accounts").children[1].children[0]; checkbox.checked = true; checkbox.onchange();
  await buttons.find(b => b.dataset.action === "activity").onclick();
  assert.deepEqual(calls.find(c => c.path === "/api/run").body, { action: "activity", accounts: ["cn:b"] });
  form.elements["schedule-daily"].value = "21:00, 09:00, 09:00";
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.deepEqual(calls.find(c => c.path === "/api/config").body.schedules.daily, ["09:00", "21:00"]);
});
