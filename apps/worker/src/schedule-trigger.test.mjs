import test from "node:test";
import assert from "node:assert/strict";
import { createScheduleTrigger } from "./schedule-trigger.mjs";

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      if (!next) throw new Error("no more fake responses queued");
      return { ok: next.status < 400, status: next.status, json: async () => next.body };
    },
  };
}

test("_tick lists active schedules and fires each one", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, body: { items: [{ id: "sched-1" }, { id: "sched-2" }] } },
    { status: 200, body: { fired: true, scheduleId: "sched-1", executionId: "exec-1" } },
    { status: 200, body: { fired: false, reason: "NOT_DUE" } },
  ]);
  const trigger = createScheduleTrigger({ workflowServiceUrl: "http://workflow.internal", fetchImpl });

  await trigger._tick();

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "http://workflow.internal/internal/workflows/schedules");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].url, "http://workflow.internal/internal/workflows/schedules/sched-1/fire");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[2].url, "http://workflow.internal/internal/workflows/schedules/sched-2/fire");
  assert.deepEqual(trigger.metrics(), { polls: 1, fired: 1, errors: 0 });
});

test("_tick counts a failed list call as an error and fires nothing", async () => {
  const { fetchImpl } = fakeFetch([{ status: 500, body: {} }]);
  const trigger = createScheduleTrigger({ workflowServiceUrl: "http://workflow.internal", fetchImpl, log: () => {} });

  await trigger._tick();

  assert.deepEqual(trigger.metrics(), { polls: 1, fired: 0, errors: 1 });
});

test("_tick counts one failed fire without aborting the remaining schedules", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, body: { items: [{ id: "sched-1" }, { id: "sched-2" }] } },
    { status: 500, body: {} },
    { status: 200, body: { fired: true, scheduleId: "sched-2", executionId: "exec-2" } },
  ]);
  const trigger = createScheduleTrigger({ workflowServiceUrl: "http://workflow.internal", fetchImpl, log: () => {} });

  await trigger._tick();

  assert.equal(calls.length, 3);
  assert.deepEqual(trigger.metrics(), { polls: 1, fired: 1, errors: 1 });
});

test("fails fast with a clear error when no service URL is configured", async () => {
  const trigger = createScheduleTrigger({ workflowServiceUrl: undefined, fetchImpl: async () => { throw new Error("should not be called"); }, log: () => {} });

  await trigger._tick();

  assert.deepEqual(trigger.metrics(), { polls: 1, fired: 0, errors: 1 });
});

test("start() polls immediately without waiting for the interval, and stop() clears it", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 200, body: { items: [] } },
  ]);
  const trigger = createScheduleTrigger({ workflowServiceUrl: "http://workflow.internal", fetchImpl, pollIntervalMs: 60_000 });

  trigger.start();
  await new Promise((resolve) => setImmediate(resolve));
  trigger.stop();

  assert.equal(trigger.metrics().polls, 1);
});
