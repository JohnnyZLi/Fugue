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
  createCanonicalWorkState,
  loadCurrentCanonicalWorkState,
  publishCanonicalWorkState,
  reconstructState,
  rollCanonicalWorkStatesToCurrentBase,
  type WorkState,
} from "./state.js";
import { processCurrentSubmissions } from "./submissions.js";
import { upsertStateComment } from "./state-comment.js";
import { actionLabel, observeWork, planWork, type WorkflowAction } from "./workflow.js";
import { claimWorker } from "./worker.js";
import type { FugueGitHub } from "./github.js";
import {
  createIntegrationRequest,
  parseIntegrationRequest,
  serializeIntegrationRequest,
  type IntegrationRequest,
} from "./integration-plan.js";
import {
  findIntegrationWorkflowRun,
  INTEGRATION_REQUEST_RECOVERY_GRACE_MS,
} from "./integration-status.js";
import { createProtocolComment, FUGUE_PROTOCOL_ACTOR, isTrustedProtocolComment } from "./provenance.js";
import { captureEvaluation, sameEvaluationIdentity } from "./evaluation.js";

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
  issueNumber?: number;
  label?: string;
}

const MAX_TRANSITIONS_PER_WORK = 12;
const STATE_LABELS = new Set(["state:ready", "state:working", "state:blocked"] as const);

export async function reconcileRepository(
  github: FugueGitHub,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (options.issue && options.pr) throw new Error("Choose at most one of issue or PR reconciliation filters.");

  const policy = await resolveActivePolicy(github);
  await rollCanonicalWorkStatesToCurrentBase(github, policy);
  await ingestCoordinatorIssueEvent(github, policy, coordinatorIssueEventFromEnvironment());
  await adoptAssignedPullRequests(github, policy);
  await repairCanonicalMirrors(github, policy);

  const initial = await reconstructState(github);
  const selected = selectWorks(initial.works, options);
  const issueNumbers = selected.map((work) => work.issueNumber);

  for (const issueNumber of issueNumbers) {
    await reconcileWork(github, issueNumber);
  }

  return { processed: issueNumbers };
}

export async function reconcileWork(github: FugueGitHub, issueNumber: number): Promise<void> {
  for (let transition = 0; transition < MAX_TRANSITIONS_PER_WORK; transition += 1) {
    const policy = await resolveActivePolicy(github);
    await rollCanonicalWorkStatesToCurrentBase(github, policy);
    await adoptAssignedPullRequests(github, policy);
    await repairCanonicalMirrors(github, policy, issueNumber);

    const state = await reconstructState(github);
    const work = state.works.find((candidate) => candidate.issueNumber === issueNumber);
    if (!work) return;

    if (work.pr) {
      const snapshot = await captureEvaluation(github, work.pr.number);
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

/**
 * Convert a Coordinator-authored issue event into protected canonical Fugue state. Issue bodies
 * and labels are inputs/presentation only: the protected workflow re-publishes accepted values in
 * a signed work-state record, and later readers consume only that record.
 */
export async function ingestCoordinatorIssueEvent(
  github: FugueGitHub,
  policy: ActivePolicy,
  event: CoordinatorIssueEvent | undefined,
): Promise<boolean> {
  if (!event || event.eventName !== "issues" || !event.issueNumber) return false;
  if (!event.actor || event.actor === FUGUE_PROTOCOL_ACTOR) return false;
  if (!(await canCanonicalizeCoordinatorEvent(github, event.actor))) return false;
  const supported = new Set(["opened", "edited", "labeled", "unlabeled"]);
  if (!supported.has(event.action)) return false;

  const { owner, repo } = github.repository;
  const issue = await github.octokit.rest.issues.get({ owner, repo, issue_number: event.issueNumber });
  if (issue.data.pull_request) return false;
  const existing = await loadCurrentCanonicalWorkState(github, event.issueNumber);

  if (event.action === "labeled" || event.action === "unlabeled") {
    if (!existing || !event.label) return false;
    let state = existing.state;
    let agentReady = existing.agent_ready;
    if (STATE_LABELS.has(event.label as WorkState["stateLabel"]) && event.action === "labeled") {
      state = event.label as WorkState["stateLabel"];
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
    }));
  }

  const body = issue.data.body ?? "";
  const metadata = parseWorkMetadata(body);
  if (!metadata) return false;
  assertWorkMetadataForIssue(metadata, event.issueNumber);
  const requirements = stripWorkMetadata(body);
  if (!existing && (metadata.execution.worker_id || metadata.execution.branch)) {
    throw new Error(`Issue #${event.issueNumber} cannot bootstrap canonical Fugue state from pre-populated Worker execution metadata.`);
  }
  const labels = issue.data.labels.map(labelName);
  const state = existing?.state ?? singleStateLabel(labels, event.issueNumber);
  const agentReady = existing?.agent_ready ?? labels.includes("agent:ready");
  const acceptedMetadata = existing ? { ...metadata, execution: existing.metadata.execution } : metadata;
  return publishCanonicalWorkState(github, createCanonicalWorkState({
    issue: event.issueNumber,
    title: issue.data.title,
    state,
    agentReady,
    requirements,
    metadata: acceptedMetadata,
    pr: existing?.pr ?? null,
    baseSha: policy.identity.baseSha,
  }));
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

export async function dispatchIntegration(github: FugueGitHub, policy: ActivePolicy, work: WorkState, now = Date.now()): Promise<void> {
  const { owner, repo } = github.repository;
  const prNumber = requirePr(work);
  const headSha = work.pr?.headSha;
  if (!headSha) throw new Error(`Work #${work.issueNumber} has no PR head.`);
  const identity = {
    prNumber,
    headSha,
    baseBranch: policy.identity.baseBranch,
    baseSha: policy.identity.baseSha,
    policyDigest: policy.identity.policyDigest,
    protocolVersion: policy.identity.protocolVersion,
    issueNumber: work.issueNumber,
    workId: work.metadata.work_id,
    workSpecDigest: work.workSpecDigest,
  };
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 });
  let existing: IntegrationRequest | undefined;
  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const candidate = parseIntegrationRequest(comment.body ?? "");
      if (candidate && sameEvaluationIdentity(candidate.identity, identity)) existing = candidate;
    } catch {
      // Malformed historical requests are inert.
    }
  }
  let created = false;
  if (!existing) {
    const request = createIntegrationRequest(identity);
    await createProtocolComment(github, prNumber, `INTEGRATION — REQUESTED\n\nHead: \`${headSha}\`\nRequest: \`${request.request_id}\`\n\n${serializeIntegrationRequest(request)}`);
    existing = request;
    created = true;
  }
  if (await findIntegrationWorkflowRun(github, existing)) return;
  if (!created) {
    const createdAt = Date.parse(existing.created_at);
    if (Number.isFinite(createdAt) && now - createdAt < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) return;
  }
  await github.octokit.rest.actions.createWorkflowDispatch({
    owner, repo, workflow_id: "fugue-integration.yml", ref: policy.identity.baseBranch,
    inputs: { pr: prNumber, request_id: existing.request_id },
  });
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

function coordinatorIssueEventFromEnvironment(): CoordinatorIssueEvent | undefined {
  const eventName = process.env.FUGUE_EVENT_NAME ?? "";
  const action = process.env.FUGUE_EVENT_ACTION ?? "";
  const actor = process.env.FUGUE_EVENT_ACTOR ?? "";
  const issueNumber = Number(process.env.FUGUE_EVENT_ISSUE ?? "");
  const label = process.env.FUGUE_EVENT_LABEL ?? "";
  if (!eventName) return undefined;
  return { eventName, action, actor, ...(Number.isInteger(issueNumber) && issueNumber > 0 ? { issueNumber } : {}), ...(label ? { label } : {}) };
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
