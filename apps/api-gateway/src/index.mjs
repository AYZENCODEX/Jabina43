import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";
import { requestContextFromHeaders, contextHeaders } from "@ayzen/tracing";
import { createServiceRequestHeaders } from "@ayzen/auth-client";
import { allowedOrigin, assertSafeUpstreamUrl, securityHeaders } from "@ayzen/security";
import { CAPABILITY_REGISTRY, listCapabilities } from "@ayzen/capabilities";
import { resolveEndpoint, SERVICE_ROUTE_TABLE } from "@ayzen/endpoint-registry";
import { createRedisEventBus } from "@ayzen/event-client";
import { resolveClientIp } from "@ayzen/service-runtime";
import { createPostgresQuotaStore } from "@ayzen/rate-limit";
import { createPostgresQuery } from "@ayzen/service-state";
import { createRouter } from "./routing.mjs";
import { createEventsIngestHandler } from "./events-ingest.mjs";

const port = Number(process.env.PORT ?? process.env.AYZEN_GATEWAY_PORT ?? 5000);
const monolithUrl = (process.env.MONOLITH_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const requestTimeoutMs = Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS ?? 15_000);
const maxBodyBytes = Number(process.env.GATEWAY_MAX_BODY_BYTES ?? 2_097_152);
const rateLimitWindowMs = Number(process.env.GATEWAY_RATE_LIMIT_WINDOW_MS ?? 60_000);
const rateLimitMax = Number(process.env.GATEWAY_RATE_LIMIT_MAX ?? 300);
const trustedProxyHops = process.env.TRUSTED_PROXY_HOPS ?? process.env.AYZEN_TRUSTED_PROXY_HOPS ?? 0;
const rateLimitMaxKeys = Number(process.env.RATE_LIMIT_MAX_KEYS ?? 10_000);
const metrics = { requests: 0, errors: 0, timeouts: 0, rateLimited: 0 };
const rateLimitState = new Map();
let nextRateLimitSweepAt = 0;
const upstreamFailures = new Map();
const upstreamOpenUntil = new Map();
const sharedRateLimitStorePromise = process.env.DATABASE_URL
  ? createPostgresQuery().then((query) => query ? createPostgresQuotaStore({ query, table: "gateway_rate_limit_buckets" }) : undefined)
  : Promise.resolve(undefined);

// Track F, Phase F2: this used to be a hand-maintained array here (11
// prefixes, hand-edited alongside `config/api/routes.json` and
// `packages/endpoint-registry`, all three free to drift from each other).
// It's now `@ayzen/endpoint-registry`'s generated `SERVICE_ROUTE_TABLE` —
// built by Phase F1's generator from infrastructure/deployment/
// topology.yaml's `routeEnv` declarations and each extracted service's own
// `routePrefixes`. Regenerate via
// `node tools/domain-routing/generate-endpoint-registry.mjs` (CI fails on
// drift) rather than hand-editing this array.
const serviceRoutes = SERVICE_ROUTE_TABLE;
const router = createRouter({ serviceRoutes, monolithUrl, assertSafeUpstreamUrl });
const { routeFor, targetFor } = router;

// Phase H5.2: the HTTP→Redis ingest gateway. `createHttpEventPublisher`
// (used by finance/mail/notification/vault/etc.) POSTs envelopes here;
// this validates them against the shared @ayzen/events contract and XADDs
// them onto the Redis stream the worker (and other subscribers) consume.
// Built lazily so a gateway boot doesn't require Redis to be reachable
// unless something actually publishes, and so it can pick up
// EVENT_BUS_REDIS_URL if it's set after process start (e.g. in tests).
let eventBus;
function getEventBus() {
  const redisUrl = process.env.EVENT_BUS_REDIS_URL ?? process.env.EVENT_BUS_URL;
  if (!redisUrl) return undefined;
  if (!eventBus) eventBus = createRedisEventBus({ url: redisUrl, consumer: process.env.EVENT_BUS_CONSUMER ?? `api-gateway-${process.pid}` });
  return eventBus;
}
const ingestEvent = createEventsIngestHandler({ getBus: getEventBus });

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(),
    "access-control-allow-origin": process.env.CORS_ORIGIN ?? (process.env.NODE_ENV === "production" ? "null" : "*"),
    "access-control-expose-headers": "x-request-id,x-trace-id,x-correlation-id,x-ayzen-service,x-ayzen-route-mode",
  });
  res.end(payload);
}

function getRequestId(req) {
  const incoming = req.headers["x-request-id"];
  return typeof incoming === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) chunks.push(chunk);
  for (const chunk of chunks) size += chunk.length;
  if (size > maxBodyBytes) {
    const error = new Error("Request body too large");
    error.code = "REQUEST_BODY_TOO_LARGE";
    throw error;
  }
  return Buffer.concat(chunks);
}

async function proxy(req, res, target) {
  const requestId = getRequestId(req);
  const context = requestContextFromHeaders(req.headers, { requestId, service: target.service });
  res.setHeader("x-request-id", requestId);
  for (const [header, value] of Object.entries(contextHeaders({ ...context, requestId }))) res.setHeader(header, value);
  metrics.requests += 1;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const incoming = new URL(req.url ?? "/", "http://gateway.local");
  const destination = new URL(`${incoming.pathname}${incoming.search}`, `${target.url}/`);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  headers["x-ayzen-gateway"] = "api-gateway";
  headers["x-ayzen-route-mode"] = target.mode;
  headers["x-ayzen-service"] = target.service;
  headers["x-request-id"] = requestId;
  Object.assign(headers, contextHeaders({ ...context, requestId }));
  const serviceSecret = process.env.AYZEN_SERVICE_AUTH_SECRET ?? process.env.SERVICE_TO_SERVICE_SECRET;
  if (serviceSecret) Object.assign(headers, createServiceRequestHeaders({
    service: "api-gateway",
    requestId,
    body,
    method: req.method,
    path: incoming.pathname,
    audience: target.service,
    secret: serviceSecret,
  }));

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), requestTimeoutMs);
  try {
    if (target.mode === "extracted" && (upstreamOpenUntil.get(target.service) ?? 0) > Date.now()) {
      if (req.method === "GET" || req.method === "HEAD") {
        await proxy(req, res, { url: monolithUrl, service: target.service, mode: "fallback" });
        return;
      }
      writeJson(res, 503, { error: "Extracted service circuit is open", code: "SERVICE_CIRCUIT_OPEN", service: target.service, requestId });
      return;
    }
    const response = await fetch(destination, { method: req.method, headers, body, redirect: "manual", signal: abort.signal });
    if (response.status >= 500 && target.mode === "extracted") {
      const failures = (upstreamFailures.get(target.service) ?? 0) + 1;
      upstreamFailures.set(target.service, failures);
      if (failures >= 3) upstreamOpenUntil.set(target.service, Date.now() + 30_000);
    } else if (target.mode === "extracted") {
      upstreamFailures.set(target.service, 0);
      upstreamOpenUntil.delete(target.service);
    }
    const responseBody = Buffer.from(await response.arrayBuffer());
    const outputHeaders = {};
    response.headers.forEach((value, key) => {
      if (!["connection", "transfer-encoding", "keep-alive"].includes(key)) outputHeaders[key] = value;
    });
    outputHeaders["x-ayzen-route-mode"] = target.mode;
    outputHeaders["x-ayzen-service"] = target.service;
    res.writeHead(response.status, outputHeaders);
    res.end(responseBody);
  } catch (error) {
    if (error?.code === "REQUEST_BODY_TOO_LARGE") {
      metrics.errors += 1;
      writeJson(res, 413, { error: "Request body too large", code: error.code, requestId });
      return;
    }
    const timedOut = error?.name === "AbortError";
    metrics.errors += 1;
    if (timedOut) metrics.timeouts += 1;
    if (target.mode === "extracted") {
      const failures = (upstreamFailures.get(target.service) ?? 0) + 1;
      upstreamFailures.set(target.service, failures);
      if (failures >= 3) upstreamOpenUntil.set(target.service, Date.now() + 30_000);
      if ((req.method === "GET" || req.method === "HEAD") && target.url !== monolithUrl) {
        await proxy(req, res, { url: monolithUrl, service: target.service, mode: "fallback" });
        return;
      }
    }
    writeJson(res, timedOut ? 504 : 502, {
      error: timedOut ? "Upstream request timed out" : "Upstream service unavailable",
      code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      service: target.service,
      mode: target.mode,
      requestId,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://gateway.local");
  const requestId = getRequestId(req);
  res.setHeader("x-request-id", requestId);
  const context = requestContextFromHeaders(req.headers, { requestId, service: "api-gateway" });
  for (const [header, value] of Object.entries(contextHeaders({ ...context, requestId }))) res.setHeader(header, value);
  res.setHeader("access-control-allow-origin", process.env.CORS_ORIGIN ?? "*");
  for (const [header, value] of Object.entries(securityHeaders())) res.setHeader(header, value);
  const origin = req.headers.origin;
  const originResponse = allowedOrigin(origin);
  if (origin && originResponse === undefined && req.method !== "OPTIONS") {
    writeJson(res, 403, { error: "Origin is not allowed", code: "ORIGIN_NOT_ALLOWED", requestId });
    return;
  }
  res.setHeader("access-control-expose-headers", "x-request-id,x-trace-id,x-correlation-id,x-ayzen-service,x-ayzen-route-mode,x-ayzen-endpoint");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,idempotency-key,x-request-id,x-trace-id,x-correlation-id,x-causation-id,x-organization-id,x-workspace-id",
    });
    res.end();
    return;
  }
  const endpoint = resolveEndpoint(req.method, url.pathname);
  if (url.pathname.startsWith("/api/") && process.env.AYZEN_STRICT_ENDPOINT_REGISTRY === "true" && !endpoint) {
    writeJson(res, 404, { error: "Endpoint is not registered", code: "ENDPOINT_NOT_REGISTERED", method: req.method, path: url.pathname, requestId });
    return;
  }
  if (endpoint) res.setHeader("x-ayzen-endpoint", `${endpoint.owner}:${endpoint.permission}`);
  const rateKey = resolveClientIp(req, { trustedProxyHops });
  const sharedRateLimitStore = await sharedRateLimitStorePromise;
  let rateDecision;
  if (sharedRateLimitStore) {
    rateDecision = await sharedRateLimitStore.consume({ key: `gateway:${rateKey}`, limit: rateLimitMax, windowMs: rateLimitWindowMs, cost: 1 });
  } else if (["production", "staging"].includes(String(process.env.NODE_ENV ?? "").toLowerCase())) {
    writeJson(res, 503, { error: "Shared gateway rate-limit store is not configured", code: "RATE_LIMIT_STORE_NOT_CONFIGURED", requestId });
    return;
  } else {
    const nowMs = Date.now();
    if (nowMs >= nextRateLimitSweepAt) {
      for (const [key, bucket] of rateLimitState) {
        if (nowMs - bucket.startedAt >= rateLimitWindowMs) rateLimitState.delete(key);
      }
      if (rateLimitState.size > rateLimitMaxKeys) {
        const oldest = [...rateLimitState.entries()]
          .sort(([, left], [, right]) => left.startedAt - right.startedAt)
          .slice(0, rateLimitState.size - rateLimitMaxKeys);
        for (const [key] of oldest) rateLimitState.delete(key);
      }
      nextRateLimitSweepAt = nowMs + Math.min(rateLimitWindowMs, 60_000);
    }
    const bucket = rateLimitState.get(rateKey);
    const activeBucket = !bucket || nowMs - bucket.startedAt >= rateLimitWindowMs
      ? { startedAt: nowMs, count: 0 }
      : bucket;
    activeBucket.count += 1;
    rateLimitState.set(rateKey, activeBucket);
    rateDecision = { allowed: activeBucket.count <= rateLimitMax };
  }
  if (rateLimitMax > 0 && !rateDecision.allowed) {
    metrics.rateLimited += 1;
    writeJson(res, 429, { error: "Rate limit exceeded", code: "RATE_LIMITED", requestId });
    return;
  }
  if (req.method === "GET" && ["/health", "/live"].includes(url.pathname)) {
    writeJson(res, 200, { ok: true, status: "ok", service: "api-gateway", requestId, timestamp: new Date().toISOString() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/ready") {
    writeJson(res, 200, {
      ok: true,
      status: "ready",
      service: "api-gateway",
      monolith: monolithUrl,
      extractedServices: serviceRoutes.filter(([, env]) => Boolean(process.env[env])).map(([, , service]) => service),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    const body = [
      "# TYPE gateway_requests_total counter",
      `gateway_requests_total ${metrics.requests}`,
      "# TYPE gateway_errors_total counter",
      `gateway_errors_total ${metrics.errors}`,
      "# TYPE gateway_timeouts_total counter",
      `gateway_timeouts_total ${metrics.timeouts}`,
      "# TYPE gateway_rate_limited_total counter",
      `gateway_rate_limited_total ${metrics.rateLimited}`,
    ].join("\n");
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store", "x-request-id": requestId });
    res.end(`${body}\n`);
    return;
  }
  if (req.method === "GET" && url.pathname === "/internal/routes") {
    writeJson(res, 200, {
      gateway: "api-gateway",
      fallback: "monolith",
      routes: serviceRoutes.map(([prefix, env, service]) => ({
        prefix,
        service,
        configured: Boolean(process.env[env]),
        env,
      })),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/internal/capabilities") {
    writeJson(res, 200, {
      gateway: "api-gateway",
      version: "v1",
      count: CAPABILITY_REGISTRY.length,
      available: listCapabilities({ status: "available" }).length,
      partial: listCapabilities({ status: "partial" }).length,
      capabilities: CAPABILITY_REGISTRY,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/events") {
    metrics.requests += 1;
    try {
      const rawBody = await readBody(req);
      const envelope = await ingestEvent(rawBody);
      writeJson(res, 202, { accepted: true, eventId: envelope.eventId, eventType: envelope.eventType, requestId });
    } catch (error) {
      metrics.errors += 1;
      if (error?.code === "REQUEST_BODY_TOO_LARGE") {
        writeJson(res, 413, { error: "Request body too large", code: error.code, requestId });
        return;
      }
      if (error?.code === "EVENT_BUS_NOT_CONFIGURED") {
        writeJson(res, 503, { error: error.message, code: error.code, requestId });
        return;
      }
      writeJson(res, 400, { error: error.message ?? "Invalid event envelope", code: error?.code ?? "INVALID_EVENT_ENVELOPE", requestId });
    }
    return;
  }
  await proxy(req, res, targetFor(url.pathname));
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    service: "api-gateway",
    event: "gateway.started",
    port,
    monolithUrl,
    extractedServices: serviceRoutes.filter(([, env]) => Boolean(process.env[env])).map(([, , service]) => service),
  }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", service: "api-gateway", event: "gateway.stopping", signal }));
  server.close(() => process.exit(0));
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));