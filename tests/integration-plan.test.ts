import { describe, expect, it } from "vitest";
import {
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

describe("GitHub-hosted Integration plan", () => {
  it("binds validation commands to an exact prepared evaluation identity", () => {
    const plan = integrationPlanSchema.parse({
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
    expect(plan.identity.headSha).toBe(identity.headSha);
    expect(plan.validation.checks).toEqual(["npm test"]);
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
});
