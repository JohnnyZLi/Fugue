import { describe, expect, it } from "vitest";
import { formatDoctorReport } from "../src/commands/doctor.js";
import { parseConfig } from "../src/core/config.js";
import {
  diagnoseRepository,
  doctorFailed,
  parseDoctorExecutor,
  type DoctorProbes,
  type DoctorReport,
} from "../src/core/doctor.js";
import type { FugueGitHub } from "../src/core/github.js";
import type { ActivePolicy } from "../src/core/policy.js";
import { FUGUE_PROTOCOL_LABELS } from "../src/core/repository-init.js";

const github = {
  repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
  octokit: {},
} as FugueGitHub;

describe("Fugue repository doctor", () => {
  it("reports a healthy governed repository", async () => {
    const report = await diagnoseRepository(github, {
      probes: probes(),
    });

    expect(doctorFailed(report)).toBe(false);
    expect(report.diagnostics.map(({ check, status }) => [check, status])).toEqual([
      ["Policy", "PASS"],
      ["Protection", "PASS"],
      ["Checks", "PASS"],
      ["Labels", "PASS"],
      ["Git", "PASS"],
      ["GitHub auth", "PASS"],
      ["Codex", "PASS"],
    ]);
    expect(formatDoctorReport(report)).toContain("RESULT PASS — repository is ready for Fugue workflows");
  });

  it("warns when optional Codex and soft status enforcement are unavailable", async () => {
    const report = await diagnoseRepository(github, {
      probes: probes({
        resolvePolicy: async () => activePolicy(false),
        branchProtection: async () => ({ requiredStatusChecks: ["test"] }),
        commandVersion: async (command) => command === "git" ? "git version 2.50.1" : null,
      }),
    });

    expect(doctorFailed(report)).toBe(false);
    expect(diagnostic(report, "Checks")).toMatchObject({ status: "WARN" });
    expect(diagnostic(report, "Codex")).toMatchObject({ status: "WARN" });
    expect(formatDoctorReport(report)).toContain("RESULT PASS — 2 warning(s)");
  });

  it("fails when protected-base policy cannot be resolved", async () => {
    const report = await diagnoseRepository(github, {
      probes: probes({
        resolvePolicy: async () => {
          throw new Error("Invalid Fugue version: bootstrap");
        },
      }),
    });

    expect(diagnostic(report, "Policy")).toEqual({
      status: "FAIL",
      check: "Policy",
      message: expect.stringContaining("Invalid Fugue version: bootstrap"),
    });
    expect(report.diagnostics.some((item) => item.check === "Protection")).toBe(false);
    expect(doctorFailed(report)).toBe(true);
  });

  it("fails an unprotected default branch when hard enforcement is preferred", async () => {
    const report = await diagnoseRepository(github, {
      probes: probes({ branchProtection: async () => null }),
    });

    expect(diagnostic(report, "Protection")).toMatchObject({
      status: "FAIL",
      message: expect.stringContaining("main is not protected"),
    });
    expect(doctorFailed(report)).toBe(true);
  });

  it("fails when hard branch protection omits a required status context", async () => {
    const report = await diagnoseRepository(github, {
      probes: probes({
        branchProtection: async () => ({ requiredStatusChecks: ["test"] }),
      }),
    });

    expect(diagnostic(report, "Checks")).toMatchObject({
      status: "FAIL",
      message: expect.stringContaining("fugue/integration"),
    });
    expect(doctorFailed(report)).toBe(true);
  });

  it("reports missing protocol labels and local write prerequisites clearly", async () => {
    const report = await diagnoseRepository(github, {
      probes: probes({
        protocolLabelNames: async () => FUGUE_PROTOCOL_LABELS
          .map((label) => label.name)
          .filter((name) => name !== "state:ready"),
        authenticatedLogin: async () => {
          throw new Error("Bad credentials");
        },
        commandVersion: async () => null,
      }),
    });

    expect(diagnostic(report, "Labels")).toMatchObject({
      status: "FAIL",
      message: expect.stringContaining("state:ready"),
    });
    expect(diagnostic(report, "Git")).toMatchObject({ status: "FAIL" });
    expect(diagnostic(report, "GitHub auth")).toMatchObject({ status: "FAIL" });
    expect(diagnostic(report, "Codex")).toMatchObject({ status: "WARN" });
  });

  it("requires Codex only when that executor is selected", async () => {
    const report = await diagnoseRepository(github, {
      executor: "codex",
      probes: probes({
        commandVersion: async (command) => command === "git" ? "git version 2.50.1" : null,
      }),
    });

    expect(diagnostic(report, "Codex")).toMatchObject({ status: "FAIL" });
    expect(parseDoctorExecutor("manual-chat")).toBe("manual-chat");
    expect(parseDoctorExecutor("codex")).toBe("codex");
    expect(() => parseDoctorExecutor("other")).toThrow(/manual-chat or codex/);
  });
});

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    resolvePolicy: async () => activePolicy(true),
    branchProtection: async () => ({ requiredStatusChecks: ["test", "fugue/integration"] }),
    protocolLabelNames: async () => FUGUE_PROTOCOL_LABELS.map((label) => label.name),
    authenticatedLogin: async () => "JohnnyZLi",
    commandVersion: async (command) => command === "git"
      ? "git version 2.50.1"
      : "codex-cli 0.42.0",
    ...overrides,
  };
}

function activePolicy(preferHardMergeGate: boolean): ActivePolicy {
  return {
    identity: {
      baseBranch: "main",
      baseSha: "abcdef1234567890",
      policyDigest: "sha256:policy",
      protocolVersion: 1,
    },
    config: parseConfig(`
version: 1
protocol: { version: 1 }
repository: { default_branch: main, agents_file: AGENTS.md }
control_plane: { paths: [] }
validation:
  install: []
  checks: []
  required_ci: [test]
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
enforcement: { prefer_hard_merge_gate: ${preferHardMergeGate} }
github: { source_of_truth: true }
`),
    configRaw: "config",
    agentsRaw: "agents",
    versionRaw: "version",
  };
}

function diagnostic(report: DoctorReport, check: string) {
  const result = report.diagnostics.find((item) => item.check === check);
  if (!result) throw new Error(`Missing ${check} diagnostic.`);
  return result;
}
