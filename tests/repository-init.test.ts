import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import {
  FUGUE_PROTOCOL_LABELS,
  buildBranchProtectionPlan,
} from "../src/core/repository-init.js";

describe("Fugue repository bootstrap", () => {
  it("defines the protocol labels required by allocation and QA", () => {
    const names = new Set(FUGUE_PROTOCOL_LABELS.map((label) => label.name));

    expect(names).toEqual(new Set([
      "state:ready",
      "state:working",
      "state:blocked",
      "type:feature",
      "type:bug",
      "type:refactor",
      "type:docs",
      "type:infra",
      "type:investigation",
      "priority:p0",
      "priority:p1",
      "priority:p2",
      "priority:p3",
      "qa:code",
      "qa:security",
      "qa:visual",
      "agent:ready",
      "agent:human-required",
    ]));
  });

  it("turns protected-base policy into a strict hard merge gate", async () => {
    const raw = await readFile(".fugue/config.yml", "utf8");
    const config = parseConfig(raw);
    const plan = buildBranchProtectionPlan(config);

    expect(plan.branch).toBe("main");
    expect(plan.strict).toBe(true);
    expect(plan.requiredStatusChecks).toEqual(["test", "fugue/integration"]);
    expect(plan.enforceAdmins).toBe(true);
    expect(plan.requiredLinearHistory).toBe(true);
    expect(plan.allowForcePushes).toBe(false);
    expect(plan.allowDeletions).toBe(false);
    expect(plan.requiredConversationResolution).toBe(true);
  });

  it("deduplicates Integration if policy already lists it", () => {
    const config = parseConfig(`
version: 1
protocol: { version: 1 }
repository: { default_branch: main, agents_file: AGENTS.md }
control_plane: { paths: [] }
validation:
  install: []
  checks: []
  required_ci: [test, fugue/integration]
  control_paths: []
reviews:
  code: { required: always }
  security: { required: conditional, paths: [] }
  visual: { required: conditional, paths: [] }
branches: { worker_pattern: "agent/{issue}-{slug}", require_up_to_date: true }
allocation:
  coordinator_only: true
  require_assignment: true
  require_worker_id: true
  one_active_pr_per_issue: true
dependencies: { require_satisfied_before_integration: true }
enforcement: { prefer_hard_merge_gate: true }
github: { source_of_truth: true }
`);

    expect(buildBranchProtectionPlan(config).requiredStatusChecks).toEqual(["test", "fugue/integration"]);
  });
});
