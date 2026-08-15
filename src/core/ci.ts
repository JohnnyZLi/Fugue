import { IntegrationGateFailure } from "./gates.js";
import type { FugueGitHub } from "./github.js";

export interface CiVerification {
  passed: true;
  checks: string[];
}

export type RequiredCiState = "success" | "pending" | "failure" | "error" | "missing";

export async function currentRequiredCiState(
  github: FugueGitHub,
  headSha: string,
  requiredNames: readonly string[],
): Promise<RequiredCiState> {
  if (!requiredNames.length) return "success";

  const { owner, repo } = github.repository;
  const [checksResponse, statusResponse] = await Promise.all([
    github.octokit.rest.checks.listForRef({ owner, repo, ref: headSha, per_page: 100 }),
    github.octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: headSha, per_page: 100 }),
  ]);

  const states = requiredNames.map((name) => {
    const matchingChecks = checksResponse.data.check_runs
      .filter((check) => check.name === name)
      .sort((a, b) => b.id - a.id);
    const latestCheck = matchingChecks[0];
    const matchingStatuses = statusResponse.data.statuses
      .filter((status) => status.context === name)
      .sort((a, b) => b.id - a.id);
    const latestStatus = matchingStatuses[0];

    const checkPassed = latestCheck?.status === "completed" && latestCheck.conclusion === "success";
    const statusPassed = latestStatus?.state === "success";
    if (checkPassed || statusPassed) return "success" as const;

    if (!latestCheck && !latestStatus) return "missing" as const;
    if (latestStatus?.state === "error") return "error" as const;
    if (latestStatus?.state === "failure") return "failure" as const;
    if (latestStatus?.state === "pending") return "pending" as const;
    if (latestCheck && latestCheck.status !== "completed") return "pending" as const;
    if (latestCheck?.status === "completed" && latestCheck.conclusion !== "success") return "failure" as const;
    return "missing" as const;
  });

  if (states.includes("error")) return "error";
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  if (states.includes("missing")) return "missing";
  return "success";
}

export async function verifyRequiredCi(
  github: FugueGitHub,
  headSha: string,
  requiredNames: readonly string[],
): Promise<CiVerification> {
  if (!requiredNames.length) return { passed: true, checks: [] };

  const { owner, repo } = github.repository;
  const [checksResponse, statusResponse] = await Promise.all([
    github.octokit.rest.checks.listForRef({ owner, repo, ref: headSha, per_page: 100 }),
    github.octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: headSha, per_page: 100 }),
  ]);

  for (const name of requiredNames) {
    const matchingChecks = checksResponse.data.check_runs
      .filter((check) => check.name === name)
      .sort((a, b) => b.id - a.id);
    const latestCheck = matchingChecks[0];
    const matchingStatuses = statusResponse.data.statuses
      .filter((status) => status.context === name)
      .sort((a, b) => b.id - a.id);
    const latestStatus = matchingStatuses[0];

    const checkPassed = latestCheck?.status === "completed" && latestCheck.conclusion === "success";
    const statusPassed = latestStatus?.state === "success";

    if (!checkPassed && !statusPassed) {
      const detail = latestCheck
        ? `check=${latestCheck.status}/${latestCheck.conclusion ?? "none"}`
        : latestStatus
          ? `status=${latestStatus.state}`
          : "not found";
      throw new IntegrationGateFailure(
        "ci",
        `Required CI '${name}' has not passed on ${headSha.slice(0, 8)} (${detail}).`,
      );
    }
  }

  return { passed: true, checks: [...requiredNames] };
}
