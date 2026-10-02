# Vault file migration map

## Classification

| Classification | Old/current source | Target boundary | Status |
| --- | --- | --- | --- |
| API | artifacts/api-server/src/routes/vault*.ts | API adapters/application | compatibility-preserved |
| Crypto | artifacts/api-server/src/lib/vault-crypto.ts | crypto | compatibility-preserved |
| Security | artifacts/api-server/src/routes/vault-security.ts | access/security | compatibility-preserved |
| Domain | entity, KYC, game, account route families | domain/application | compatibility-preserved |
| Recovery | vault-backup*, vault-snapshot*, vault-trash* | backup/snapshot adapters | compatibility-preserved |
| Standalone entry | services/vault/src/index.mjs | application adapter | thin entrypoint |
| New seam | services/vault/src/{crypto,access,contracts,domain}.mjs | owned module boundaries | extracted |

Generated inventory files are excluded from the source-of-truth count. No old
file is deleted before import, dynamic reference, fixture, and job searches
prove that a compatibility adapter is no longer needed.
