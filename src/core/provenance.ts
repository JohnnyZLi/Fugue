export const FUGUE_PROTOCOL_ACTOR = "github-actions[bot]";

export interface GitHubActorLike {
  login?: string | null;
  type?: string | null;
}

export interface GitHubCommentLike {
  user?: GitHubActorLike | null;
}

export interface GitHubWorkflowRunLike {
  actor?: GitHubActorLike | null;
}

export interface GitHubCommitStatusLike {
  creator?: GitHubActorLike | null;
}

export function isTrustedProtocolActor(actor: GitHubActorLike | null | undefined): boolean {
  if (actor?.login !== FUGUE_PROTOCOL_ACTOR) return false;
  return actor.type == null || actor.type === "Bot";
}

export function isTrustedProtocolComment(comment: GitHubCommentLike): boolean {
  return isTrustedProtocolActor(comment.user);
}

export function isTrustedProtocolWorkflowRun(run: GitHubWorkflowRunLike): boolean {
  return isTrustedProtocolActor(run.actor);
}

export function isTrustedProtocolCommitStatus(status: GitHubCommitStatusLike): boolean {
  return isTrustedProtocolActor(status.creator);
}
