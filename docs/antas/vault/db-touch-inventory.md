# Vault data/provider touch inventory

## Persistence and providers

- Primary API persistence: `vault_entries` and related Vault migrations.
- Standalone service persistence: `@ayzen/service-state` with a Postgres
  query adapter; memory fallback is opt-in for local development only.
- Encryption: service crypto boundary and API `vault-crypto` helper.
- Events/audit: transactional outbox and audit log.
- Recovery: backup envelope/cloud/delivery/key-rotation and snapshot/trash
  modules are retained as separate adapter candidates.
- Scheduling: health, backup, and trash cron modules retain their schedules.

## Safety

Tenant/account ownership predicates, transaction boundaries, retry behavior, and
failure semantics remain frozen. Provider-backed evidence must be recorded by
deployment-specific drills; this repository evidence does not claim production
execution.
