import { parseAttestation, type IntegrationAttestation } from "./attestations.js";
import { sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import type { FugueGitHub } from "./github.js";
import {
  integrationRunTitle,
  parseIntegrationRequest,
  type IntegrationRequest,
} from "./integration-plan.js";
import {
  isTrustedProtocolComment,
  isTrustedProtocolCommitStatus,
  isTrustedProtocolWorkflowRun,
  type GitHubCommentLike,
} from "./provenance.js";

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
  const [statuses, comments] = await Promise.all([
    github.octokit.rest.repos.listCommitStatusesForRef({
      owner,
      repo,
      ref: snapshot.identity.headSha,
      per_page: 100,
    }),
    github.octokit.paginate(github.octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: snapshot.pr.number,
      per_page: 100,
    }),
  ]);

  const trustedComments = comments.filter(isTrustedProtocolComment);
  const requests = integrationRequests(trustedComments);
  const request = latestCurrentRequest(requests, snapshot);
  const latest = statuses.data.find((status) =>
    status.context === "fugue/integration" && isTrustedProtocolCommitStatus(status),
  );

  if (latest) {
    if (requests.length > 0 && !request) {
      return {
        state: "stale",
        ...(latest.target_url ? { targetUrl: latest.target_url } : {}),
      };
    }

    if (latest.state !== "success") {
      const state = integrationFailureState(latest.state);
      return {
        state,
        ...(request ? { request } : {}),
        ...(latest.target_url ? { targetUrl: latest.target_url } : {}),
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
      return {
        state: "stale",
        ...(request ? { request } : {}),
        ...(latest.target_url ? { targetUrl: latest.target_url } : {}),
      };
    }

    return {
      state: "success",
      attestation: current,
      ...(request ? { request } : {}),
      ...(latest.target_url ? { targetUrl: latest.target_url } : {}),
    };
  }

  if (!request) return { state: "none" };

  const workflowRun = await findIntegrationWorkflowRun(github, request.request_id);
  if (workflowRun) {
    if (workflowRun.status !== "completed") {
      return { state: "pending", request, targetUrl: workflowRun.htmlUrl };
    }
    return {
      state: "error",
      request,
      targetUrl: workflowRun.htmlUrl,
    };
  }

  const created = Date.parse(request.created_at);
  if (!Number.isFinite(created)) return { state: "error", request };
  if (now - created < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
    return { state: "pending", request };
  }

  // A durable trusted request with no matching trusted Actions run after the recovery grace
  // period is eligible for redispatch. Returning none lets the deterministic planner retry it.
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
  return latestCurrentRequest(
    integrationRequests(comments.filter(isTrustedProtocolComment)),
    snapshot,
  );
}

export async function findIntegrationWorkflowRun(
  github: FugueGitHub,
  requestId: string,
): Promise<IntegrationWorkflowRun | undefined> {
  const { owner, repo } = github.repository;
  const runs = await github.octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: "fugue-integration.yml",
    event: "workflow_dispatch",
    per_page: 100,
  });
  const match = runs.data.workflow_runs.find((run) =>
    isTrustedProtocolWorkflowRun(run) && run.display_title === integrationRunTitle(requestId),
  );
  if (!match) return undefined;
  return {
    status: match.status,
    conclusion: match.conclusion,
    htmlUrl: match.html_url,
  };
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

function integrationFailureState(value: string): "pending" | "failure" | "error" {
  if (value === "pending" || value === "failure" || value === "error") return value;
  return "error";
}
