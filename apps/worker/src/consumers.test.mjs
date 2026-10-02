import test from "node:test";
import assert from "node:assert/strict";
import { createConsumerRegistry, dispatchEvent } from "./consumers.mjs";

test("dispatches to every registered consumer for an event type", async () => {
  const registry = createConsumerRegistry();
  const seen = [];
  registry.register("finance.transaction.created", "notification", async (event) => { seen.push(["notification", event.eventId]); });
  registry.register("finance.transaction.created", "search", async (event) => { seen.push(["search", event.eventId]); });
  registry.register("finance.transaction.created", "workflow", async (event) => { seen.push(["workflow", event.eventId]); });

  const metrics = {};
  const result = await dispatchEvent({ registry, event: { eventType: "finance.transaction.created", eventId: "evt-1", payload: {} }, metrics });

  assert.equal(result.consumers, 3);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 0);
  assert.deepEqual(seen.sort(), [["notification", "evt-1"], ["search", "evt-1"], ["workflow", "evt-1"]].sort());
  assert.equal(metrics.consumed, 3);
});

test("one consumer type can have a single owner too, e.g. workflow.started", async () => {
  const registry = createConsumerRegistry();
  let ran = false;
  registry.register("workflow.started", "workflow", async () => { ran = true; return { started: true }; });

  const metrics = {};
  const result = await dispatchEvent({ registry, event: { eventType: "workflow.started", eventId: "evt-2" }, metrics });

  assert.equal(ran, true);
  assert.equal(result.consumers, 1);
  assert.equal(metrics.consumed, 1);
});

test("an event type with no registered consumers is counted as skipped, not silently dropped", async () => {
  const registry = createConsumerRegistry();
  const logs = [];
  const metrics = {};
  const result = await dispatchEvent({ registry, event: { eventType: "user.created", eventId: "evt-3" }, metrics, log: (fields) => logs.push(fields) });

  assert.equal(result.consumers, 0);
  assert.equal(metrics.skipped, 1);
  assert.equal(logs[0].event, "job.processed");
  assert.equal(logs[0].consumers, 0);
});

test("one consumer failing does not stop the others, and is not rethrown", async () => {
  const registry = createConsumerRegistry();
  const ranOwners = [];
  registry.register("wisp.message.received", "notification", async () => { throw new Error("notification service unreachable"); });
  registry.register("wisp.message.received", "workflow", async () => { ranOwners.push("workflow"); });

  const metrics = {};
  const logs = [];
  const result = await dispatchEvent({
    registry,
    event: { eventType: "wisp.message.received", eventId: "evt-4" },
    metrics,
    log: (fields) => logs.push(fields),
  });

  assert.deepEqual(ranOwners, ["workflow"]);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.consumed, 1);
  assert.ok(logs.some((entry) => entry.event === "event.consumer.failed" && entry.owner === "notification"));
});

test("skipped outcome from a handler (e.g. an idempotent no-op) is reflected in metrics.skipped", async () => {
  const registry = createConsumerRegistry();
  registry.register("workflow.started", "workflow", async () => ({ skipped: true }));

  const metrics = {};
  await dispatchEvent({ registry, event: { eventType: "workflow.started", eventId: "evt-5" }, metrics });

  assert.equal(metrics.skipped, 1);
  assert.equal(metrics.consumed, 1);
});

test("describe() reports every registered (eventType -> owners) mapping", () => {
  const registry = createConsumerRegistry();
  registry.register("finance.transaction.created", "notification", async () => {});
  registry.register("finance.transaction.created", "search", async () => {});
  registry.register("workflow.completed", "ai", async () => {});

  assert.deepEqual(registry.describe(), {
    "finance.transaction.created": ["notification", "search"],
    "workflow.completed": ["ai"],
  });
});

test("register() validates its arguments", () => {
  const registry = createConsumerRegistry();
  assert.throws(() => registry.register("", "notification", async () => {}), /eventType is required/);
  assert.throws(() => registry.register("finance.transaction.created", "", async () => {}), /owner is required/);
  assert.throws(() => registry.register("finance.transaction.created", "notification", "not-a-function"), /handle must be a function/);
});
