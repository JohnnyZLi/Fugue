import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertWorkMetadataForIssue,
  parseWorkMetadata,
  stripWorkMetadata,
  upsertWorkMetadata,
} from "./metadata.js";
import { canonicalizePrMetadata } from "./pr-metadata.js";
import { beginReview } from "./reviews.js";
import { resolveActivePolicy, type ActivePolicy } from "./policy.js";
import {
  canonicalRequirements,
  compareCoordinatorSnapshots,
  coordinatorSnapshotSchema,
  createCanonicalWorkState,
  createFugueAuthorityVariable,
  deleteFugueAuthorityVariable,
  getFugueAuthorityVariable,
  publishCoordinatorSnapshot,
  reconstructState,
  recoverCoordinatorSnapshots,
  repairCanonicalWorkStateComments,
  rollCanonicalWorkStatesToCurrentBase,
  type CoordinatorSnapshot,
  type WorkState,
} from "./state.js";
import { processCurrentSubmissions } from "./submissions.js";
import { upsertStateComment } from "./state-comment.js";
import { actionLabel, observeWork, planWork, type WorkflowAction } from "./workflow.js";
import { claimWorker } from "./worker.js";
import type { FugueGitHub } from "./github.js";
import {
  bindDispatchedIntegrationRun,
  bindIntegrationRun,
  ensureIntegrationDispatch,
  getCurrentIntegrationRecord,
  getIntegrationRunStartEvidence,
  INTEGRATION_REQUEST_RECOVERY_GRACE_MS,
  integrationDispatchRunToken,
  markIntegrationDispatchStarted,
  publishIntegrationRecord,
  reclaimOrphanIntegrationAuthorityVariables,
  releaseIntegrationAuthorityVariable,
  sealIntegrationWorkflowRunEvent,
} from "./integration-status.js";
import { FUGUE_PROTOCOL_ACTOR } from "./provenance.js";
import { captureEvaluation } from "./evaluation.js";
import { loadCurrentCanonicalWorkState, publishCanonicalWorkState } from "./state.js";

export interface ReconcileOptions {
  issue?: number;
  pr?: number;
}

export interface ReconcileResult {
  processed: number[];
}

export interface CoordinatorIssueEvent {
  eventName: string;
  action: string;
  actor: string;
  eventId?: string;
  eventSequence?: number;
  issueNumber?: number;
  label?: string;
  issueTitle?: string;
  issueBody?: string;
  issueLabels?: string[];
  issueUpdatedAt?: string;
  issueIsPullRequest?: boolean;
}

const MAX_TRANSITIONS_PER_WORK = 12;
const STATE_LABELS = new Set(["state:ready", "state:working", "state:blocked"] as const);
const COORDINATOR_ACTIONS = new Set(["opened", "edited", "labeled", "unlabeled"]);
const INTEGRATION_DISPATCH_FENCE_PREFIX = "FUGUE_INT_F_";
const INTEGRATION_BINDING_WITNESS_PREFIX = "FUGUE_INT_B_";

interface ProtectedIntegrationDispatchFence {
  version: 1;
  kind: "integration_dispatch_fence";
  request_id: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  anchor_name: string;
  secret_digest: string;
  run_token: string;
  authority_actor_id: number;
  created_at: string;
}

interface ProtectedIntegrationBindingWitness {
  version: 1;
  kind: "integration_binding_witness";
  request_id: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  anchor_name: string;
  run_token: string;
  authority_actor_id: number;
  run_id: number;
  run_attempt: 1;
  run_created_at: string;
  html_url: string;
}

export type ProtectedIntegrationRecoveryDecision =
  | { kind: "bind"; runId: number; createdAt: string; htmlUrl: string }
  | { kind: "pending" }
  | { kind: "identity_lost" };

/**
 * Hosted lost-bind recovery does constant request-local work: exact protected evidence wins immediately;
 * an F-only may-have-dispatched boundary waits through one bounded grace interval and then converges to the
 * sole run-ID-optional terminal outcome, identity_lost. It never consults mutable history, retries the
 * ambiguous request, or elects a later run.
 */
export function protectedIntegrationRecoveryDecision(input: {
  requestCreatedAt: string;
  dispatchStartedAt?: string | null | undefined;
  fenceCreatedAt?: string | null | undefined;
  witness?: { runId: number; createdAt: string; htmlUrl: string } | undefined;
  now: number;
}): ProtectedIntegrationRecoveryDecision {
  if (input.witness) {
    return { kind: "bind", runId: input.witness.runId, createdAt: input.witness.createdAt, htmlUrl: input.witness.htmlUrl };
  }
  const boundary = input.fenceCreatedAt ?? input.dispatchStartedAt ?? input.requestCreatedAt;
  const started = Date.parse(boundary);
  if (!Number.isFinite(started) || input.now - started >= INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
    return { kind: "identity_lost" };
  }
  return { kind: "pending" };
}

export async function reconcileRepository(
  github: FugueGitHub,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (options.issue && options.pr) throw new Error("Choose at most one of issue or PR reconciliation filters.");

  const policy = await resolveActivePolicy(github);
  assertProtectedWorkflowRuntimeCurrent(policy);
  await rollCanonicalWorkStatesToCurrentBase(github, policy);
  await repairCanonicalWorkStateComments(github, policy);
  await reclaimOrphanIntegrationAuthorityVariables(github);

  const integrationEvent = integrationWorkflowRunEventFromEnvironment();
  if (integrationAuthorityActorId() === undefined) {
    // Non-hosted compatibility only. The protected control plane always supplies the Authority App
    // identity and never lets legacy Deployment/Deployment Status presentation choose a run.
    await sealIntegrationWorkflowRunEvent(github, integrationEvent);
  } else if (integrationEvent) {
    const bound = await bindProtectedIntegrationWorkflowRunEvent(github, integrationEvent);
    if (bound) await sealIntegrationWorkflowRunEvent(github, { ...integrationEvent, actor: "github-actions[bot]" });
  }
  const event = coordinatorIssueEventFromEnvironment();
  await preserveCoordinatorIssueEvent(github, policy, event);
  await replayCoordinatorSnapshots(github, policy);

  await adoptAssignedPullRequests(github, policy);
  await repairCanonicalMirrors(github, policy);

  const initial = await reconstructState(github);
  const selected = selectWorks(initial.works, options);
  const issueNumbers = selected.map((work) => work.issueNumber);

  for (const issueNumber of issueNumbers) await reconcileWork(github, issueNumber);
  return { processed: issueNumbers };
}

export async function reconcileWork(github: FugueGitHub, issueNumber: number): Promise<void> {
  for (let transition = 0; transition < MAX_TRANSITIONS_PER_WORK; transition += 1) {
    const policy = await resolveActivePolicy(github);
    assertProtectedWorkflowRuntimeCurrent(policy);
    await rollCanonicalWorkStatesToCurrentBase(github, policy);
    await repairCanonicalWorkStateComments(github, policy);
    await replayCoordinatorSnapshots(github, policy, issueNumber);
    await adoptAssignedPullRequests(github, policy);
    await repairCanonicalMirrors(github, policy, issueNumber);

    const state = await reconstructState(github);
    const work = state.works.find((candidate) => candidate.issueNumber === issueNumber);
    if (!work) return;

    if (work.pr) {
      const snapshot = await captureEvaluation(github, work.pr.number);
      await cleanupTerminalProtectedIntegrationRecovery(github, snapshot);
      const submissions = await processCurrentSubmissions(github, snapshot);
      if (submissions.blockedReason) {
        await upsertStateComment(github, work, { kind: "blocked", reason: submissions.blockedReason });
        return;
      }
      if (submissions.accepted > 0) continue;
    }

    const observation = await observeWork(github, work);
    const action = planWork(observation);
    let changed: boolean;
    try {
      changed = await applyAction(github, state.policy, work, action);
    } catch (error) {
      const detail = message(error);
      await upsertStateComment(github, work, {
        kind: "blocked",
        reason: `Control-plane error while trying to ${actionLabel(action)}: ${detail}`,
      });
      throw error;
    }
    if (changed) continue;

    await upsertStateComment(github, work, action);
    return;
  }

  const state = await reconstructState(github);
  const work = state.works.find((candidate) => candidate.issueNumber === issueNumber);
  if (work) {
    await upsertStateComment(github, work, {
      kind: "blocked",
      reason: `Reconciliation exceeded ${MAX_TRANSITIONS_PER_WORK} deterministic transitions; inspect for a protocol loop.`,
    });
  }
}

export function assertProtectedWorkflowRuntimeCurrent(
  policy: ActivePolicy,
  runtimeSha = process.env.FUGUE_WORKFLOW_SHA ?? process.env.GITHUB_WORKFLOW_SHA,
): void {
  if (!runtimeSha) return;
  if (!/^[0-9a-f]{40}$/i.test(runtimeSha)) throw new Error("Protected Fugue runtime SHA is malformed.");
  if (runtimeSha.toLowerCase() !== policy.identity.baseSha.toLowerCase()) {
    throw new Error(
      `Stale protected Fugue invocation ${runtimeSha.slice(0, 8)} cannot mutate current base ${policy.identity.baseSha.slice(0, 8)}.`,
    );
  }
}

async function applyAction(
  github: FugueGitHub,
  policy: ActivePolicy,
  work: WorkState,
  action: WorkflowAction,
): Promise<boolean> {
  switch (action.kind) {
    case "allocate_worker":
      await allocateWorker(github, policy, work);
      return true;
    case "start_qa":
      for (const role of action.roles) await beginReview(github, requirePr(work), role);
      return true;
    case "mark_pr_ready":
      await markPrReady(github, policy, work);
      return true;
    case "update_base":
      await updatePrBranch(github, work);
      return true;
    case "integrate":
      await dispatchIntegration(github, policy, work);
      return false;
    case "wait_worker":
    case "wait_ci":
    case "wait_qa":
    case "resume_worker":
    case "human_control_plane_ack":
    case "wait_integration":
    case "ready_to_merge":
    case "blocked":
      return false;
  }
}

export async function preserveCoordinatorIssueEvent(
  github: FugueGitHub,
  policy: ActivePolicy,
  event: CoordinatorIssueEvent | undefined,
): Promise<boolean> {
  if (!event || event.eventName !== "issues" || !event.issueNumber) return false;
  if (event.issueIsPullRequest) return false;
  if (!event.actor || event.actor === FUGUE_PROTOCOL_ACTOR) return false;
  if (!COORDINATOR_ACTIONS.has(event.action)) return false;
  if (!(await canCanonicalizeCoordinatorEvent(github, event.actor))) return false;
  if (event.issueTitle === undefined || event.issueBody === undefined || !event.issueLabels || !event.issueUpdatedAt) return false;

  const capturedAt = new Date().toISOString();
  const snapshot = coordinatorSnapshotSchema.parse({
    version: 1,
    kind: "coordinator_snapshot",
    event_id: event.eventId ?? `${event.issueNumber}:${event.issueUpdatedAt}:${event.action}:${event.label ?? ""}`,
    event_sequence: event.eventSequence ?? 0,
    event_name: "issues",
    action: event.action,
    actor: event.actor,
    issue: event.issueNumber,
    ...(event.label ? { label: event.label } : {}),
    title: event.issueTitle,
    body: event.issueBody,
    labels: event.issueLabels,
    issue_updated_at: event.issueUpdatedAt,
    captured_at: capturedAt,
  });
  await publishCoordinatorSnapshot(github, policy.identity.baseSha, snapshot);
  return true;
}

export async function replayCoordinatorSnapshots(
  github: FugueGitHub,
  policy: ActivePolicy,
  onlyIssue?: number,
): Promise<number[]> {
  const snapshots = await recoverCoordinatorSnapshots(github, policy);
  const applied: number[] = [];
  for (const snapshot of snapshots) {
    if (onlyIssue && snapshot.issue !== onlyIssue) continue;
    if (await ingestCoordinatorSnapshot(github, policy, snapshot)) applied.push(snapshot.issue);
  }
  return applied;
}

export async function ingestCoordinatorSnapshot(
  github: FugueGitHub,
  policy: ActivePolicy,
  snapshot: CoordinatorSnapshot,
): Promise<boolean> {
  const latest = await recoverCoordinatorSnapshots(github, policy);
  const current = latest.find((candidate) => candidate.issue === snapshot.issue);
  if (current && compareCoordinatorSnapshots(current, snapshot) > 0) return false;
  return ingestCoordinatorIssueEvent(github, policy, {
    eventName: snapshot.event_name,
    action: snapshot.action,
    actor: snapshot.actor,
    eventId: snapshot.event_id,
    eventSequence: snapshot.event_sequence,
    issueNumber: snapshot.issue,
    ...(snapshot.label ? { label: snapshot.label } : {}),
    issueTitle: snapshot.title,
    issueBody: snapshot.body,
    issueLabels: snapshot.labels,
    issueUpdatedAt: snapshot.issue_updated_at,
    issueIsPullRequest: false,
  }, true);
}

/** Canonicalize an authorized immutable issue snapshot, never a later mutable fetch. */
export async function ingestCoordinatorIssueEvent(
  github: FugueGitHub,
  policy: ActivePolicy,
  event: CoordinatorIssueEvent | undefined,
  alreadyAuthorized = false,
): Promise<boolean> {
  if (!event || event.eventName !== "issues" || !event.issueNumber) return false;
  if (event.issueIsPullRequest) return false;
  if (!event.actor || event.actor === FUGUE_PROTOCOL_ACTOR) return false;
  if (!COORDINATOR_ACTIONS.has(event.action)) return false;
  if (!alreadyAuthorized && !(await canCanonicalizeCoordinatorEvent(github, event.actor))) return false;

  const existing = await loadCurrentCanonicalWorkState(github, event.issueNumber, policy.identity.baseSha);
  const coordinator = coordinatorIdentity(event);
  if (existing && coordinator && compareCoordinatorIdentity(existing, coordinator) >= 0) return false;

  if (event.action === "labeled" || event.action === "unlabeled") {
    if (!existing || !event.label || !event.issueLabels) return false;
    let state = existing.state;
    let agentReady = existing.agent_ready;
    if (STATE_LABELS.has(event.label as WorkState["stateLabel"]) && event.action === "labeled") {
      state = singleStateLabel(event.issueLabels, event.issueNumber);
    }
    if (event.label === "agent:ready") agentReady = event.action === "labeled";
    return publishCanonicalWorkState(github, createCanonicalWorkState({
      issue: existing.issue,
      title: existing.title,
      state,
      agentReady,
      requirements: canonicalRequirements(existing),
      metadata: existing.metadata,
      pr: existing.pr,
      baseSha: policy.identity.baseSha,
      predecessor: existing,
      ...(coordinator ? { coordinator } : {}),
    }));
  }

  if (event.issueTitle === undefined || event.issueBody === undefined || !event.issueLabels) return false;
  const metadata = parseWorkMetadata(event.issueBody);
  if (!metadata) return false;
  assertWorkMetadataForIssue(metadata, event.issueNumber);
  const requirements = stripWorkMetadata(event.issueBody);
  if (!existing && (metadata.execution.worker_id || metadata.execution.branch)) {
    throw new Error(`Issue #${event.issueNumber} cannot bootstrap canonical Fugue state from pre-populated Worker execution metadata.`);
  }
  const state = existing?.state ?? singleStateLabel(event.issueLabels, event.issueNumber);
  const agentReady = existing?.agent_ready ?? event.issueLabels.includes("agent:ready");
  const acceptedMetadata = existing ? { ...metadata, execution: existing.metadata.execution } : metadata;
  return publishCanonicalWorkState(github, createCanonicalWorkState({
    issue: event.issueNumber,
    title: event.issueTitle,
    state,
    agentReady,
    requirements,
    metadata: acceptedMetadata,
    pr: existing?.pr ?? null,
    baseSha: policy.identity.baseSha,
    ...(existing ? { predecessor: existing } : { logicalRoot: true }),
    ...(coordinator ? { coordinator } : {}),
  }));
}

function coordinatorIdentity(event: CoordinatorIssueEvent): { issueUpdatedAt: string; eventSequence: number; eventId: string } | undefined {
  if (!event.issueUpdatedAt || !event.issueNumber) return undefined;
  return {
    issueUpdatedAt: event.issueUpdatedAt,
    eventSequence: event.eventSequence ?? 0,
    eventId: event.eventId ?? `${event.issueNumber}:${event.issueUpdatedAt}:${event.action}:${event.label ?? ""}`,
  };
}

function compareCoordinatorIdentity(
  state: { coordinator_issue_updated_at?: string | undefined; coordinator_event_sequence?: number | undefined; coordinator_event_id?: string | undefined },
  incoming: { issueUpdatedAt: string; eventSequence: number; eventId: string },
): number {
  if (state.coordinator_issue_updated_at === undefined || state.coordinator_event_sequence === undefined ||
      state.coordinator_event_id === undefined) return -1;
  const left = Date.parse(state.coordinator_issue_updated_at);
  const right = Date.parse(incoming.issueUpdatedAt);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left < right ? -1 : 1;
  if (state.coordinator_issue_updated_at !== incoming.issueUpdatedAt) {
    return state.coordinator_issue_updated_at.localeCompare(incoming.issueUpdatedAt);
  }
  if (state.coordinator_event_sequence !== incoming.eventSequence) {
    return state.coordinator_event_sequence < incoming.eventSequence ? -1 : 1;
  }
  return state.coordinator_event_id.localeCompare(incoming.eventId);
}

export async function allocateWorker(github: FugueGitHub, policy: ActivePolicy, work: WorkState): Promise<void> {
  if (!work.agentReady) throw new Error(`Issue #${work.issueNumber} is state:ready but canonical state lacks agent:ready.`);
  const claim = claimWorker(work.metadata, work.issueNumber, work.title, policy.config.branches.worker_pattern, false);
  await ensureWorkerBranchAtBase(github, claim.branch, policy.identity.baseSha);
  await publishCanonicalWorkState(github, createCanonicalWorkState({
    issue: work.issueNumber,
    title: work.title,
    state: "state:working",
    agentReady: work.agentReady,
    requirements: work.requirements,
    metadata: claim.metadata,
    pr: work.canonical.pr,
    baseSha: policy.identity.baseSha,
    predecessor: work.canonical,
  }));
}

export async function ensureWorkerBranchAtBase(github: FugueGitHub, branch: string, baseSha: string): Promise<void> {
  const { owner, repo } = github.repository;
  let existing = await readBranchSha(github, branch);
  if (!existing) {
    try {
      await github.octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    } catch (error) {
      if (httpStatus(error) !== 422) throw error;
    }
    existing = await readBranchSha(github, branch);
  }
  if (!existing) throw new Error(`Worker branch ${branch} was not present after allocation.`);
  if (existing !== baseSha) {
    throw new Error(`Worker branch ${branch} already exists at ${existing.slice(0, 8)}, expected protected base ${baseSha.slice(0, 8)}.`);
  }
}

export async function adoptAssignedPullRequests(github: FugueGitHub, suppliedPolicy?: ActivePolicy): Promise<number[]> {
  const policy = suppliedPolicy ?? await resolveActivePolicy(github);
  const state = await reconstructState(github);
  const { owner, repo } = github.repository;
  const pulls = await github.octokit.paginate(github.octokit.rest.pulls.list, { owner, repo, state: "open", per_page: 100 });
  const adopted: number[] = [];
  for (const work of state.works) {
    const workerId = work.metadata.execution.worker_id;
    const branch = work.metadata.execution.branch;
    if (!workerId || !branch || work.canonical.pr) continue;
    const matches = pulls.filter((pull) => pull.head.ref === branch && pull.base.ref === policy.identity.baseBranch);
    if (matches.length > 1) throw new Error(`Multiple open PRs use assigned branch ${branch}.`);
    const pull = matches[0];
    if (!pull) continue;
    const expected = { version: 1 as const, work_id: work.metadata.work_id, issue: work.issueNumber, worker_id: workerId, branch };
    await publishCanonicalWorkState(github, createCanonicalWorkState({
      issue: work.issueNumber,
      title: work.title,
      state: work.stateLabel,
      agentReady: work.agentReady,
      requirements: work.requirements,
      metadata: work.metadata,
      pr: { number: pull.number, metadata: expected, draft: true },
      baseSha: policy.identity.baseSha,
      predecessor: work.canonical,
    }));
    adopted.push(pull.number);
  }
  if (adopted.length) await repairCanonicalMirrors(github, policy);
  return adopted;
}

export async function repairCanonicalMirrors(github: FugueGitHub, policy: ActivePolicy, onlyIssue?: number): Promise<void> {
  const state = await reconstructState(github);
  const { owner, repo } = github.repository;
  for (const work of state.works) {
    if (onlyIssue && work.issueNumber !== onlyIssue) continue;
    const issue = await github.octokit.rest.issues.get({ owner, repo, issue_number: work.issueNumber });
    const currentLabels = issue.data.labels.map(labelName);
    const nextLabels = currentLabels.filter((label) => !label.startsWith("state:") && label !== "agent:ready");
    nextLabels.push(work.stateLabel);
    if (work.agentReady) nextLabels.push("agent:ready");
    const desiredBody = upsertWorkMetadata(work.requirements, work.metadata);
    if (issue.data.state !== "open" || issue.data.title !== work.title || (issue.data.body ?? "") !== desiredBody || !sameStringSet(currentLabels, nextLabels)) {
      await github.octokit.rest.issues.update({
        owner, repo, issue_number: work.issueNumber, title: work.title, body: desiredBody, state: "open", labels: [...new Set(nextLabels)],
      });
    }
    if (!work.pr) continue;
    const pull = await github.octokit.rest.pulls.get({ owner, repo, pull_number: work.pr.number });
    if (pull.data.merged) continue;
    let body = pull.data.body ?? "";
    if (!new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${work.issueNumber}\\b`, "i").test(body)) {
      body = `${body.trimEnd()}\n\nCloses #${work.issueNumber}\n`;
    }
    body = canonicalizePrMetadata(body, work.pr.metadata);
    if (pull.data.state !== "open" || pull.data.base.ref !== policy.identity.baseBranch || body !== (pull.data.body ?? "")) {
      await github.octokit.rest.pulls.update({ owner, repo, pull_number: work.pr.number, state: "open", base: policy.identity.baseBranch, body });
    }
    await syncPrDraft(github, work.pr.number, work.pr.draft);
  }
}

async function markPrReady(github: FugueGitHub, policy: ActivePolicy, work: WorkState): Promise<void> {
  const prNumber = requirePr(work);
  if (!work.canonical.pr) throw new Error(`Work #${work.issueNumber} has no canonical PR linkage.`);
  if (work.canonical.pr.draft) {
    await publishCanonicalWorkState(github, createCanonicalWorkState({
      issue: work.issueNumber,
      title: work.title,
      state: work.stateLabel,
      agentReady: work.agentReady,
      requirements: work.requirements,
      metadata: work.metadata,
      pr: { ...work.canonical.pr, draft: false },
      baseSha: policy.identity.baseSha,
      predecessor: work.canonical,
    }));
  }
  await syncPrDraft(github, prNumber, false);
}

async function updatePrBranch(github: FugueGitHub, work: WorkState): Promise<void> {
  const { owner, repo } = github.repository;
  const prNumber = requirePr(work);
  const headSha = work.pr?.headSha;
  if (!headSha) throw new Error(`Work #${work.issueNumber} has no PR head to update.`);
  await github.octokit.rest.pulls.updateBranch({ owner, repo, pull_number: prNumber, expected_head_sha: headSha });
}

function integrationAuthorityActorId(): number | undefined {
  // Protected request-local recovery records: FUGUE_INT_F_* fence and FUGUE_INT_B_* exact-run witness.
  const token = process.env.FUGUE_AUTHORITY_TOKEN?.trim();
  const raw = process.env.FUGUE_AUTHORITY_ACTOR_ID?.trim();
  // Integration finalize also has a Variables-only Authority token; only the control-plane actor ID
  // opts a process into hosted F/B dispatch recovery.
  if (!raw) return undefined;
  if (!token) throw new Error("Protected Fugue Authority actor ID requires FUGUE_AUTHORITY_TOKEN.");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Protected Fugue Authority actor ID is malformed.");
  return id;
}

function integrationRecoverySuffix(requestId: string): string {
  return createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 32).toUpperCase();
}

function integrationDispatchFenceName(requestId: string): string {
  return `${INTEGRATION_DISPATCH_FENCE_PREFIX}${integrationRecoverySuffix(requestId)}`;
}

function integrationBindingWitnessName(requestId: string): string {
  return `${INTEGRATION_BINDING_WITNESS_PREFIX}${integrationRecoverySuffix(requestId)}`;
}

function parseProtectedIntegrationDispatchFence(raw: string): ProtectedIntegrationDispatchFence {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new Error("Protected Integration dispatch fence is malformed."); }
  if (!value || typeof value !== "object") throw new Error("Protected Integration dispatch fence is malformed.");
  const fence = value as Partial<ProtectedIntegrationDispatchFence>;
  if (fence.version !== 1 || fence.kind !== "integration_dispatch_fence" ||
      typeof fence.request_id !== "string" || typeof fence.pr_number !== "number" ||
      typeof fence.head_sha !== "string" || typeof fence.base_sha !== "string" ||
      typeof fence.anchor_name !== "string" || typeof fence.secret_digest !== "string" ||
      typeof fence.run_token !== "string" || typeof fence.authority_actor_id !== "number" ||
      typeof fence.created_at !== "string") {
    throw new Error("Protected Integration dispatch fence is malformed.");
  }
  return fence as ProtectedIntegrationDispatchFence;
}

function parseProtectedIntegrationBindingWitness(raw: string): ProtectedIntegrationBindingWitness {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new Error("Protected Integration binding witness is malformed."); }
  if (!value || typeof value !== "object") throw new Error("Protected Integration binding witness is malformed.");
  const witness = value as Partial<ProtectedIntegrationBindingWitness>;
  if (witness.version !== 1 || witness.kind !== "integration_binding_witness" ||
      typeof witness.request_id !== "string" || typeof witness.pr_number !== "number" ||
      typeof witness.head_sha !== "string" || typeof witness.base_sha !== "string" ||
      typeof witness.anchor_name !== "string" || typeof witness.run_token !== "string" ||
      typeof witness.authority_actor_id !== "number" || typeof witness.run_id !== "number" ||
      witness.run_attempt !== 1 || typeof witness.run_created_at !== "string" || typeof witness.html_url !== "string") {
    throw new Error("Protected Integration binding witness is malformed.");
  }
  return witness as ProtectedIntegrationBindingWitness;
}

async function readProtectedIntegrationDispatchFence(
  github: FugueGitHub,
  requestId: string,
): Promise<ProtectedIntegrationDispatchFence | undefined> {
  const raw = await getFugueAuthorityVariable(github, integrationDispatchFenceName(requestId));
  return raw === undefined ? undefined : parseProtectedIntegrationDispatchFence(raw);
}

async function readProtectedIntegrationBindingWitness(
  github: FugueGitHub,
  requestId: string,
): Promise<ProtectedIntegrationBindingWitness | undefined> {
  const raw = await getFugueAuthorityVariable(github, integrationBindingWitnessName(requestId));
  return raw === undefined ? undefined : parseProtectedIntegrationBindingWitness(raw);
}

async function cleanupProtectedIntegrationRecovery(github: FugueGitHub, requestId: string): Promise<void> {
  await deleteFugueAuthorityVariable(github, integrationBindingWitnessName(requestId));
  await deleteFugueAuthorityVariable(github, integrationDispatchFenceName(requestId));
}

export async function cleanupTerminalProtectedIntegrationRecovery(
  github: FugueGitHub,
  snapshot: Awaited<ReturnType<typeof captureEvaluation>>,
): Promise<boolean> {
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.terminal?.state !== "identity_lost") return false;
  // Durable d3 terminal authority already exists. Every delete below is request-specific and idempotent;
  // a crash at any point can only leave redundant transient state for the next reconciliation to remove.
  await releaseIntegrationAuthorityVariable(github, current);
  await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
  return true;
}

function protectedIntegrationFenceDigest(fence: ProtectedIntegrationDispatchFence): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(fence), "utf8").digest("hex")}`;
}

function assertProtectedFenceMatchesRecord(
  fence: ProtectedIntegrationDispatchFence,
  current: Awaited<ReturnType<typeof getCurrentIntegrationRecord>>,
  actorId: number,
): void {
  if (!current || !current.dispatch || current.request.request_id !== fence.request_id ||
      current.identity.prNumber !== fence.pr_number || current.identity.headSha.toLowerCase() !== fence.head_sha.toLowerCase() ||
      current.identity.baseSha.toLowerCase() !== fence.base_sha.toLowerCase() ||
      current.dispatch.anchor_name !== fence.anchor_name || current.dispatch.secret_digest.toLowerCase() !== fence.secret_digest.toLowerCase() ||
      fence.authority_actor_id !== actorId || !/^[0-9a-f]{24}$/.test(fence.run_token) || !Number.isFinite(Date.parse(fence.created_at))) {
    throw new Error(`Protected Integration dispatch fence does not match active request ${fence.request_id}.`);
  }
}

function assertProtectedWitnessMatchesFence(
  witness: ProtectedIntegrationBindingWitness,
  fence: ProtectedIntegrationDispatchFence,
  github: FugueGitHub,
): void {
  const expectedUrl = `https://github.com/${github.repository.fullName}/actions/runs/${witness.run_id}`;
  if (witness.request_id !== fence.request_id || witness.pr_number !== fence.pr_number ||
      witness.head_sha.toLowerCase() !== fence.head_sha.toLowerCase() || witness.base_sha.toLowerCase() !== fence.base_sha.toLowerCase() ||
      witness.anchor_name !== fence.anchor_name || witness.run_token !== fence.run_token ||
      witness.authority_actor_id !== fence.authority_actor_id || !Number.isSafeInteger(witness.run_id) || witness.run_id <= 0 ||
      witness.run_attempt !== 1 || !Number.isFinite(Date.parse(witness.run_created_at)) || witness.html_url !== expectedUrl) {
    throw new Error(`Protected Integration binding witness conflicts with immutable request ${fence.request_id}.`);
  }
}

export async function recoverExistingProtectedIntegration(
  github: FugueGitHub,
  snapshot: Awaited<ReturnType<typeof captureEvaluation>>,
  now: number,
): Promise<boolean> {
  const actorId = integrationAuthorityActorId();
  if (actorId === undefined) return false;
  let current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current) return false;
  if (current.terminal) {
    if (current.terminal.state === "identity_lost") {
      await releaseIntegrationAuthorityVariable(github, current);
      await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
      return true;
    }
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    // A genuinely aborted no-fence transport remains the existing retryable case. The revised
    // no-retry rule is specific to identity_lost and must not suppress fresh-request recovery here.
    return current.terminal.state !== "aborted";
  }
  if (current.run) {
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    return true;
  }

  const start = await getIntegrationRunStartEvidence(github, current);
  if (start) {
    await bindIntegrationRun(github, snapshot, current.request.request_id, start.run_id);
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    return true;
  }

  const fence = await readProtectedIntegrationDispatchFence(github, current.request.request_id);
  // No F means the protected caller never crossed the may-have-dispatched boundary. The older
  // provably-pre-POST path remains separate; identity_lost is reserved for an existing protected F.
  if (!fence) return false;
  assertProtectedFenceMatchesRecord(fence, current, actorId);
  let witness = await readProtectedIntegrationBindingWitness(github, current.request.request_id);
  if (witness) assertProtectedWitnessMatchesFence(witness, fence, github);

  const decision = protectedIntegrationRecoveryDecision({
    requestCreatedAt: current.request.created_at,
    dispatchStartedAt: current.dispatch_started_at,
    fenceCreatedAt: fence.created_at,
    witness: witness ? { runId: witness.run_id, createdAt: witness.run_created_at, htmlUrl: witness.html_url } : undefined,
    now,
  });
  if (decision.kind === "bind") {
    await bindDispatchedIntegrationRun(
      github, snapshot, current.request.request_id, decision.runId, decision.htmlUrl, decision.createdAt,
    );
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    return true;
  }
  if (decision.kind === "pending") {
    if (!current.dispatch_started_at) {
      await markIntegrationDispatchStarted(github, snapshot, current.request.request_id, fence.created_at);
    }
    return true;
  }

  if (!current.dispatch_started_at) {
    current = await markIntegrationDispatchStarted(github, snapshot, current.request.request_id, fence.created_at);
  }

  // Give every attacker-resistant exact-L source one final request-local read before committing the
  // irreversible exception. Any genuine exact evidence observed here wins over identity_lost.
  const finalStart = await getIntegrationRunStartEvidence(github, current);
  if (finalStart) {
    await bindIntegrationRun(github, snapshot, current.request.request_id, finalStart.run_id);
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    return true;
  }
  witness = await readProtectedIntegrationBindingWitness(github, current.request.request_id);
  if (witness) {
    assertProtectedWitnessMatchesFence(witness, fence, github);
    await bindDispatchedIntegrationRun(
      github, snapshot, current.request.request_id, witness.run_id, witness.html_url, witness.run_created_at,
    );
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    return true;
  }

  const terminalAt = new Date(now).toISOString();
  const terminal = await publishIntegrationRecord(github, {
    ...current,
    dispatch_started_at: current.dispatch_started_at ?? fence.created_at,
    run: null,
    terminal: {
      state: "identity_lost",
      attempt: 1,
      boundary_created_at: fence.created_at,
      fence_digest: protectedIntegrationFenceDigest(fence),
      detail: "Protected dispatch may have created attempt 1, but the synchronous returned run identity and every attacker-resistant exact-run witness are unavailable; this request is terminal and requires explicit Human action for any fresh Integration.",
      created_at: terminalAt,
    },
    created_at: terminalAt,
  });
  // Cleanup is strictly post-commit. If either delete crashes, the next work reconciliation sees the
  // same irreversible d3 terminal and resumes these idempotent request-specific deletions.
  await releaseIntegrationAuthorityVariable(github, terminal);
  await cleanupProtectedIntegrationRecovery(github, terminal.request.request_id);
  return true;
}

async function createProtectedIntegrationDispatchFence(
  github: FugueGitHub,
  snapshot: Awaited<ReturnType<typeof captureEvaluation>>,
  requestId: string,
  dispatchSecret: string,
  authorityAnchor: string,
  now: number,
): Promise<{ created: boolean; fence: ProtectedIntegrationDispatchFence }> {
  const actorId = integrationAuthorityActorId();
  if (actorId === undefined) throw new Error("Protected Integration dispatch requires the Fugue Authority App identity.");
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.request.request_id !== requestId || !current.dispatch || current.terminal || current.run) {
    throw new Error(`Integration request ${requestId} is not an active unbound dispatch authorization.`);
  }
  const runToken = integrationDispatchRunToken(requestId, dispatchSecret);
  const createdAt = new Date(now).toISOString();
  const fence: ProtectedIntegrationDispatchFence = {
    version: 1,
    kind: "integration_dispatch_fence",
    request_id: requestId,
    pr_number: snapshot.identity.prNumber,
    head_sha: snapshot.identity.headSha,
    base_sha: snapshot.identity.baseSha,
    anchor_name: authorityAnchor,
    secret_digest: current.dispatch.secret_digest,
    run_token: runToken,
    authority_actor_id: actorId,
    created_at: createdAt,
  };
  const serialized = JSON.stringify(fence);
  const name = integrationDispatchFenceName(requestId);
  const created = await createFugueAuthorityVariable(github, name, serialized);
  const committed = await getFugueAuthorityVariable(github, name);
  if (committed !== serialized) {
    throw new Error(`Protected Integration dispatch fence ${name} was claimed with conflicting authority.`);
  }
  return { created, fence };
}

async function dispatchProtectedIntegrationWithAuthorityApp(
  github: FugueGitHub,
  policy: ActivePolicy,
  snapshot: Awaited<ReturnType<typeof captureEvaluation>>,
  requestId: string,
  dispatchSecret: string,
  authorityAnchor: string,
  runToken: string,
): Promise<void> {
  const token = process.env.FUGUE_AUTHORITY_TOKEN?.trim();
  if (!token) throw new Error("Protected Integration dispatch requires FUGUE_AUTHORITY_TOKEN.");
  const { owner, repo } = github.repository;
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/fugue-integration.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({
        ref: policy.identity.baseBranch,
        return_run_details: true,
        inputs: {
          pr: snapshot.identity.prNumber,
          request_id: requestId,
          dispatch_secret: dispatchSecret,
          authority_anchor: authorityAnchor,
          run_token: runToken,
        },
      }),
    },
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Protected Authority-App Integration dispatch failed (${response.status}): ${raw.slice(0, 300)}`);
  }
  let data: { workflow_run_id?: unknown; html_url?: unknown; run_url?: unknown } = {};
  if (raw) {
    try { data = JSON.parse(raw) as typeof data; }
    catch { /* requested-event witness remains the recovery authority */ }
  }
  const runId = typeof data.workflow_run_id === "number" ? data.workflow_run_id : Number.NaN;
  const htmlUrl = typeof data.html_url === "string" ? data.html_url : typeof data.run_url === "string" ? data.run_url : "";
  const expectedHtmlUrl = Number.isSafeInteger(runId) && runId > 0
    ? `https://github.com/${github.repository.fullName}/actions/runs/${runId}`
    : "";
  if (Number.isSafeInteger(runId) && runId > 0 && htmlUrl === expectedHtmlUrl) {
    await bindDispatchedIntegrationRun(github, snapshot, requestId, runId, htmlUrl, new Date().toISOString());
    await cleanupProtectedIntegrationRecovery(github, requestId);
    return;
  }
  // The POST succeeded but the exact synchronous identity did not survive. F remains create-only and
  // prevents redispatch; B/run-start may still recover exact L through grace, otherwise F converges to
  // durable terminal identity_lost on a later reconciliation.
  return;
}

async function bindProtectedIntegrationWorkflowRunEvent(
  github: FugueGitHub,
  event: IntegrationWorkflowRunEvent,
): Promise<boolean> {
  const actorId = integrationAuthorityActorId();
  if (actorId === undefined || event.workflowName !== "Fugue Integration" || event.runAttempt !== 1) return false;
  const match = event.displayTitle.match(/^Fugue Integration PR #(\d+) (int-[0-9a-f]{16}-[0-9a-f]{16}) ([0-9a-f]{24})$/);
  if (!match?.[1] || !match[2] || !match[3]) return false;
  const prNumber = Number(match[1]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return false;
  const snapshot = await captureEvaluation(github, prNumber);
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.request.request_id !== match[2] || current.terminal) return false;
  if (current.run) return current.run.id === event.runId;

  const fence = await readProtectedIntegrationDispatchFence(github, current.request.request_id);
  const witness = await readProtectedIntegrationBindingWitness(github, current.request.request_id);
  if (!fence || !witness) return false;
  assertProtectedFenceMatchesRecord(fence, current, actorId);
  assertProtectedWitnessMatchesFence(witness, fence, github);
  if (fence.run_token !== match[3] || witness.run_id !== event.runId ||
      witness.run_created_at !== event.createdAt || witness.html_url !== event.htmlUrl) return false;
  await bindDispatchedIntegrationRun(
    github, snapshot, current.request.request_id, witness.run_id, witness.html_url, witness.run_created_at,
  );
  await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
  return true;
}

export async function dispatchIntegration(github: FugueGitHub, policy: ActivePolicy, work: WorkState, now = Date.now()): Promise<void> {
  const { owner, repo } = github.repository;
  const prNumber = requirePr(work);
  const snapshot = await captureEvaluation(github, prNumber);
  if (snapshot.identity.baseSha !== policy.identity.baseSha) {
    throw new Error(`Integration dispatch base changed while reconciling PR #${prNumber}.`);
  }

  const actorId = integrationAuthorityActorId();
  if (actorId !== undefined) {
    const existing = await getCurrentIntegrationRecord(github, snapshot.identity);
    if (existing && await recoverExistingProtectedIntegration(github, snapshot, now)) return;
    // No F/B/start/run exists: this remains the canonical provably-pre-POST recovery path.
  }

  const next = await ensureIntegrationDispatch(github, snapshot, now);
  if (!next.dispatch || !next.request || !next.dispatchSecret || !next.authorityAnchor) return;
  const runToken = integrationDispatchRunToken(next.request.request_id, next.dispatchSecret);

  if (actorId !== undefined) {
    const { created, fence } = await createProtectedIntegrationDispatchFence(
      github, snapshot, next.request.request_id, next.dispatchSecret, next.authorityAnchor, now,
    );
    if (!created) return;
    await markIntegrationDispatchStarted(github, snapshot, next.request.request_id, fence.created_at);
    await dispatchProtectedIntegrationWithAuthorityApp(
      github, policy, snapshot, next.request.request_id, next.dispatchSecret, next.authorityAnchor, runToken,
    );
    return;
  }

  const dispatched = await github.octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
    owner,
    repo,
    workflow_id: "fugue-integration.yml",
    ref: policy.identity.baseBranch,
    return_run_details: true,
    inputs: {
      pr: prNumber, request_id: next.request.request_id, dispatch_secret: next.dispatchSecret,
      authority_anchor: next.authorityAnchor, run_token: runToken,
    },
    headers: { "X-GitHub-Api-Version": "2026-03-10" },
  });
  const data = dispatched.data as unknown as { workflow_run_id?: unknown; html_url?: unknown; run_url?: unknown };
  const runId = typeof data.workflow_run_id === "number" ? data.workflow_run_id : Number.NaN;
  const htmlUrl = typeof data.html_url === "string" ? data.html_url : typeof data.run_url === "string" ? data.run_url : "";
  if (!Number.isInteger(runId) || runId <= 0 || !htmlUrl) {
    throw new Error(`Protected Integration dispatch for request ${next.request.request_id} did not return its exact run identity.`);
  }
  await bindDispatchedIntegrationRun(github, snapshot, next.request.request_id, runId, htmlUrl, new Date().toISOString());
}

async function syncPrDraft(github: FugueGitHub, prNumber: number, expectedDraft: boolean): Promise<void> {
  const { owner, repo } = github.repository;
  const pr = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if ((pr.data.draft ?? false) === expectedDraft) return;
  if (expectedDraft) {
    await github.octokit.graphql(
      `mutation Draft($pullRequestId: ID!) { convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } } }`,
      { pullRequestId: pr.data.node_id },
    );
    return;
  }
  await github.octokit.graphql(
    `mutation Ready($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } } }`,
    { pullRequestId: pr.data.node_id },
  );
}

async function canCanonicalizeCoordinatorEvent(github: FugueGitHub, actor: string): Promise<boolean> {
  const { owner, repo } = github.repository;
  try {
    const response = await github.octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: actor });
    return response.data.permission === "write" || response.data.permission === "maintain" || response.data.permission === "admin";
  } catch {
    return false;
  }
}

export interface IntegrationWorkflowRunEvent {
  eventName: "workflow_run";
  workflowName: string;
  runId: number;
  runAttempt: number;
  conclusion: string | null;
  status: string;
  headSha: string;
  displayTitle: string;
  createdAt: string;
  htmlUrl: string;
  actor: string;
}

export function integrationWorkflowRunEventFromEnvironment(): IntegrationWorkflowRunEvent | undefined {
  if ((process.env.GITHUB_EVENT_NAME ?? "") !== "workflow_run") return undefined;
  const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
  if (!eventPath) return undefined;
  try {
    const payload = JSON.parse(readFileSync(eventPath, "utf8")) as {
      workflow_run?: {
        name?: unknown; id?: unknown; run_attempt?: unknown; conclusion?: unknown; status?: unknown;
        head_sha?: unknown; display_title?: unknown; created_at?: unknown; html_url?: unknown;
        actor?: { login?: unknown } | null; event?: unknown;
      };
    };
    const run = payload.workflow_run;
    if (!run || run.name !== "Fugue Integration" || run.event !== "workflow_dispatch" ||
        typeof run.id !== "number" || typeof run.run_attempt !== "number" ||
        typeof run.status !== "string" || typeof run.head_sha !== "string" ||
        typeof run.display_title !== "string" || typeof run.created_at !== "string" ||
        typeof run.html_url !== "string" || typeof run.actor?.login !== "string") return undefined;
    return {
      eventName: "workflow_run",
      workflowName: run.name,
      runId: run.id,
      runAttempt: run.run_attempt,
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      status: run.status,
      headSha: run.head_sha,
      displayTitle: run.display_title,
      createdAt: run.created_at,
      htmlUrl: run.html_url,
      actor: run.actor.login,
    };
  } catch {
    return undefined;
  }
}

export function coordinatorIssueEventFromEnvironment(): CoordinatorIssueEvent | undefined {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
  if (eventName !== "issues" || !eventPath) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(eventPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as {
    action?: unknown;
    sender?: { login?: unknown };
    label?: { name?: unknown } | null;
    issue?: {
      id?: unknown;
      number?: unknown;
      title?: unknown;
      body?: unknown;
      updated_at?: unknown;
      labels?: Array<string | { name?: unknown }>;
      pull_request?: unknown;
    };
  };
  const issue = value.issue;
  const issueNumber = typeof issue?.number === "number" && Number.isInteger(issue.number) && issue.number > 0
    ? issue.number
    : undefined;
  const action = typeof value.action === "string" ? value.action : "";
  const actor = typeof value.sender?.login === "string" ? value.sender.login : "";
  const label = typeof value.label?.name === "string" ? value.label.name : undefined;
  const issueTitle = typeof issue?.title === "string" ? issue.title : undefined;
  const issueBody = typeof issue?.body === "string" ? issue.body : issue?.body === null ? "" : undefined;
  const issueUpdatedAt = typeof issue?.updated_at === "string" ? issue.updated_at : undefined;
  const issueLabels = Array.isArray(issue?.labels)
    ? issue.labels.map((item) => typeof item === "string" ? item : typeof item.name === "string" ? item.name : "").filter(Boolean)
    : undefined;
  const rawId = typeof issue?.id === "number" ? String(issue.id) : String(issueNumber ?? "issue");
  const runId = process.env.GITHUB_RUN_ID ?? "0";
  const runNumber = Number(process.env.GITHUB_RUN_NUMBER ?? process.env.GITHUB_RUN_ID ?? "0");
  const eventSequence = Number.isInteger(runNumber) && runNumber >= 0 ? runNumber : 0;
  const eventDigest = createHash("sha256").update(JSON.stringify({
    rawId,
    issueNumber,
    action,
    actor,
    label: label ?? "",
    issueTitle: issueTitle ?? "",
    issueBody: issueBody ?? "",
    issueLabels: issueLabels ?? [],
    issueUpdatedAt: issueUpdatedAt ?? "",
  }), "utf8").digest("hex").slice(0, 24);
  const eventId = `${runId}:${eventDigest}`;
  return {
    eventName,
    action,
    actor,
    eventId,
    eventSequence,
    ...(issueNumber ? { issueNumber } : {}),
    ...(label ? { label } : {}),
    ...(issueTitle !== undefined ? { issueTitle } : {}),
    ...(issueBody !== undefined ? { issueBody } : {}),
    ...(issueLabels ? { issueLabels } : {}),
    ...(issueUpdatedAt ? { issueUpdatedAt } : {}),
    issueIsPullRequest: Boolean(issue?.pull_request),
  };
}

function singleStateLabel(labels: string[], issueNumber: number): WorkState["stateLabel"] {
  const matches = labels.filter((label): label is WorkState["stateLabel"] => STATE_LABELS.has(label as WorkState["stateLabel"]));
  if (matches.length !== 1) throw new Error(`Issue #${issueNumber} must have exactly one lifecycle label before canonicalization.`);
  return matches[0]!;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function readBranchSha(github: FugueGitHub, branch: string): Promise<string | null> {
  const { owner, repo } = github.repository;
  try {
    const ref = await github.octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return ref.data.object.sha;
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    throw error;
  }
}

function selectWorks(works: WorkState[], options: ReconcileOptions): WorkState[] {
  if (options.issue) return works.filter((work) => work.issueNumber === options.issue);
  if (options.pr) return works.filter((work) => work.pr?.number === options.pr);
  return works;
}

function requirePr(work: WorkState): number {
  if (!work.pr) throw new Error(`Work #${work.issueNumber} has no linked PR.`);
  return work.pr.number;
}

function labelName(label: string | { name?: string | null }): string {
  return typeof label === "string" ? label : label.name ?? "";
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
