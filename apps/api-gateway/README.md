# AYZEN API Gateway

The gateway is the only public HTTP boundary for the split server.

- `/health`, `/live`, and `/ready` are gateway probes.
- `/internal/routes` exposes route ownership metadata without credentials.
- `/internal/capabilities` exposes the versioned API capability registry for
  bot and client integrations.
- Domain routes fall back to `MONOLITH_URL` until the matching service URL is configured.
- Configure `FINANCE_SERVICE_URL`, `VAULT_SERVICE_URL`, `WISP_SERVICE_URL`,
  `NOTIFICATION_SERVICE_URL`, `WORKFLOW_SERVICE_URL`, `AI_SERVICE_URL`,
  `MARKETPLACE_SERVICE_URL`, or `SEARCH_SERVICE_URL` to advance one route
  family to an extracted service.

The fallback is intentional. It makes the phase-25 strangler cutover explicit
and reversible rather than silently routing traffic to an incomplete service.