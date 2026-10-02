import { assertEventEnvelope } from "@ayzen/events";

/**
 * Phase H5.2 — the missing bridge between `createHttpEventPublisher`
 * (used by finance/mail/notification/vault/etc., which POST envelopes over
 * HTTP) and `createRedisEventBus` (used by the worker and everything else
 * that subscribes). Before this, nothing implemented the `/events` HTTP
 * receiver those publishers expected, so every HTTP-published event was
 * silently dropped by the fetch failing (or, with ALLOW_EVENTBUS_NOOP, by
 * never being sent at all).
 *
 * `createEventsIngestHandler` returns a function that takes the raw request
 * body (a Buffer/string), validates it against the shared `@ayzen/events`
 * envelope contract, and XADDs it onto the Redis stream via the bus
 * returned by `getBus()`. It intentionally does not construct the bus
 * itself — `getBus` is injected so the gateway can build the Redis
 * connection lazily (only once something actually publishes) and so tests
 * can supply a fake bus.
 */
export function createEventsIngestHandler({ getBus }) {
  if (typeof getBus !== "function") throw new Error("getBus is required");

  return async function ingestEvent(rawBody) {
    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      const error = new Error("Event body must be valid JSON");
      error.code = "INVALID_EVENT_ENVELOPE";
      throw error;
    }

    let envelope;
    try {
      envelope = assertEventEnvelope(parsed);
    } catch (validationError) {
      const error = new Error(validationError.message);
      error.code = "INVALID_EVENT_ENVELOPE";
      throw error;
    }

    const bus = getBus();
    if (!bus) {
      const error = new Error(
        "Event bus is not configured on the gateway; set EVENT_BUS_REDIS_URL",
      );
      error.code = "EVENT_BUS_NOT_CONFIGURED";
      throw error;
    }

    await bus.publish(envelope);
    return envelope;
  };
}
