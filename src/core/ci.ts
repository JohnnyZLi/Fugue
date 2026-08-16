import { IntegrationGateFailure } from "./gates.js";
import type { FugueGitHub } from "./github.js";

export interface CiVerification {
  passed: true;
  checks: string[];
}

export type RequiredCiState = "success" | "pending" | "failure" | "error" | "missing";

export const DEFAULT_REQUIRED_CI_WORKFLOW = ".github/workflows/ci.yml";

interface RequiredCiObservation {
  state: RequiredCiState;
  detail: string;
}

export async function currentRequiredCiState(
  github: FugueGitHub,
  headSha: string,
  requiredNames: readonly string[],
  workflowId = DEFAULT_REQUIRED_CI_WORKFLOW,
): Promise<RequiredCiState> {
  if (!requiredNames.length) return "success";
  const observations = await observeTrustedRequiredCi(github, headSha, requiredNames, workflowId);
  const states = [...observations.values()].map((item) => item.state);
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
  workflowId = DEFAULT_REQUIRED_CI_WORKFLOW,
): Promise<CiVerification> {
  if (!requiredNames.length) return { passed: true, checks: [] };
  const observations = await observeTrustedRequiredCi(github, headSha, requiredNames, workflowId);

  for (const name of requiredNames) {
    const observed = observations.get(name);
    if (observed?.state === "success") continue;
    throw new IntegrationGateFailure(
      "ci",
      `Required CI '${name}' has not passed on ${headSha.slice(0, 8)} from protected workflow ${workflowId} (${observed?.detail ?? "not found"}).`,
    );
  }

  return { passed: true, checks: [...requiredNames] };
}

async function observeTrustedRequiredCi(
  github: FugueGitHub,
  headSha: string,
  requiredNames: readonly string[],
  workflowId: string,
): Promise<Map<string, RequiredCiObservation>> {
  const { owner, repo } = github.repository;
  const [runs, associatedPulls] = await Promise.all([
    github.octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowId,
      event: "pull_request",
      head_sha: headSha,
      per_page: 100,
    }),
    github.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: headSha,
      per_page: 100,
    }),
  ]);

  const pulls = associatedPulls.data.filter((pull) => pull.head.sha === headSha && pull.state === "open");
  if (pulls.length !== 1) {
    return observationsFor(
      requiredNames,
      "error",
      `expected one open PR for exact head, found ${pulls.length}`,
    );
  }
  const baseSha = pulls[0]!.base.sha;
  if (!(await sameRepositoryFileBlob(github, workflowId, headSha, baseSha))) {
    return observationsFor(
      requiredNames,
      "error",
      `candidate ${workflowId} differs from protected base ${baseSha.slice(0, 8)}`,
    );
  }

  const run = runs.data.workflow_runs
    .filter((candidate) => candidate.event === "pull_request" && candidate.head_sha === headSha)
    .sort((a, b) => b.id - a.id)[0];

  if (!run) {
    return observationsFor(requiredNames, "missing", "trusted workflow run not found");
  }
  if (run.status !== "completed") {
    return observationsFor(requiredNames, "pending", `workflow=${run.status}`);
  }

  const jobs = await github.octokit.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  const result = new Map<string, RequiredCiObservation>();

  for (const name of requiredNames) {
    const job = jobs.data.jobs
      .filter((candidate) => candidate.name === name)
      .sort((a, b) => b.id - a.id)[0];
    if (!job) {
      result.set(name, {
        state: run.conclusion === "success" ? "missing" : workflowFailureState(run.conclusion),
        detail: `workflow=completed/${run.conclusion ?? "none"}, job=missing`,
      });
      continue;
    }
    if (job.status !== "completed") {
      result.set(name, { state: "pending", detail: `job=${job.status}/${job.conclusion ?? "none"}` });
      continue;
    }
    if (job.conclusion === "success") {
      result.set(name, { state: "success", detail: "job=completed/success" });
      continue;
    }
    result.set(name, {
      state: workflowFailureState(job.conclusion),
      detail: `job=completed/${job.conclusion ?? "none"}`,
    });
  }
  return result;
}

async function sameRepositoryFileBlob(
  github: FugueGitHub,
  path: string,
  headSha: string,
  baseSha: string,
): Promise<boolean> {
  const { owner, repo } = github.repository;
  try {
    const [head, base] = await Promise.all([
      github.octokit.rest.repos.getContent({ owner, repo, path, ref: headSha }),
      github.octokit.rest.repos.getContent({ owner, repo, path, ref: baseSha }),
    ]);
    if (Array.isArray(head.data) || Array.isArray(base.data)) return false;
    if (head.data.type !== "file" || base.data.type !== "file") return false;
    return head.data.sha === base.data.sha;
  } catch {
    return false;
  }
}

function observationsFor(
  names: readonly string[],
  state: RequiredCiState,
  detail: string,
): Map<string, RequiredCiObservation> {
  return new Map(names.map((name) => [name, { state, detail }]));
}

function workflowFailureState(conclusion: string | null | undefined): "failure" | "error" {
  if (conclusion === "failure") return "failure";
  return "error";
}
