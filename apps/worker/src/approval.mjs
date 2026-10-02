import { createServiceRequestHeaders } from "@ayzen/auth-client";

/**
 * Phase H8.1 — before this, createWorkflowExecutor (apps/worker's only
 * production instantiation) was never given an `approval` handler.
 * packages/workflow/src/executor.mjs's "approval" step case requires one
 * and throws immediately if it's missing, so any workflow definition with
 * an approval step failed the instant it reached that step — there was no
 * way to build a workflow that actually paused for a human decision.
 *
 * The worker has no database of its own and no long-lived UI. The natural
 * owner of a durable, queryable approval record is services/workflow
 * itself (resource: workflow_approvals — see its ownedResources and the
 * /api/workflows/approvals routes), reached the same way the worker
 * already reaches notification and search: a signed internal HTTP call
 * (mirrors callInternalService in ./index.mjs).
 *
 * This handler creates the approval record, then polls it for a decision.
 * Polling — rather than something event-driven like H8.2's waitForEvent —
 * is a deliberate minimal first cut for the approval case specifically:
 * the executor already wraps this whole call in the step's own
 * `timeoutMs` (see packages/workflow/src/executor.mjs's withTimeout), so a
 * workflow author who wants a bound on how long a step may sit waiting for
 * a human already has one. Absent that, this handler waits indefinitely,
 * which is the correct default for "pause until someone decides."
 */
export function createApprovalHandler({
  workflowServiceUrl,
  serviceAuthSecret,
  pollIntervalMs = Number(process.env.WORKFLOW_APPROVAL_POLL_MS ?? 2_000),
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  function headersFor(requestId, body) {
    const headers = { "content-type": "application/json" };
    if (serviceAuthSecret) Object.assign(headers, createServiceRequestHeaders({ service: "worker", requestId, body, secret: serviceAuthSecret }));
    return headers;
  }

  function requireUrl() {
    if (workflowServiceUrl) return;
    const error = new Error("No service URL configured for internal call to /api/workflows/approvals");
    error.code = "SERVICE_URL_NOT_CONFIGURED";
    throw error;
  }

  async function createApprovalRequest({ runId, correlationId, step, input }) {
    requireUrl();
    const body = JSON.stringify({
      executionId: runId,
      stepId: step.id,
      correlationId,
      description: step.description ?? step.name,
      input,
    });
    const response = await fetchImpl(`${workflowServiceUrl.replace(/\/+$/, "")}/api/workflows/approvals`, {
      method: "POST",
      headers: headersFor(runId, body),
      body,
    });
    if (!response.ok) {
      const error = new Error(`Creating approval request returned ${response.status}`);
      error.code = "APPROVAL_REQUEST_FAILED";
      throw error;
    }
    return response.json();
  }

  async function loadApproval(approvalId) {
    requireUrl();
    const response = await fetchImpl(`${workflowServiceUrl.replace(/\/+$/, "")}/api/workflows/approvals/${approvalId}`, {
      method: "GET",
      headers: headersFor(approvalId, undefined),
    });
    if (!response.ok) {
      const error = new Error(`Fetching approval status returned ${response.status}`);
      error.code = "APPROVAL_LOOKUP_FAILED";
      throw error;
    }
    return response.json();
  }

  return async function approval({ step, context, input }) {
    const record = await createApprovalRequest({ runId: context.runId, correlationId: context.correlationId, step, input });
    // Blocks this step (and so this run) until a decision is recorded
    // through POST /api/workflows/approvals/:id/decision, or until the
    // step's own timeoutMs (if any) cuts the whole call off from outside.
    for (;;) {
      const current = await loadApproval(record.id);
      if (current.status === "approved") {
        return { approved: true, approvalId: current.id, decidedBy: current.decidedBy, decidedAt: current.decidedAt, reason: current.reason };
      }
      if (current.status === "rejected") {
        const error = new Error(current.reason ?? "Approval was rejected");
        error.code = "WORKFLOW_APPROVAL_REJECTED";
        throw error;
      }
      await sleep(pollIntervalMs);
    }
  };
}
