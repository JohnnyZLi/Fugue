import { createHash, createHmac, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
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
  assertRepositoryDefaultBranchRevision,
  createProtocolComment,
  isTrustedProtocolComment,
  readRepositoryDefaultBranchIdentity,
  verifyProtocolPublicationBodyAtRevision,
} from "./provenance.js";

const WORK_STATE_START = "<!-- fugue-work-state";
const END = "-->";
const WORK_STATE_BUNDLE_PREFIX = "fugue/ws2/";
const BUNDLE_KEY_BYTES = 16;
const BUNDLE_CHUNK_SIZE = 120;
const BUNDLE_MAX_CHUNKS = 999;
const BUNDLE_WRITE_ATTEMPTS = 4;
const BUNDLE_MANIFEST_PATTERN = /^n=(\d+);d=([0-9a-f]{64})$/;

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

interface WorkStateBundleRecord {
  context: string;
  description: string;
}

interface LoadedBundle {
  state: CanonicalWorkState;
  body: string;
  manifestId: number;
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

function exactCanonicalWorkState(left: CanonicalWorkState, right: CanonicalWorkState): boolean {
  return sameCanonicalWorkState(left, right) && left.created_at === right.created_at;
}

/**
 * Data contexts are secret-derived and written before the manifest reveals the bundle key. A
 * candidate can append to a revealed context later, but the earliest server-assigned status in
 * that exact unpredictable context is already the protected writer's immutable chunk.
 */
export function workStateDataContext(issueNumber: number, bundleKey: string, index: number): string {
  const digest = createHmac("sha256", Buffer.from(bundleKey, "hex"))
    .update(String(index), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${WORK_STATE_BUNDLE_PREFIX}${issueNumber}/d/${digest}`;
}

export function workStateManifestContext(issueNumber: number, bundleKey: string): string {
  return `${WORK_STATE_BUNDLE_PREFIX}${issueNumber}/m/${bundleKey}`;
}

export function encodeWorkStateBundle(
  issueNumber: number,
  bundleKey: string,
  signedBody: string,
): { data: WorkStateBundleRecord[]; manifest: WorkStateBundleRecord } {
  if (!/^[0-9a-f]{32}$/i.test(bundleKey)) throw new Error("Invalid work-state bundle key.");
  const encoded = gzipSync(Buffer.from(signedBody, "utf8")).toString("base64url");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += BUNDLE_CHUNK_SIZE) {
    chunks.push(encoded.slice(offset, offset + BUNDLE_CHUNK_SIZE));
  }
  if (!chunks.length || chunks.length > BUNDLE_MAX_CHUNKS) {
    throw new Error(`Canonical work-state bundle requires unsupported chunk count ${chunks.length}.`);
  }
  const digest = createHash("sha256").update(encoded, "utf8").digest("hex");
  return {
    data: chunks.map((chunk, index) => ({
      context: workStateDataContext(issueNumber, bundleKey, index),
      description: chunk,
    })),
    manifest: {
      context: workStateManifestContext(issueNumber, bundleKey),
      description: `n=${chunks.length};d=${digest}`,
    },
  };
}

/**
 * Canonical state authority is a cryptographically signed status bundle, not an ordinary issue
 * comment and not a fixed append-only status head. Invalid/forged bundles are inert; each genuine
 * publication uses fresh unpredictable contexts, so poisoning or exhausting an old context cannot
 * wedge the protected writer. The comment is only a regenerable Human-facing mirror.
 */
export async function publishCanonicalWorkState(
  github: FugueGitHub,
  state: CanonicalWorkState,
): Promise<boolean> {
  let parsed = canonicalWorkStateSchema.parse(state);
  assertWorkMetadataForIssue(parsed.metadata, parsed.issue);
  const current = await loadCanonicalWorkStateAtBase(github, parsed.issue, parsed.base_sha);
  if (current && sameCanonicalWorkState(current, parsed)) {
    await ensureCanonicalWorkStateComment(github, current);
    return false;
  }

  await assertRepositoryDefaultBranchRevision(github, parsed.base_sha);
  const minimumCreated = current ? Date.parse(current.created_at) + 1 : 0;
  const requestedCreated = Date.parse(parsed.created_at);
  const createdMs = Math.max(Date.now(), minimumCreated, Number.isFinite(requestedCreated) ? requestedCreated : 0);
  parsed = canonicalWorkStateSchema.parse({ ...parsed, created_at: new Date(createdMs).toISOString() });

  const unsignedBody = renderCanonicalWorkStateComment(parsed);
  const comment = await createProtocolComment(github, parsed.issue, unsignedBody);
  const proofValid = await verifyProtocolPublicationBodyAtRevision(
    github,
    comment.data.body,
    parsed.base_sha,
    Date.parse(parsed.created_at),
  );
  if (!proofValid) {
    throw new CanonicalWorkStateIntegrityError(
      `Issue #${parsed.issue} protected publisher proof does not match base ${parsed.base_sha.slice(0, 8)}; refusing authority commit.`,
    );
  }

  await assertRepositoryDefaultBranchRevision(github, parsed.base_sha);
  await writeWorkStateBundle(github, parsed, comment.data.body, comment.data.html_url);
  return true;
}

export async function loadCurrentCanonicalWorkState(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
): Promise<CanonicalWorkState | undefined> {
  return loadCanonicalWorkStateAtBase(github, issueNumber, baseSha);
}

/** Locate the nearest historical base containing a valid exact-base signed work-state bundle. */
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
    const state = await loadCanonicalWorkStateAtBase(github, issueNumber, sha);
    if (state) return state;
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
    const current = await loadCanonicalWorkStateAtBase(github, issue.number, policy.identity.baseSha);
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

/** Recreate deleted/tampered canonical-state comments from status-bundle authority. */
export async function repairCanonicalWorkStateComments(
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
  const repaired: number[] = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const state = await loadCanonicalWorkStateAtBase(github, issue.number, policy.identity.baseSha);
    if (!state) continue;
    if (await ensureCanonicalWorkStateComment(github, state)) repaired.push(issue.number);
  }
  return repaired;
}

async function ensureCanonicalWorkStateComment(
  github: FugueGitHub,
  state: CanonicalWorkState,
): Promise<boolean> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: state.issue,
    per_page: 100,
  });
  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const parsed = parseCanonicalWorkState(comment.body ?? "");
      if (parsed && exactCanonicalWorkState(parsed, state)) return false;
    } catch {
      // A damaged mirror is presentation only; a fresh protected mirror is created below.
    }
  }
  await createProtocolComment(github, state.issue, renderCanonicalWorkStateComment(state));
  return true;
}

function renderCanonicalWorkStateComment(state: CanonicalWorkState): string {
  return `${serializeCanonicalWorkState(state)}\n\nFUGUE WORK STATE — CANONICAL\n\nWork: \`${state.metadata.work_id}\`\nIssue: #${state.issue}`;
}

async function writeWorkStateBundle(
  github: FugueGitHub,
  state: CanonicalWorkState,
  signedBody: string,
  targetUrl: string,
): Promise<void> {
  const { owner, repo } = github.repository;
  let lastValidationError: unknown;
  for (let attempt = 0; attempt < BUNDLE_WRITE_ATTEMPTS; attempt += 1) {
    const key = randomBytes(BUNDLE_KEY_BYTES).toString("hex");
    const bundle = encodeWorkStateBundle(state.issue, key, signedBody);
    try {
      for (const record of bundle.data) {
        await github.octokit.rest.repos.createCommitStatus({
          owner,
          repo,
          sha: state.base_sha,
          state: "success",
          context: record.context,
          description: record.description,
          target_url: targetUrl,
        });
      }
      // The manifest is the only discoverable commit point. If the base advanced or this stale
      // workflow cannot prove the exact base, all prior chunks stay inert and a fresh run recovers.
      await assertRepositoryDefaultBranchRevision(github, state.base_sha);
      const proofStillValid = await verifyProtocolPublicationBodyAtRevision(
        github,
        signedBody,
        state.base_sha,
        Date.parse(state.created_at),
      );
      if (!proofStillValid) {
        throw new CanonicalWorkStateIntegrityError(
          `Issue #${state.issue} publisher identity changed before canonical bundle commit.`,
        );
      }
      await github.octokit.rest.repos.createCommitStatus({
        owner,
        repo,
        sha: state.base_sha,
        state: "success",
        context: bundle.manifest.context,
        description: bundle.manifest.description,
        target_url: targetUrl,
      });
      return;
    } catch (error) {
      if (httpStatus(error) !== 422) throw error;
      lastValidationError = error;
      // A partial random-key bundle has no manifest or remains independently verifiable; retrying
      // under a fresh secret key is safe and avoids any exhausted/poisoned context.
      await assertRepositoryDefaultBranchRevision(github, state.base_sha);
    }
  }
  throw new Error(`Unable to allocate a fresh canonical work-state status bundle: ${message(lastValidationError)}`);
}

async function loadCanonicalWorkStateAtBase(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
): Promise<CanonicalWorkState | undefined> {
  const statuses = await listStatuses(github, baseSha);
  const identity = await readRepositoryDefaultBranchIdentity(github);
  const loaded: LoadedBundle[] = [];
  const manifestPattern = new RegExp(`^${escapeRegex(WORK_STATE_BUNDLE_PREFIX)}${issueNumber}/m/([0-9a-f]{32})$`, "i");
  const byContext = new Map<string, CommitStatusRecord[]>();
  for (const status of statuses) {
    const list = byContext.get(status.context) ?? [];
    list.push(status);
    byContext.set(status.context, list);
  }
  for (const list of byContext.values()) list.sort((a, b) => a.id - b.id);

  for (const status of statuses) {
    const keyMatch = status.context.match(manifestPattern);
    const key = keyMatch?.[1]?.toLowerCase();
    if (!key) continue;
    const earliestManifest = byContext.get(status.context)?.[0];
    if (!earliestManifest || earliestManifest.id !== status.id) continue;
    const manifest = status.description?.match(BUNDLE_MANIFEST_PATTERN);
    if (!manifest?.[1] || !manifest[2]) continue;
    const count = Number(manifest[1]);
    if (!Number.isInteger(count) || count <= 0 || count > BUNDLE_MAX_CHUNKS) continue;

    const chunks: string[] = [];
    let complete = true;
    for (let index = 0; index < count; index += 1) {
      const context = workStateDataContext(issueNumber, key, index);
      const first = byContext.get(context)?.[0];
      const chunk = first?.description ?? "";
      if (!chunk || !/^[A-Za-z0-9_-]+$/.test(chunk)) {
        complete = false;
        break;
      }
      chunks.push(chunk);
    }
    if (!complete) continue;

    const encoded = chunks.join("");
    if (createHash("sha256").update(encoded, "utf8").digest("hex") !== manifest[2]) continue;
    let body: string;
    try {
      body = gunzipSync(Buffer.from(encoded, "base64url")).toString("utf8");
    } catch {
      continue;
    }
    let parsed: CanonicalWorkState | null;
    try {
      parsed = parseCanonicalWorkState(body);
    } catch {
      continue;
    }
    if (!parsed || parsed.issue !== issueNumber) continue;
    if (parsed.base_sha.toLowerCase() !== baseSha.toLowerCase()) continue;
    const timestamp = Date.parse(parsed.created_at);
    if (!Number.isFinite(timestamp)) continue;
    let trusted = false;
    try {
      trusted = await verifyProtocolPublicationBodyAtRevision(
        github,
        body,
        baseSha,
        timestamp,
        identity.branch,
      );
    } catch {
      trusted = false;
    }
    if (!trusted) continue;
    loaded.push({ state: parsed, body, manifestId: status.id });
  }

  return loaded
    .sort((a, b) => {
      const time = Date.parse(a.state.created_at) - Date.parse(b.state.created_at);
      if (time !== 0) return time;
      const digest = createHash("sha256").update(a.body).digest("hex")
        .localeCompare(createHash("sha256").update(b.body).digest("hex"));
      if (digest !== 0) return digest;
      return a.manifestId - b.manifestId;
    })
    .at(-1)?.state;
}

async function listStatuses(github: FugueGitHub, sha: string): Promise<CommitStatusRecord[]> {
  const { owner, repo } = github.repository;
  const statuses = await github.octokit.paginate(github.octokit.rest.repos.listCommitStatusesForRef, {
    owner,
    repo,
    ref: sha,
    per_page: 100,
  });
  return statuses.map((status) => ({
    id: status.id,
    context: status.context,
    description: status.description,
  }));
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
        repositoryDrift.push(`Issue #${issue.number}: presentation state exists without a current protected canonical work-state bundle`);
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
          if (detail.data.merged) continue;
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
    works.map((work) => ({ issueNumber: work.issueNumber, dependencies: work.metadata.spec.dependencies })),
  );

  const activeManagedIssues = new Set(works.map((work) => work.issueNumber));
  const dependencyCache = new Map<number, string | null>();

  for (const work of works) {
    for (const dependency of work.metadata.spec.dependencies) {
      if (activeManagedIssues.has(dependency)) continue;
      let problem = dependencyCache.get(dependency);
      if (problem === undefined) {
        const canonicalDependency = await loadCurrentCanonicalWorkState(github, dependency, policy.identity.baseSha);
        if (!canonicalDependency) {
          problem = "has no current protected canonical Fugue work state";
        } else if (!canonicalDependency.pr) {
          problem = "has no protected canonical PR linkage";
        } else {
          try {
            const pull = await github.octokit.rest.pulls.get({ owner, repo, pull_number: canonicalDependency.pr.number });
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

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
