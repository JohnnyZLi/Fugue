import { parseAttestation, type IntegrationAttestation } from "./attestations.js";
import { sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import type { FugueGitHub } from "./github.js";
import {
  integrationRunTitle,
  parseIntegrationRequest,
  type IntegrationRequest,
} from "./integration-plan.js";
import { isTrustedProtocolComment, isTrustedProtocolWorkflowRun, type GitHubCommentLike } from "./provenance.js";

export type IntegrationState = "none" | "pending" | "success" | "failure" | "error" | "stale";

export interface CurrentIntegrationState {
  state: IntegrationState;
  targetUrl?: string;
  attestation?: IntegrationAttestation;
  request?: IntegrationRequest;
}

export interface IntegrationWorkflowRun {
  status: string | null;
  conclusion: string | null;
  htmlUrl: string;
}

interface IntegrationComment extends GitHubCommentLike {
  body?: string | null;
}

export const INTEGRATION_REQUEST_RECOVERY_GRACE_MS = 10 * 60 * 1000;

export async function currentIntegrationState(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  now = Date.now(),
): Promise<CurrentIntegrationState> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });

  const trustedComments: IntegrationComment[] = [];
  for (const comment of comments) {
    if (await isTrustedProtocolComment(github, comment)) trustedComments.push(comment);
  }

  const requests = integrationRequests(trustedComments);
  const request = latestCurrentRequest(requests, snapshot);
  if (!request) return { state: "none" };

  const workflowRun = await findIntegrationWorkflowRun(github, request);
  if (workflowRun) {
    if (workflowRun.status !== "completed") {
      return { state: "pending", request, targetUrl: workflowRun.htmlUrl };
    }
    if (workflowRun.conclusion !== "success") {
      return {
        state: workflowRun.conclusion === "failure" ? "failure" : "error",
        request,
        targetUrl: workflowRun.htmlUrl,
      };
    }

    let current: IntegrationAttestation | undefined;
    for (const comment of trustedComments) {
      try {
        const value = parseAttestation(comment.body ?? "");
        if (value?.kind !== "integration") continue;
        if (!sameEvaluationIdentity(value.identity, snapshot.identity)) continue;
        current = value;
      } catch {
        // Invalid historical evidence cannot make an Integration result current.
      }
    }

    if (!current) {
      return { state: "stale", request, targetUrl: workflowRun.htmlUrl };
    }

    return {
      state: "success",
      attestation: current,
      request,
      targetUrl: workflowRun.htmlUrl,
    };
  }

  const created = Date.parse(request.created_at);
  if (!Number.isFinite(created)) return { state: "error", request };
  if (now - created < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
    return { state: "pending", request };
  }

  return { state: "none", request };
}

export async function findCurrentIntegrationRequest(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<IntegrationRequest | undefined> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });
  const trusted: IntegrationComment[] = [];
  for (const comment of comments) {
    if (await isTrustedProtocolComment(github, comment)) trusted.push(comment);
  }
  return latestCurrentRequest(integrationRequests(trusted), snapshot);
}

/**
 * Discover the latest causally valid Integration run. Completed runs whose conclusion represents
 * cancellation/abortion rather than a protected Integration decision are ignored so shared
 * Actions authority cannot strand the durable request. A prior success/failure remains visible;
 * if cancellation was the only run, recovery proceeds after the request grace period.
 */
export async function findIntegrationWorkflowRun(
  github: FugueGitHub,
  request: IntegrationRequest,
): Promise<IntegrationWorkflowRun | undefined> {
  const { owner, repo } = github.repository;
  const requestCreated = Date.parse(request.created_at);
  if (!Number.isFinite(requestCreated)) return undefined;
  const runs = await github.octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: "fugue-integration.yml",
    event: "workflow_dispatch",
    head_sha: request.identity.baseSha,
    per_page: 100,
  });
  const matches = runs.data.workflow_runs
    .filter((run) => {
      const runCreated = Date.parse(run.created_at ?? "");
      return isTrustedProtocolWorkflowRun(run) &&
        normalizedRunAttempt(run.run_attempt) === 1 &&
        run.event === "workflow_dispatch" &&
        run.head_sha === request.identity.baseSha &&
        run.display_title === integrationRunTitle(request.request_id, request.identity.prNumber) &&
        Number.isFinite(runCreated) &&
        runCreated >= requestCreated &&
        !isRecoverableAbortedRun(run.status, run.conclusion);
    })
    .sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""));
  const match = matches[0];
  if (!match) return undefined;
  return {
    status: match.status,
    conclusion: match.conclusion,
    htmlUrl: match.html_url,
  };
}

function isRecoverableAbortedRun(status: string | null, conclusion: string | null): boolean {
  return status === "completed" && conclusion !== null && conclusion !== "success" && conclusion !== "failure";
}

function normalizedRunAttempt(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function integrationRequests(comments: IntegrationComment[]): IntegrationRequest[] {
  const requests: IntegrationRequest[] = [];
  for (const comment of comments) {
    try {
      const request = parseIntegrationRequest(comment.body ?? "");
      if (request) requests.push(request);
    } catch {
      // Malformed historical requests are inert protocol evidence.
    }
  }
  return requests;
}

function latestCurrentRequest(
  requests: IntegrationRequest[],
  snapshot: EvaluationSnapshot,
): IntegrationRequest | undefined {
  return requests
    .filter((request) => sameEvaluationIdentity(request.identity, snapshot.identity))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .at(-1);
}
