# AYZEN roadmap Phase 01 — Canonical Component Registry

## What this phase delivers

One machine-readable registry for the platform's components, with a schema
that requires a stable id, owner, app, environment and lifecycle on every
entry, and a build tool that bootstraps it from the existing enumerable
registries rather than hand-authoring a parallel data set.

| Artifact | Path |
| --- | --- |
| Schema | `schemas/platform/components/component.v1.json` |
| Validation + catalog package | `packages/component-registry/src/validate.mjs`, `packages/component-registry/src/index.mjs` |
| Unit tests | `packages/component-registry/test/index.test.mjs` (9 tests) |
| Build tool | `tools/component-registry/build.mjs` |
| Generated registry | `infrastructure/platform/component-registry.json` |
| Completeness report | `reports/component-registry/completeness.json` |
| CI wiring | `.github/workflows/ci.yml` (`validation` job), `pnpm run validate:component-registry` |

## Design

`validateComponentDefinition` (in `packages/component-registry/src/validate.mjs`)
is the single gate: a component missing `id`, `kind`, `owner`, `app`,
`environment` or `lifecycle` throws and is never admitted to the catalog.
`createComponentCatalog` (in `src/index.mjs`) wraps this with:

- **Duplicate-id rejection** — registering a second component under an
  already-used id throws `Duplicate component id: <id>`.
- **`findings()`** — registry-level checks: any declared source registry
  that contributed zero components (`SOURCE_REGISTRY_NOT_REPRESENTED`), and
  any component left `QUARANTINED`.
- **`completeness()`** — total components, source-registry coverage ratio,
  and a per-kind breakdown across the 19 component kinds defined in the
  schema (app, domain, feature, sub-feature, function, module, api, service,
  database, event, workflow, worker-pool, scheduler-job,
  notification-channel, telegram-command, ui-route, artifact, engine,
  control-plane).

This mirrors the existing `@ayzen/service-registry` / `@ayzen/platform-governance`
pattern already in the codebase rather than introducing a new style.

## Bootstrap sources (Phase 01 scope)

`tools/component-registry/build.mjs` currently reads the seven registries
that already hold enumerable, list-shaped entries:

| Source registry | Kind produced | Count |
| --- | --- | --- |
| `infrastructure/platform/service-registry.json` | `service` | 15 |
| `infrastructure/platform/workflow-registry.json` | `workflow` | 3 |
| `infrastructure/platform/worker-pools.json` | `worker-pool` | 5 |
| `infrastructure/platform/telegram-command-registry.json` | `telegram-command` | 72 |
| `infrastructure/platform/feature-completeness.json` | `feature` | 4 |
| `infrastructure/platform/domain-registry.json` | `domain` | 4 |
| `infrastructure/platform/enforcement-registry.json` | `engine` / `control-plane` | 9 |
| **Total** | | **112** |

Running `pnpm run validate:component-registry` (or `node
tools/component-registry/build.mjs`) regenerates
`infrastructure/platform/component-registry.json` and
`reports/component-registry/completeness.json`, and exits non-zero if a
declared source stops contributing components — so drift between this build
script and the registries it reads is a CI failure, not a silent gap.

## What Phase 01 does not yet claim

`api`, `database`, `event`, `sub-feature`, `function`, `module`,
`scheduler-job`, `notification-channel`, `ui-route` and `artifact` show as
`0` in the current completeness report. This is accurate, not a bug: the
underlying sources for these (`endpoint-registry.json`, `event-fabric.json`,
`scheduler.json`, `notification.json`, the frontend) are currently
**configuration/policy documents**, not enumerable per-item lists — there is
nothing to bootstrap from yet. Phases 02–05 (Universal ID standard, Full
Feature Circuit Registry, Function/Module/API Lineage, UI-to-Backend
Circuit) are where those sources gain enumerable entries; at that point they
are added to the `SOURCES` list in `build.mjs` the same way the seven above
were, and the completeness ratio moves from source-registry coverage today
toward full component-kind coverage.

## Verification run

```
$ pnpm run validate:component-registry
{
  "status": "READY",
  "totalComponents": 112,
  "sourceRegistries": "7/7",
  "findings": 0,
  "registryOutput": "infrastructure/platform/component-registry.json",
  "reportOutput": "reports/component-registry/completeness.json"
}

$ node --test packages/component-registry/test/index.test.mjs
# tests 9
# pass 9
# fail 0
```
