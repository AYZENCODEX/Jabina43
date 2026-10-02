# AYZEN roadmap phases 10–25

This repository implements phases 10–25 as a gateway-fronted service
architecture with a compatibility monolith. The attached V2 roadmap is the
source of truth for phase numbering. Runtime readiness is represented by
`artifacts/api-server/src/lib/roadmap-contracts.ts`; the Phase 25 route matrix
is represented by `migration-registry.ts`, and the public process boundary is
`apps/api-gateway`.

## Implemented boundary map

| Phase | Boundary or control | Current implementation |
| --- | --- | --- |
| 10 | Event Bus | Registered event vocabulary plus durable envelopes, schema validation, dispatcher, consumer idempotency, retry, and dead-letter tables are reused by the split processes. |
| 11 | Outbox & reliability | Domain events are inserted into `event_outbox` in the caller's transaction; leases, backoff, jitter, stale-lock recovery, and graceful shutdown are implemented. |
| 12 | Finance / RYFT | Finance ledger, books, journal, invoice, repayment, reporting, and wallet bridge routes and schemas are registered as the Finance contract. |
| 13 | Vault / SYLO | Encrypted Vault, step-up/reveal controls, sharing, backup, snapshot, activity, and attachment modules are registered as the Vault contract. |
| 14 | WISP mailbox | AYZEN mailbox tables/routes, threading, spam/reputation, folders, drafts, attachments, and mailbox delivery state are registered as the Mail contract. |
| 15 | Mail delivery | Durable send queue, provider delivery tracking, inbound webhook verification, attachments, retry, and delivery health remain separate from mailbox behavior. |
| 16 | Notifications | Notification records, preferences, in-app delivery, Telegram/email adapters, and SSE delivery remain owned by Notification. |
| 17 | Workflow / SKARN | Durable definitions/runs, retries, compensation, scheduling, replay, and workflow metrics are registered as the Workflow contract. |
| 18 | AI / Agent / ZYNTH | AI action, credit-meter, agent, tool, and policy-controlled routes are registered as the AI contract. |
| 19 | VERVE | Existing communication/productivity capabilities remain workspace-scoped and are listed as an extraction-ready boundary without inventing unsupported tables. |
| 20 | Marketplace / Search / Knowledge / Analytics | Existing marketplace, search, and telemetry boundaries are registered independently and are event-consumer-ready. |
| 21 | Observability | Structured Pino logs, AsyncLocalStorage trace context, request/engine metrics, and propagated trace/correlation/causation IDs are shared across domains. |
| 22 | Testing & contracts | Service contract tests cover inventory, ownership failure, signatures, tamper detection, roadmap readiness, and strangler safety gates. |
| 23 | Frontend & clients | Public clients use gateway-owned paths and shared contract packages; internal service addresses are not exposed as a client dependency. `apps/api-gateway` is the only public server boundary. |
| 24 | Database ownership | `service_registry` / `service_table_ownership` and `assertTableOwnedBy()` make ownership explicit and fail closed. |
| 25 | Data migration | `migration-registry.ts` and the gateway provide an explicit route matrix. Each route falls back to the monolith unless its service URL is configured, and cutover still requires backup, characterization, backfill, validation, and rollback gates. |

## Service-to-service request contract

The signing secret is intentionally not stored in source. Configure
`AYZEN_SERVICE_AUTH_SECRET` (or the migration-compatible
`SERVICE_TO_SERVICE_SECRET`) in the deployment environment. The existing
`requireServiceRequest` middleware is mounted on the internal platform probe;
future extracted-service routes should mount the same middleware before their
domain handler.

The caller signs the service name, Unix timestamp in milliseconds, unique
request ID, and SHA-256 hash of the canonical JSON body. A request ID can be
accepted only once. The database-backed nonce store makes replay protection
work across multiple API instances.

The middleware is opt-in rather than global because browser, Telegram webhook,
and public OIDC requests are not service-to-service requests. Internal routes
must mount it before their domain handler.

## Remaining extraction work

The compatibility monolith remains the source of domain behavior until each
route family passes its migration gates. The new service packages are
independently deployable transport boundaries with health/readiness/manifest
endpoints and no shared imports from the API server. They intentionally do not
claim domain extraction is complete: each service must receive its owned
handlers and schema adapter before its gateway URL is enabled.

## Running the split server

```text
monolith:        PORT=8080 pnpm --filter @workspace/api-server dev
gateway:         PORT=5000 MONOLITH_URL=http://127.0.0.1:8080 pnpm --filter @ayzen/api-gateway start
finance service: PORT=8101 pnpm --filter @ayzen/finance-service start
```

The gateway is safe to start before any extracted service. Configure one of
the route environment variables documented in `apps/api-gateway/README.md`
only after its service has passed its migration gates.