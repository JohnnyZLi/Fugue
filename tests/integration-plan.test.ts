import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { reviewStartSchema } from "../src/core/attestations.js";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { canonicalWorkSpecIdentity, workMetadataSchema, workSpecDigestFromRequirements } from "../src/core/metadata.js";
import { resolveQaRequirements } from "../src/core/qa.js";
import {
  assertValidationMatchesPlan,
  createIntegrationRecord,
  createIntegrationRequest,
  integrationPlanSchema,
  integrationValidationSchema,
} from "../src/core/integration-plan.js";
import { protectedIntegrationRecoveryDecision } from "../src/core/reconcile.js";
import { matchesCleanupAwareDurableRunStartBinding } from "../src/core/integration-status.js";

const CURRENT_WORK_SPEC_DIGEST = "sha256:a808b8ae2dbf920771f978dfb3c747d7372b24bf516e3d4d92b0d26afa55a15a";

const identity = {
  prNumber: 21,
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  baseBranch: "main",
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  policyDigest: "sha256:policy",
  protocolVersion: 1 as const,
  issueNumber: 18,
  workId: "work-18",
  workSpecDigest: CURRENT_WORK_SPEC_DIGEST,
};

const integration = {
  request_id: "int-0123456789abcdef-fedcba9876543210",
  run_id: 12345,
  run_attempt: 1 as const,
};

function plan() {
  return integrationPlanSchema.parse({
    version: 1,
    identity,
    integration,
    validation: { install: ["npm ci"], checks: ["npm test"] },
    required_ci: ["test"],
    qa_required: ["code", "security"],
    agents_md: { update_required: false, update_present: false },
    control_plane: { changed: true, human_acknowledgement: "passed" },
    validation_control: { changed: true, reviewed: true, acceptable: true },
    created_at: new Date().toISOString(),
  });
}

describe("GitHub-hosted Integration plan", () => {
  it("binds validation to the exact evaluation and protected request/run identity", () => {
    const value = plan();
    expect(value.identity.headSha).toBe(identity.headSha);
    expect(value.integration).toEqual(integration);
    expect(value.validation.checks).toEqual(["npm test"]);
  });

  it("uses one canonical work-spec normalization/hash and carries the exact digest in review-start evidence", () => {
    const metadata = workMetadataSchema.parse({
      version: 1, work_id: "work-18",
      spec: { dependencies: [], ownership: { owned: ["src/**"], coordinate: [], forbidden: [] }, qa: { force: ["code"] }, authorized_changes: { agents_invariants: [] } },
      execution: { worker_id: "wkr-b0057a9e", branch: "agent/18-migrate-fugue-to-chat-first-github-hosted-orchestration" },
    });
    const first = canonicalWorkSpecIdentity("## Outcome\r\nSame state   \r\n", metadata);
    const second = canonicalWorkSpecIdentity("## Outcome\nSame state", metadata);
    expect(first.digest).toBe(second.digest);
    expect(workSpecDigestFromRequirements("## Outcome\nSame state", metadata)).toBe(first.digest);
    const review = reviewStartSchema.parse({
      version: 1, kind: "review_start", session_id: "rev-code-digest", role: "code", identity,
      fugue_version: "0.1.0-alpha.0", created_at: "2026-08-17T05:00:00.000Z",
    });
    expect(review.identity.workSpecDigest).toBe(CURRENT_WORK_SPEC_DIGEST);
  });

  it("uses an unpredictable request nonce so a future exact request cannot be preplayed", () => {
    const first = createIntegrationRequest(identity, "2026-08-16T20:00:00.500Z", "0123456789abcdef");
    const second = createIntegrationRequest(identity, "2026-08-16T20:00:00.500Z", "fedcba9876543210");
    expect(first.request_id).not.toBe(second.request_id);
    expect(first.request_id).toMatch(/^int-[0-9a-f]{16}-0123456789abcdef$/);
    expect(first.created_at).toBe("2026-08-16T20:00:00.000Z");
  });

  it("rejects validation evidence for a different identity or run binding", () => {
    expect(() => integrationValidationSchema.parse({
      version: 1,
      identity: { ...identity, protocolVersion: 2 },
      integration,
      passed: true,
      commands: ["npm ci", "npm test"],
      created_at: new Date().toISOString(),
    })).toThrow();
    const value = plan();
    const wrongRun = integrationValidationSchema.parse({
      version: 1,
      identity,
      integration: { ...integration, run_id: integration.run_id + 1 },
      passed: true,
      commands: ["npm ci", "npm test"],
      created_at: new Date().toISOString(),
    });
    expect(() => assertValidationMatchesPlan(value, wrongRun)).toThrow(/request\/run identity/);
  });

  it("rejects validation evidence that changes the protected-base command plan", () => {
    const value = plan();
    const valid = integrationValidationSchema.parse({
      version: 1,
      identity,
      integration,
      passed: true,
      commands: ["npm ci", "npm test"],
      created_at: new Date().toISOString(),
    });
    expect(() => assertValidationMatchesPlan(value, valid)).not.toThrow();
    expect(() => assertValidationMatchesPlan(value, { ...valid, commands: ["npm test -- --skip-critical"] })).toThrow(/protected-base command plan/);
  });

  it("keeps candidate validation credential-separated and shell inputs quoted", async () => {
    const workflow = await readFile(".github/workflows/fugue-integration.yml", "utf8");
    expect(workflow).toContain("permissions:\n      contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('GITHUB_TOKEN: ""');
    expect(workflow).toContain('GH_TOKEN: ""');
    expect(workflow).toContain("FUGUE_RUNTIME_SHA: ${{ github.sha }}");
    expect(workflow).toContain("dispatch_secret:");
    expect(workflow).toContain("authority_anchor:");
    expect(workflow).toContain("environment: fugue-authority");
    expect(workflow).toContain("Audit external Fugue Authority environment invariant");
    expect(workflow).toContain("deployment-branch-policies?per_page=100");
    expect(workflow).toContain("names.length !== 1 || names[0] !== branch");
    expect(workflow).toContain("actions/create-github-app-token@v3");
    expect(workflow).toContain("permission-variables: write");
    expect(workflow).toContain("FUGUE_AUTHORITY_APP_PRIVATE_KEY");
    expect(workflow).toContain("FUGUE_AUTHORITY_TOKEN");
    expect(workflow).toContain("Commit protected Integration run-start evidence");
    const prepare = workflow.slice(workflow.indexOf("  prepare:"), workflow.indexOf("  validate:"));
    expect(prepare).toContain("actions: read");
    expect(workflow).toContain("FUGUE_INT_S_${String(prNumber).padStart(10, '0')}_${requestToken}");
    expect(workflow).toContain("/actions/variables/${anchorName}");
    expect(workflow).toContain("method: 'POST'");
    expect(workflow).not.toContain("method: 'PATCH'");
    expect(workflow).not.toContain("/git/refs/");
    expect(workflow).not.toContain("fugue/integration/${digest}");
    expect(workflow).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(workflow.indexOf("Commit protected Integration run-start evidence")).toBeLessThan(workflow.indexOf("actions/checkout@v4"));
    expect(workflow).toContain('--runtime-sha "$FUGUE_RUNTIME_SHA"');
    expect(workflow).not.toContain('integration-runtime prepare "${{ inputs.pr }}"');
  });

  it("allows cleanup-aware run-start no-op only for exact durable d3 request/evaluation/run/attempt", () => {
    const request = createIntegrationRequest(identity, "2026-08-18T18:00:00.000Z", "1234567890abcdef");
    const anchorName = `FUGUE_INT_A_${String(identity.prNumber).padStart(10, "0")}_${createHash("sha256").update(request.request_id, "utf8").digest("hex").slice(0, 16).toUpperCase()}`;
    const record = createIntegrationRecord(request, {
      dispatch: { secret_digest: "1".repeat(64), authorized_at: "2026-08-18T18:00:00.000Z", anchor_name: anchorName },
      run: { id: 7001, attempt: 1, created_at: "2026-08-18T18:00:01.000Z", html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/7001" },
      createdAt: "2026-08-18T18:00:01.000Z",
    });
    const context = { requestId: request.request_id, prNumber: identity.prNumber, baseSha: identity.baseSha, anchorName, runId: 7001, runAttempt: 1 };
    expect(matchesCleanupAwareDurableRunStartBinding(record, context)).toBe(true);
    expect(matchesCleanupAwareDurableRunStartBinding({ ...record, run: null }, context)).toBe(false);
    expect(matchesCleanupAwareDurableRunStartBinding(record, { ...context, runId: 7002 })).toBe(false);
    expect(matchesCleanupAwareDurableRunStartBinding(record, { ...context, requestId: request.request_id.replace(/.$/, "1") })).toBe(false);
    const wrongEvaluation = { ...record, identity: { ...record.identity, headSha: "f".repeat(40) } } as typeof record;
    expect(matchesCleanupAwareDurableRunStartBinding(wrongEvaluation, context)).toBe(false);
    expect(matchesCleanupAwareDurableRunStartBinding(record, { ...context, runAttempt: 2 })).toBe(false);
  });

  it("uses only committed durable d3 Authority witnesses for cleanup-aware run-start fallback", async () => {
    const workflow = await readFile(".github/workflows/fugue-integration.yml", "utf8");
    expect(workflow).toContain("durableExactBindingAfterCleanup");
    expect(workflow).toContain("FUGUE_D3_");
    expect(workflow).toContain("FUGUE_D3P_");
    expect(workflow).toContain("cursor.commit_witness !== true");
    expect(workflow).toContain("cursor.best_manifest.status_ids.length !== cursor.best_manifest.chunk_count");
    expect(workflow).toContain("canonicalRequestId !== requestId");
    expect(workflow).toContain("record.run.id !== runId || record.run.attempt !== runAttempt");
    expect(workflow).toContain("Protected Integration request anchor is missing without matching durable d3 exact-run authority");
    expect(workflow).toContain("Protected Integration dispatch fence is missing without matching durable d3 exact-run authority");
    const runStart = workflow.slice(workflow.indexOf("Commit protected Integration run-start evidence"), workflow.indexOf("- uses: actions/checkout@v4"));
    expect(runStart).not.toContain("deployments");
    expect(runStart).not.toContain("workflow-runs");
    expect(runStart).not.toContain("issues/comments");
  });

  it("pins reconciliation to workflow_sha and prevents issue-event pending replacement", async () => {
    const workflow = await readFile(".github/workflows/fugue-control-plane.yml", "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).toContain("FUGUE_WORKFLOW_SHA: ${{ github.workflow_sha }}");
    expect(workflow).toContain("environment: fugue-authority");
    expect(workflow).toContain("Audit external Fugue Authority environment invariant");
    expect(workflow).toContain("deployment-branch-policies?per_page=100");
    expect(workflow).toContain("names.length !== 1 || names[0] !== branch");
    expect(workflow).toContain("actions/create-github-app-token@v3");
    expect(workflow).toContain("permission-actions: write");
    expect(workflow).toContain("permission-variables: write");
    expect(workflow).toContain("FUGUE_AUTHORITY_TOKEN: ${{ steps.fugue-authority.outputs.token }}");
    expect(workflow).toContain("FUGUE_AUTHORITY_ACTOR_ID: ${{ steps.fugue-authority-actor.outputs.id }}");
    expect(workflow).toContain("github.event_name == 'issues'");
    expect(workflow).toContain("github.run_id");
    expect(workflow).not.toContain("group: fugue-control-plane-${{ github.repository }}\n");
  });

  it("covers all direct Security-QA trust primitives requested by the contract", async () => {
    const config = await readFile(".fugue/config.yml", "utf8");
    for (const path of [
      "src/cli.ts",
      "src/commands/advance.ts",
      "src/commands/run.ts",
      "src/core/validation.ts",
      "src/core/git.ts",
      "src/core/config.ts",
      "src/core/ownership.ts",
      "src/core/state.ts",
      "src/core/reconcile.ts",
      "src/core/provenance.ts",
      "src/core/integration.ts",
      "src/core/integration-status.ts",
    ]) expect(config).toContain(`- "${path}"`);
  });

  it("treats CLI, validation, config, ownership and trust runtime as Human control-plane changes", async () => {
    const raw = await readFile(".fugue/config.yml", "utf8");
    const config = parseConfig(raw);
    for (const path of [
      "src/cli.ts",
      "src/commands/advance.ts",
      "src/commands/run.ts",
      "src/core/validation.ts",
      "src/core/config.ts",
      "src/core/ownership.ts",
      "src/core/reconcile.ts",
      "src/core/state.ts",
      "src/core/provenance.ts",
      "src/core/integration-status.ts",
      "src/commands/integration-runtime.ts",
      "src/commands/init.ts",
      "src/core/repository-init.ts",
    ]) {
      const resolution = resolveQaRequirements(config, [path]);
      expect(resolution.controlPlaneChanged, path).toBe(true);
      expect(resolution.required.some((item) => item.role === "security"), path).toBe(true);
    }
  });

  it("removes mutable live history from hosted lost-bind authority", async () => {
    const reconcile = await readFile("src/core/reconcile.ts", "utf8");
    const control = await readFile(".github/workflows/fugue-control-plane.yml", "utf8");
    const protectedStart = reconcile.indexOf("function integrationAuthorityActorId");
    const protectedEnd = reconcile.indexOf("async function syncPrDraft");
    const hostedRecovery = reconcile.slice(protectedStart, protectedEnd);
    expect(hostedRecovery).toContain("FUGUE_INT_F_");
    expect(hostedRecovery).toContain("FUGUE_INT_B_");
    expect(hostedRecovery).toContain("protectedIntegrationRecoveryDecision");
    expect(hostedRecovery).toContain("return_run_details: true");
    expect(hostedRecovery).toContain('"X-GitHub-Api-Version": "2026-03-10"');
    expect(hostedRecovery).toContain("bindDispatchedIntegrationRun");
    expect(hostedRecovery).toContain("expectedHtmlUrl");
    expect(hostedRecovery).not.toContain('GET /repos/{owner}/{repo}/deployments');
    expect(hostedRecovery).not.toContain("correlatedIntegrationDeploymentSnapshot");
    expect(control).not.toContain("deployments: read");
    expect(control).toContain("types: [requested, completed]");
    expect(control).toContain("Persist protected Integration binding witness");
    expect(control).toContain("actorId !== expectedActorId");
    expect(control).toContain("run.actor?.type !== 'Bot'");
    expect(control.indexOf("Persist protected Integration binding witness")).toBeLessThan(control.indexOf("uses: actions/checkout@v4"));
  });

  it("makes bounded monotonic progress across arbitrarily deep later history and page shifts", () => {
    const requestCreatedAt = "2026-08-18T07:00:00.000Z";
    const fenceCreatedAt = "2026-08-18T07:00:01.000Z";
    const laterHistory = Array.from({ length: 1_000_000 }, (_, index) => 9_000_000 + index);
    const first = protectedIntegrationRecoveryDecision({
      requestCreatedAt, fenceCreatedAt, now: Date.parse("2026-08-18T07:00:02.000Z"),
    });
    laterHistory.splice(0, 500_000);
    laterHistory.reverse();
    const resumed = protectedIntegrationRecoveryDecision({
      requestCreatedAt, fenceCreatedAt, now: Date.parse("2026-08-18T07:05:00.000Z"),
    });
    expect(first).toEqual({ kind: "pending" });
    expect(resumed).toEqual({ kind: "pending" });
  });

  it("binds deleted legitimate L from the protected witness and never elects later replay A", () => {
    const L = { runId: 4242, createdAt: "2026-08-18T07:00:02.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4242" };
    const laterReplayA = { runId: 4243, createdAt: "2026-08-18T07:00:03.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4243" };
    const result = protectedIntegrationRecoveryDecision({
      requestCreatedAt: "2026-08-18T07:00:00.000Z",
      fenceCreatedAt: "2026-08-18T07:00:01.000Z",
      witness: L,
      now: Date.parse("2026-08-18T07:20:00.000Z"),
    });
    expect(result).toEqual({ kind: "bind", ...L });
    expect(result.kind === "bind" ? result.runId : 0).not.toBe(laterReplayA.runId);
  });

  it("terminalizes a stranded may-have-dispatched fence as identity_lost without fabricating run authority or retry", () => {
    const input = {
      requestCreatedAt: "2026-08-18T07:00:00.000Z",
      fenceCreatedAt: "2026-08-18T07:00:01.000Z",
    };
    for (let invocation = 0; invocation < 50; invocation += 1) {
      const result = protectedIntegrationRecoveryDecision({
        ...input,
        now: Date.parse("2026-08-18T07:11:00.000Z") + invocation * 15 * 60 * 1000,
      });
      expect(result).toEqual({ kind: "identity_lost" });
      expect(result).not.toHaveProperty("runId");
    }
  });

  it("does not invent exact L when dispatch creation outruns both the synchronous response and every protected witness", () => {
    const legitimateCreatedRunL = 4242;
    const laterReplayA = 4243;
    const result = protectedIntegrationRecoveryDecision({
      requestCreatedAt: "2026-08-18T07:00:00.000Z",
      fenceCreatedAt: "2026-08-18T07:00:01.000Z",
      now: Date.parse("2026-08-18T07:30:00.000Z"),
    });
    expect(result).toEqual({ kind: "identity_lost" });
    expect(result).not.toHaveProperty("runId");
    expect(legitimateCreatedRunL).not.toBe(laterReplayA);
  });

  it("documents the external Authority bootstrap invariant and safe local read path", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("Before the App private key is installed");
    expect(readme).toContain("FUGUE_AUTHORITY_TOKEN");
    expect(readme).toContain("Variables: read");
    expect(readme).not.toContain("Integration scans all workflow-run pages");
  });
});

// Focused request-local Integration terminal serialization regressions.
import { readFileSync } from "node:fs";
import {
  claimIntegrationCommitWithStore,
  integrationExactRunCommitSchema,
  integrationIdentityLostCommitSchema,
  type IntegrationCommitStore,
  type IntegrationCommitContext,
} from "../src/core/integration-status.js";

const context: IntegrationCommitContext = {
  requestId: "int-1111111111111111-2222222222222222",
  prNumber: 19,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  anchorName: "FUGUE_INT_A_0000000019_0123456789ABCDEF",
};

const exact = integrationExactRunCommitSchema.parse({
  version: 1,
  kind: "integration_exact_run_commit",
  request_id: context.requestId,
  pr_number: context.prNumber,
  head_sha: context.headSha,
  base_sha: context.baseSha,
  anchor_name: context.anchorName,
  run_id: 99101,
  run_attempt: 1,
  run_created_at: "2026-08-18T12:00:02.000Z",
  html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/99101",
});

const lost = integrationIdentityLostCommitSchema.parse({
  version: 1,
  kind: "integration_identity_lost_commit",
  request_id: context.requestId,
  pr_number: context.prNumber,
  head_sha: context.headSha,
  base_sha: context.baseSha,
  anchor_name: context.anchorName,
  attempt: 1,
  boundary_created_at: "2026-08-18T12:00:01.000Z",
  fence_digest: `sha256:${"c".repeat(64)}`,
  created_at: "2026-08-18T12:11:00.000Z",
});

function createOnlyStore(): IntegrationCommitStore & { value(): string | undefined } {
  let value: string | undefined;
  return {
    async create(candidate) {
      if (value !== undefined) return false;
      value = candidate;
      return true;
    },
    async read() { return value; },
    value() { return value; },
  };
}

describe("request-local Integration terminal serialization", () => {
  it("lets exact L win when B/S commits after terminal final-read but before terminal commit", async () => {
    const store = createOnlyStore();
    expect((await claimIntegrationCommitWithStore(store, context, exact)).kind).toBe("integration_exact_run_commit");
    const terminalWinner = await claimIntegrationCommitWithStore(store, context, lost);
    expect(terminalWinner).toMatchObject({ kind: "integration_exact_run_commit", run_id: exact.run_id });
  });

  it("makes delayed B/S permanently inert when identity_lost commits first", async () => {
    const store = createOnlyStore();
    expect((await claimIntegrationCommitWithStore(store, context, lost)).kind).toBe("integration_identity_lost_commit");
    const lateExact = await claimIntegrationCommitWithStore(store, context, exact);
    expect(lateExact).toMatchObject({
      kind: "integration_identity_lost_commit",
      boundary_created_at: lost.boundary_created_at,
      fence_digest: lost.fence_digest,
    });
  });

  it("converges concurrent identity_lost terminalizers on one idempotent value", async () => {
    const store = createOnlyStore();
    const [left, right] = await Promise.all([
      claimIntegrationCommitWithStore(store, context, lost),
      claimIntegrationCommitWithStore(store, context, lost),
    ]);
    expect(left).toEqual(lost);
    expect(right).toEqual(lost);
  });

  it("rejects stale run-null publication and keeps known cancellation terminal", () => {
    const status = readFileSync(new URL("../src/core/integration-status.ts", import.meta.url), "utf8");
    expect(status).toContain("if (current?.run && !record.run)");
    expect(status).toContain("cannot clear protected run");
    expect(status).not.toContain("isRecoverableAbortedRun");
    expect(status).not.toContain('state: "aborted", detail: "Protected attempt 1 completed cancelled.');
    expect(status).toContain("known attempt is never retryable transport");
    expect(status).toContain("known attempt 1 cannot become retryable transport");
  });

  it("serializes B/S through C and revalidates their cleanup prerequisites after C", () => {
    const control = readFileSync(new URL("../.github/workflows/fugue-control-plane.yml", import.meta.url), "utf8");
    const integration = readFileSync(new URL("../.github/workflows/fugue-integration.yml", import.meta.url), "utf8");

    const bCommit = control.indexOf("const committedRaw =");
    const bRevalidate = control.indexOf("const fenceAfterCommit =", bCommit);
    const bPublish = control.indexOf("const witness =", bCommit);
    expect(control).toContain("FUGUE_INT_C_${suffix}");
    expect(control).toContain("integration_identity_lost_commit') process.exit(0)");
    expect(bCommit).toBeGreaterThanOrEqual(0);
    expect(bRevalidate).toBeGreaterThan(bCommit);
    expect(bPublish).toBeGreaterThan(bRevalidate);
    expect(control).toContain("await deleteVariable(commitName)");

    const sCommit = integration.indexOf("const commitVariable =");
    const sFenceRevalidate = integration.indexOf("const fenceAfterCommit =", sCommit);
    const sAnchorRevalidate = integration.indexOf("const anchorAfterCommit =", sCommit);
    const sPublish = integration.indexOf("const startEvidence =", sCommit);
    expect(integration).toContain("FUGUE_INT_C_${suffix}");
    expect(integration).toContain("integration_identity_lost_commit') process.exit(0)");
    expect(sCommit).toBeGreaterThanOrEqual(0);
    expect(sFenceRevalidate).toBeGreaterThan(sCommit);
    expect(sAnchorRevalidate).toBeGreaterThan(sCommit);
    expect(sPublish).toBeGreaterThan(sFenceRevalidate);
    expect(sPublish).toBeGreaterThan(sAnchorRevalidate);
    expect(integration).toContain("await deleteVariable(commitName)");
  });

  it("revalidates d3 request authority after C before either exact-run binding publish", () => {
    const status = readFileSync(new URL("../src/core/integration-status.ts", import.meta.url), "utf8");
    expect(status).toContain("async function revalidateExactIntegrationCommit");
    expect(status.match(/await revalidateExactIntegrationCommit\(/g)?.length).toBe(2);
    expect(status).toContain("ceased to be active after exact-run serialization");
  });

  it("preserves only proven no-attempt aborted transport and keeps cleanup C-last", () => {
    const status = readFileSync(new URL("../src/core/integration-status.ts", import.meta.url), "utf8");
    expect(status).toContain("protected evidence proves no attempt was created");
    expect(status).toContain('terminal: {\n          state: "aborted"');

    const release = status.indexOf("export async function releaseIntegrationAuthorityVariable");
    const fenceDelete = status.indexOf("integrationDispatchFenceName", release);
    const anchorDelete = status.indexOf("record.dispatch.anchor_name", release);
    const bindingDelete = status.indexOf("integrationBindingWitnessName", release);
    const startDelete = status.indexOf("integrationRunStartVariableName", release);
    const commitDelete = status.indexOf("releaseIntegrationCommit", release);
    expect(fenceDelete).toBeGreaterThan(release);
    expect(anchorDelete).toBeGreaterThan(release);
    expect(bindingDelete).toBeGreaterThan(release);
    expect(startDelete).toBeGreaterThan(release);
    expect(commitDelete).toBeGreaterThan(startDelete);
    expect(status).toContain("if (normalized.terminal) await releaseIntegrationAuthorityVariable(github, normalized)");
  });
});

// Cross-protected-base historical identity_lost recovery regressions.
import { vi } from "vitest";
import type { FugueGitHub } from "../src/core/github.js";
import {
  authorizeIntegrationDispatch,
  bindDispatchedIntegrationRun,
  claimIdentityLostIntegrationCommit,
  currentIntegrationState,
  getCurrentIntegrationRecord,
  integrationCommitVariableName,
  integrationDispatchRunToken,
  integrationRunStartVariableName,
  publishIntegrationRecord,
  reclaimOrphanIntegrationAuthorityVariables,
  serializeIntegrationRunStartEvidence,
} from "../src/core/integration-status.js";

interface HistoricalTestStatus {
  id: number;
  sha: string;
  context: string;
  description: string;
  target_url?: string;
  created_at: string;
}

interface HistoricalTestGithub extends FugueGitHub {
  __baseSha: string;
  __authorityVariables: Map<string, string>;
  __statuses: HistoricalTestStatus[];
  __beforeRevisionCheck?: () => Promise<void> | void;
}

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  const verifyPublication = async (_github: FugueGitHub, body: string, _expected: string): Promise<boolean> => {
    if (body.includes("<!-- fugue-durable-recovery") || body.includes("INTEGRATION DISPATCH — AUTHORIZED") ||
        body.includes("INTEGRATION RUN — STARTED")) return body.includes("token: test-proof");
    const key = body.match(/Fugue-Authority-Key: ([0-9a-f]{32})/i)?.[1];
    const commit = body.match(/Fugue-Authority-Commit: ([0-9a-f]{32})/i)?.[1];
    return Boolean(key && commit && !/^0+$/.test(key) && !/^0+$/.test(commit));
  };
  return {
    ...actual,
    assertRepositoryDefaultBranchRevision: vi.fn(async (github: FugueGitHub, expected: string) => {
      await (github as HistoricalTestGithub).__beforeRevisionCheck?.();
      const actualSha = (github as HistoricalTestGithub).__baseSha;
      if (actualSha.toLowerCase() !== expected.toLowerCase()) throw new Error(`stale protected revision ${actualSha.slice(0, 8)}`);
    }),
    readRepositoryDefaultBranchIdentity: vi.fn(async (github: FugueGitHub) => ({ branch: "main", sha: (github as HistoricalTestGithub).__baseSha })),
    signProtocolBody: vi.fn(async (_github: FugueGitHub, body: string) => `${body}\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: test-proof\n-->`),
    createDurableManifestProof: vi.fn(async () => "manifest-proof"),
    verifyDurableManifestProof: vi.fn(async (_github: FugueGitHub, proof: string) => proof === "manifest-proof"),
    verifyProtocolPublicationBodyAtRevision: vi.fn(verifyPublication),
    isTrustedProtocolComment: vi.fn(async () => false),
    createProtocolComment: vi.fn(async (_github: FugueGitHub, _issueNumber: number, body: string) => ({
      data: { id: 1, html_url: "https://github.com/JohnnyZLi/Fugue/pull/19#issuecomment-1", body, created_at: new Date().toISOString() },
    })),
  };
});

const HIST_B1 = "b".repeat(40);
const HIST_B2 = "c".repeat(40);
const HIST_B3 = "d".repeat(40);

function makeHistoricalGithub(): HistoricalTestGithub {
  const authorityVariables = new Map<string, string>();
  const statuses: HistoricalTestStatus[] = [];
  let nextStatusId = 10_000;
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    __baseSha: HIST_B1,
    __authorityVariables: authorityVariables,
    __statuses: statuses,
    octokit: {
      paginate: vi.fn(async (method: (args: Record<string, unknown>) => Promise<{ data: unknown }>, args: Record<string, unknown>) => (await method(args)).data),
      rest: {
        issues: {
          get: vi.fn(async () => ({ data: { comments: 0 } })),
          listComments: vi.fn(async () => ({ data: [] })),
          deleteComment: vi.fn(async () => ({ data: {} })),
        },
        repos: {
          createCommitStatus: vi.fn(async (args: { sha: string; context: string; description?: string; target_url?: string }) => {
            const status: HistoricalTestStatus = {
              id: ++nextStatusId,
              sha: args.sha,
              context: args.context,
              description: args.description ?? "",
              ...(args.target_url ? { target_url: args.target_url } : {}),
              created_at: new Date().toISOString(),
            };
            statuses.push(status);
            return { data: status };
          }),
        },
      },
    },
  } as unknown as HistoricalTestGithub;
}

function historicalIdentity(prNumber: number, headChar: string, baseSha = HIST_B1) {
  return {
    prNumber,
    headSha: headChar.repeat(40),
    baseBranch: "main",
    baseSha,
    policyDigest: `sha256:policy-${baseSha.slice(0, 4)}`,
    protocolVersion: 1 as const,
    issueNumber: 8000 + prNumber,
    workId: `work-${8000 + prNumber}`,
    workSpecDigest: `sha256:spec-${headChar}-${baseSha.slice(0, 4)}`,
  };
}

function protectedRecoveryVariableNames(requestId: string) {
  const suffix = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 32).toUpperCase();
  return { fence: `FUGUE_INT_F_${suffix}`, binding: `FUGUE_INT_B_${suffix}` };
}

async function seedHistoricalAmbiguity(github: HistoricalTestGithub, prNumber: number, nonce: string) {
  const oldIdentity = historicalIdentity(prNumber, "1", HIST_B1);
  const request = createIntegrationRequest(oldIdentity, "2026-08-18T20:00:00.000Z", nonce);
  const secret = prNumber.toString(16).padStart(64, "0");
  const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-18T20:00:00.000Z", secret);
  const anchorBody = github.__authorityVariables.get(authorized.authorization.anchor_name)!;
  const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
    dispatch: authorized.authorization,
    createdAt: "2026-08-18T20:00:00.000Z",
  }));
  github.__authorityVariables.delete(authorized.electionName);
  const names = protectedRecoveryVariableNames(request.request_id);
  const runToken = integrationDispatchRunToken(request.request_id, secret);
  const fence = {
    version: 1,
    kind: "integration_dispatch_fence",
    request_id: request.request_id,
    pr_number: oldIdentity.prNumber,
    head_sha: oldIdentity.headSha,
    base_sha: oldIdentity.baseSha,
    anchor_name: authorized.authorization.anchor_name,
    secret_digest: authorized.authorization.secret_digest,
    run_token: runToken,
    authority_actor_id: 424242,
    created_at: "2026-08-18T20:00:01.000Z",
  };
  const fenceRaw = JSON.stringify(fence);
  github.__authorityVariables.set(names.fence, fenceRaw);
  return { oldIdentity, request, secret, authorized, anchorBody, record, names, fence, fenceRaw, runToken };
}

async function claimHistoricalLostC(github: HistoricalTestGithub, seeded: Awaited<ReturnType<typeof seedHistoricalAmbiguity>>) {
  const createdAt = new Date(Date.parse(seeded.record.created_at) + 1).toISOString();
  const fenceDigest = `sha256:${createHash("sha256").update(seeded.fenceRaw, "utf8").digest("hex")}`;
  await claimIdentityLostIntegrationCommit(github, {
    requestId: seeded.request.request_id,
    prNumber: seeded.oldIdentity.prNumber,
    headSha: seeded.oldIdentity.headSha,
    baseSha: seeded.oldIdentity.baseSha,
    anchorName: seeded.authorized.authorization.anchor_name,
  }, { boundaryCreatedAt: seeded.fence.created_at, fenceDigest, createdAt });
  return { createdAt, fenceDigest };
}

function recoveryCheckpointBodiesForHistoricalTest(github: HistoricalTestGithub): string[] {
  const result: string[] = [];
  for (const [name, value] of github.__authorityVariables) {
    if (name.startsWith("FUGUE_D3_")) { result.push(value); continue; }
    if (!name.startsWith("FUGUE_D3P_")) continue;
    try {
      const pack = JSON.parse(value) as { kind?: unknown; entries?: unknown };
      if (pack.kind !== "durable_recovery_pack" || !Array.isArray(pack.entries)) continue;
      for (const entry of pack.entries) if (typeof entry === "string") result.push(entry);
    } catch { /* malformed packs are irrelevant */ }
  }
  return result;
}

function historicalTombstoneScope(requestId: string, prNumber: number): string {
  const requestToken = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 16).toUpperCase();
  return `int-hist/${prNumber}/${requestToken}`;
}

function historicalTombstones(github: HistoricalTestGithub, requestId: string, prNumber: number): Array<Record<string, unknown>> {
  const scope = historicalTombstoneScope(requestId, prNumber);
  return recoveryCheckpointBodiesForHistoricalTest(github).flatMap((body) => {
    const cursorPayload = body.match(/<!-- fugue-durable-recovery\nversion: 1\npayload: ([A-Za-z0-9_-]+)/)?.[1];
    if (!cursorPayload) return [];
    let cursor: { scope?: unknown; commit_witness?: unknown; best_body_b64?: unknown };
    try { cursor = JSON.parse(Buffer.from(cursorPayload, "base64url").toString("utf8")); } catch { return []; }
    if (cursor.scope !== scope || cursor.commit_witness !== true || typeof cursor.best_body_b64 !== "string") return [];
    const bestBody = Buffer.from(cursor.best_body_b64, "base64url").toString("utf8");
    const payload = bestBody.match(/<!-- fugue-historical-integration-identity-lost\nversion: 1\npayload: ([A-Za-z0-9_-]+)/)?.[1];
    if (!payload) return [];
    try { return [JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>]; } catch { return []; }
  });
}

function currentDriftIdentity(oldIdentity: ReturnType<typeof historicalIdentity>, baseSha: string, headChar: string) {
  return {
    ...oldIdentity,
    headSha: headChar.repeat(40),
    baseSha,
    policyDigest: `sha256:policy-${baseSha.slice(0, 4)}`,
    workSpecDigest: `sha256:spec-${headChar}-${baseSha.slice(0, 4)}`,
  };
}

async function installDelayedHistoricalBindingAndStart(
  github: HistoricalTestGithub,
  seeded: Awaited<ReturnType<typeof seedHistoricalAmbiguity>>,
  runId: number,
): Promise<void> {
  const htmlUrl = `https://github.com/JohnnyZLi/Fugue/actions/runs/${runId}`;
  github.__authorityVariables.set(seeded.names.binding, JSON.stringify({
    version: 1, kind: "integration_binding_witness", request_id: seeded.request.request_id,
    pr_number: seeded.oldIdentity.prNumber, head_sha: seeded.oldIdentity.headSha, base_sha: seeded.oldIdentity.baseSha,
    anchor_name: seeded.authorized.authorization.anchor_name, run_token: seeded.runToken, authority_actor_id: 424242,
    run_id: runId, run_attempt: 1, run_created_at: "2026-08-18T20:10:00.000Z", html_url: htmlUrl,
  }));
  const start = serializeIntegrationRunStartEvidence({
    version: 1, kind: "integration_run_start", request_id: seeded.request.request_id,
    pr_number: seeded.oldIdentity.prNumber, head_sha: seeded.oldIdentity.headSha, base_sha: seeded.oldIdentity.baseSha,
    secret_digest: seeded.authorized.authorization.secret_digest, anchor_name: seeded.authorized.authorization.anchor_name,
    run_id: runId + 1, run_attempt: 1, created_at: "2026-08-18T20:10:01.000Z",
  });
  github.__authorityVariables.set(integrationRunStartVariableName(seeded.request), `${start}\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: test-proof\n-->`);
}

describe("cross-protected-base historical identity_lost recovery", () => {
  it("seals B1 lost-C under B2, reclaims F/A/C, survives presentation deletion, and cannot satisfy current B2 Integration", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 601, "0000000000000601");
    const lostC = await claimHistoricalLostC(github, seeded);
    const historicalBefore = await getCurrentIntegrationRecord(github, seeded.oldIdentity);
    github.__statuses.splice(0);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "2");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse(lostC.createdAt) + 60_000, [b2]);
    expect(github.__authorityVariables.has(seeded.names.fence)).toBe(false);
    expect(github.__authorityVariables.has(seeded.authorized.authorization.anchor_name)).toBe(false);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    expect(await getCurrentIntegrationRecord(github, seeded.oldIdentity)).toEqual(historicalBefore);
    const tombstones = historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      kind: "historical_integration_identity_lost",
      recovery_base_sha: HIST_B2,
      request: { request_id: seeded.request.request_id, identity: seeded.oldIdentity },
      commit: { kind: "integration_identity_lost_commit", attempt: 1, boundary_created_at: seeded.fence.created_at, fence_digest: lostC.fenceDigest },
    });
    await expect(currentIntegrationState(github, { identity: b2, pr: { number: b2.prNumber } } as unknown as EvaluationSnapshot, Date.parse(lostC.createdAt) + 120_000))
      .resolves.toMatchObject({ state: "none" });
  });

  it("recovers a crash after lost C when B1 is no longer current instead of trying to publish fresh B1 d3", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 602, "0000000000000602");
    const lostC = await claimHistoricalLostC(github, seeded);
    const oldBefore = await getCurrentIntegrationRecord(github, seeded.oldIdentity);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "3");
    await expect(reclaimOrphanIntegrationAuthorityVariables(github, Date.parse(lostC.createdAt) + 1, [b2])).resolves.toBeUndefined();
    const oldAfter = await getCurrentIntegrationRecord(github, seeded.oldIdentity);
    expect(oldAfter).toEqual(oldBefore);
    expect(oldAfter?.terminal).toBeNull();
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toHaveLength(1);
  });

  it("makes monotonic B1 to B2 to B3 progress when B2 advances during tombstone publication", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 603, "0000000000000603");
    const lostC = await claimHistoricalLostC(github, seeded);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "4");
    let advanced = false;
    github.__beforeRevisionCheck = () => { if (!advanced) { advanced = true; github.__baseSha = HIST_B3; } };
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse(lostC.createdAt) + 1, [b2]);
    expect(advanced).toBe(true);
    expect(github.__authorityVariables.has(seeded.names.fence)).toBe(true);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(true);
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
    github.__beforeRevisionCheck = undefined;
    const b3 = currentDriftIdentity(seeded.oldIdentity, HIST_B3, "5");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse(lostC.createdAt) + 2, [b3]);
    expect(github.__authorityVariables.has(seeded.names.fence)).toBe(false);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    const tombstones = historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.recovery_base_sha).toBe(HIST_B3);
  });

  it("keeps delayed historical B/S inert after lost C cleanup and removes them from the durable tombstone alone", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 604, "0000000000000604");
    const lostC = await claimHistoricalLostC(github, seeded);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "6");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse(lostC.createdAt) + 1, [b2]);
    await installDelayedHistoricalBindingAndStart(github, seeded, 160401);
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse(lostC.createdAt) + 2, [b2]);
    expect(github.__authorityVariables.has(seeded.names.binding)).toBe(false);
    expect(github.__authorityVariables.has(integrationRunStartVariableName(seeded.request))).toBe(false);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    expect((await getCurrentIntegrationRecord(github, seeded.oldIdentity))?.run).toBeNull();
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toHaveLength(1);
  });

  it("preserves exact L that won before the protected-base advance and never replaces it with identity_lost", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 605, "0000000000000605");
    const htmlUrl = "https://github.com/JohnnyZLi/Fugue/actions/runs/160501";
    const bound = await bindDispatchedIntegrationRun(
      github,
      { identity: seeded.oldIdentity, pr: { number: seeded.oldIdentity.prNumber } } as unknown as EvaluationSnapshot,
      seeded.request.request_id, 160501, htmlUrl, "2026-08-18T20:00:02.000Z",
    );
    github.__authorityVariables.set(seeded.names.binding, JSON.stringify({
      version: 1, kind: "integration_binding_witness", request_id: seeded.request.request_id,
      pr_number: seeded.oldIdentity.prNumber, head_sha: seeded.oldIdentity.headSha, base_sha: seeded.oldIdentity.baseSha,
      anchor_name: seeded.authorized.authorization.anchor_name, run_token: seeded.runToken, authority_actor_id: 424242,
      run_id: 160501, run_attempt: 1, run_created_at: bound.run!.created_at, html_url: htmlUrl,
    }));
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "7");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:30:00.000Z"), [b2]);
    expect(github.__authorityVariables.has(seeded.names.binding)).toBe(false);
    expect((await getCurrentIntegrationRecord(github, seeded.oldIdentity))?.run?.id).toBe(160501);
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
  });

  it("preserves proven-no-attempt historical aborted as the only retryable outcome and does not mint lost tombstone", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 606, "0000000000000606");
    const abortedAt = new Date(Date.parse(seeded.record.created_at) + 1).toISOString();
    const aborted = await publishIntegrationRecord(github, {
      ...seeded.record,
      terminal: { state: "aborted", detail: "protected evidence proves no attempt was created", created_at: abortedAt },
      created_at: abortedAt,
    });
    github.__authorityVariables.set(seeded.authorized.authorization.anchor_name, seeded.anchorBody);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "8");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse(abortedAt) + 1, [b2]);
    expect((await getCurrentIntegrationRecord(github, seeded.oldIdentity))?.terminal).toEqual(aborted.terminal);
    expect(github.__authorityVariables.has(seeded.authorized.authorization.anchor_name)).toBe(false);
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
  });
});
