import { createHash } from "node:crypto";
import { z } from "zod";
import type { FugueGitHub } from "./github.js";
import { assertAcyclicDependencies } from "./dependencies.js";
import {
  assertWorkMetadataForIssue,
  parseWorkMetadata,
  stripWorkMetadata,
  workMetadataSchema,
  workSpecDigestFromRequirements,
  type WorkMetadata,
} from "./metadata.js";
import { parsePrMetadata, prMetadataSchema, samePrMetadata, type PrMetadata } from "./pr-metadata.js";
import { resolveActivePolicy, type ActivePolicy } from "./policy.js";
import {
  createProtocolComment,
  isReusableProtocolComment,
  isTrustedProtocolComment,
} from "./provenance.js";

const WORK_STATE_START = "<!-- fugue-work-state";
const END = "-->";
const WORK_STATE_HEAD_CONTEXT_PREFIX = "fugue/work-state/";
const WORK_STATE_STAGE_CONTEXT_PREFIX = "fugue/work-state-stage/";
const CHECKPOINT_PATTERN = /^stage=(\d+);comment=(\d+);digest=([0-9a-f]{64})$/;

const stateLabelSchema = z.enum(["state:ready", "state:working", "state:blocked"]);
const canonicalPrSchema = z.object({
  number: z.number().int().positive(),
  metadata: prMetadataSchema,
  draft: z.boolean(),
});

export const canonicalWorkStateSchema = z.object({
  version: z.literal(1),
  kind: z.literal("work_state"),
  issue: z.number().int().positive(),
  title: z.string().min(1),
  state: stateLabelSchema,
  agent_ready: z.boolean(),
  requirements_b64: z.string(),
  metadata: workMetadataSchema,
  pr: canonicalPrSchema.nullable(),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  checkpoint_id: z.number().int().positive().optional(),
  created_at: z.string().min(1),
});

export type CanonicalWorkState = z.infer<typeof canonicalWorkStateSchema>;
export type CanonicalPrState = z.infer<typeof canonicalPrSchema>;

export class CanonicalWorkStateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalWorkStateIntegrityError";
  }
}

export interface WorkPrState {
  number: number;
  url: string;
  headSha: string;
  headBranch: string;
  draft: boolean;
  metadata: PrMetadata;
}

export interface WorkState {
  issueNumber: number;
  title: string;
  url: string;
  stateLabel: "state:ready" | "state:working" | "state:blocked";
  agentReady: boolean;
  metadata: WorkMetadata;
  requirements: string;
  workSpecDigest: string;
  pr: WorkPrState | null;
  drift: string[];
  presentationDrift: string[];
  canonical: CanonicalWorkState;
}

export interface RepositoryState {
  policy: ActivePolicy;
  works: WorkState[];
  drift: string[];
}

interface CommitStatusRecord {
  id: number;
  context: string;
  description?: string | null;
}

interface CheckpointPointer {
  stageId: number;
  commentId: number;
  digest: string;
}

export function workStateHeadContext(issueNumber: number): string {
  return `${WORK_STATE_HEAD_CONTEXT_PREFIX}${issueNumber}`;
}

export function workStateStageContext(issueNumber: number): string {
  return `${WORK_STATE_STAGE_CONTEXT_PREFIX}${issueNumber}`;
}

export function createCanonicalWorkState(input: {
  issue: number;
  title: string;
  state: WorkState["stateLabel"];
  agentReady: boolean;
  requirements: string;
  metadata: WorkMetadata;
  pr?: CanonicalPrState | null;
  baseSha: string;
  checkpointId?: number;
  createdAt?: string;
}): CanonicalWorkState {
  assertWorkMetadataForIssue(input.metadata, input.issue);
  return canonicalWorkStateSchema.parse({
    version: 1,
    kind: "work_state",
    issue: input.issue,
    title: input.title,
    state: input.state,
    agent_ready: input.agentReady,
    requirements_b64: Buffer.from(input.requirements, "utf8").toString("base64url"),
    metadata: input.metadata,
    pr: input.pr ?? null,
    base_sha: input.baseSha,
    ...(input.checkpointId ? { checkpoint_id: input.checkpointId } : {}),
    created_at: input.createdAt ?? new Date().toISOString(),
  });
}

export function canonicalRequirements(state: CanonicalWorkState): string {
  try {
    return Buffer.from(state.requirements_b64, "base64url").toString("utf8");
  } catch {
    throw new Error(`Canonical work state for Issue #${state.issue} has invalid requirements encoding.`);
  }
}

export function serializeCanonicalWorkState(state: CanonicalWorkState): string {
  const parsed = canonicalWorkStateSchema.parse(state);
  const payload = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
  return `${WORK_STATE_START}\nversion: 1\npayload: ${payload}\n${END}`;
}

export function parseCanonicalWorkState(body: string): CanonicalWorkState | null {
  const start = body.indexOf(WORK_STATE_START);
  if (start < 0) return null;
  const end = body.indexOf(END, start + WORK_STATE_START.length);
  if (end < 0) throw new Error("Unterminated fugue-work-state block.");
  const block = body.slice(start + WORK_STATE_START.length, end).trim();
  const match = block.match(/^version: 1\npayload: ([A-Za-z0-9_-]+)$/);
  if (!match?.[1]) throw new Error("Malformed fugue-work-state block.");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid fugue-work-state payload.");
  }
  const parsed = canonicalWorkStateSchema.parse(raw);
  assertWorkMetadataForIssue(parsed.metadata, parsed.issue);
  canonicalRequirements(parsed);
  return parsed;
}

export function sameCanonicalWorkState(left: CanonicalWorkState, right: CanonicalWorkState): boolean {
  return left.issue === right.issue &&
    left.base_sha.toLowerCase() === right.base_sha.toLowerCase() &&
    left.title === right.title &&
    left.state === right.state &&
    left.agent_ready === right.agent_ready &&
    left.requirements_b64 === right.requirements_b64 &&
    JSON.stringify(left.metadata) === JSON.stringify(right.metadata) &&
    JSON.stringify(left.pr) === JSON.stringify(right.pr);
}

/**
 * Publish a canonical work-state transaction. The staging and head commit statuses are append-only
 * server-assigned checkpoints on the protected base. The signed comment embeds the staging ID;
 * the head status commits that exact comment ID and digest. Readers always validate the newest
 * head and never fall back, so deletion/tampering or forged later pointers fail closed instead of
 * rolling authority backward.
 */
export async function publishCanonicalWorkState(
  github: FugueGitHub,
  state: CanonicalWorkState,
): Promise<boolean> {
  const parsed = canonicalWorkStateSchema.parse(state);
  assertWorkMetadataForIssue(parsed.metadata, parsed.issue);
  const current = await loadCanonicalWorkStateAtBase(github, parsed.issue, parsed.base_sha, "current");
  if (current && sameCanonicalWorkState(current, parsed)) return false;

  const { owner, repo } = github.repository;
  const stage = await github.octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: parsed.base_sha,
    state: "success",
    context: workStateStageContext(parsed.issue),
    description: `Fugue work-state staging generation for Issue #${parsed.issue}`,
  });
  const stageId = stage.data.id;
  const staged = canonicalWorkStateSchema.parse({ ...parsed, checkpoint_id: stageId });
  const comment = await createProtocolComment(
    github,
    staged.issue,
    `${serializeCanonicalWorkState(staged)}\n\nFUGUE WORK STATE — CANONICAL\n\nWork: \`${staged.metadata.work_id}\`\nIssue: #${staged.issue}`,
  );
  const digest = createHash("sha256").update(comment.data.body, "utf8").digest("hex");
  await github.octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: staged.base_sha,
    state: "success",
    context: workStateHeadContext(staged.issue),
    description: checkpointDescription(stageId, comment.data.id, digest),
    target_url: comment.data.html_url,
  });
  return true;
}

export async function loadCurrentCanonicalWorkState(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
): Promise<CanonicalWorkState | undefined> {
  return loadCanonicalWorkStateAtBase(github, issueNumber, baseSha, "current");
}

/**
 * Locate the nearest historical canonical checkpoint on the protected branch and verify that its
 * signed publisher proof was minted by that exact historical base SHA. Newer invalid checkpoints
 * are fatal; rollover never skips backward to older evidence.
 */
export async function loadReusableCanonicalWorkState(
  github: FugueGitHub,
  issueNumber: number,
  currentBaseSha: string,
  baseBranch: string,
): Promise<CanonicalWorkState | undefined> {
  const { owner, repo } = github.repository;
  const commits = await github.octokit.paginate(github.octokit.rest.repos.listCommits, {
    owner,
    repo,
    sha: baseBranch,
    per_page: 100,
  });
  for (const commit of commits) {
    const sha = commit.sha;
    if (sha.toLowerCase() === currentBaseSha.toLowerCase()) continue;
    const hasHead = (await listStatuses(github, sha, workStateHeadContext(issueNumber))).length > 0;
    if (!hasHead) continue;
    return loadCanonicalWorkStateAtBase(github, issueNumber, sha, "reusable");
  }
  return undefined;
}

export async function rollCanonicalWorkStatesToCurrentBase(
  github: FugueGitHub,
  policy: ActivePolicy,
): Promise<number[]> {
  const { owner, repo } = github.repository;
  const issues = await github.octokit.paginate(github.octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  });
  const rolled: number[] = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const current = await loadCanonicalWorkStateAtBase(
      github,
      issue.number,
      policy.identity.baseSha,
      "current",
    );
    if (current) continue;
    const previous = await loadReusableCanonicalWorkState(
      github,
      issue.number,
      policy.identity.baseSha,
      policy.identity.baseBranch,
    );
    if (!previous) continue;
    const next = createCanonicalWorkState({
      issue: previous.issue,
      title: previous.title,
      state: previous.state,
      agentReady: previous.agent_ready,
      requirements: canonicalRequirements(previous),
      metadata: previous.metadata,
      pr: previous.pr,
      baseSha: policy.identity.baseSha,
    });
    if (await publishCanonicalWorkState(github, next)) rolled.push(issue.number);
  }
  return rolled;
}

async function loadCanonicalWorkStateAtBase(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
  mode: "current" | "reusable",
): Promise<CanonicalWorkState | undefined> {
  const heads = await listStatuses(github, baseSha, workStateHeadContext(issueNumber));
  const head = heads[0];
  if (!head) return undefined;
  const pointer = parseCheckpointPointer(head.description, issueNumber, baseSha);

  const stages = (await listStatuses(github, baseSha, workStateStageContext(issueNumber)))
    .filter((status) => status.id < head.id);
  const latestStage = stages[0];
  if (!latestStage || latestStage.id !== pointer.stageId) {
    throw new CanonicalWorkStateIntegrityError(
      `Issue #${issueNumber} canonical work-state head at ${baseSha.slice(0, 8)} does not commit the latest staging generation before it.`,
    );
  }

  const { owner, repo } = github.repository;
  let comment;
  try {
    comment = await github.octokit.rest.issues.getComment({ owner, repo, comment_id: pointer.commentId });
  } catch (error) {
    if (isNotFound(error)) {
      throw new CanonicalWorkStateIntegrityError(
        `Issue #${issueNumber} canonical work-state checkpoint points to deleted comment ${pointer.commentId}; state is non-current.`,
      );
    }
    throw error;
  }
  const body = comment.data.body ?? "";
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  if (digest !== pointer.digest) {
    throw new CanonicalWorkStateIntegrityError(
      `Issue #${issueNumber} canonical work-state comment ${pointer.commentId} no longer matches its immutable checkpoint digest.`,
    );
  }

  const trusted = mode === "current"
    ? await isTrustedProtocolComment(github, comment.data)
    : await isReusableProtocolComment(github, comment.data, baseSha);
  if (!trusted) {
    throw new CanonicalWorkStateIntegrityError(
      `Issue #${issueNumber} canonical work-state checkpoint does not have publisher proof for protected base ${baseSha.slice(0, 8)}.`,
    );
  }

  let parsed: CanonicalWorkState | null;
  try {
    parsed = parseCanonicalWorkState(body);
  } catch (error) {
    throw new CanonicalWorkStateIntegrityError(
      `Issue #${issueNumber} canonical work-state checkpoint is malformed (${message(error)}).`,
    );
  }
  if (!parsed || parsed.issue !== issueNumber) {
    throw new CanonicalWorkStateIntegrityError(
      `Issue #${issueNumber} canonical checkpoint does not contain its work-state record.`,
    );
  }
  if (parsed.base_sha.toLowerCase() !== baseSha.toLowerCase()) {
    throw new CanonicalWorkStateIntegrityError(
      `Issue #${issueNumber} canonical work-state claims base ${parsed.base_sha.slice(0, 8)} but checkpoint is on ${baseSha.slice(0, 8)}.`,
    );
  }
  if (parsed.checkpoint_id !== pointer.stageId) {
    throw new CanonicalWorkStateIntegrityError(
      `Issue #${issueNumber} canonical work-state generation does not match its immutable checkpoint.`,
    );
  }
  return parsed;
}

async function listStatuses(
  github: FugueGitHub,
  sha: string,
  context: string,
): Promise<CommitStatusRecord[]> {
  const { owner, repo } = github.repository;
  const statuses = await github.octokit.paginate(github.octokit.rest.repos.listCommitStatusesForRef, {
    owner,
    repo,
    ref: sha,
    per_page: 100,
  });
  return statuses
    .filter((status) => status.context === context)
    .map((status) => ({ id: status.id, context: status.context, description: status.description }))
    .sort((a, b) => b.id - a.id);
}

function checkpointDescription(stageId: number, commentId: number, digest: string): string {
  return `stage=${stageId};comment=${commentId};digest=${digest}`;
}

function parseCheckpointPointer(
  description: string | null | undefined,
  issueNumber: number,
  baseSha: string,
): CheckpointPointer {
  const match = description?.match(CHECKPOINT_PATTERN);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new CanonicalWorkStateIntegrityError(
      `Issue #${issueNumber} latest canonical work-state head at ${baseSha.slice(0, 8)} is not a valid protected checkpoint.`,
    );
  }
  const stageId = Number(match[1]);
  const commentId = Number(match[2]);
  if (!Number.isSafeInteger(stageId) || stageId <= 0 || !Number.isSafeInteger(commentId) || commentId <= 0) {
    throw new CanonicalWorkStateIntegrityError(`Issue #${issueNumber} canonical work-state checkpoint IDs are invalid.`);
  }
  return { stageId, commentId, digest: match[3] };
}

export async function reconstructState(github: FugueGitHub): Promise<RepositoryState> {
  const policy = await resolveActivePolicy(github);
  const { owner, repo } = github.repository;

  const [issues, pulls] = await Promise.all([
    github.octokit.paginate(github.octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: "all",
      per_page: 100,
    }),
    github.octokit.paginate(github.octokit.rest.pulls.list, {
      owner,
      repo,
      state: "all",
      per_page: 100,
    }),
  ]);

  const pullsByNumber = new Map(pulls.map((pull) => [pull.number, pull] as const));
  const repositoryDrift: string[] = [];
  const works: WorkState[] = [];

  for (const issue of issues) {
    if (issue.pull_request) continue;
    const canonical = await loadCurrentCanonicalWorkState(github, issue.number, policy.identity.baseSha);
    if (!canonical) {
      const body = issue.body ?? "";
      const looksManaged = body.includes("<!-- fugue-work") || issue.labels.map(labelName).some((label) =>
        label === "state:ready" || label === "state:working" || label === "state:blocked" || label === "agent:ready"
      );
      if (looksManaged) {
        repositoryDrift.push(`Issue #${issue.number}: presentation state exists without a current protected canonical work-state checkpoint`);
      }
      continue;
    }

    const requirements = canonicalRequirements(canonical);
    const drift: string[] = [];
    const presentationDrift: string[] = [];
    const body = issue.body ?? "";
    let mirrorMetadata: WorkMetadata | null = null;
    try {
      mirrorMetadata = parseWorkMetadata(body);
    } catch (error) {
      presentationDrift.push(`issue fugue-work mirror is malformed (${message(error)})`);
    }
    if (!mirrorMetadata || JSON.stringify(mirrorMetadata) !== JSON.stringify(canonical.metadata)) {
      presentationDrift.push("issue fugue-work mirror differs from canonical state");
    }
    try {
      if (stripWorkMetadata(body) !== requirements) presentationDrift.push("issue requirements mirror differs from canonical state");
    } catch {
      presentationDrift.push("issue requirements mirror is malformed");
    }
    if (issue.title !== canonical.title) presentationDrift.push("issue title mirror differs from canonical state");

    const stateLabels = issue.labels
      .map(labelName)
      .filter((name): name is WorkState["stateLabel"] =>
        name === "state:ready" || name === "state:working" || name === "state:blocked",
      );
    if (stateLabels.length !== 1 || stateLabels[0] !== canonical.state) {
      presentationDrift.push("issue lifecycle label mirror differs from canonical state");
    }
    const agentReadyMirror = issue.labels.map(labelName).includes("agent:ready");
    if (agentReadyMirror !== canonical.agent_ready) presentationDrift.push("issue agent:ready mirror differs from canonical state");

    let pr: WorkPrState | null = null;
    if (canonical.pr) {
      const pull = pullsByNumber.get(canonical.pr.number);
      if (!pull) {
        drift.push(`canonical PR #${canonical.pr.number} is not visible`);
      } else {
        if (pull.state !== "open") {
          const detail = await github.octokit.rest.pulls.get({ owner, repo, pull_number: pull.number });
          if (detail.data.merged) {
            continue;
          }
          presentationDrift.push(`canonical PR #${pull.number} is closed`);
        }
        if (pull.base.ref !== policy.identity.baseBranch) presentationDrift.push(`PR #${pull.number} base differs from protected base`);
        if (pull.head.ref !== canonical.pr.metadata.branch) drift.push(`PR #${pull.number} head differs from canonical branch`);
        let mirrorPr: PrMetadata | null = null;
        try {
          mirrorPr = parsePrMetadata(pull.body);
        } catch (error) {
          presentationDrift.push(`PR #${pull.number} fugue-pr mirror is malformed (${message(error)})`);
        }
        if (!mirrorPr || !samePrMetadata(mirrorPr, canonical.pr.metadata)) {
          presentationDrift.push(`PR #${pull.number} fugue-pr mirror differs from canonical state`);
        }
        if ((pull.draft ?? false) !== canonical.pr.draft) {
          presentationDrift.push(`PR #${pull.number} draft mirror differs from canonical state`);
        }
        pr = {
          number: pull.number,
          url: pull.html_url,
          headSha: pull.head.sha,
          headBranch: pull.head.ref,
          draft: canonical.pr.draft,
          metadata: canonical.pr.metadata,
        };
      }
    }

    if (issue.state !== "open") presentationDrift.push("issue is closed while canonical work remains active");

    works.push({
      issueNumber: issue.number,
      title: canonical.title,
      url: issue.html_url,
      stateLabel: canonical.state,
      agentReady: canonical.agent_ready,
      metadata: canonical.metadata,
      requirements,
      workSpecDigest: workSpecDigestFromRequirements(requirements, canonical.metadata),
      pr,
      drift,
      presentationDrift,
      canonical,
    });
  }

  assertAcyclicDependencies(
    works.map((work) => ({
      issueNumber: work.issueNumber,
      dependencies: work.metadata.spec.dependencies,
    })),
  );

  const activeManagedIssues = new Set(works.map((work) => work.issueNumber));
  const dependencyCache = new Map<number, string | null>();

  for (const work of works) {
    for (const dependency of work.metadata.spec.dependencies) {
      if (activeManagedIssues.has(dependency)) continue;

      let problem = dependencyCache.get(dependency);
      if (problem === undefined) {
        const canonicalDependency = await loadCurrentCanonicalWorkState(
          github,
          dependency,
          policy.identity.baseSha,
        );
        if (!canonicalDependency) {
          problem = "has no current protected canonical Fugue work state";
        } else if (!canonicalDependency.pr) {
          problem = "has no protected canonical PR linkage";
        } else {
          try {
            const pull = await github.octokit.rest.pulls.get({
              owner,
              repo,
              pull_number: canonicalDependency.pr.number,
            });
            if (pull.data.head.ref !== canonicalDependency.pr.metadata.branch) {
              problem = `canonical PR #${canonicalDependency.pr.number} no longer matches its protected branch identity`;
            } else if (!pull.data.merged) {
              problem = `canonical PR #${canonicalDependency.pr.number} is not merged`;
            } else {
              problem = null;
            }
          } catch (error) {
            if (isNotFound(error)) problem = `canonical PR #${canonicalDependency.pr.number} does not exist`;
            else throw error;
          }
        }
        dependencyCache.set(dependency, problem);
      }

      if (problem) work.drift.push(`dependency #${dependency} ${problem}`);
    }
  }

  return { policy, works: works.sort((a, b) => a.issueNumber - b.issueNumber), drift: repositoryDrift };
}

function labelName(label: string | { name?: string | null }): string {
  return typeof label === "string" ? label : label.name ?? "";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status?: number }).status === 404;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
