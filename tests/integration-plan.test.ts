import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { resolveQaRequirements } from "../src/core/qa.js";
import {
  assertValidationMatchesPlan,
  createIntegrationRequest,
  integrationPlanSchema,
  integrationValidationSchema,
} from "../src/core/integration-plan.js";

const identity = {
  prNumber: 21,
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  baseBranch: "main",
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  policyDigest: "sha256:policy",
  protocolVersion: 1 as const,
  issueNumber: 18,
  workId: "work-18",
  workSpecDigest: "sha256:spec",
};

function plan() {
  return integrationPlanSchema.parse({
    version: 1,
    identity,
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
  it("binds validation commands to an exact prepared evaluation identity", () => {
    const value = plan();
    expect(value.identity.headSha).toBe(identity.headSha);
    expect(value.validation.checks).toEqual(["npm test"]);
  });

  it("uses an unpredictable request nonce so a future exact request cannot be preplayed", () => {
    const first = createIntegrationRequest(identity, "2026-08-16T20:00:00.500Z", "0123456789abcdef");
    const second = createIntegrationRequest(identity, "2026-08-16T20:00:00.500Z", "fedcba9876543210");
    expect(first.request_id).not.toBe(second.request_id);
    expect(first.request_id).toMatch(/^int-[0-9a-f]{16}-0123456789abcdef$/);
    expect(first.created_at).toBe("2026-08-16T20:00:00.000Z");
  });

  it("rejects validation evidence for a different identity shape", () => {
    expect(() => integrationValidationSchema.parse({
      version: 1,
      identity: { ...identity, protocolVersion: 2 },
      passed: true,
      commands: ["npm ci", "npm test"],
      created_at: new Date().toISOString(),
    })).toThrow();
  });

  it("rejects validation evidence that changes the protected-base command plan", () => {
    const value = plan();
    const valid = integrationValidationSchema.parse({
      version: 1,
      identity,
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
    expect(workflow).toContain('--runtime-sha "$FUGUE_RUNTIME_SHA"');
    expect(workflow).not.toContain('integration-runtime prepare "${{ inputs.pr }}"');
  });

  it("pins protected reconciliation to immutable workflow_sha while event contents come from GITHUB_EVENT_PATH", async () => {
    const workflow = await readFile(".github/workflows/fugue-control-plane.yml", "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toContain("pull_request:\n");
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).toContain("FUGUE_WORKFLOW_SHA: ${{ github.workflow_sha }}");
    expect(workflow).not.toContain("ref: ${{ github.event.repository.default_branch }}");
  });

  it("covers every direct security trust primitive, including repository discovery", async () => {
    const config = await readFile(".fugue/config.yml", "utf8");
    for (const path of [
      "src/core/qa.ts",
      "src/core/metadata.ts",
      "src/core/pr-metadata.ts",
      "src/core/hash.ts",
      "src/core/glob.ts",
      "src/core/worker.ts",
      "src/core/dependencies.ts",
      "src/core/git.ts",
      "src/core/state.ts",
      "src/core/evaluation.ts",
      "src/core/review-activity.ts",
      "src/core/gates.ts",
      "src/core/workflow.ts",
      "src/core/provenance.ts",
      "src/core/ci.ts",
    ]) expect(config).toContain(`- "${path}"`);
  });

  it("treats source-level trust-runtime changes as Human control-plane acknowledgement changes", async () => {
    const raw = await readFile(".fugue/config.yml", "utf8");
    const config = parseConfig(raw);
    for (const path of [
      "src/core/reconcile.ts",
      "src/core/state.ts",
      "src/core/provenance.ts",
      "src/core/submissions.ts",
      "src/core/gates.ts",
      "src/core/integration.ts",
      "src/core/integration-status.ts",
      "src/core/git.ts",
      "src/commands/integration-runtime.ts",
    ]) {
      const resolution = resolveQaRequirements(config, [path]);
      expect(resolution.controlPlaneChanged, path).toBe(true);
      expect(resolution.required.some((item) => item.role === "security"), path).toBe(true);
    }
  });
});
