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
  const writes = [], states = [], wakes = [];
  const history = { state: {}, replaceState(state) { this.state = state; } };
  const host = {
    saved: {}, ack: null, receipts: new Map(),
    get: async () => host.saved,
    set: async next => { writes.push(next); host.saved = next; }
  };
  const open = (h = history) => {
    const context = vm.createContext({ setTimeout, clearTimeout, Date });
    script.runInContext(context);
    return context.WBRequests({ options: host, receipt: id => host.receipts.get(id) ?? host.ack, changed: s => states.push(s), wake: () => wakes.push(structuredClone(host.saved.request)), history: h });
  };
  return { host, history, open, wakes, ui: open(), writes, phase: () => states.at(-1)?.phase };
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

test("only a timely confirmed new job opens its entry once, keeping the original payload", async t => {
  const { host, ui, open, history, phase, wakes, writes } = page(t);
  const original = job("first");
  await ui.send(original);
  assert.deepEqual(wakes, [original.request]);
  assert.equal(writes.length, 1);
  t.mock.timers.tick(2_000);
  const reopened = open(); await reopened.restore();
  assert.equal(phase(), "awaiting");
  t.mock.timers.tick(28_000);
  assert.equal(phase(), "unknown");
  assert.equal(reopened.locked(), true);
  await assert.rejects(reopened.send(job("again")), /确认/);
  reopened.receive(host.ack = { id: "first", ok: true });
  assert.equal(history.state.wbPending, null);
  assert.equal(phase(), "accepted");
  assert.deepEqual(wakes, [original.request]);
  assert.equal(writes.length, 1);
});

test("no entry load for an uncertain write, late resolution, restored job, or non-job", async t => {
  const { host, ui, open, wakes, writes } = page(t);
  const set = host.set, gate = Promise.withResolvers();
  host.set = async next => { await set(next); await gate.promise; };
  const sending = ui.send(job("uncertain")); await setImmediate();
  t.mock.timers.tick(10_000); await sending;
  gate.resolve(); await setImmediate();
  const restored = open(null); await restored.restore();
  assert.equal(restored.locked(), true);
  restored.receive(host.ack = { id: "uncertain", ok: true });
  await restored.send({ request: { id: "refresh", action: "refresh" } });
  assert.equal(writes.length, 2); assert.deepEqual(wakes, []);
});

test("any matching receipt seen before set returns suppresses the first handoff", async t => {
  const { host, ui, wakes } = page(t);
  host.set = async next => {
    host.saved = next;
    ui.receive(host.ack = { id: next.request.id, ok: false, error: "unknown" });
    host.ack = { id: "intervening", ok: true };
  };
  await ui.send(job("A"));
  assert.equal(ui.locked(), true); assert.deepEqual(wakes, []);
});

test("saved options plus a recent matching receipt can confirm a fresh handoff without iframe history", async t => {
  const { host, open, phase, wakes, writes } = page(t);
  host.saved = job("recent");
  host.ack = { id: "recent", ok: true };
  const reopened = open(null);
  await reopened.restore();
  assert.equal(phase(), "accepted");
  assert.equal(reopened.locked(), false);
  assert.equal(reopened.canUpgrade(), true);
  assert.equal(wakes.length, 0); assert.equal(writes.length, 0);
});

test("sidebar confirms a pending request even when another request has the latest receipt", async t => {
  const { host, open, phase, writes, wakes } = page(t);
  host.saved = job("first");
  host.ack = { id: "second", ok: true };
  const reopened = open(null);
  await reopened.restore();
  assert.equal(phase(), "unknown");
  host.receipts.set("first", { id: "first", ok: true, job: "original-job" });
  reopened.receive();
  assert.equal(phase(), "accepted");
  assert.equal(reopened.locked(), false);
  assert.equal(writes.length, 0);
  assert.equal(wakes.length, 0);
});

test("a suspended frame observing a successful set after its deadline does not warm the host", async t => {
  const { ui, host, wakes, phase } = page(t);
  host.set = async next => {
    host.saved = next;
    t.mock.timers.setTime(Date.now() + 11_000); // deadline passed, timeout callback has not run
  };
  await ui.send(job("late"));
  assert.equal(ui.locked(), true); assert.equal(phase(), "unknown"); assert.deepEqual(wakes, []);
});
