import { readFile } from "node:fs/promises";
import { reviewStartSchema } from "../src/core/attestations.js";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { canonicalWorkSpecIdentity, workMetadataSchema, workSpecDigestFromRequirements } from "../src/core/metadata.js";
import { resolveQaRequirements } from "../src/core/qa.js";
import {
  assertValidationMatchesPlan,
  createIntegrationRequest,
  integrationPlanSchema,
  integrationValidationSchema,
} from "../src/core/integration-plan.js";
import { protectedIntegrationRecoveryDecision } from "../src/core/reconcile.js";

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
    // Adversarial history is intentionally not an input to the authoritative transition. A million
    // later records can be inserted/deleted/reordered without changing the request-local decision.
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
    // F was committed before POST. GitHub then created L, but the response/process was lost and an
    // actions:write adversary prevented requested/completed witness consumers and deleted L. Neither
    // L nor A is trusted input now; attacker-writable Deployment/Status/history cannot fill that gap.
    // The revised exact-identity exception therefore terminalizes the request as identity_lost.
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
