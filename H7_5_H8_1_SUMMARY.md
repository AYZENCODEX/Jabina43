# H7.5 and H8.1 — implementation summary

Zip contains only the changed/new files, with paths relative to the repo root
(`AYZEN-track-H7_4-applied.zip`'s layout). Drop them into place over that tree.

## H7.5 — `services/workflow`'s execution record never updates after creation

**Root cause was one layer deeper than the roadmap entry states:** `workflow.completed`
and `workflow.failed` are declared in `emittedEvents` (and notification's H7.2
handler has been listening for `workflow.completed` since that phase), but
**nothing in the repo actually published either event.** Subscribing to them,
as the roadmap suggested, would have been a no-op without this.

Changes:

- **`apps/worker/src/index.mjs`** — after `executor.run()` settles for a
  `workflow.started` event, publishes `workflow.completed` (with the run's
  output values) or `workflow.failed` (with the error). Skips publishing when:
  - the run was `ALREADY_TERMINAL` or `LEASE_HELD` (another call/replica
    already owns or owns the real outcome — publishing here would be a
    premature or duplicate event),
  - the failure was a lease loss (`WORKFLOW_LEASE_LOST` — another replica now
    owns the run),
  - the failure was a cancellation (`WORKFLOW_CANCELLED` — `workflow.cancelled`,
    published by `services/workflow`'s cancel route since H7.4, already
    covers this; publishing `workflow.failed` too would misreport a
    deliberate cancel as a failure).

- **`services/workflow/src/execution-event-handlers.mjs`** (new) — handlers
  for `workflow.completed` / `workflow.failed` that update the service's own
  `executions` record (status, `updatedAt`, and `output`/`error`). Guards
  against overwriting an already-terminal record (redelivery, or a cancel
  that raced ahead of a completion event) and against a missing execution.
  `workflow.cancelled` is intentionally not handled here — cancellation is
  known synchronously by the service's own `/cancel` route already.

- **`services/workflow/src/index.mjs`** — subscribes to those two events via
  `createRedisEventBus` (same pattern `search` uses for its H7.3 fix), with
  the same "no bus configured → hard error unless explicitly opted into
  no-op" guard used elsewhere in the repo. Also adds the **missing**
  `GET /api/workflows/executions/:id` route — this was declared in
  `packages/capabilities` (`workflow.get-execution`) but never implemented,
  so there was previously no way to observe an execution's status at all.
  Updated `ownedResources`/`consumedEvents` metadata to match.

- **`packages/domain-boundaries/src/index.mjs`** — updated workflow's
  `consumedEvents`/`ownedResources` for consistency with the above.

- **`services/workflow/src/execution-event-handlers.test.mjs`** (new) — unit
  tests for the update/guard logic.

## H8.1 — no `approval` handler wired

- **`services/workflow/src/index.mjs`** — new approval queue, backed by the
  existing Postgres-backed `createStateStore` (H6.2 pattern), resource name
  `workflow_approvals`:
  - `POST /api/workflows/approvals` — create a pending approval record
  - `GET /api/workflows/approvals` (optional `?status=`) — the queue an
    operator/admin UI would list
  - `GET /api/workflows/approvals/:id` — read one record (polled by the
    worker's handler)
  - `POST /api/workflows/approvals/:id/decision` — record `approved` or
    `rejected` (409 if already decided)

- **`apps/worker/src/approval.mjs`** (new) — the `approval` handler passed
  into `createWorkflowExecutor`. Creates the approval record via a signed
  internal call to `services/workflow` (same signing pattern as the existing
  `callInternalService` used for notification), then polls
  `GET .../approvals/:id` until it's no longer `pending`. Approval resolves
  the step; rejection throws `WORKFLOW_APPROVAL_REJECTED`, which fails the
  step (and, absent a `compensate`, the whole run) the same way any other
  step failure does. Relies on the step's own `timeoutMs` (already enforced
  by the executor) for a bound, rather than implementing a second timeout.

- **`apps/worker/src/index.mjs`** — wires `createApprovalHandler(...)` into
  the executor's `approval` option; moved `serviceAuthSecret` above the
  executor construction since the handler needs it.

- **`apps/worker/src/approval.test.mjs`** (new) and
  **`packages/workflow/test/approval.test.mjs`** (new) — unit tests for the
  handler in isolation, and an end-to-end test through the real executor
  proving the roadmap's stated verification: *"a workflow with an approval
  step pauses and only proceeds after an explicit decision."* Includes a
  rejection case and the pre-fix "no handler configured" failure mode.

## Verification

All new and pre-existing tests pass (34 total across
`packages/workflow/test`, `apps/worker/src`, `services/workflow/src`,
`services/search/src`):

```
node --test packages/workflow/test/*.mjs apps/worker/src/*.test.mjs \
             services/workflow/src/*.test.mjs services/search/src/*.test.mjs
```

## Not in scope here (left for later phases per the roadmap)

- H8.2 (`waitForEvent`), H8.3 (`policyContext` / `stepAuthorizationRequired`
  enforcement), H8.4 (`workflowOwnerRequired` / `cancellationIsAudited`
  enforcement on the new approval/execution routes too) — the approval
  endpoints added here use only the existing coarse auth gate, matching the
  rest of the service at this point in the roadmap.
