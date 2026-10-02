import { createServiceServer, readJsonBody } from "@ayzen/service-runtime";
import { assertEventEnvelope, createEventEnvelope, EVENT_TYPES } from "@ayzen/events";
import { createRedisEventBus, createConsumerLagMonitor } from "@ayzen/event-client";
import { createServiceRequestHeaders } from "@ayzen/auth-client";
import os from "node:os";
import { createWorkflowExecutor, createInMemoryWorkflowStore, createPostgresWorkflowStore, createStalledWorkflowMonitor } from "@ayzen/workflow";
import { createConsumerRegistry, dispatchEvent } from "./consumers.mjs";
import { createApprovalHandler } from "./approval.mjs";
import { createEventWaiter } from "./wait-for-event.mjs";
import { createScheduleTrigger } from "./schedule-trigger.mjs";

// The worker is a separately deployed process. Falling back to an in-memory
// bus here would acknowledge work that no other process can observe.
const bus = createRedisEventBus({ consumer: process.env.EVENT_BUS_CONSUMER ?? `worker-${process.pid}` });
// Phase H8.2 — see ./wait-for-event.mjs for why this has to be a fan-out
// alongside the main dispatch subscriptions below rather than a second
// bus.subscribe() call per awaited event type.
const eventWaiter = createEventWaiter();
const queue = [];
const metrics = { accepted: 0, processed: 0, failed: 0, skipped: 0, consumed: 0 };

const subscribedEventTypes = EVENT_TYPES;
// Workflow state must survive a worker restart and be shared between replicas,
// so it lives in Postgres. The in-memory store is a local-dev escape hatch only.
async function createStore() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.WORKER_DB_POOL_MAX ?? 5) });
    return createPostgresWorkflowStore({ query: (text, params) => pool.query(text, params) });
  }
  if (process.env.ALLOW_WORKFLOW_MEMORY_STORE === "true") return createInMemoryWorkflowStore();
  throw new Error("worker requires DATABASE_URL for durable workflow state; set ALLOW_WORKFLOW_MEMORY_STORE=true only for local development");
}

// Bound how many workflows one replica runs at once.
const maxConcurrent = Math.max(1, Number(process.env.WORKER_MAX_CONCURRENT_WORKFLOWS ?? 4));
let running = 0;
const waiters = [];
async function withSlot(fn) {
  if (running >= maxConcurrent) await new Promise((resolve) => waiters.push(resolve));
  running += 1;
  try { return await fn(); } finally { running -= 1; waiters.shift()?.(); }
}

// Needed before executor construction: the H8.1 approval handler below
// signs its internal calls to services/workflow the same way callInternalService
// (further down) signs its calls to notification.
const serviceAuthSecret = process.env.AYZEN_SERVICE_AUTH_SECRET ?? process.env.SERVICE_TO_SERVICE_SECRET;

const workflowStore = await createStore();
const executor = createWorkflowExecutor({
  store: workflowStore,
  leaseOwner: `${os.hostname()}-${process.pid}`,
  leaseTtlMs: Number(process.env.WORKFLOW_LEASE_TTL_MS ?? 30_000),
  publish: (event) => bus.publish(event),
  // Phase H8.2 — before this, no `waitForEvent` was ever passed here, so
  // an `event` step's `awaitEventType` (packages/workflow/src/executor.mjs)
  // silently resolved immediately with the just-published envelope instead
  // of pausing for the correlated response.
  waitForEvent: eventWaiter.waitForEvent,
  worker: async ({ step, input }) => ({ worker: step.action ?? step.id, input }),
  // Phase H8.1 — see ./approval.mjs. Before this, the executor was
  // constructed with no `approval` option at all, so any "approval" step
  // threw immediately (packages/workflow/src/executor.mjs requires one).
  approval: createApprovalHandler({
    workflowServiceUrl: process.env.WORKFLOW_SERVICE_URL,
    serviceAuthSecret,
  }),
});

// ---------------------------------------------------------------------------
// Phase H11.2 — Season 2 finding #14: `event.consumer.lag` and
// `workflow.stalled` are registered event types with no publisher
// anywhere, so there was no lag/stall detection at all. The worker is
// already the one process subscribing to every declared event type
// (`subscribedEventTypes` below) and the one process owning workflow
// execution (H7.4/H7.5's cancel/outcome handling), so it is the natural
// home for both periodic checks rather than standing up a dedicated
// monitoring process for two polls. Both monitors publish onto the same
// `bus` every other event in this file already uses, so an alert is a
// real, consumable event like any other — `admin`, `intelligence`, or a
// dashboard can subscribe to either type the same way anything else
// subscribes to `workflow.failed` or `finance.transaction.created`.
// ---------------------------------------------------------------------------
const lagMonitor = createConsumerLagMonitor({
  bus,
  // Excludes the two operational types themselves: alerting on a backlog
  // in the "we are alerting on a backlog" stream is circular and adds
  // nothing an operator can act on differently.
  eventTypes: EVENT_TYPES.filter((type) => type !== "event.consumer.lag" && type !== "workflow.stalled"),
});
const stallMonitor = createStalledWorkflowMonitor({ store: workflowStore, publish: (event) => bus.publish(event) });
lagMonitor.start();
stallMonitor.start();

// ---------------------------------------------------------------------------
// H13 — Season 2 audit finding §4: `workflow_schedules` had storage and
// CRUD routes on services/workflow (see that service's ./schedules.mjs)
// but nothing anywhere actually fired a workflow on a cron/interval basis.
// This is the third periodic-background-check responsibility on the
// worker, alongside the two H11.2 monitors just above — see
// ./schedule-trigger.mjs's own header for why it lives here rather than
// as its own service, and why running one poller per worker replica
// needs no locking of its own.
// ---------------------------------------------------------------------------
const scheduleTrigger = createScheduleTrigger({
  workflowServiceUrl: process.env.WORKFLOW_SERVICE_URL,
  serviceAuthSecret,
  log: (fields) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "worker", component: "schedule-trigger", ...fields })),
});
scheduleTrigger.start();

// ---------------------------------------------------------------------------
// Phase H7.1 — dispatch table. See ./consumers.mjs for the registry/dispatch
// mechanics; what follows is registering one real handler per (owner
// service, eventType) pair drawn from every service's declared
// `consumedEvents` (see services/*/src/index.mjs's createServiceServer
// calls). Before this, every event except workflow.started was logged and
// dropped regardless of what any service claimed to consume.
// ---------------------------------------------------------------------------

/**
 * The worker has no direct DB access to any other service's state — the
 * event bus and signed internal HTTP calls are the only channels it has to
 * make something actually happen in the owning service. Mirrors the same
 * x-ayzen-* signature scheme `@ayzen/service-runtime`'s
 * createConfiguredAuthenticator already verifies on the receiving end.
 */
async function callInternalService({ url, path, requestId, body }) {
  if (!url) {
    const error = new Error(`No service URL configured for internal call to ${path}`);
    error.code = "SERVICE_URL_NOT_CONFIGURED";
    throw error;
  }
  const payload = JSON.stringify(body);
  const headers = { "content-type": "application/json" };
  if (serviceAuthSecret) Object.assign(headers, createServiceRequestHeaders({ service: "worker", requestId, body: payload, secret: serviceAuthSecret }));
  const response = await fetch(`${url.replace(/\/+$/, "")}${path}`, { method: "POST", headers, body: payload });
  if (!response.ok) {
    const error = new Error(`${path} returned ${response.status}`);
    error.code = "INTERNAL_SERVICE_CALL_FAILED";
    throw error;
  }
  return response.json().catch(() => undefined);
}

function notificationBody(template, recipient, event) {
  return {
    template,
    recipient: recipient ?? "unknown",
    channel: "in-app",
    data: event.payload ?? {},
    tenant: { organizationId: event.organizationId, workspaceId: event.workspaceId },
  };
}

// Small in-memory record of "consumed but not actioned" events, exposed on
// /internal/worker/metrics so an operator (or a test) can see the gap
// instead of it looking identical to an event nobody declared consuming.
const acknowledgedOnly = [];
function acknowledgeOnly(owner, event) {
  const entry = { owner, eventType: event.eventType, eventId: event.eventId, timestamp: new Date().toISOString() };
  acknowledgedOnly.push(entry);
  if (acknowledgedOnly.length > 1000) acknowledgedOnly.shift();
  return { acknowledged: true };
}

const registry = createConsumerRegistry();

// workflow: consumedEvents has no workflow.started entry — this is workflow
// EXECUTION, the one handler that already existed, moved into the registry
// unchanged.
// Phase H7.5 — before this, nothing anywhere published workflow.completed
// or workflow.failed, even though both are declared in services/workflow's
// emittedEvents and even though notification's H7.2 handler for
// workflow.completed (below) has been listening for it the whole time.
// The worker's executor is the only process that ever knows a run actually
// finished (services/workflow's own record is created once, at execute
// time, and never updated after that — see Season 1 finding #4b /
// services/workflow/src/execution-event-handlers.mjs), so this is where
// that event has to originate.
function outcomeEnvelope(eventType, { workflowId, executionId, values, error }, event) {
  return createEventEnvelope({
    eventType,
    payload: { workflowId, executionId, ...(eventType === "workflow.completed" ? { values } : { error: String(error?.message ?? error) }) },
    correlationId: event.correlationId,
    causationId: event.eventId,
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    aggregate: { type: "workflow_execution", id: executionId },
  });
}

// Phase H8.3 — the real caller's identity (whoever hit POST
// .../executions on services/workflow) is carried on the workflow.started
// envelope's `actor` field (see services/workflow/src/index.mjs's
// actorFrom()), plus organizationId/workspaceId on the envelope itself.
// This is what packages/workflow/src/executor.mjs's step-boundary policy
// gate checks a step's declared capability against — see that file's
// enforceStepPolicy() for why it's the run's authContext and not anything
// baked into the workflow definition itself: the same definition can be
// executed by different callers, each with their own scopes/roles, and a
// gate that only ever saw whoever authored the definition would be
// checking the wrong identity entirely.
function authContextFrom(event) {
  const actor = event.actor;
  if (!actor?.subject) return undefined;
  return {
    subject: actor.subject,
    actorType: actor.actorType,
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    scopes: actor.scopes,
    roles: actor.roles,
    stepUpAt: actor.stepUpAt,
  };
}

registry.register("workflow.started", "workflow", async (event) => {
  if (!Array.isArray(event.payload?.definition?.steps)) return { skipped: true };
  const { workflowId, executionId } = event.payload;
  try {
    const result = await withSlot(() => executor.run(event.payload.definition, {
      runId: executionId,
      input: event.payload.input ?? {},
      correlationId: event.correlationId,
      causationId: event.eventId,
      authContext: authContextFrom(event),
    }));
    // ALREADY_TERMINAL (redelivered event for a finished run) and LEASE_HELD
    // (another replica is already running it) both mean this call didn't
    // actually decide the outcome, so publishing a completed event here
    // would be premature or a duplicate of one already published.
    if (result?.skipped) return result;
    await bus.publish(outcomeEnvelope("workflow.completed", { workflowId, executionId, values: result.values }, event));
    return result;
  } catch (error) {
    // A lease loss means a different replica owns this run's outcome now —
    // it will publish (or already has published) the real result.
    if (error?.code === "WORKFLOW_LEASE_LOST") return { skipped: true, reason: "LEASE_LOST" };
    // Cancellation already has its own, more specific event
    // (workflow.cancelled, published by services/workflow's cancel route —
    // see H7.4); publishing workflow.failed on top of it would misreport a
    // deliberate cancel as a failure.
    if (error?.code !== "WORKFLOW_CANCELLED") {
      await bus.publish(outcomeEnvelope("workflow.failed", { workflowId, executionId, error }, event));
    }
    throw error;
  }
});

// workflow.cancelled: also has no consumedEvents entry anywhere (same
// reason as workflow.started above — this is workflow EXECUTION, which the
// worker owns regardless of what any service declares). Phase H7.4 — before
// this, services/workflow published workflow.cancelled on POST
// .../cancel, but nothing subscribed to it, so executor.cancel(runId) was
// never called and an in-flight run just kept executing its remaining
// steps to completion (Season 1 finding #4a: cancel was cosmetic).
//
// executor.cancel(runId) does two things: it marks the run cancelled in
// this process's own in-memory set (instant, for a run this exact worker
// replica happens to be executing), and it persists CANCELLED to the
// shared workflow store via store.cancelWorkflowInstance. The persisted
// write matters because worker replicas share one event-bus consumer group
// (see EVENT_BUS_CONSUMER_GROUP in infrastructure/docker/docker-compose.yml)
// — competing consumers means the replica that happens to dequeue this
// workflow.cancelled event is frequently *not* the replica actually running
// the workflow's steps. The executor's step loop checks the shared store at
// each step boundary (see packages/workflow/src/executor.mjs), which is
// what lets the replica that's actually running the workflow notice a
// cancellation requested through a different replica.
registry.register("workflow.cancelled", "workflow", async (event) => {
  const runId = event.payload?.executionId;
  if (!runId) return { skipped: true };
  return executor.cancel(runId);
});

// notification: consumedEvents = ["finance.transaction.created",
// "wisp.message.received", "workflow.completed"]. A real HTTP call to
// notification's own POST /api/notifications, which is a genuine, already-
// working endpoint — so this is a real notification record, not a stub.
registry.register("finance.transaction.created", "notification", (event) => callInternalService({
  url: process.env.NOTIFICATION_SERVICE_URL,
  path: "/api/notifications",
  requestId: event.eventId,
  body: notificationBody("finance.transaction.created", event.payload?.accountId, event),
}));
registry.register("wisp.message.received", "notification", (event) => callInternalService({
  url: process.env.NOTIFICATION_SERVICE_URL,
  path: "/api/notifications",
  requestId: event.eventId,
  body: notificationBody("wisp.message.received", event.payload?.recipient ?? event.payload?.mailbox, event),
}));
registry.register("workflow.completed", "notification", (event) => callInternalService({
  url: process.env.NOTIFICATION_SERVICE_URL,
  path: "/api/notifications",
  requestId: event.eventId,
  body: notificationBody("workflow.completed", event.payload?.executionId ?? event.payload?.workflowId, event),
}));

// search: consumedEvents = ["wisp.message.sent", "finance.transaction.created"].
// Phase H7.3 moved this consumption out of the worker: search now
// subscribes to the event bus itself (see services/search/src/index.mjs)
// so it can call its own indexing logic in-process once it has fetched the
// real message/transaction content from mail/finance, instead of the worker
// acknowledging the event here with no content to index and no way to get
// any (a separate process with no DB access of its own to those services).
// No registry entries for "search" here — the worker no longer needs to act
// on these two event types on search's behalf.

// workflow (as a *consumer* here, distinct from the workflow.started
// EXECUTION entry above) and ai: no business behavior for these is
// specified anywhere in the roadmap (H7.2/H7.3 only define notification's
// and search's reactions), so — same reasoning as search above —
// acknowledging is the honest middle ground between fabricating unspecified
// behavior and silently dropping a declared consumedEvents entry.
registry.register("finance.transaction.created", "workflow", (event) => acknowledgeOnly("workflow", event));
registry.register("wisp.message.received", "workflow", (event) => acknowledgeOnly("workflow", event));
registry.register("workflow.completed", "ai", (event) => acknowledgeOnly("ai", event));

for (const eventType of subscribedEventTypes) {
  bus.subscribe(eventType, async (event) => {
    metrics.processed += 1;
    // Phase H8.2 — resolve any workflow step's `awaitEventType` blocked on
    // this exact (eventType, correlationId) pair. Runs regardless of
    // whether any consumer is registered below: an awaited event type may
    // have no registered consumer at all (see ./consumers.mjs's header on
    // "declared but no business behavior specified"), and this must still
    // wake the waiting workflow step either way.
    eventWaiter.notify(event);
    const dispatch = await dispatchEvent({
      registry,
      event,
      metrics,
      log: (fields) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "worker", ...fields })),
    });
    if (dispatch.failed > 0) {
      const error = new Error(`${dispatch.failed} event consumer(s) failed`);
      error.code = "EVENT_CONSUMER_FAILED";
      throw error;
    }
  });
}

async function handle({ req, url }) {
  if (url.pathname === "/internal/jobs" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body.type || !body.payload) return { status: 400, body: { error: "type and payload are required", code: "INVALID_JOB" } };
    const envelope = assertEventEnvelope(body.event ?? body);
    queue.push(envelope);
    metrics.accepted += 1;
    await bus.publish(envelope);
    return { status: 202, body: { accepted: true, eventId: envelope.eventId, queueDepth: queue.length } };
  }
  if (url.pathname === "/internal/worker/metrics" && req.method === "GET") {
    const deadLetters = await bus.deadLetters();
    return { status: 200, body: { ...metrics, queueDepth: queue.length, deadLetters: deadLetters.length, acknowledgedOnly: acknowledgedOnly.length, transport: bus.metrics().transport ?? "memory", schedules: scheduleTrigger.metrics() } };
  }
  if (url.pathname === "/internal/worker/consumers" && req.method === "GET") {
    return { status: 200, body: { consumers: registry.describe(), acknowledgedOnly: acknowledgedOnly.slice(-50) } };
  }
  return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
}

createServiceServer({
  service: "worker",
  displayName: "Event and Job Worker",
  port: Number(process.env.PORT ?? 8110),
  routePrefixes: ["/internal/jobs"],
  handle,
  dependencies: { eventBus: true },
}).start();