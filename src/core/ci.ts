import { IntegrationGateFailure } from "./gates.js";
import type { FugueGitHub } from "./github.js";

export interface CiVerification {
  passed: true;
  checks: string[];
}

export type RequiredCiState = "success" | "pending" | "failure" | "error" | "missing";

export const DEFAULT_REQUIRED_CI_WORKFLOW = ".github/workflows/ci.yml";
export const REQUIRED_CI_RUN_PREFIX = "Fugue CI ";

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
  const runs = await github.octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: workflowId,
    event: "pull_request_target",
    per_page: 100,
  });
  const expectedTitle = `${REQUIRED_CI_RUN_PREFIX}${headSha}`;
  const run = runs.data.workflow_runs
    .filter((candidate) =>
      candidate.event === "pull_request_target" && candidate.display_title === expectedTitle,
    )
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
