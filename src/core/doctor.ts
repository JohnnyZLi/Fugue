import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActivePolicy } from "./policy.js";
import { resolveActivePolicy } from "./policy.js";
import type { FugueGitHub } from "./github.js";
import {
  FUGUE_PROTOCOL_LABELS,
  buildBranchProtectionPlan,
} from "./repository-init.js";

const execFileAsync = promisify(execFile);

export type DoctorStatus = "PASS" | "WARN" | "FAIL";
export type DoctorExecutor = "manual-chat" | "codex";

export interface DoctorDiagnostic {
  status: DoctorStatus;
  check: string;
  message: string;
}

export interface DoctorReport {
  repository: string;
  executor: DoctorExecutor;
  diagnostics: DoctorDiagnostic[];
}

export interface BranchProtectionSnapshot {
  requiredStatusChecks: string[];
}

export interface DoctorProbes {
  resolvePolicy(github: FugueGitHub): Promise<ActivePolicy>;
  branchProtection(github: FugueGitHub, branch: string): Promise<BranchProtectionSnapshot | null>;
  protocolLabelNames(github: FugueGitHub): Promise<string[]>;
  authenticatedLogin(github: FugueGitHub): Promise<string>;
  commandVersion(command: "git" | "codex"): Promise<string | null>;
}

export interface DoctorOptions {
  executor?: DoctorExecutor;
  probes?: DoctorProbes;
}

const defaultProbes: DoctorProbes = {
  resolvePolicy: resolveActivePolicy,
  branchProtection: readBranchProtection,
  protocolLabelNames: readProtocolLabelNames,
  authenticatedLogin: readAuthenticatedLogin,
  commandVersion: readCommandVersion,
};

export async function diagnoseRepository(
  github: FugueGitHub,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const executor = options.executor ?? "manual-chat";
  const probes = options.probes ?? defaultProbes;
  const [policyResult, labelsResult, authenticationResult, gitResult, codexResult] = await Promise.all([
    capture(() => probes.resolvePolicy(github)),
    capture(() => probes.protocolLabelNames(github)),
    capture(() => probes.authenticatedLogin(github)),
    capture(() => probes.commandVersion("git")),
    capture(() => probes.commandVersion("codex")),
  ]);
  const diagnostics: DoctorDiagnostic[] = [];

  if (policyResult.ok) {
    const policy = policyResult.value;
    diagnostics.push({
      status: "PASS",
      check: "Policy",
      message: `Protected-base policy resolved at ${policy.identity.baseBranch} @ ${short(policy.identity.baseSha)} (protocol ${policy.identity.protocolVersion}).`,
    });
    diagnostics.push(...await diagnoseProtection(github, policy, probes));
  } else {
    diagnostics.push({
      status: "FAIL",
      check: "Policy",
      message: `Protected-base Fugue policy could not be resolved: ${message(policyResult.error)} Restore compatible AGENTS.md and .fugue policy files on the default branch.`,
    });
  }

  if (labelsResult.ok) {
    const existing = new Set(labelsResult.value);
    const missing = FUGUE_PROTOCOL_LABELS
      .map((label) => label.name)
      .filter((name) => !existing.has(name));
    diagnostics.push(missing.length
      ? {
          status: "FAIL",
          check: "Labels",
          message: `Missing ${missing.length} required Fugue protocol label(s): ${missing.join(", ")}. Run fugue init after reviewing the changes it will make.`,
        }
      : {
          status: "PASS",
          check: "Labels",
          message: `All ${FUGUE_PROTOCOL_LABELS.length} required Fugue protocol labels are present.`,
        });
  } else {
    diagnostics.push({
      status: "FAIL",
      check: "Labels",
      message: `Unable to inspect required Fugue protocol labels: ${message(labelsResult.error)}`,
    });
  }

  if (gitResult.ok && gitResult.value) {
    diagnostics.push({ status: "PASS", check: "Git", message: gitResult.value });
  } else {
    diagnostics.push({
      status: "FAIL",
      check: "Git",
      message: "Git is unavailable. Install Git and ensure `git` is on PATH before running Fugue workflows.",
    });
  }

  if (authenticationResult.ok) {
    diagnostics.push({
      status: "PASS",
      check: "GitHub auth",
      message: `Authenticated as @${authenticationResult.value} for GitHub-backed workflows.`,
    });
  } else {
    diagnostics.push({
      status: "FAIL",
      check: "GitHub auth",
      message: "GitHub authentication is unavailable for write workflows. Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`.",
    });
  }

  if (codexResult.ok && codexResult.value) {
    diagnostics.push({ status: "PASS", check: "Codex", message: codexResult.value });
  } else if (executor === "codex") {
    diagnostics.push({
      status: "FAIL",
      check: "Codex",
      message: "Codex CLI is required for the selected executor. Install @openai/codex and run `codex --login`, or select manual-chat.",
    });
  } else {
    diagnostics.push({
      status: "WARN",
      check: "Codex",
      message: "Codex CLI is unavailable; manual-chat workflows remain usable. Install @openai/codex to use `fugue run --executor codex`.",
    });
  }

  return {
    repository: github.repository.fullName,
    executor,
    diagnostics,
  };
}

export function parseDoctorExecutor(value: string | undefined): DoctorExecutor {
  const executor = value ?? "manual-chat";
  if (executor !== "manual-chat" && executor !== "codex") {
    throw new Error(`Invalid doctor executor: ${executor}. Choose manual-chat or codex.`);
  }
  return executor;
}

export function doctorFailed(report: DoctorReport): boolean {
  return report.diagnostics.some((diagnostic) => diagnostic.status === "FAIL");
}

async function diagnoseProtection(
  github: FugueGitHub,
  policy: ActivePolicy,
  probes: DoctorProbes,
): Promise<DoctorDiagnostic[]> {
  const hardGate = policy.config.enforcement.prefer_hard_merge_gate;
  const result = await capture(() => probes.branchProtection(github, policy.identity.baseBranch));

  if (!result.ok) {
    return [{
      status: hardGate ? "FAIL" : "WARN",
      check: "Protection",
      message: `Unable to inspect protection for ${policy.identity.baseBranch}: ${message(result.error)}`,
    }];
  }

  if (!result.value) {
    return [{
      status: hardGate ? "FAIL" : "WARN",
      check: "Protection",
      message: `Default branch ${policy.identity.baseBranch} is not protected. Configure branch protection before governed work begins.`,
    }];
  }

  const diagnostics: DoctorDiagnostic[] = [{
    status: "PASS",
    check: "Protection",
    message: `Default branch ${policy.identity.baseBranch} is protected.`,
  }];
  const required = buildBranchProtectionPlan(policy.config).requiredStatusChecks;
  const existing = new Set(result.value.requiredStatusChecks);
  const missing = required.filter((context) => !existing.has(context));

  diagnostics.push(missing.length
    ? {
        status: hardGate ? "FAIL" : "WARN",
        check: "Checks",
        message: `Branch protection is missing required status context(s): ${missing.join(", ")}. Add them to ${policy.identity.baseBranch} protection.`,
      }
    : {
        status: "PASS",
        check: "Checks",
        message: `Branch protection requires ${required.join(", ")}.`,
      });

  return diagnostics;
}

async function readBranchProtection(
  github: FugueGitHub,
  branch: string,
): Promise<BranchProtectionSnapshot | null> {
  const { owner, repo } = github.repository;
  try {
    const response = await github.octokit.rest.repos.getBranchProtection({ owner, repo, branch });
    const statusChecks = response.data.required_status_checks as {
      contexts?: string[];
      checks?: Array<{ context: string }>;
    } | null | undefined;
    const contexts = statusChecks?.contexts ?? [];
    const checks = statusChecks?.checks?.map((check) => check.context) ?? [];
    return { requiredStatusChecks: [...new Set([...contexts, ...checks])] };
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    throw error;
  }
}

async function readProtocolLabelNames(github: FugueGitHub): Promise<string[]> {
  const { owner, repo } = github.repository;
  const labels = await github.octokit.paginate(github.octokit.rest.issues.listLabelsForRepo, {
    owner,
    repo,
    per_page: 100,
  });
  return labels.map((label) => label.name);
}

async function readAuthenticatedLogin(github: FugueGitHub): Promise<string> {
  const response = await github.octokit.rest.users.getAuthenticated();
  return response.data.login;
}

async function readCommandVersion(command: "git" | "codex"): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return firstLine(stdout) || firstLine(stderr) || `${command} is available`;
  } catch {
    return null;
  }
}

type Captured<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function capture<T>(operation: () => Promise<T>): Promise<Captured<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function short(value: string): string {
  return value.slice(0, 8);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
