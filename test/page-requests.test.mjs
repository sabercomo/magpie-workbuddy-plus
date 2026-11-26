import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { actions } from "../engine.mjs";

const script = new vm.Script(readFileSync(new URL("../page/requests.js", import.meta.url), "utf8"));
const job = id => ({ request: { id, action: "all", at: Date.now(), accounts: ["cn:fixture"] } });
function page(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const writes = [], states = [];
  const history = { state: {}, replaceState(state) { this.state = state; } };
  const host = {
    saved: {}, ack: null,
    get: async () => host.saved,
    set: async next => { writes.push(next); host.saved = next; }
  };
  const open = (h = history) => {
    const context = vm.createContext({ setTimeout, clearTimeout, Date });
    script.runInContext(context);
    return context.WBRequests({ options: host, receipt: () => host.ack, changed: s => states.push(s), history: h });
  };
  return { host, history, open, ui: open(), writes, phase: () => states.at(-1)?.phase };
}

test("sidebar locks before get; a 30-second timeout and unrelated receipts never resend", async t => {
  const { host, ui, phase, writes } = page(t);
  for (const action of [...actions, "retry"]) assert.equal(ui.isJob(action), true);
  const gate = Promise.withResolvers();
  host.get = () => gate.promise;
  const submit = ui.send(job("A"));
  assert.equal(ui.locked(), true);
  await assert.rejects(ui.send(job("B")), /确认/);
  assert.equal(writes.length, 0);
  gate.resolve({ port: 4389 }); await submit;
  assert.equal(writes[0].port, 4389);
  assert.equal(phase(), "awaiting");
  t.mock.timers.tick(29_999); assert.equal(phase(), "awaiting");
  t.mock.timers.tick(1); assert.equal(phase(), "unknown");
  ui.receive({ id: "B", ok: true }); ui.receive({ id: "A" });
  await assert.rejects(ui.send({ syncRequest: {} }), /确认/);
  ui.receive({ id: "A", ok: true, job: "fixture" });
  assert.equal(phase(), "accepted"); assert.equal(ui.locked(), false);
  assert.equal(writes.length, 1);
});

test("sidebar get timeout cancels the continuation, not just its UI", async t => {
  const { host, ui, phase, writes } = page(t);
  const gate = Promise.withResolvers(); host.get = () => gate.promise;
  const result = assert.rejects(ui.send(job("A")), /未写入/);
  t.mock.timers.tick(10_000); await result; gate.resolve({}); await setImmediate();
  assert.equal(phase(), "not-submitted"); assert.equal(ui.locked(), false);
  assert.equal(writes.length, 0);
});

test("uncertain set stays locked across refresh and host-options recovery without a second write", async t => {
  const { host, history, open, ui, phase, writes } = page(t);
  const gate = Promise.withResolvers();
  host.set = async next => { writes.push(next); await gate.promise; host.saved = next; };
  const submit = ui.send(job("A")); await setImmediate();
  t.mock.timers.tick(10_000); await submit;
  assert.equal(phase(), "unknown"); assert.equal(ui.locked(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(history.state.wbPending)), { id: "A", action: "all" });
  const refreshed = open(); await refreshed.restore(); // host write not yet visible
  await assert.rejects(refreshed.send(job("B")), /确认/);
  gate.resolve(); await setImmediate();
  const reopened = open(null); await reopened.restore(); // new iframe, no history
  assert.equal(phase(), "unknown");
  await assert.rejects(reopened.send({ request: { id: "C", action: "refresh" } }), /确认/);
  const other = open(null); // even if restore hasn't finished, preflight sees A
  await assert.rejects(other.send(job("D")), /确认/);
  host.ack = { id: "A", ok: true, job: "fixture" }; reopened.receive(host.ack); refreshed.receive(host.ack);
  assert.equal(history.state.wbPending, null);
  assert.equal(reopened.locked(), false); assert.equal(writes.length, 1);
});

test("a matching ACK can arrive before set settles; unknown backend errors are not pre-dispatch rejections", async t => {
  const { host, ui, phase, writes } = page(t);
  const gate = Promise.withResolvers();
  host.set = async next => { writes.push(next); host.saved = next; await gate.promise; };
  const submit = ui.send(job("A")); await setImmediate();
  ui.receive(host.ack = { id: "A", ok: true }); gate.resolve(); await submit;
  t.mock.timers.tick(30_000); assert.equal(phase(), "accepted");
  await ui.send(job("B")); ui.receive(host.ack = { id: "B", ok: false, error: "保存失败" });
  assert.equal(phase(), "unknown"); assert.equal(ui.locked(), true);
  ui.receive(host.ack = { id: "B", ok: false, beforeDispatch: true, error: "请求已过期" });
  assert.equal(phase(), "rejected"); assert.equal(ui.locked(), false);
  await ui.send({ syncRequest: { id: "sync" } });
  assert.equal(writes.length, 3); assert.equal("request" in writes[2], false);
});
