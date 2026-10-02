import { createServiceRequestHeaders } from "@ayzen/auth-client";

/**
 * H13 — Season 2 audit finding §4: "Scheduler — does not exist anywhere in
 * the new services architecture." services/workflow/src/schedules.mjs now
 * owns schedule storage and the pure "is this due, build the execution,
 * advance to the next occurrence" logic, and exposes it over two
 * unauthenticated-by-design internal routes:
 *
 *   GET  /internal/workflows/schedules        — every currently-active schedule
 *   POST /internal/workflows/schedules/:id/fire — fire one if due, no-op otherwise
 *
 * Something still has to actually call those on a cadence — this module is
 * that something. It runs inside apps/worker rather than as its own
 * service for the same reason H11.2's lag/stall monitors do (see
 * ./index.mjs's own comment on them): the worker is already the one
 * long-running process in this architecture set up for periodic
 * background checks, and a third one-poll process would be needless
 * operational surface for something this small.
 *
 * Multiple worker replicas each run this poller independently and all
 * call /fire for the same due schedule at roughly the same time — that's
 * fine by design, not a bug to prevent here. Dedup happens one layer
 * down, in services/workflow's /fire route, via the same shared-Postgres
 * idempotency store every other exactly-once-effect route in this repo
 * already relies on (H6.3) — see that route's own comment for the exact
 * key. This poller does not need its own leader-election or locking; it
 * only needs to poll and call fire, same as any of its replicas would.
 *
 * Every call is a signed internal HTTP call, same convention as
 * ./approval.mjs and ./index.mjs's callInternalService: the coarse
 * capability gate (H4, SERVICE_CAPABILITY_GATE) still requires a
 * recognized caller identity on every route including unregistered
 * `/internal/*` ones — see packages/service-runtime's authenticator,
 * which only mints a service identity for headers that verify against
 * AYZEN_SERVICE_AUTH_SECRET. Skipping capability *registration* for
 * these two routes (matchCapabilityRoute's "not_gated", per index.mjs's
 * comment on them) is not the same as skipping authentication.
 */
export function createScheduleTrigger({
  workflowServiceUrl,
  serviceAuthSecret,
  pollIntervalMs = Number(process.env.SCHEDULE_POLL_MS ?? 30_000),
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  function headersFor(requestId, body) {
    const headers = { "content-type": "application/json" };
    if (serviceAuthSecret) Object.assign(headers, createServiceRequestHeaders({ service: "worker", requestId, body, secret: serviceAuthSecret }));
    return headers;
  }

  function requireUrl() {
    if (workflowServiceUrl) return;
    const error = new Error("No service URL configured for internal call to /internal/workflows/schedules");
    error.code = "SERVICE_URL_NOT_CONFIGURED";
    throw error;
  }

  async function listDueCandidates() {
    requireUrl();
    const response = await fetchImpl(`${workflowServiceUrl.replace(/\/+$/, "")}/internal/workflows/schedules`, {
      method: "GET",
      headers: headersFor("schedule-poll", undefined),
    });
    if (!response.ok) {
      const error = new Error(`Listing schedules returned ${response.status}`);
      error.code = "SCHEDULE_LIST_FAILED";
      throw error;
    }
    const { items } = await response.json();
    return items ?? [];
  }

  async function fire(scheduleId) {
    const body = "{}";
    const response = await fetchImpl(`${workflowServiceUrl.replace(/\/+$/, "")}/internal/workflows/schedules/${scheduleId}/fire`, {
      method: "POST",
      headers: headersFor(scheduleId, body),
      body,
    });
    if (!response.ok) {
      const error = new Error(`Firing schedule ${scheduleId} returned ${response.status}`);
      error.code = "SCHEDULE_FIRE_FAILED";
      throw error;
    }
    return response.json();
  }

  let timer = null;
  let metrics = { polls: 0, fired: 0, errors: 0 };

  // /internal/workflows/schedules already filters to `active` schedules
  // server-side, but not to ones that are actually due right now — this
  // poller still calls /fire for every active schedule on every tick and
  // lets that route's own isDue() check decide, rather than duplicating
  // the due-window arithmetic here. The route already returns cheaply
  // ({ fired: false, reason: "NOT_DUE" }) for one that isn't, so the
  // extra round trip costs one HTTP call per active schedule per tick,
  // not a real correctness or performance concern at this scale.
  async function tick() {
    metrics.polls += 1;
    let items;
    try {
      items = await listDueCandidates();
    } catch (error) {
      metrics.errors += 1;
      log({ level: "error", message: "schedule poll failed", error: String(error?.message ?? error) });
      return;
    }
    for (const schedule of items) {
      try {
        const result = await fire(schedule.id);
        if (result?.fired) metrics.fired += 1;
      } catch (error) {
        metrics.errors += 1;
        log({ level: "error", message: "schedule fire failed", scheduleId: schedule.id, error: String(error?.message ?? error) });
      }
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, pollIntervalMs);
      // Fire one immediately on boot rather than waiting a full interval
      // for the first schedules to ever run.
      tick().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    metrics() { return { ...metrics }; },
    // Exposed for tests — exercise one poll cycle without waiting on the
    // real interval, same shape as ./wait-for-event.mjs's testing seams.
    _tick: tick,
  };
}
