import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertValidationMatchesPlan,
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

    const tampered = { ...valid, commands: ["npm ci", "npm test -- --skip-critical"] };
    expect(() => assertValidationMatchesPlan(value, tampered)).toThrow(/protected-base command plan/);
  });

  it("keeps candidate validation credential-separated from trusted publication steps", async () => {
    const workflow = await readFile(".github/workflows/fugue-integration.yml", "utf8");
    expect(workflow).toContain("permissions:\n      contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('GITHUB_TOKEN: ""');
    expect(workflow).toContain('GH_TOKEN: ""');
    expect(workflow).toContain('--runtime-sha "${{ github.sha }}"');
  });

  it("uses base-trusted PR reconciliation instead of candidate workflow execution", async () => {
    const workflow = await readFile(".github/workflows/fugue-control-plane.yml", "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toContain("pull_request:\n");
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
  });
});
