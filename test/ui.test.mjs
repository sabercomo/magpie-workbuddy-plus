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
    constructor(tag) { this.tag = tag; this.children = []; this.value = ""; this.dataset = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
  }
  const nodes = new Map(), buttonNames = [...readFileSync(new URL("../public/index.html", import.meta.url), "utf8").matchAll(/data-action="([^"]+)"/g)].map(m => m[1]);
  const buttons = buttonNames.map(action => { const b = new Element("button"); b.dataset.action = action; return b; });
  for (const id of ["schedule-state", "toggle-schedule", "error", "accounts", "jobs", "updated", "config-form", "schedule-fields", "saved"]) nodes.set(id, new Element("div"));
  const form = nodes.get("config-form"); form.elements = {};
  for (const name of ["timezone", "proxy"]) form.elements[name] = new Element("input");
  nodes.get("schedule-fields").append = function (...labels) { for (const label of labels) { const input = label.children[0]; form.elements[input.name] = input; } this.children.push(...labels); };
  const calls = [], status = { config: structuredClone(defaults), accounts: [
    { id: "cn:a", name: "国内测试", realm: "cn", source: "magpie", enabled: true },
    { id: "cn:b", name: "国内测试二", realm: "cn", source: "magpie", enabled: true }
  ], jobs: [] };
  vm.runInNewContext(readFileSync(new URL("../public/app.js", import.meta.url), "utf8"), {
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), querySelectorAll: () => buttons },
    fetch: async (path, init) => { calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined }); return { ok: true, json: async () => path === "/api/status" ? structuredClone(status) : {} }; },
    setInterval() {}, console
  });
  await setImmediate();
  assert.equal(nodes.get("accounts").children.length, 2);
  const checkbox = nodes.get("accounts").children[1].children[0]; checkbox.checked = true; checkbox.onchange();
  await buttons.find(b => b.dataset.action === "activity").onclick();
  assert.deepEqual(calls.find(c => c.path === "/api/run").body, { action: "activity", accounts: ["cn:b"] });
  form.elements["schedule-daily"].value = "21:00, 09:00, 09:00";
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.deepEqual(calls.find(c => c.path === "/api/config").body.schedules.daily, ["09:00", "21:00"]);
});
