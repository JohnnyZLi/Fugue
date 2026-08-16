import { parseWorkMetadata, upsertWorkMetadata } from "./metadata.js";
import { canonicalizePrMetadata, parsePrMetadata, samePrMetadata } from "./pr-metadata.js";
import { beginReview } from "./reviews.js";
import { resolveActivePolicy, type ActivePolicy } from "./policy.js";
import { reconstructState, type WorkState } from "./state.js";
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
import { createProtocolComment, isTrustedProtocolComment } from "./provenance.js";

export interface ReconcileOptions {
  issue?: number;
  pr?: number;
}

export interface ReconcileResult {
  processed: number[];
}

const MAX_TRANSITIONS_PER_WORK = 12;

export async function reconcileRepository(
  github: FugueGitHub,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (options.issue && options.pr) throw new Error("Choose at most one of issue or PR reconciliation filters.");

  await adoptAssignedPullRequests(github);
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
    await adoptAssignedPullRequests(github);
    const state = await reconstructState(github);
    const work = state.works.find((candidate) => candidate.issueNumber === issueNumber);
    if (!work) return;

    if (work.pr) {
      const snapshot = await import("./evaluation.js").then(({ captureEvaluation }) => captureEvaluation(github, work.pr!.number));
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
      await markPrReady(github, requirePr(work));
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

export async function allocateWorker(github: FugueGitHub, policy: ActivePolicy, work: WorkState): Promise<void> {
  const { owner, repo } = github.repository;
  const issue = await github.octokit.rest.issues.get({ owner, repo, issue_number: work.issueNumber });
  const labels = issue.data.labels.map(labelName);
  if (!labels.includes("agent:ready")) {
    throw new Error(`Issue #${work.issueNumber} is state:ready but lacks agent:ready.`);
  }

  const body = issue.data.body ?? "";
  const metadata = parseWorkMetadata(body);
  if (!metadata) throw new Error(`Issue #${work.issueNumber} is missing fugue-work metadata.`);
  const claim = claimWorker(
    metadata,
    work.issueNumber,
    issue.data.title,
    policy.config.branches.worker_pattern,
    false,
  );

  await ensureWorkerBranchAtBase(github, claim.branch, policy.identity.baseSha);

  const nextLabels = [
    ...labels.filter((label) => !label.startsWith("state:")),
    "state:working",
  ];
  await github.octokit.rest.issues.update({
    owner,
    repo,
    issue_number: work.issueNumber,
    body: upsertWorkMetadata(body, claim.metadata),
    labels: [...new Set(nextLabels)],
  });
}

export async function ensureWorkerBranchAtBase(
  github: FugueGitHub,
  branch: string,
  baseSha: string,
): Promise<void> {
  const { owner, repo } = github.repository;
  let existing = await readBranchSha(github, branch);

  if (!existing) {
    try {
      await github.octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      });
    } catch (error) {
      if (httpStatus(error) !== 422) throw error;
    }
    existing = await readBranchSha(github, branch);
  }

  if (!existing) {
    throw new Error(`Worker branch ${branch} was not present after allocation.`);
  }
  if (existing !== baseSha) {
    throw new Error(
      `Worker branch ${branch} already exists at ${existing.slice(0, 8)}, expected protected base ${baseSha.slice(0, 8)}.`,
    );
  }
}

export async function adoptAssignedPullRequests(github: FugueGitHub): Promise<number[]> {
  const policy = await resolveActivePolicy(github);
  const { owner, repo } = github.repository;
  const [issues, pulls] = await Promise.all([
    github.octokit.paginate(github.octokit.rest.issues.listForRepo, { owner, repo, state: "open", per_page: 100 }),
    github.octokit.paginate(github.octokit.rest.pulls.list, { owner, repo, state: "open", per_page: 100 }),
  ]);

  const adopted: number[] = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    let metadata;
    try {
      metadata = parseWorkMetadata(issue.body ?? "");
    } catch {
      continue;
    }
    if (!metadata?.execution.worker_id || !metadata.execution.branch) continue;

    const matches = pulls.filter((pull) =>
      pull.head.ref === metadata.execution.branch && pull.base.ref === policy.identity.baseBranch,
    );
    if (matches.length > 1) {
      throw new Error(`Multiple open PRs use assigned branch ${metadata.execution.branch}.`);
    }
    const pull = matches[0];
    if (!pull) continue;

    const expected = {
      version: 1 as const,
      work_id: metadata.work_id,
      issue: issue.number,
      worker_id: metadata.execution.worker_id,
      branch: metadata.execution.branch,
    };

    let existing = null;
    try {
      existing = parsePrMetadata(pull.body);
    } catch {
      // Assigned-branch ownership lets protected Fugue repair malformed metadata below.
    }
    if (existing && samePrMetadata(existing, expected)) continue;

    let body = pull.body ?? "";
    if (!new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue.number}\\b`, "i").test(body)) {
      body = `${body.trimEnd()}\n\nCloses #${issue.number}\n`;
    }
    body = canonicalizePrMetadata(body, expected);
    await github.octokit.rest.pulls.update({ owner, repo, pull_number: pull.number, body });
    adopted.push(pull.number);
  }

  return adopted;
}

async function markPrReady(github: FugueGitHub, prNumber: number): Promise<void> {
  const { owner, repo } = github.repository;
  const pr = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (!pr.data.draft) return;
  await github.octokit.graphql(
    `mutation MarkReady($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest { isDraft }
      }
    }`,
    { pullRequestId: pr.data.node_id },
  );
}

async function updatePrBranch(github: FugueGitHub, work: WorkState): Promise<void> {
  const { owner, repo } = github.repository;
  const prNumber = requirePr(work);
  const headSha = work.pr?.headSha;
  if (!headSha) throw new Error(`Work #${work.issueNumber} has no PR head to update.`);
  await github.octokit.rest.pulls.updateBranch({
    owner,
    repo,
    pull_number: prNumber,
    expected_head_sha: headSha,
  });
}

export async function dispatchIntegration(
  github: FugueGitHub,
  policy: ActivePolicy,
  work: WorkState,
  now = Date.now(),
): Promise<void> {
  const { owner, repo } = github.repository;
  const prNumber = requirePr(work);
  const headSha = work.pr?.headSha;
  if (!headSha) throw new Error(`Work #${work.issueNumber} has no PR head.`);

  const request = createIntegrationRequest({
    prNumber,
    headSha,
    baseBranch: policy.identity.baseBranch,
    baseSha: policy.identity.baseSha,
    policyDigest: policy.identity.policyDigest,
    protocolVersion: policy.identity.protocolVersion,
    issueNumber: work.issueNumber,
    workId: work.metadata.work_id,
    workSpecDigest: work.workSpecDigest,
  });

  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  let existing: IntegrationRequest | undefined;
  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const candidate = parseIntegrationRequest(comment.body ?? "");
      if (candidate?.request_id === request.request_id) {
        existing = candidate;
        break;
      }
    } catch {
      // Malformed historical requests are inert.
    }
  }

  let created = false;
  if (!existing) {
    await createProtocolComment(
      github,
      prNumber,
      `INTEGRATION — REQUESTED\n\nHead: \`${headSha}\`\nRequest: \`${request.request_id}\`\n\n${serializeIntegrationRequest(request)}`,
    );
    existing = request;
    created = true;
  }

  const run = await findIntegrationWorkflowRun(github, existing);
  if (run) return;

  if (!created) {
    const createdAt = Date.parse(existing.created_at);
    if (Number.isFinite(createdAt) && now - createdAt < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
      return;
    }
  }

  await github.octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: "fugue-integration.yml",
    ref: policy.identity.baseBranch,
    inputs: {
      pr: prNumber,
      request_id: existing.request_id,
    },
  });
}

async function readBranchSha(github: FugueGitHub, branch: string): Promise<string | null> {
  const { owner, repo } = github.repository;
  try {
    const ref = await github.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
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
