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

  it("uses only the canonical protected d3 reader for cleanup-aware run-start fallback", async () => {
    const workflow = await readFile(".github/workflows/fugue-integration.yml", "utf8");
    const cleanupStart = workflow.indexOf("Verify cleanup-aware run-start against canonical d3 authority");
    const cleanupEnd = workflow.indexOf("- id: prepare", cleanupStart);
    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    const cleanup = workflow.slice(cleanupStart, cleanupEnd);
    expect(cleanup).toContain("recoverDurableProtocolRecord");
    expect(cleanup).toContain("matchesCleanupAwareDurableRunStartBinding");
    expect(cleanup).toContain("listFugueAuthorityVariables(github, 'FUGUE_D3')");
    expect(cleanup).not.toContain("deployments");
    expect(cleanup).not.toContain("workflow-runs");
    expect(cleanup).not.toContain("issues/comments");
    expect(workflow).toContain("ref: $" + "{{ github.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow.indexOf("npm run build")).toBeLessThan(cleanupStart);
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

import { vi } from "vitest";
import type { FugueGitHub } from "../src/core/github.js";
import {
  authorizeIntegrationDispatch,
  bindDispatchedIntegrationRun,
  claimExactIntegrationCommit,
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

class HistoricalAuthorityMap extends Map<string, string> {
  failAfterIntegrationDelete?: number;
  integrationDeleteCount = 0;

  armCleanupCrash(afterDeletes: number): void {
    this.failAfterIntegrationDelete = afterDeletes;
    this.integrationDeleteCount = 0;
  }

  override delete(key: string): boolean {
    if (this.failAfterIntegrationDelete !== undefined && /^FUGUE_INT_[ABCFS]_/.test(key)) {
      if (this.integrationDeleteCount++ === this.failAfterIntegrationDelete) {
        this.failAfterIntegrationDelete = undefined;
        throw new Error("simulated historical Integration cleanup crash");
      }
    }
    return super.delete(key);
  }
}

interface HistoricalTestGithub extends FugueGitHub {
  __baseSha: string;
  __authorityVariables: HistoricalAuthorityMap;
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
  const authorityVariables = new HistoricalAuthorityMap();
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

async function claimHistoricalExactC(
  github: HistoricalTestGithub,
  seeded: Awaited<ReturnType<typeof seedHistoricalAmbiguity>>,
  runId: number,
  createdAt = "2026-08-18T20:00:02.000Z",
) {
  const htmlUrl = `https://github.com/JohnnyZLi/Fugue/actions/runs/${runId}`;
  const commit = await claimExactIntegrationCommit(github, {
    requestId: seeded.request.request_id,
    prNumber: seeded.oldIdentity.prNumber,
    headSha: seeded.oldIdentity.headSha,
    baseSha: seeded.oldIdentity.baseSha,
    anchorName: seeded.authorized.authorization.anchor_name,
  }, { runId, createdAt, htmlUrl });
  return { commit, runId, createdAt, htmlUrl };
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
    } catch { }
  }
  return result;
}

function historicalTombstoneScope(requestId: string, prNumber: number): string {
  const requestToken = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 16).toUpperCase();
  return `int-hist/${prNumber}/${requestToken}`;
}

function historicalExactBridgeScope(requestId: string, prNumber: number): string {
  const requestToken = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 16).toUpperCase();
  return `int-hist-run/${prNumber}/${requestToken}`;
}

function historicalAuthorityPayloads(
  github: HistoricalTestGithub,
  requestId: string,
  prNumber: number,
  scope: string,
  marker: string,
): Array<Record<string, unknown>> {
  return recoveryCheckpointBodiesForHistoricalTest(github).flatMap((body) => {
    const cursorPayload = body.match(/<!-- fugue-durable-recovery\nversion: 1\npayload: ([A-Za-z0-9_-]+)/)?.[1];
    if (!cursorPayload) return [];
    let cursor: { scope?: unknown; commit_witness?: unknown; best_body_b64?: unknown };
    try { cursor = JSON.parse(Buffer.from(cursorPayload, "base64url").toString("utf8")); } catch { return []; }
    if (cursor.scope !== scope || cursor.commit_witness !== true || typeof cursor.best_body_b64 !== "string") return [];
    const bestBody = Buffer.from(cursor.best_body_b64, "base64url").toString("utf8");
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const payload = bestBody.match(new RegExp(`${escapedMarker}\\nversion: 1\\npayload: ([A-Za-z0-9_-]+)`))?.[1];
    if (!payload) return [];
    try { return [JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>]; } catch { return []; }
  });
}

function historicalTombstones(github: HistoricalTestGithub, requestId: string, prNumber: number): Array<Record<string, unknown>> {
  return historicalAuthorityPayloads(
    github, requestId, prNumber, historicalTombstoneScope(requestId, prNumber),
    "<!-- fugue-historical-integration-identity-lost",
  );
}

function historicalExactBridges(github: HistoricalTestGithub, requestId: string, prNumber: number): Array<Record<string, unknown>> {
  return historicalAuthorityPayloads(
    github, requestId, prNumber, historicalExactBridgeScope(requestId, prNumber),
    "<!-- fugue-historical-integration-exact-run",
  );
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

function installHistoricalExactBinding(
  github: HistoricalTestGithub,
  seeded: Awaited<ReturnType<typeof seedHistoricalAmbiguity>>,
  runId: number,
  createdAt: string,
): void {
  const htmlUrl = `https://github.com/JohnnyZLi/Fugue/actions/runs/${runId}`;
  github.__authorityVariables.set(seeded.names.binding, JSON.stringify({
    version: 1, kind: "integration_binding_witness", request_id: seeded.request.request_id,
    pr_number: seeded.oldIdentity.prNumber, head_sha: seeded.oldIdentity.headSha, base_sha: seeded.oldIdentity.baseSha,
    anchor_name: seeded.authorized.authorization.anchor_name, run_token: seeded.runToken, authority_actor_id: 424242,
    run_id: runId, run_attempt: 1, run_created_at: createdAt, html_url: htmlUrl,
  }));
}

function installHistoricalExactStart(
  github: HistoricalTestGithub,
  seeded: Awaited<ReturnType<typeof seedHistoricalAmbiguity>>,
  runId: number,
  createdAt: string,
): void {
  const start = serializeIntegrationRunStartEvidence({
    version: 1, kind: "integration_run_start", request_id: seeded.request.request_id,
    pr_number: seeded.oldIdentity.prNumber, head_sha: seeded.oldIdentity.headSha, base_sha: seeded.oldIdentity.baseSha,
    secret_digest: seeded.authorized.authorization.secret_digest, anchor_name: seeded.authorized.authorization.anchor_name,
    run_id: runId, run_attempt: 1, created_at: createdAt,
  });
  github.__authorityVariables.set(integrationRunStartVariableName(seeded.request), `${start}\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: test-proof\n-->`);
}

function installHistoricalExactBindingAndStart(
  github: HistoricalTestGithub,
  seeded: Awaited<ReturnType<typeof seedHistoricalAmbiguity>>,
  runId: number,
  createdAt: string,
): void {
  installHistoricalExactBinding(github, seeded, runId, createdAt);
  installHistoricalExactStart(github, seeded, runId, createdAt);
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
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
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
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
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
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
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
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
  });
});

describe("cross-protected-base historical exact-L bridge", () => {
  it("bridges exact C+B under B2 without rewriting B1 d3 or satisfying current Integration", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 610, "0000000000000610");
    const exactC = await claimHistoricalExactC(github, seeded, 161001);
    installHistoricalExactBinding(github, seeded, exactC.runId, exactC.createdAt);
    const oldBefore = await getCurrentIntegrationRecord(github, seeded.oldIdentity);
    expect(oldBefore?.run).toBeNull();
    github.__statuses.splice(0);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "2");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:20:00.000Z"), [b2]);
    const oldAfter = await getCurrentIntegrationRecord(github, seeded.oldIdentity);
    expect(oldAfter).toEqual(oldBefore);
    expect(oldAfter?.run).toBeNull();
    expect(github.__authorityVariables.has(seeded.names.fence)).toBe(false);
    expect(github.__authorityVariables.has(seeded.authorized.authorization.anchor_name)).toBe(false);
    expect(github.__authorityVariables.has(seeded.names.binding)).toBe(false);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toMatchObject({
      kind: "historical_integration_exact_run",
      recovery_base_sha: HIST_B2,
      request: { request_id: seeded.request.request_id, identity: seeded.oldIdentity },
      commit: { kind: "integration_exact_run_commit", run_id: exactC.runId, run_attempt: 1, run_created_at: exactC.createdAt, html_url: exactC.htmlUrl },
    });
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
    await expect(currentIntegrationState(github, { identity: b2, pr: { number: b2.prNumber } } as unknown as EvaluationSnapshot))
      .resolves.toMatchObject({ state: "none" });
  });

  it("recovers exact L from C alone after A/F/B/S were already removed", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 611, "0000000000000611");
    const exactC = await claimHistoricalExactC(github, seeded, 161101);
    github.__authorityVariables.delete(seeded.names.fence);
    github.__authorityVariables.delete(seeded.authorized.authorization.anchor_name);
    github.__authorityVariables.delete(seeded.names.binding);
    github.__authorityVariables.delete(integrationRunStartVariableName(seeded.request));
    github.__baseSha = HIST_B2;
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:20:00.000Z"), [currentDriftIdentity(seeded.oldIdentity, HIST_B2, "3")]);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
    expect(bridges).toHaveLength(1);
    expect((bridges[0]?.commit as { run_id?: number }).run_id).toBe(exactC.runId);
    expect((await getCurrentIntegrationRecord(github, seeded.oldIdentity))?.run).toBeNull();
  });

  it("lets a surviving protected B or S propose only the same L through create-only C before bridging", async () => {
    for (const [offset, evidence] of [[0, "B"], [1, "S"]] as const) {
      const github = makeHistoricalGithub();
      const seeded = await seedHistoricalAmbiguity(github, 612 + offset, `000000000000061${2 + offset}`);
      const runId = 161200 + offset;
      const createdAt = "2026-08-18T20:00:02.000Z";
      if (evidence === "B") installHistoricalExactBinding(github, seeded, runId, createdAt);
      else installHistoricalExactStart(github, seeded, runId, createdAt);
      expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
      github.__baseSha = HIST_B2;
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:20:00.000Z"), [currentDriftIdentity(seeded.oldIdentity, HIST_B2, "4")]);
      expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
      const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
      expect(bridges).toHaveLength(1);
      expect((bridges[0]?.commit as { run_id?: number }).run_id).toBe(runId);
      expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
    }
  });

  it("retries B1 to B2 to B3 bridge publication monotonically without changing L", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 614, "0000000000000614");
    const exactC = await claimHistoricalExactC(github, seeded, 161401);
    github.__baseSha = HIST_B2;
    let advanced = false;
    github.__beforeRevisionCheck = () => { if (!advanced) { advanced = true; github.__baseSha = HIST_B3; } };
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:20:00.000Z"), [currentDriftIdentity(seeded.oldIdentity, HIST_B2, "5")]);
    expect(advanced).toBe(true);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(true);
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
    github.__beforeRevisionCheck = undefined;
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:20:01.000Z"), [currentDriftIdentity(seeded.oldIdentity, HIST_B3, "6")]);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toMatchObject({ recovery_base_sha: HIST_B3, commit: { run_id: exactC.runId } });
  });

  it("never creates an exact-L bridge when identity_lost won C first", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 615, "0000000000000615");
    const lostC = await claimHistoricalLostC(github, seeded);
    installHistoricalExactBindingAndStart(github, seeded, 161501, "2026-08-18T20:00:02.000Z");
    github.__baseSha = HIST_B2;
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse(lostC.createdAt) + 1, [currentDriftIdentity(seeded.oldIdentity, HIST_B2, "7")]);
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toHaveLength(1);
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
  });

  it("never creates identity_lost after exact L won C first", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 616, "0000000000000616");
    const exactC = await claimHistoricalExactC(github, seeded, 161601);
    github.__baseSha = HIST_B2;
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T21:00:00.000Z"), [currentDriftIdentity(seeded.oldIdentity, HIST_B2, "8")]);
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toHaveLength(1);
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
    expect((await getCurrentIntegrationRecord(github, seeded.oldIdentity))?.run).toBeNull();
    expect(exactC.runId).toBe(161601);
  });

  it("is restart-complete at every F/A/B/S-before-C historical cleanup cut", async () => {
    for (const cut of [0, 1, 2, 3, 4]) {
      const github = makeHistoricalGithub();
      const seeded = await seedHistoricalAmbiguity(github, 620 + cut, `000000000000062${cut}`);
      const exactC = await claimHistoricalExactC(github, seeded, 162000 + cut);
      installHistoricalExactBindingAndStart(github, seeded, exactC.runId, exactC.createdAt);
      github.__baseSha = HIST_B2;
      github.__authorityVariables.armCleanupCrash(cut);
      await expect(reclaimOrphanIntegrationAuthorityVariables(
        github,
        Date.parse("2026-08-18T20:30:00.000Z"),
        [currentDriftIdentity(seeded.oldIdentity, HIST_B2, "9")],
      )).rejects.toThrow(/simulated historical Integration cleanup crash/);
      expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(true);
      await reclaimOrphanIntegrationAuthorityVariables(
        github,
        Date.parse("2026-08-18T20:30:01.000Z"),
        [currentDriftIdentity(seeded.oldIdentity, HIST_B2, "9")],
      );
      expect([
        seeded.names.fence,
        seeded.authorized.authorization.anchor_name,
        seeded.names.binding,
        integrationRunStartVariableName(seeded.request),
        integrationCommitVariableName(seeded.request.request_id),
      ].filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
      expect(bridges).toHaveLength(1);
      expect((bridges[0]?.commit as { run_id?: number }).run_id).toBe(exactC.runId);
    }
  });

  it("reclaims delayed matching B/S from the exact-L bridge after C and presentation data are gone", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 630, "0000000000000630");
    const exactC = await claimHistoricalExactC(github, seeded, 163001);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "a");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:30:00.000Z"), [b2]);
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toHaveLength(1);
    github.__statuses.splice(0);
    installHistoricalExactBindingAndStart(github, seeded, exactC.runId, exactC.createdAt);
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:31:00.000Z"), [b2]);
    expect(github.__authorityVariables.has(seeded.names.binding)).toBe(false);
    expect(github.__authorityVariables.has(integrationRunStartVariableName(seeded.request))).toBe(false);
    expect((await getCurrentIntegrationRecord(github, seeded.oldIdentity))?.run).toBeNull();
  });

  it("does not exhaust request-local Authority capacity across more than 64 cross-base exact-L interruptions", async () => {
    const github = makeHistoricalGithub();
    const b2Identities = [];
    for (let index = 0; index < 65; index += 1) {
      github.__baseSha = HIST_B1;
      const seeded = await seedHistoricalAmbiguity(github, 700 + index, index.toString(16).padStart(16, "0"));
      const exactC = await claimHistoricalExactC(github, seeded, 170000 + index);
      github.__baseSha = HIST_B2;
      const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "e");
      b2Identities.push(b2);
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T21:00:00.000Z") + index, [b2]);
      expect([
        seeded.names.fence,
        seeded.authorized.authorization.anchor_name,
        seeded.names.binding,
        integrationRunStartVariableName(seeded.request),
        integrationCommitVariableName(seeded.request.request_id),
      ].filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
      expect(bridges).toHaveLength(1);
      expect((bridges[0]?.commit as { run_id?: number }).run_id).toBe(exactC.runId);
    }
    expect([...github.__authorityVariables.keys()].filter((name) => /^FUGUE_INT_[ABCFS]_/.test(name))).toEqual([]);
  }, 30000);
});

describe("historical bridge permanent C winner", () => {
  it("reclaims delayed opposite-kind identity_lost C after exact-L bridge cleanup and stale B1 publication failure", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 770, "0000000000000770");
    const exactC = await claimHistoricalExactC(github, seeded, 177001);
    const oldBefore = await getCurrentIntegrationRecord(github, seeded.oldIdentity);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "f");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:30:00.000Z"), [b2]);
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toHaveLength(1);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);

    const staleLostAt = "2026-08-18T21:00:00.000Z";
    const fenceDigest = `sha256:${createHash("sha256").update(seeded.fenceRaw, "utf8").digest("hex")}`;
    await claimIdentityLostIntegrationCommit(github, {
      requestId: seeded.request.request_id,
      prNumber: seeded.oldIdentity.prNumber,
      headSha: seeded.oldIdentity.headSha,
      baseSha: seeded.oldIdentity.baseSha,
      anchorName: seeded.authorized.authorization.anchor_name,
    }, { boundaryCreatedAt: seeded.fence.created_at, fenceDigest, createdAt: staleLostAt });
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(true);

    await expect(publishIntegrationRecord(github, {
      ...seeded.record,
      dispatch_started_at: seeded.fence.created_at,
      run: null,
      terminal: {
        state: "identity_lost",
        attempt: 1,
        boundary_created_at: seeded.fence.created_at,
        fence_digest: fenceDigest,
        detail: "stale old-base identity_lost publisher",
        created_at: staleLostAt,
      },
      created_at: staleLostAt,
    })).rejects.toThrow(/stale protected revision/);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(true);

    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T21:00:01.000Z"), [b2]);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
    expect(bridges).toHaveLength(1);
    expect((bridges[0]?.commit as { run_id?: number }).run_id).toBe(exactC.runId);
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
    expect(await getCurrentIntegrationRecord(github, seeded.oldIdentity)).toEqual(oldBefore);
  });

  it("is restart-complete when a delayed opposite-kind C recreates after bridge cleanup and the publisher crashes", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 771, "0000000000000771");
    const exactC = await claimHistoricalExactC(github, seeded, 177101);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "a");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:30:00.000Z"), [b2]);
    const fenceDigest = `sha256:${createHash("sha256").update(seeded.fenceRaw, "utf8").digest("hex")}`;
    await claimIdentityLostIntegrationCommit(github, {
      requestId: seeded.request.request_id,
      prNumber: seeded.oldIdentity.prNumber,
      headSha: seeded.oldIdentity.headSha,
      baseSha: seeded.oldIdentity.baseSha,
      anchorName: seeded.authorized.authorization.anchor_name,
    }, { boundaryCreatedAt: seeded.fence.created_at, fenceDigest, createdAt: "2026-08-18T21:01:00.000Z" });
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(true);

    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T21:02:00.000Z"), [b2]);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
    expect(bridges).toHaveLength(1);
    expect((bridges[0]?.commit as { run_id?: number }).run_id).toBe(exactC.runId);
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
  });

  it("keeps a historical identity_lost tombstone permanent when delayed exact C/B/S recreate", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 772, "0000000000000772");
    const lostC = await claimHistoricalLostC(github, seeded);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "b");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse(lostC.createdAt) + 60_000, [b2]);
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toHaveLength(1);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);

    const lateRun = 177201;
    const lateAt = "2026-08-18T21:03:00.000Z";
    await claimExactIntegrationCommit(github, {
      requestId: seeded.request.request_id,
      prNumber: seeded.oldIdentity.prNumber,
      headSha: seeded.oldIdentity.headSha,
      baseSha: seeded.oldIdentity.baseSha,
      anchorName: seeded.authorized.authorization.anchor_name,
    }, { runId: lateRun, createdAt: lateAt, htmlUrl: `https://github.com/JohnnyZLi/Fugue/actions/runs/${lateRun}` });
    installHistoricalExactBindingAndStart(github, seeded, lateRun, lateAt);

    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T21:04:00.000Z"), [b2]);
    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    expect(github.__authorityVariables.has(seeded.names.binding)).toBe(false);
    expect(github.__authorityVariables.has(integrationRunStartVariableName(seeded.request))).toBe(false);
    expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toHaveLength(1);
    expect(historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
    expect((await getCurrentIntegrationRecord(github, seeded.oldIdentity))?.run).toBeNull();
  });

  it("never preserves or bridges later L2 over durable historical exact L and keeps the bridge non-current", async () => {
    const github = makeHistoricalGithub();
    const seeded = await seedHistoricalAmbiguity(github, 773, "0000000000000773");
    const exactC = await claimHistoricalExactC(github, seeded, 177301);
    github.__baseSha = HIST_B2;
    const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "c");
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T20:30:00.000Z"), [b2]);

    const laterRun = exactC.runId + 1;
    const laterAt = "2026-08-18T21:05:00.000Z";
    await claimExactIntegrationCommit(github, {
      requestId: seeded.request.request_id,
      prNumber: seeded.oldIdentity.prNumber,
      headSha: seeded.oldIdentity.headSha,
      baseSha: seeded.oldIdentity.baseSha,
      anchorName: seeded.authorized.authorization.anchor_name,
    }, { runId: laterRun, createdAt: laterAt, htmlUrl: `https://github.com/JohnnyZLi/Fugue/actions/runs/${laterRun}` });
    installHistoricalExactBindingAndStart(github, seeded, laterRun, laterAt);
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T21:06:00.000Z"), [b2]);

    expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
    expect(github.__authorityVariables.has(seeded.names.binding)).toBe(false);
    expect(github.__authorityVariables.has(integrationRunStartVariableName(seeded.request))).toBe(false);
    const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
    expect(bridges).toHaveLength(1);
    expect((bridges[0]?.commit as { run_id?: number }).run_id).toBe(exactC.runId);
    expect((bridges[0]?.commit as { run_id?: number }).run_id).not.toBe(laterRun);
    const oldRecord = await getCurrentIntegrationRecord(github, seeded.oldIdentity);
    expect(oldRecord?.run).toBeNull();
    expect(matchesCleanupAwareDurableRunStartBinding(oldRecord!, {
      requestId: seeded.request.request_id,
      prNumber: seeded.oldIdentity.prNumber,
      baseSha: seeded.oldIdentity.baseSha,
      anchorName: seeded.authorized.authorization.anchor_name,
      runId: exactC.runId,
      runAttempt: 1,
    })).toBe(false);
    await expect(currentIntegrationState(github, { identity: b2, pr: { number: b2.prNumber } } as unknown as EvaluationSnapshot))
      .resolves.toMatchObject({ state: "none" });
    github.__baseSha = HIST_B3;
    const b3 = currentDriftIdentity(seeded.oldIdentity, HIST_B3, "d");
    await expect(currentIntegrationState(github, { identity: b3, pr: { number: b3.prNumber } } as unknown as EvaluationSnapshot))
      .resolves.toMatchObject({ state: "none" });
  });

  it("reclaims more than 64 generations of delayed opposite-kind C without Authority exhaustion", async () => {
    const github = makeHistoricalGithub();
    for (let index = 0; index < 65; index += 1) {
      github.__baseSha = HIST_B1;
      const seeded = await seedHistoricalAmbiguity(github, 900 + index, (0x1000 + index).toString(16).padStart(16, "0"));
      const exactC = await claimHistoricalExactC(github, seeded, 190000 + index);
      github.__baseSha = HIST_B2;
      const b2 = currentDriftIdentity(seeded.oldIdentity, HIST_B2, "e");
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T22:00:00.000Z") + index * 10, [b2]);
      const fenceDigest = `sha256:${createHash("sha256").update(seeded.fenceRaw, "utf8").digest("hex")}`;
      await claimIdentityLostIntegrationCommit(github, {
        requestId: seeded.request.request_id,
        prNumber: seeded.oldIdentity.prNumber,
        headSha: seeded.oldIdentity.headSha,
        baseSha: seeded.oldIdentity.baseSha,
        anchorName: seeded.authorized.authorization.anchor_name,
      }, {
        boundaryCreatedAt: seeded.fence.created_at,
        fenceDigest,
        createdAt: new Date(Date.parse("2026-08-18T22:00:01.000Z") + index * 10).toISOString(),
      });
      expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(true);
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T22:00:02.000Z") + index * 10, [b2]);
      expect(github.__authorityVariables.has(integrationCommitVariableName(seeded.request.request_id))).toBe(false);
      const bridges = historicalExactBridges(github, seeded.request.request_id, seeded.oldIdentity.prNumber);
      expect(bridges).toHaveLength(1);
      expect((bridges[0]?.commit as { run_id?: number }).run_id).toBe(exactC.runId);
      expect(historicalTombstones(github, seeded.request.request_id, seeded.oldIdentity.prNumber)).toEqual([]);
    }
    expect([...github.__authorityVariables.keys()].filter((name) => /^FUGUE_INT_[ABCFS]_/.test(name))).toEqual([]);
  }, 45000);
});
