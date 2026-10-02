import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalHandler } from "./approval.mjs";

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      return { ok: next.status < 400, status: next.status, json: async () => next.body };
    },
  };
}

test("approval handler creates a request, polls, and resolves once approved", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 201, body: { id: "appr-1", status: "pending" } },
    { status: 200, body: { id: "appr-1", status: "pending" } },
    { status: 200, body: { id: "appr-1", status: "approved", decidedBy: { subject: "ops" }, decidedAt: "t" } },
  ]);
  const approval = createApprovalHandler({
    workflowServiceUrl: "http://workflow.internal",
    fetchImpl,
    sleep: async () => {},
  });

  const result = await approval({ step: { id: "step-1" }, context: { runId: "run-1", correlationId: "corr-1" }, input: {} });

  assert.equal(result.approved, true);
  assert.equal(result.approvalId, "appr-1");
  assert.equal(calls[0].url, "http://workflow.internal/api/workflows/approvals");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[1].url, "http://workflow.internal/api/workflows/approvals/appr-1");
});

test("approval handler throws a WORKFLOW_APPROVAL_REJECTED error on rejection", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 201, body: { id: "appr-2", status: "pending" } },
    { status: 200, body: { id: "appr-2", status: "rejected", reason: "not now" } },
  ]);
  const approval = createApprovalHandler({ workflowServiceUrl: "http://workflow.internal", fetchImpl, sleep: async () => {} });

  await assert.rejects(
    approval({ step: { id: "step-1" }, context: { runId: "run-2" }, input: {} }),
    (error) => error.code === "WORKFLOW_APPROVAL_REJECTED" && error.message === "not now",
  );
});

test("approval handler fails fast with a clear error when no service URL is configured", async () => {
  const approval = createApprovalHandler({ workflowServiceUrl: undefined, fetchImpl: async () => { throw new Error("should not be called"); } });

  await assert.rejects(
    approval({ step: { id: "step-1" }, context: { runId: "run-3" }, input: {} }),
    (error) => error.code === "SERVICE_URL_NOT_CONFIGURED",
  );
});
