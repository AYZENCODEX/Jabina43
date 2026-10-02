/**
 * Phase H7.1 — the worker used to have exactly one branch:
 * `if (eventType === "workflow.started") { ... }`. Every other event it
 * received — including every service's declared `consumedEvents` — was
 * logged under `job.processed` and otherwise dropped (Season 1 finding #2).
 *
 * This module is the dispatch table that replaces that branch: a registry
 * keyed by `eventType`, holding one entry per (owning service, eventType)
 * pair drawn from each service's declared `consumedEvents` — not one entry
 * per eventType, since more than one service can (and does) declare the
 * same event type. `finance.transaction.created`, for example, is consumed
 * by `notification`, `search`, and `workflow`, and needs its own handler
 * for each.
 *
 * Pulled into its own module — rather than living inline in `index.mjs`,
 * which opens real Redis and Postgres connections as soon as it's imported
 * — so the registry and its dispatch behavior can be unit-tested without a
 * running event bus, database, or downstream services.
 */

export function createConsumerRegistry() {
  const registry = new Map();
  return Object.freeze({
    register(eventType, owner, handle) {
      if (typeof eventType !== "string" || !eventType) throw new Error("eventType is required");
      if (typeof owner !== "string" || !owner) throw new Error("owner is required");
      if (typeof handle !== "function") throw new Error("handle must be a function");
      const list = registry.get(eventType) ?? [];
      list.push({ owner, handle });
      registry.set(eventType, list);
    },
    consumersFor(eventType) {
      return registry.get(eventType) ?? [];
    },
    /** eventType -> [owner, ...], for observability/verification endpoints. */
    describe() {
      return Object.fromEntries([...registry.entries()].map(([eventType, consumers]) => [eventType, consumers.map((consumer) => consumer.owner)]));
    },
  });
}

/**
 * Runs every consumer registered for one event's type, independently of one
 * another: one consumer throwing is recorded and counted but never stops
 * the rest from running, and is never rethrown to the caller. That matches
 * the old code's own behavior for its one workflow.started handler (catch,
 * log, count `failed`, move on) — this just applies the same rule per
 * consumer now that a single event type can fan out to more than one owner.
 * Letting one owner's failure dead-letter/redeliver the whole event would
 * also mean re-running every other owner's already-succeeded handler on
 * retry, which is worse than the one consumer that actually failed missing
 * a delivery.
 *
 * An event type with zero registered consumers is `skipped`, not silently
 * absorbed — this is the real behavior difference from before: previously
 * every non-workflow.started event looked identical (log line, no branch
 * taken) whether or not any service actually declared it as consumed.
 */
export async function dispatchEvent({ registry, event, metrics = {}, log = () => {} }) {
  const eventType = event?.eventType ?? event?.type;
  const consumers = registry.consumersFor(eventType);
  if (consumers.length === 0) {
    metrics.skipped = (metrics.skipped ?? 0) + 1;
    log({ level: "info", event: "job.processed", type: eventType, event_id: event?.eventId, consumers: 0 });
    return { consumers: 0, succeeded: 0, failed: 0 };
  }
  let succeeded = 0;
  let failed = 0;
  for (const { owner, handle } of consumers) {
    try {
      const outcome = await handle(event);
      succeeded += 1;
      if (outcome?.skipped) metrics.skipped = (metrics.skipped ?? 0) + 1;
    } catch (error) {
      failed += 1;
      metrics.failed = (metrics.failed ?? 0) + 1;
      log({ level: "error", event: "event.consumer.failed", owner, type: eventType, event_id: event?.eventId, error: String(error?.message ?? error) });
    }
  }
  metrics.consumed = (metrics.consumed ?? 0) + succeeded;
  log({ level: "info", event: "job.processed", type: eventType, event_id: event?.eventId, consumers: consumers.length, succeeded, failed });
  return { consumers: consumers.length, succeeded, failed };
}
