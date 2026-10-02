// ─────────────────────────────────────────────────────────────────────────
// apps/api-gateway/src/routing.mjs
// AYZEN Roadmap — Track F, Phase F2 ("Make the gateway read the registry
// instead of a hardcoded array").
//
// This is the routing decision logic that used to live as unexported
// closures (`routeFor`/`targetFor`) directly inside index.mjs, reading a
// hand-maintained `serviceRoutes` array. It's pulled out here, unchanged in
// behavior, so it can:
//   1. Be driven by @ayzen/endpoint-registry's generated SERVICE_ROUTE_TABLE
//      (Phase F1) instead of a second hand-written list.
//   2. Be unit-tested on its own (routing.test.mjs) instead of only being
//      reachable through a running HTTP server.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Picks the longest-matching [prefix, envVar, service] triple for a given
 * pathname, matching only on a real path boundary (a prefix match must be
 * followed by end-of-string or "/", never a mere string-startsWith).
 */
export function routeFor(pathname, serviceRoutes) {
  return serviceRoutes
    .filter(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    .sort((a, b) => b[0].length - a[0].length)[0];
}

/**
 * Builds the gateway's routing decision functions.
 *
 * @param {Array} serviceRoutes - [prefix, envVar, service] triples, longest-
 *   prefix-first (@ayzen/endpoint-registry's SERVICE_ROUTE_TABLE).
 * @param {string} monolithUrl - fallback upstream for anything unrouted, an
 *   unconfigured env var, or an extracted service whose configured URL
 *   fails `assertSafeUpstreamUrl`.
 * @param {(name: string) => string | undefined} [getEnv] - reads an
 *   upstream URL by env var name. Defaults to `process.env` lookup so
 *   production call sites (index.mjs) don't need to pass it; tests inject a
 *   fixture instead of touching real env vars.
 * @param {(url: string) => URL} [assertSafeUpstreamUrl] - validates a
 *   configured upstream URL, throwing if it's unsafe (SSRF-style checks
 *   live in @ayzen/security). Defaults to a permissive `new URL(url)` so
 *   routing.test.mjs's fixture-table tests don't need to import
 *   @ayzen/security for cases that don't care about that validation.
 */
export function createRouter({
  serviceRoutes,
  monolithUrl,
  getEnv = (name) => process.env[name],
  assertSafeUpstreamUrl = (url) => new URL(url),
}) {
  function targetFor(pathname) {
    const route = routeFor(pathname, serviceRoutes);
    if (!route) return { url: monolithUrl, service: "monolith", mode: "fallback" };
    const configuredUrl = getEnv(route[1]);
    if (configuredUrl) {
      try {
        const validatedUrl = assertSafeUpstreamUrl(configuredUrl);
        return { url: validatedUrl.toString().replace(/\/+$/, ""), service: route[2], mode: "extracted" };
      } catch {
        return { url: monolithUrl, service: route[2], mode: "invalid_configuration" };
      }
    }
    return { url: monolithUrl, service: route[2], mode: "monolith" };
  }

  function configuredServices() {
    return serviceRoutes.filter(([, envVar]) => Boolean(getEnv(envVar))).map(([, , service]) => service);
  }

  return { routeFor: (pathname) => routeFor(pathname, serviceRoutes), targetFor, configuredServices };
}
