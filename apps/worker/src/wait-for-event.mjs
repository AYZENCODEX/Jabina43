/**
 * Phase H8.2 — before this, `packages/workflow/src/executor.mjs`'s "event"
 * step already had the shape for this (`if (step.awaitEventType && typeof
 * waitForEvent === "function") return waitForEvent(...)`), but
 * `apps/worker/src/index.mjs` — the only production place a
 * `createWorkflowExecutor` gets built — never passed a `waitForEvent`, so
 * an `awaitEventType` step silently skipped waiting and resolved with the
 * envelope it had just published instead of pausing (Season 1 finding #3b).
 *
 * The obvious approach — call `bus.subscribe(eventType, ...)` from inside
 * `waitForEvent` itself — doesn't work here: `@ayzen/event-client`'s
 * `createRedisEventBus().subscribe(type, handler)` keeps exactly one
 * handler per event type (`subscriptions.set(type, registration)`, a plain
 * `Map`), and `apps/worker/src/index.mjs` already owns that one
 * subscription per type for dispatch (`./consumers.mjs`'s registry).
 * Calling `subscribe` again from here would silently replace — not add
 * to — that dispatch subscription for whichever event type a workflow
 * happens to await.
 *
 * So this is a fan-out sitting *alongside* dispatch instead of a second
 * subscription: `notify(event)` is called once per delivered event, from
 * the same place `dispatchEvent` already is (see index.mjs), and resolves
 * whichever pending `waitForEvent(...)` call is waiting on that event's
 * (eventType, correlationId) pair — the same correlationId convention the
 * executor's own "event" step already publishes with
 * (`createEventEnvelope({ ..., correlationId: context.correlationId })`).
 */
export function createEventWaiter({ now = () => Date.now() } = {}) {
  const waiters = new Map();

  function key(eventType, correlationId) {
    return `${eventType}::${correlationId}`;
  }

  /** Called once per event the worker's bus delivers, for every subscribed
   * event type — regardless of whether anything is actually waiting on it,
   * which is the common case and is deliberately cheap (one Map lookup). */
  function notify(event) {
    const eventType = event?.eventType ?? event?.type;
    const correlationId = event?.correlationId;
    if (!eventType || !correlationId) return false;
    const pending = waiters.get(key(eventType, correlationId));
    if (!pending) return false;
    waiters.delete(key(eventType, correlationId));
    pending.resolve(event);
    return true;
  }

  /** The `waitForEvent(eventType, { correlationId, timeoutMs })` executor
   * option: blocks until `notify()` delivers a matching event, or —
   * mirroring `packages/workflow/src/executor.mjs`'s own `withTimeout` —
   * until `timeoutMs` elapses, whichever comes first. With no `timeoutMs`
   * this waits indefinitely, same deliberate default as the H8.1 approval
   * handler for "pause until the correlated event arrives". */
  function waitForEvent(eventType, { correlationId, timeoutMs } = {}) {
    if (!eventType) throw new Error("waitForEvent requires an eventType");
    if (!correlationId) throw new Error("waitForEvent requires a correlationId to match the awaited event against");
    const mapKey = key(eventType, correlationId);
    if (waiters.has(mapKey)) {
      // Two "event" steps in the same run awaiting the same (eventType,
      // correlationId) pair concurrently is not a shape the executor
      // produces today (one step at a time, sequential), but failing
      // loudly here is safer than one silently overwriting the other's
      // resolver and leaving it to hang forever.
      throw new Error(`Already waiting for ${eventType} with correlationId ${correlationId}`);
    }
    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        resolve: (event) => {
          if (timer) clearTimeout(timer);
          resolve(event);
        },
        startedAt: now(),
      };
      waiters.set(mapKey, entry);
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (waiters.get(mapKey) !== entry) return;
          waiters.delete(mapKey);
          const error = new Error(`Timed out after ${timeoutMs}ms waiting for ${eventType} (correlationId ${correlationId})`);
          error.code = "WORKFLOW_WAIT_FOR_EVENT_TIMEOUT";
          reject(error);
        }, timeoutMs);
        // Deliberately left ref'd (Node's default): unref'd, this would be
        // the only pending handle in some runs (a single awaited workflow
        // step with nothing else in flight), and Node is free to end the
        // event loop without ever firing an unref'd timer, silently
        // leaving this promise unsettled forever instead of timing out.
      }
    });
  }

  return {
    notify,
    waitForEvent,
    /** Observability only — how many awaits are currently outstanding. */
    pendingCount() {
      return waiters.size;
    },
  };
}
