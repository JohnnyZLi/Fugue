import type { FugueConfig } from "./config.js";
import type { FugueGitHub } from "./github.js";

export interface ProtocolLabel {
  name: string;
  color: string;
  description: string;
}

export const FUGUE_PROTOCOL_LABELS: readonly ProtocolLabel[] = [
  { name: "state:ready", color: "1f883d", description: "Eligible for Fugue Worker allocation" },
  { name: "state:working", color: "0969da", description: "Claimed and active in the Fugue lifecycle" },
  { name: "state:blocked", color: "d73a4a", description: "Blocked by a durable dependency or condition" },
  { name: "type:feature", color: "a2eeef", description: "Feature work" },
  { name: "type:bug", color: "d73a4a", description: "Bug fix" },
  { name: "type:refactor", color: "c5def5", description: "Refactor without intended behavior change" },
  { name: "type:docs", color: "0075ca", description: "Documentation work" },
  { name: "type:infra", color: "5319e7", description: "Infrastructure or workflow work" },
  { name: "type:investigation", color: "d4c5f9", description: "Investigation or design work" },
  { name: "priority:p0", color: "b60205", description: "Critical priority" },
  { name: "priority:p1", color: "d93f0b", description: "High priority" },
  { name: "priority:p2", color: "fbca04", description: "Normal priority" },
  { name: "priority:p3", color: "c2e0c6", description: "Low priority" },
  { name: "qa:code", color: "0e8a16", description: "Explicit additive Code QA requirement" },
  { name: "qa:security", color: "b60205", description: "Explicit additive Security QA requirement" },
  { name: "qa:visual", color: "7057ff", description: "Explicit additive Visual / UX QA requirement" },
  { name: "agent:ready", color: "1d76db", description: "Eligible for an autonomous Fugue Worker" },
  { name: "agent:human-required", color: "e99695", description: "Requires Human execution or decision" },
];

export interface BranchProtectionPlan {
  branch: string;
  strict: boolean;
  requiredStatusChecks: string[];
  enforceAdmins: true;
  requiredLinearHistory: true;
  allowForcePushes: false;
  allowDeletions: false;
  requiredConversationResolution: true;
}

export interface LabelBootstrapResult {
  created: string[];
  existing: string[];
}

export function buildBranchProtectionPlan(config: FugueConfig): BranchProtectionPlan {
  return {
    branch: config.repository.default_branch,
    strict: config.branches.require_up_to_date,
    requiredStatusChecks: [...new Set([...config.validation.required_ci, "fugue/integration"])],
    enforceAdmins: true,
    requiredLinearHistory: true,
    allowForcePushes: false,
    allowDeletions: false,
    requiredConversationResolution: true,
  };
}

export async function ensureProtocolLabels(github: FugueGitHub): Promise<LabelBootstrapResult> {
  const { owner, repo } = github.repository;
  const labels = await github.octokit.paginate(github.octokit.rest.issues.listLabelsForRepo, {
    owner,
    repo,
    per_page: 100,
  });
  const existingNames = new Set(labels.map((label) => label.name));
  const created: string[] = [];
  const existing: string[] = [];

  for (const label of FUGUE_PROTOCOL_LABELS) {
    if (existingNames.has(label.name)) {
      existing.push(label.name);
      continue;
    }
    await github.octokit.rest.issues.createLabel({
      owner,
      repo,
      name: label.name,
      color: label.color,
      description: label.description,
    });
    created.push(label.name);
  }

  return { created, existing };
}

export async function applyBranchProtection(github: FugueGitHub, config: FugueConfig): Promise<BranchProtectionPlan> {
  const { owner, repo } = github.repository;
  const plan = buildBranchProtectionPlan(config);

  try {
    await github.octokit.rest.repos.updateBranchProtection({
      owner,
      repo,
      branch: plan.branch,
      required_status_checks: {
        strict: plan.strict,
        contexts: plan.requiredStatusChecks,
      },
      enforce_admins: plan.enforceAdmins,
      required_pull_request_reviews: null,
      restrictions: null,
      required_linear_history: plan.requiredLinearHistory,
      allow_force_pushes: plan.allowForcePushes,
      allow_deletions: plan.allowDeletions,
      required_conversation_resolution: plan.requiredConversationResolution,
    });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? String((error as { status?: unknown }).status ?? "unknown")
      : "unknown";
    throw new Error(
      `Unable to configure branch protection for ${owner}/${repo}:${plan.branch} (GitHub status ${status}). ` +
      "Use repository-owner/admin GitHub authentication with Administration write permission, then rerun fugue init.",
    );
  }

  return plan;
}
