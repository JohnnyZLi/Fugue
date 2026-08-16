import { parseAttestation, type QaRole } from "./attestations.js";
import { currentRequiredCiState, type RequiredCiState } from "./ci.js";
import { captureEvaluation, sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import { IntegrationGateFailure, verifyBaseCurrent } from "./gates.js";
import type { FugueGitHub } from "./github.js";
import { currentIntegrationState, type IntegrationState } from "./integration-status.js";
import { resolveOwnership } from "./ownership.js";
import { isTrustedProtocolComment } from "./provenance.js";
import { currentReviewActivities } from "./reviews.js";
import type { WorkState } from "./state.js";

export type QaWorkflowState = "none" | "pending" | "approved" | "changes_requested" | "error";
export type OwnershipWorkflowState = "not_applicable" | "passed" | "failed";

export interface QaWorkflowObservation {
  role: QaRole;
  state: QaWorkflowState;
  supersededSessions: number;
}

export interface WorkflowObservation {
  issueNumber: number;
  workId: string;
  stateLabel: WorkState["stateLabel"];
  workerClaimed: boolean;
  hasPr: boolean;
  prNumber?: number;
  prDraft: boolean;
  drift: string[];
  ownership: OwnershipWorkflowState;
  ownershipDetail?: string;
  ci: RequiredCiState | "not_applicable";
  baseCurrent: boolean;
  qa: QaWorkflowObservation[];
  controlPlaneChanged: boolean;
  humanControlPlaneAcknowledged: boolean;
  integration: IntegrationState;
}

export type WorkflowAction =
  | { kind: "allocate_worker" }
  | { kind: "wait_worker" }
  | { kind: "wait_ci"; state: RequiredCiState }
  | { kind: "update_base" }
  | { kind: "start_qa"; roles: QaRole[] }
  | { kind: "wait_qa"; roles: QaRole[] }
  | { kind: "resume_worker"; roles: QaRole[]; reason?: string }
  | { kind: "human_control_plane_ack" }
  | { kind: "mark_pr_ready" }
  | { kind: "integrate" }
  | { kind: "wait_integration" }
  | { kind: "ready_to_merge" }
  | { kind: "blocked"; reason: string };

export function planWork(observation: WorkflowObservation): WorkflowAction {
  if (observation.drift.length) {
    return { kind: "blocked", reason: `State drift: ${observation.drift.join("; ")}` };
  }
  if (observation.stateLabel === "state:blocked") {
    return { kind: "blocked", reason: "Work item is explicitly blocked." };
  }
  if (!observation.workerClaimed) {
    return observation.stateLabel === "state:ready"
      ? { kind: "allocate_worker" }
      : { kind: "blocked", reason: "Working item has no durable Worker claim." };
  }
  if (!observation.hasPr) return { kind: "wait_worker" };

  if (observation.ownership === "failed") {
    return { kind: "blocked", reason: `Ownership violation: ${observation.ownershipDetail ?? "changed files exceed assigned scope"}` };
  }

  if (!observation.baseCurrent) return { kind: "update_base" };

  if (observation.ci === "failure" || observation.ci === "error") {
    return { kind: "resume_worker", roles: [], reason: `Required CI is ${observation.ci}.` };
  }
  if (observation.ci === "pending" || observation.ci === "missing") {
    return { kind: "wait_ci", state: observation.ci };
  }

  const changesRequested = observation.qa
    .filter((item) => item.state === "changes_requested")
    .map((item) => item.role);
  if (changesRequested.length) return { kind: "resume_worker", roles: changesRequested };

  const qaErrors = observation.qa.filter((item) => item.state === "error").map((item) => item.role);
  if (qaErrors.length) {
    return { kind: "blocked", reason: `QA error requires intervention: ${qaErrors.join(", ")}` };
  }

  const code = observation.qa.find((item) => item.role === "code");
  if (code?.state === "none") return { kind: "start_qa", roles: ["code"] };
  if (code?.state === "pending") return { kind: "wait_qa", roles: ["code"] };

  const remaining = observation.qa.filter((item) => item.role !== "code");
  const notStarted = remaining.filter((item) => item.state === "none").map((item) => item.role);
  if (notStarted.length) return { kind: "start_qa", roles: notStarted };

  const pending = remaining.filter((item) => item.state === "pending").map((item) => item.role);
  if (pending.length) return { kind: "wait_qa", roles: pending };

  if (observation.controlPlaneChanged && !observation.humanControlPlaneAcknowledged) {
    return { kind: "human_control_plane_ack" };
  }

  if (observation.integration === "success") return { kind: "ready_to_merge" };
  if (observation.integration === "pending") return { kind: "wait_integration" };
  if (observation.integration === "failure" || observation.integration === "error") {
    return { kind: "blocked", reason: `Integration is ${observation.integration}; inspect durable evidence before retrying.` };
  }

  if (observation.prDraft) return { kind: "mark_pr_ready" };
  return { kind: "integrate" };
}

export async function observeWork(github: FugueGitHub, work: WorkState): Promise<WorkflowObservation> {
  const workerClaimed = Boolean(work.metadata.execution.worker_id && work.metadata.execution.branch);
  const base: WorkflowObservation = {
    issueNumber: work.issueNumber,
    workId: work.metadata.work_id,
    stateLabel: work.stateLabel,
    workerClaimed,
    hasPr: Boolean(work.pr),
    prDraft: work.pr?.draft ?? false,
    drift: [...work.drift],
    ownership: "not_applicable",
    ci: "not_applicable",
    baseCurrent: true,
    qa: [],
    controlPlaneChanged: false,
    humanControlPlaneAcknowledged: false,
    integration: "none",
  };

  if (!work.pr) return base;

  const snapshot = await captureEvaluation(github, work.pr.number);
  const activities = await currentReviewActivities(github, snapshot);
  const qa: QaWorkflowObservation[] = [];

  for (const requirement of snapshot.qa.required) {
    const activity = activities.get(requirement.role);
    const state: QaWorkflowState = activity?.active
      ? "pending"
      : activity?.completed
        ? activity.completed.verdict
        : "none";
    qa.push({
      role: requirement.role,
      state,
      supersededSessions: activity?.superseded.length ?? 0,
    });
  }

  const ownership = resolveOwnership(snapshot.changedFiles, snapshot.workMetadata.spec.ownership);
  let baseCurrent = true;
  if (snapshot.policy.config.branches.require_up_to_date) {
    try {
      await verifyBaseCurrent(github, snapshot.identity.baseSha, snapshot.identity.headSha);
    } catch (error) {
      if (error instanceof IntegrationGateFailure && error.gate === "base-current") baseCurrent = false;
      else throw error;
    }
  }

  return {
    ...base,
    prNumber: work.pr.number,
    ownership: ownership.passed ? "passed" : "failed",
    ...(ownership.passed
      ? {}
      : { ownershipDetail: ownership.violations.map((item) => `${item.path} (${item.kind})`).join(", ") }),
    ci: await currentRequiredCiState(
      github,
      snapshot.identity.headSha,
      snapshot.policy.config.validation.required_ci,
      snapshot.policy.config.validation.required_ci_workflow,
    ),
    baseCurrent,
    qa,
    controlPlaneChanged: snapshot.qa.controlPlaneChanged,
    humanControlPlaneAcknowledged: snapshot.qa.controlPlaneChanged
      ? await hasCurrentHumanControlPlaneAcknowledgement(github, snapshot)
      : false,
    integration: (await currentIntegrationState(github, snapshot)).state,
  };
}

export function actionLabel(action: WorkflowAction): string {
  switch (action.kind) {
    case "allocate_worker": return "allocate Worker";
    case "wait_worker": return "needs Worker chat";
    case "wait_ci": return `wait for required CI (${action.state})`;
    case "update_base": return "update Worker branch from current base";
    case "start_qa": return `start ${action.roles.map(roleLabel).join(" + ")}`;
    case "wait_qa": return `needs ${action.roles.map(roleLabel).join(" + ")} chat`;
    case "resume_worker": return action.reason
      ? `resume Worker — ${action.reason}`
      : `resume Worker after ${action.roles.map(roleLabel).join(" + ")} changes requested`;
    case "human_control_plane_ack": return "human control-plane acknowledgement";
    case "mark_pr_ready": return "mark PR ready for review";
    case "integrate": return "dispatch Integration";
    case "wait_integration": return "wait for Integration";
    case "ready_to_merge": return "ready for human merge";
    case "blocked": return `blocked — ${action.reason}`;
  }
}

function roleLabel(role: QaRole): string {
  if (role === "code") return "Code QA";
  if (role === "security") return "Security QA";
  return "Visual QA";
}

async function hasCurrentHumanControlPlaneAcknowledgement(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<boolean> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });

  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const value = parseAttestation(comment.body ?? "");
      if (value?.kind !== "human_control_plane") continue;
      if (sameEvaluationIdentity(value.identity, snapshot.identity)) return true;
    } catch {
      // Invalid historical evidence is not a current acknowledgement.
    }
  }
  return false;
}
