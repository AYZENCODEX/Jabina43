# Vault modularization architecture

## Boundary

The Vault application boundary owns orchestration and policy composition. Domain
modules own pure lifecycle and ownership rules. Crypto owns encryption/decryption
only. Infrastructure owns database, event, storage, backup, and scheduler
adapters. API files remain compatibility adapters.

## Dependency direction

`api -> application -> domain`; application may depend on security and
infrastructure ports; domain may not import routes, providers, or database
clients; crypto may not import business domains. Existing API routes remain the
public compatibility surface until consumer proof permits retirement.

## Existing implementation graph

- Standalone service: `services/vault/src/index.mjs`
- Crypto boundary: `services/vault/src/crypto.mjs` and
  `artifacts/api-server/src/lib/vault-crypto.ts`
- Access boundary: `services/vault/src/access.mjs` and
  `artifacts/api-server/src/routes/vault-security.ts`
- Domain seams: `services/vault/src/domain.mjs`, entity/account/KYC/game
  route families, and snapshot/trash modules
- Infrastructure candidates: backup, cloud, storage, audit, event, and cron
  modules under `artifacts/api-server/src/lib`

The architecture checker is the existing `scripts/validate-domain-boundaries.mjs`
plus the VLT validators. No route or database contract is redesigned.
