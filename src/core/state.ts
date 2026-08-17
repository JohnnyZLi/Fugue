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
  type GitHubCommentLike,
} from "./provenance.js";

const WORK_STATE_START = "<!-- fugue-work-state";
const END = "-->";

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
  created_at: z.string().min(1),
});

export type CanonicalWorkState = z.infer<typeof canonicalWorkStateSchema>;
export type CanonicalPrState = z.infer<typeof canonicalPrSchema>;

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

interface CanonicalComment extends GitHubCommentLike {
  id?: number;
  body?: string | null;
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

export async function publishCanonicalWorkState(
  github: FugueGitHub,
  state: CanonicalWorkState,
): Promise<boolean> {
  const parsed = canonicalWorkStateSchema.parse(state);
  assertWorkMetadataForIssue(parsed.metadata, parsed.issue);
  const current = await loadCurrentCanonicalWorkState(github, parsed.issue);
  if (current && sameCanonicalWorkState(current, parsed)) return false;
  await createProtocolComment(
    github,
    parsed.issue,
    `${serializeCanonicalWorkState(parsed)}\n\nFUGUE WORK STATE — CANONICAL\n\nWork: \`${parsed.metadata.work_id}\`\nIssue: #${parsed.issue}`,
  );
  return true;
}

export async function loadCurrentCanonicalWorkState(
  github: FugueGitHub,
  issueNumber: number,
): Promise<CanonicalWorkState | undefined> {
  return loadCanonicalWorkState(github, issueNumber, isTrustedProtocolComment);
}

/**
 * Load the latest work-state object from an originally trusted first-attempt protected workflow
 * revision. This is used only by current protected code to roll durable work truth forward after
 * the default branch advances; normal state/evaluation readers consume the current re-publication.
 */
export async function loadReusableCanonicalWorkState(
  github: FugueGitHub,
  issueNumber: number,
): Promise<CanonicalWorkState | undefined> {
  return loadCanonicalWorkState(github, issueNumber, isReusableProtocolComment);
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
    if (await loadCurrentCanonicalWorkState(github, issue.number)) continue;
    const previous = await loadReusableCanonicalWorkState(github, issue.number);
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

async function loadCanonicalWorkState(
  github: FugueGitHub,
  issueNumber: number,
  verifyComment: (github: FugueGitHub, comment: GitHubCommentLike) => Promise<boolean>,
): Promise<CanonicalWorkState | undefined> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const states: CanonicalWorkState[] = [];
  for (const comment of comments as CanonicalComment[]) {
    if (!(await verifyComment(github, comment))) continue;
    try {
      const parsed = parseCanonicalWorkState(comment.body ?? "");
      if (parsed?.issue === issueNumber) states.push(parsed);
    } catch {
      // Invalid canonical-looking historical text is inert.
    }
  }
  return states
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .at(-1);
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
    const canonical = await loadCurrentCanonicalWorkState(github, issue.number);
    if (!canonical) continue;
    if (canonical.base_sha.toLowerCase() !== policy.identity.baseSha.toLowerCase()) {
      repositoryDrift.push(`Issue #${issue.number}: canonical work state is not bound to current protected base`);
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
            // A merged canonical PR is terminal Human state; it is no longer active work.
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
        const canonicalDependency = await loadCurrentCanonicalWorkState(github, dependency);
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
