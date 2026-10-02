import test from "node:test";
import assert from "node:assert/strict";
import { routeFor, createRouter } from "./routing.mjs";
import { SERVICE_ROUTE_TABLE } from "@ayzen/endpoint-registry";

// ─── Track F, Phase F2 gate ────────────────────────────────────────────────
// "Existing gateway routing tests still pass against the registry-driven
// table." There were no gateway routing tests before this phase (routing
// lived as unexported closures inside index.mjs) — these are that suite,
// exercising the exact same decision logic index.mjs now runs, wired up to
// both fixture tables and the real generated SERVICE_ROUTE_TABLE.

test("routeFor picks the longest matching prefix", () => {
  const table = [
    ["/api/admin", "ADMIN_SERVICE_URL", "admin"],
    ["/api/admin/xuka", "ADMIN_XUKA_SERVICE_URL", "admin-xuka"],
  ];
  assert.equal(routeFor("/api/admin/xuka/phases", table)[2], "admin-xuka");
  assert.equal(routeFor("/api/admin/other", table)[2], "admin");
});

test("routeFor only matches on a path boundary, not a string prefix", () => {
  const table = [["/api/vault", "VAULT_SERVICE_URL", "vault"]];
  assert.equal(routeFor("/api/vault", table)[2], "vault");
  assert.equal(routeFor("/api/vault/secrets", table)[2], "vault");
  assert.equal(routeFor("/api/vaultx", table), undefined, "must not match a path that merely starts with the same characters");
});

test("routeFor returns undefined for an unrouted path", () => {
  const table = [["/api/vault", "VAULT_SERVICE_URL", "vault"]];
  assert.equal(routeFor("/api/unrelated", table), undefined);
});

test("targetFor falls back to the monolith when no route matches", () => {
  const { targetFor } = createRouter({ serviceRoutes: [], monolithUrl: "http://monolith.local", getEnv: () => undefined });
  const target = targetFor("/api/whatever");
  assert.deepEqual(target, { url: "http://monolith.local", service: "monolith", mode: "fallback" });
});

test("targetFor falls back to the monolith when the route's env var is unset", () => {
  const table = [["/api/finance", "FINANCE_SERVICE_URL", "finance"]];
  const { targetFor } = createRouter({ serviceRoutes: table, monolithUrl: "http://monolith.local", getEnv: () => undefined });
  const target = targetFor("/api/finance/accounts");
  assert.deepEqual(target, { url: "http://monolith.local", service: "finance", mode: "monolith" });
});

test("targetFor routes to the extracted service once its env var is configured", () => {
  const table = [["/api/finance", "FINANCE_SERVICE_URL", "finance"]];
  const { targetFor } = createRouter({
    serviceRoutes: table,
    monolithUrl: "http://monolith.local",
    getEnv: (name) => (name === "FINANCE_SERVICE_URL" ? "http://finance.internal:8101/" : undefined),
    assertSafeUpstreamUrl: (url) => new URL(url),
  });
  const target = targetFor("/api/finance/accounts");
  assert.equal(target.mode, "extracted");
  assert.equal(target.service, "finance");
  assert.equal(target.url, "http://finance.internal:8101");
});

test("targetFor falls back to the monolith when the configured URL is unsafe", () => {
  const table = [["/api/finance", "FINANCE_SERVICE_URL", "finance"]];
  const { targetFor } = createRouter({
    serviceRoutes: table,
    monolithUrl: "http://monolith.local",
    getEnv: () => "not-a-valid-url",
    assertSafeUpstreamUrl: () => { throw new Error("unsafe upstream"); },
  });
  const target = targetFor("/api/finance/accounts");
  assert.deepEqual(target, { url: "http://monolith.local", service: "finance", mode: "invalid_configuration" });
});

test("configuredServices lists only services with a resolvable env var", () => {
  const table = [
    ["/api/finance", "FINANCE_SERVICE_URL", "finance"],
    ["/api/vault", "VAULT_SERVICE_URL", "vault"],
  ];
  const { configuredServices } = createRouter({
    serviceRoutes: table,
    monolithUrl: "http://monolith.local",
    getEnv: (name) => (name === "FINANCE_SERVICE_URL" ? "http://finance.internal" : undefined),
  });
  assert.deepEqual(configuredServices(), ["finance"]);
});

// ─── Against the real, generated table ─────────────────────────────────────

test("SERVICE_ROUTE_TABLE (generated) resolves the well-known service prefixes", () => {
  assert.equal(routeFor("/api/finance/accounts", SERVICE_ROUTE_TABLE)[2], "finance");
  assert.equal(routeFor("/api/vault/secrets", SERVICE_ROUTE_TABLE)[2], "vault");
  assert.equal(routeFor("/api/admin/data/query", SERVICE_ROUTE_TABLE)[2], "admin");
  assert.equal(routeFor("/api/workflows/123/executions", SERVICE_ROUTE_TABLE)[2], "workflow");
});

test("SERVICE_ROUTE_TABLE (generated) leaves unmapped product surface to the monolith fallback", () => {
  // "/api/tasks" etc. belong to the "workspace"/"platform" registry owners,
  // which have no extracted service (no routeEnv in topology.yaml) — the
  // gateway must keep sending them to the monolith, not invent a route.
  assert.equal(routeFor("/api/tasks", SERVICE_ROUTE_TABLE), undefined);
});
