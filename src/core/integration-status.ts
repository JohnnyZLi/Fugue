import { parseAttestation, type IntegrationAttestation } from "./attestations.js";
import { sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import type { FugueGitHub } from "./github.js";

export type IntegrationState = "none" | "pending" | "success" | "failure" | "error" | "stale";

export interface CurrentIntegrationState {
  state: IntegrationState;
  targetUrl?: string;
  attestation?: IntegrationAttestation;
}

export async function currentIntegrationState(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<CurrentIntegrationState> {
  const { owner, repo } = github.repository;
  const statuses = await github.octokit.rest.repos.listCommitStatusesForRef({
    owner,
    repo,
    ref: snapshot.identity.headSha,
    per_page: 100,
  });
  const latest = statuses.data.find((status) => status.context === "fugue/integration");
  if (!latest) return { state: "none" };

  if (latest.state !== "success") {
    return {
      state: latest.state,
      ...(latest.target_url ? { targetUrl: latest.target_url } : {}),
    };
  }

  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });

  let current: IntegrationAttestation | undefined;
  for (const comment of comments) {
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
      ...(latest.target_url ? { targetUrl: latest.target_url } : {}),
    };
  }

  return {
    state: "success",
    attestation: current,
    ...(latest.target_url ? { targetUrl: latest.target_url } : {}),
  };
}
