import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { globToRegExp, matchesAnyPath } from "../src/core/glob.js";
import { resolveQaRequirements } from "../src/core/qa.js";
import {
  parseAttestation,
  reviewStartSchema,
  serializeAttestation,
} from "../src/core/attestations.js";

const config = parseConfig(`
version: 1
protocol: { version: 1 }
repository: { default_branch: main, agents_file: AGENTS.md }
control_plane:
  paths: [AGENTS.md, .fugue/**, .github/workflows/**]
validation:
  install: [npm ci]
  checks: [npm test]
  required_ci: [test]
  control_paths: [package.json, scripts/**]
reviews:
  code: { required: always }
  security:
    required: conditional
    paths: [.github/workflows/**, src/api/**]
  visual:
    required: conditional
    paths: [src/**/*.tsx, src/ui/**]
branches: { worker_pattern: 'agent/{issue}-{slug}', require_up_to_date: true }
allocation:
  coordinator_only: true
  require_assignment: true
  require_worker_id: true
  one_active_pr_per_issue: true
dependencies: { require_satisfied_before_integration: true }
enforcement: { prefer_hard_merge_gate: true }
github: { source_of_truth: true }
`);

describe("path matching", () => {
  it("supports recursive glob paths", () => {
    expect(matchesAnyPath(".github/workflows/ci.yml", [".github/workflows/**"])).toBe(true);
    expect(matchesAnyPath("src/App.tsx", ["src/**/*.tsx"])).toBe(true);
    expect(matchesAnyPath("src/ui/panels/Timeline.tsx", ["src/ui/**"])).toBe(true);
    expect(matchesAnyPath("src/core/events.ts", ["src/**/*.tsx"])).toBe(false);
  });

  it("anchors globs to the full repository path", () => {
    expect(globToRegExp("AGENTS.md").test("docs/AGENTS.md")).toBe(false);
  });
});

describe("QA requirement resolution", () => {
  it("requires Code and Visual QA for UI changes", () => {
    const result = resolveQaRequirements(config, ["src/ui/Timeline.tsx"]);
    expect(result.required.map((entry) => entry.role)).toEqual(["code", "visual"]);
  });

  it("forces Code and Security QA for control-plane changes", () => {
    const result = resolveQaRequirements(config, [".fugue/config.yml"]);
    expect(result.controlPlaneChanged).toBe(true);
    expect(result.required.map((entry) => entry.role)).toEqual(["code", "security"]);
  });

  it("flags validation-control changes", () => {
    const result = resolveQaRequirements(config, ["package.json"]);
    expect(result.validationControlChanged).toBe(true);
    expect(result.required.map((entry) => entry.role)).toEqual(["code"]);
  });

  it("keeps explicit QA additive", () => {
    const result = resolveQaRequirements(config, ["src/core/events.ts"], ["visual"]);
    expect(result.required.map((entry) => entry.role)).toEqual(["code", "visual"]);
  });
});

describe("structured attestations", () => {
  it("round-trips a review-start record", () => {
    const value = reviewStartSchema.parse({
      version: 1,
      kind: "review_start",
      session_id: "rev-code-12345678",
      role: "code",
      identity: {
        prNumber: 9,
        headSha: "abcdef1234567890",
        baseBranch: "main",
        baseSha: "1234567890abcdef",
        policyDigest: "sha256:policy",
        protocolVersion: 1,
        issueNumber: 7,
        workId: "work-7",
        workSpecDigest: "sha256:work",
      },
      fugue_version: "0.1.0-alpha.0",
      created_at: "2026-08-15T00:00:00.000Z",
    });

    expect(parseAttestation(serializeAttestation(value))).toEqual(value);
  });
});
