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
  signProtocolBody,
  updateProtocolComment,
  verifyProtocolPublicationBodyAtRevision,
} from "./provenance.js";

const WORK_STATE_START = "<!-- fugue-work-state";
const COORDINATOR_START = "<!-- fugue-coordinator-snapshot";
const RECOVERY_START = "<!-- fugue-durable-recovery";
const END = "-->";
const WORK_RECEIPT = "Fugue-Authority-Receipt: work-d3";
const COORDINATOR_RECEIPT = "Fugue-Authority-Receipt: coordinator-d3";
const DURABLE_PREFIX = "fugue/d3/";
const AUTHORITY_KEY_PREFIX = "Fugue-Authority-Key: ";
const AUTHORITY_COMMIT_PREFIX = "Fugue-Authority-Commit: ";
const SECRET_BYTES = 16;
const SECRET_HEX_LENGTH = SECRET_BYTES * 2;
const REDACTED_SECRET = "0".repeat(SECRET_HEX_LENGTH);
const DURABLE_CHUNK_SIZE = 100;
const DURABLE_MAX_CHUNKS = 48;
const DURABLE_WRITE_ATTEMPTS = 4;
const STATUS_PAGE_SIZE = 100;
const MANIFESTS_PER_RECOVERY_SLICE = 2;
const MANIFEST_PATTERN = /^n=(\d+);d=([0-9a-f]{64});c=([0-9a-f]{32})$/i;

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

export const coordinatorSnapshotSchema = z.object({
  version: z.literal(1),
  kind: z.literal("coordinator_snapshot"),
  event_id: z.string().min(1),
  event_name: z.literal("issues"),
  action: z.string().min(1),
  actor: z.string().min(1),
  issue: z.number().int().positive(),
  label: z.string().optional(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  issue_updated_at: z.string().min(1),
  captured_at: z.string().min(1),
});

const recoveryCursorSchema = z.object({
  version: z.literal(1),
  kind: z.literal("durable_recovery"),
  scope: z.string().min(1),
  storage_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  publisher_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  page: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  anchor_id: z.number().int().positive().nullable(),
  best_body_b64: z.string().optional(),
});

export type CanonicalWorkState = z.infer<typeof canonicalWorkStateSchema>;
export type CanonicalPrState = z.infer<typeof canonicalPrSchema>;
export type CoordinatorSnapshot = z.infer<typeof coordinatorSnapshotSchema>;
type RecoveryCursor = z.infer<typeof recoveryCursorSchema>;

export class CanonicalWorkStateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalWorkStateIntegrityError";
  }
}

export class DurableProtocolRecoveryPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableProtocolRecoveryPendingError";
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

interface DurableBundleRecord {
  context: string;
  description: string;
}

export interface DurableRecord<T> {
  value: T;
  body: string;
}

export interface DurableRecoveryResult<T> {
  record?: DurableRecord<T>;
  exhausted: boolean;
}

export interface DurableRecordOptions<T> {
  storageSha: string;
  publisherSha: string;
  scope: string;
  issueNumber: number;
  parse: (body: string) => T | null;
  timestamp: (value: T) => number;
  compare?: (left: T, right: T) => number;
  validate?: (value: T) => boolean;
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
  return parsePayloadBlock(body, WORK_STATE_START, canonicalWorkStateSchema, (parsed) => {
    assertWorkMetadataForIssue(parsed.metadata, parsed.issue);
    canonicalRequirements(parsed);
  });
}

export function serializeCoordinatorSnapshot(snapshot: CoordinatorSnapshot): string {
  const parsed = coordinatorSnapshotSchema.parse(snapshot);
  const payload = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
  return `${COORDINATOR_START}\nversion: 1\npayload: ${payload}\n${END}`;
}

export function parseCoordinatorSnapshot(body: string): CoordinatorSnapshot | null {
  return parsePayloadBlock(body, COORDINATOR_START, coordinatorSnapshotSchema);
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

function durablePrefix(scope: string): string {
  if (!/^[A-Za-z0-9._/-]{1,56}$/.test(scope)) throw new Error(`Invalid durable Fugue scope ${scope}.`);
  return `${DURABLE_PREFIX}${scope}`;
}

export function durableDataContext(scope: string, bundleKey: string, index: number): string {
  const digest = createHmac("sha256", Buffer.from(bundleKey, "hex"))
    .update(String(index), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${durablePrefix(scope)}/d/${digest}`;
}

export function durableManifestContext(scope: string, bundleKey: string): string {
  return `${durablePrefix(scope)}/m/${bundleKey}`;
}

function authorityBody(unsignedBody: string, key: string, nonce: string): string {
  return `${unsignedBody}\n\n${AUTHORITY_KEY_PREFIX}${key}\n${AUTHORITY_COMMIT_PREFIX}${nonce}`;
}

function redactAuthorityBody(signedBody: string, key: string, nonce: string): string {
  const keyLine = `${AUTHORITY_KEY_PREFIX}${key}`;
  const commitLine = `${AUTHORITY_COMMIT_PREFIX}${nonce}`;
  if (!signedBody.includes(keyLine) || !signedBody.includes(commitLine)) {
    throw new Error("Signed durable body does not contain its authority capability.");
  }
  return signedBody
    .replace(keyLine, `${AUTHORITY_KEY_PREFIX}${REDACTED_SECRET}`)
    .replace(commitLine, `${AUTHORITY_COMMIT_PREFIX}${REDACTED_SECRET}`);
}

function restoreAuthorityBody(redactedBody: string, key: string, nonce: string): string | null {
  const keyLine = `${AUTHORITY_KEY_PREFIX}${REDACTED_SECRET}`;
  const commitLine = `${AUTHORITY_COMMIT_PREFIX}${REDACTED_SECRET}`;
  if (!redactedBody.includes(keyLine) || !redactedBody.includes(commitLine)) return null;
  return redactedBody
    .replace(keyLine, `${AUTHORITY_KEY_PREFIX}${key}`)
    .replace(commitLine, `${AUTHORITY_COMMIT_PREFIX}${nonce}`);
}

function encodeDurableBundle(scope: string, key: string, nonce: string, signedBody: string): {
  data: DurableBundleRecord[];
  manifest: DurableBundleRecord;
} {
  const redacted = redactAuthorityBody(signedBody, key, nonce);
  const encoded = gzipSync(Buffer.from(redacted, "utf8")).toString("base64url");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += DURABLE_CHUNK_SIZE) {
    chunks.push(encoded.slice(offset, offset + DURABLE_CHUNK_SIZE));
  }
  if (!chunks.length || chunks.length > DURABLE_MAX_CHUNKS) {
    throw new Error(`Durable Fugue record requires unsupported chunk count ${chunks.length}.`);
  }
  const digest = createHash("sha256").update(encoded, "utf8").digest("hex");
  return {
    data: chunks.map((chunk, index) => ({
      context: durableDataContext(scope, key, index),
      description: chunk,
    })),
    manifest: {
      context: durableManifestContext(scope, key),
      description: `n=${chunks.length};d=${digest};c=${nonce}`,
    },
  };
}

/**
 * Publish a durable protocol body so statuses:write is transport only, never authority. Both the
 * random bundle key and a 128-bit commit nonce are covered by the protected OIDC signature but are
 * redacted from every pre-commit status chunk. The final manifest reveals them atomically. A
 * candidate can neither finish an aborted prospective publication nor repackage a committed body
 * under a fresh key because the protected signature binds the exact key used by the manifest.
 */
export async function publishDurableProtocolRecord(
  github: FugueGitHub,
  input: {
    storageSha: string;
    publisherSha: string;
    scope: string;
    unsignedBody: string;
    publicationTimestamp: number;
  },
): Promise<string> {
  const { owner, repo } = github.repository;
  let lastError: unknown;
  for (let attempt = 0; attempt < DURABLE_WRITE_ATTEMPTS; attempt += 1) {
    const key = randomBytes(SECRET_BYTES).toString("hex");
    const nonce = randomBytes(SECRET_BYTES).toString("hex");
    try {
      await assertRepositoryDefaultBranchRevision(github, input.publisherSha);
      const signedBody = await signProtocolBody(github, authorityBody(input.unsignedBody, key, nonce));
      if (!(await verifyProtocolPublicationBodyAtRevision(
        github,
        signedBody,
        input.publisherSha,
        input.publicationTimestamp,
      ))) {
        throw new Error("Protected publisher proof does not match the exact durable-record revision.");
      }
      const bundle = encodeDurableBundle(input.scope, key, nonce, signedBody);
      const writtenIds: number[] = [];
      for (const record of bundle.data) {
        const response = await github.octokit.rest.repos.createCommitStatus({
          owner,
          repo,
          sha: input.storageSha,
          state: "success",
          context: record.context,
          description: record.description,
        });
        writtenIds.push(response.data.id);
      }

      await assertRepositoryDefaultBranchRevision(github, input.publisherSha);
      if (!(await verifyProtocolPublicationBodyAtRevision(
        github,
        signedBody,
        input.publisherSha,
        input.publicationTimestamp,
      ))) {
        throw new Error("Protected publisher identity changed before durable authority commit.");
      }

      // A committed bundle is guaranteed to fit inside two adjacent 100-status recovery pages.
      // If hostile interleaving pushed any protected chunk out of the newest page before commit,
      // abandon the redacted partial bundle and retry under fresh unrevealed secrets.
      const newest = await statusPage(github, input.storageSha, 1);
      const newestIds = new Set(newest.map((status) => status.id));
      if (!writtenIds.every((id) => newestIds.has(id))) {
        lastError = new Error("Durable-record chunks were interleaved out of the bounded commit window.");
        continue;
      }

      await assertRepositoryDefaultBranchRevision(github, input.publisherSha);
      await github.octokit.rest.repos.createCommitStatus({
        owner,
        repo,
        sha: input.storageSha,
        state: "success",
        context: bundle.manifest.context,
        description: bundle.manifest.description,
      });
      return signedBody;
    } catch (error) {
      if (httpStatus(error) !== 422) throw error;
      lastError = error;
      await assertRepositoryDefaultBranchRevision(github, input.publisherSha);
    }
  }
  throw new Error(`Unable to commit a fresh durable Fugue record: ${message(lastError)}`);
}

/**
 * Recover one bounded slice of a durable scope. Fake manifests never trigger per-chunk API calls:
 * one primary and one adjacent status page are loaded, then at most two manifests and 48 in-memory
 * chunks are considered. A protected signed cursor advances across scheduled runs; if the status
 * anchor changes, recovery restarts from the newest page so a stable finite hostile history is
 * eventually exhausted without rollback.
 */
export async function recoverDurableProtocolRecord<T>(
  github: FugueGitHub,
  options: DurableRecordOptions<T>,
): Promise<DurableRecoveryResult<T>> {
  const firstPage = await statusPage(github, options.storageSha, 1);
  const anchorId = firstPage[0]?.id ?? null;
  let cursorEntry = await findRecoveryCursor(github, options);
  let cursor = cursorEntry?.cursor;
  if (!cursor || cursor.anchor_id !== anchorId) {
    cursor = recoveryCursorSchema.parse({
      version: 1,
      kind: "durable_recovery",
      scope: options.scope,
      storage_sha: options.storageSha,
      publisher_sha: options.publisherSha,
      page: 1,
      offset: 0,
      anchor_id: anchorId,
    });
    cursorEntry = undefined;
  }

  const primary = cursor.page === 1 ? firstPage : await statusPage(github, options.storageSha, cursor.page);
  const secondary = await statusPage(github, options.storageSha, cursor.page + 1);
  const prefix = `${durablePrefix(options.scope)}/m/`;
  const manifests = primary
    .filter((status) => status.context.startsWith(prefix))
    .sort((a, b) => b.id - a.id);

  let bestBody = cursor.best_body_b64
    ? Buffer.from(cursor.best_body_b64, "base64url").toString("utf8")
    : undefined;
  let bestValue: T | undefined;
  if (bestBody) bestValue = await validateDurableBody(github, options, bestBody);
  if (!bestValue) bestBody = undefined;

  const slice = manifests.slice(cursor.offset, cursor.offset + MANIFESTS_PER_RECOVERY_SLICE);
  const window = [...primary, ...secondary];
  for (const manifestStatus of slice) {
    const candidateBody = await reconstructDurableBodyFromWindow(options.scope, manifestStatus, window);
    if (!candidateBody) continue;
    const candidate = await validateDurableBody(github, options, candidateBody);
    if (!candidate) continue;
    if (!bestValue || compareDurable(options, candidate, bestValue) > 0) {
      bestValue = candidate;
      bestBody = candidateBody;
    }
  }

  const nextOffset = cursor.offset + slice.length;
  const moreManifestsOnPage = nextOffset < manifests.length;
  const exhausted = !moreManifestsOnPage && primary.length < STATUS_PAGE_SIZE;
  if (exhausted) {
    if (cursorEntry) await deleteCommentIfPresent(github, cursorEntry.id);
    return bestValue && bestBody
      ? { record: { value: bestValue, body: bestBody }, exhausted: true }
      : { exhausted: true };
  }

  const next = recoveryCursorSchema.parse({
    ...cursor,
    page: moreManifestsOnPage ? cursor.page : cursor.page + 1,
    offset: moreManifestsOnPage ? nextOffset : 0,
    ...(bestBody ? { best_body_b64: Buffer.from(bestBody, "utf8").toString("base64url") } : { best_body_b64: undefined }),
  });
  await writeRecoveryCursor(github, options, next, cursorEntry?.id);
  return { exhausted: false };
}

async function validateDurableBody<T>(
  github: FugueGitHub,
  options: DurableRecordOptions<T>,
  body: string,
): Promise<T | undefined> {
  let value: T | null;
  try {
    value = options.parse(body);
  } catch {
    return undefined;
  }
  if (!value || (options.validate && !options.validate(value))) return undefined;
  const timestamp = options.timestamp(value);
  if (!Number.isFinite(timestamp)) return undefined;
  try {
    if (!(await verifyProtocolPublicationBodyAtRevision(
      github,
      body,
      options.publisherSha,
      timestamp,
    ))) return undefined;
  } catch {
    return undefined;
  }
  return value;
}

function compareDurable<T>(options: DurableRecordOptions<T>, left: T, right: T): number {
  return options.compare?.(left, right) ?? options.timestamp(left) - options.timestamp(right);
}

async function reconstructDurableBodyFromWindow(
  scope: string,
  manifestStatus: CommitStatusRecord,
  window: CommitStatusRecord[],
): Promise<string | undefined> {
  const keyPattern = new RegExp(`^${escapeRegex(durablePrefix(scope))}/m/([0-9a-f]{${SECRET_HEX_LENGTH}})$`, "i");
  const key = manifestStatus.context.match(keyPattern)?.[1]?.toLowerCase();
  if (!key) return undefined;
  const manifest = manifestStatus.description?.match(MANIFEST_PATTERN);
  if (!manifest?.[1] || !manifest[2] || !manifest[3]) return undefined;
  const count = Number(manifest[1]);
  if (!Number.isInteger(count) || count <= 0 || count > DURABLE_MAX_CHUNKS) return undefined;
  const nonce = manifest[3].toLowerCase();

  const byContext = new Map<string, CommitStatusRecord[]>();
  for (const status of window) {
    const list = byContext.get(status.context) ?? [];
    list.push(status);
    byContext.set(status.context, list);
  }
  for (const list of byContext.values()) list.sort((a, b) => a.id - b.id);

  const chunks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const context = durableDataContext(scope, key, index);
    const chunk = byContext.get(context)?.[0]?.description ?? "";
    if (!chunk || !/^[A-Za-z0-9_-]+$/.test(chunk)) return undefined;
    chunks.push(chunk);
  }
  const encoded = chunks.join("");
  if (createHash("sha256").update(encoded, "utf8").digest("hex") !== manifest[2].toLowerCase()) return undefined;
  let redacted: string;
  try {
    redacted = gunzipSync(Buffer.from(encoded, "base64url")).toString("utf8");
  } catch {
    return undefined;
  }
  return restoreAuthorityBody(redacted, key, nonce) ?? undefined;
}

async function statusPage(github: FugueGitHub, sha: string, page: number): Promise<CommitStatusRecord[]> {
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.repos.listCommitStatusesForRef({
    owner,
    repo,
    ref: sha,
    per_page: STATUS_PAGE_SIZE,
    page,
  });
  return response.data.map((status) => ({
    id: status.id,
    context: status.context,
    description: status.description,
  }));
}

async function findRecoveryCursor<T>(
  github: FugueGitHub,
  options: DurableRecordOptions<T>,
): Promise<{ id: number; cursor: RecoveryCursor } | undefined> {
  const comments = await recentIssueComments(github, options.issueNumber);
  let current: { id: number; cursor: RecoveryCursor } | undefined;
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (!body.includes(RECOVERY_START)) continue;
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    let cursor: RecoveryCursor | null;
    try {
      cursor = parsePayloadBlock(body, RECOVERY_START, recoveryCursorSchema);
    } catch {
      continue;
    }
    if (!cursor) continue;
    if (cursor.scope !== options.scope || cursor.storage_sha !== options.storageSha || cursor.publisher_sha !== options.publisherSha) continue;
    if (!current || comment.id > current.id) current = { id: comment.id, cursor };
  }
  return current;
}

async function writeRecoveryCursor<T>(
  github: FugueGitHub,
  options: DurableRecordOptions<T>,
  cursor: RecoveryCursor,
  existingId?: number,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const body = `${RECOVERY_START}\nversion: 1\npayload: ${payload}\n${END}\n\nDurable Fugue recovery: ${options.scope}`;
  if (existingId) {
    try {
      await updateProtocolComment(github, existingId, body);
      return;
    } catch (error) {
      if (httpStatus(error) !== 404) throw error;
    }
  }
  await createProtocolComment(github, options.issueNumber, body);
}

async function recentIssueComments(github: FugueGitHub, issueNumber: number) {
  const { owner, repo } = github.repository;
  const issue = await github.octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const total = issue.data.comments ?? 0;
  const page = Math.max(1, Math.ceil(total / 100));
  const response = await github.octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
    page,
  });
  return response.data;
}

async function deleteCommentIfPresent(github: FugueGitHub, commentId: number): Promise<void> {
  const { owner, repo } = github.repository;
  try {
    await github.octokit.rest.issues.deleteComment({ owner, repo, comment_id: commentId });
  } catch (error) {
    if (httpStatus(error) !== 404) throw error;
  }
}

async function deleteTrustedReceiptComments(
  github: FugueGitHub,
  issueNumber: number,
  receipt: string,
): Promise<void> {
  for (const comment of await recentIssueComments(github, issueNumber)) {
    if (!(comment.body ?? "").includes(receipt)) continue;
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    await deleteCommentIfPresent(github, comment.id);
  }
}

async function loadWorkLocator(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
): Promise<CanonicalWorkState | undefined> {
  const matches: CanonicalWorkState[] = [];
  for (const comment of await recentIssueComments(github, issueNumber)) {
    const body = comment.body ?? "";
    if (!body.includes(WORK_RECEIPT)) continue;
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    let parsed: CanonicalWorkState | null;
    try {
      parsed = parseCanonicalWorkState(body);
    } catch {
      continue;
    }
    if (!parsed || parsed.issue !== issueNumber || parsed.base_sha.toLowerCase() !== baseSha.toLowerCase()) continue;
    matches.push(parsed);
  }
  if (!matches.length) return undefined;
  const newest = matches.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1)!;
  if (matches.some((candidate) => !exactCanonicalWorkState(candidate, newest))) return undefined;
  return newest;
}

async function createWorkLocator(github: FugueGitHub, state: CanonicalWorkState): Promise<void> {
  await createProtocolComment(github, state.issue, `${renderCanonicalWorkStateComment(state)}\n\n${WORK_RECEIPT}`);
}

/** Canonical work-state publication deletes the old locator before committing a newer authority. */
export async function publishCanonicalWorkState(
  github: FugueGitHub,
  state: CanonicalWorkState,
): Promise<boolean> {
  let parsed = canonicalWorkStateSchema.parse(state);
  assertWorkMetadataForIssue(parsed.metadata, parsed.issue);
  const current = await loadCurrentCanonicalWorkState(github, parsed.issue, parsed.base_sha);
  if (current && sameCanonicalWorkState(current, parsed)) return false;

  await assertRepositoryDefaultBranchRevision(github, parsed.base_sha);
  const minimumCreated = current ? Date.parse(current.created_at) + 1 : 0;
  const requestedCreated = Date.parse(parsed.created_at);
  const createdMs = Math.max(Date.now(), minimumCreated, Number.isFinite(requestedCreated) ? requestedCreated : 0);
  parsed = canonicalWorkStateSchema.parse({ ...parsed, created_at: new Date(createdMs).toISOString() });

  // No older valid locator may survive a newer authority commit. If publication then crashes, the
  // existing status authority is recovered instead of falling back to an older signed comment.
  await deleteTrustedReceiptComments(github, parsed.issue, WORK_RECEIPT);
  await publishDurableProtocolRecord(github, {
    storageSha: parsed.base_sha,
    publisherSha: parsed.base_sha,
    scope: workScope(parsed.issue),
    unsignedBody: renderCanonicalWorkStateComment(parsed),
    publicationTimestamp: Date.parse(parsed.created_at),
  });
  await createWorkLocator(github, parsed);
  return true;
}

export async function loadCurrentCanonicalWorkState(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
): Promise<CanonicalWorkState | undefined> {
  const locator = await loadWorkLocator(github, issueNumber, baseSha);
  if (locator) return locator;
  const recovered = await recoverWorkStateAtBase(github, issueNumber, baseSha);
  if (recovered.record) {
    await deleteTrustedReceiptComments(github, issueNumber, WORK_RECEIPT);
    await createWorkLocator(github, recovered.record.value);
    return recovered.record.value;
  }
  if (recovered.exhausted) return undefined;
  throw new DurableProtocolRecoveryPendingError(
    `Issue #${issueNumber} canonical work-state recovery is progressing through bounded status history.`,
  );
}

async function recoverWorkStateAtBase(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
): Promise<DurableRecoveryResult<CanonicalWorkState>> {
  return recoverDurableProtocolRecord(github, {
    storageSha: baseSha,
    publisherSha: baseSha,
    scope: workScope(issueNumber),
    issueNumber,
    parse: parseCanonicalWorkState,
    timestamp: (value) => Date.parse(value.created_at),
    validate: (value) => value.issue === issueNumber && value.base_sha.toLowerCase() === baseSha.toLowerCase(),
  });
}

function workScope(issueNumber: number): string {
  return `work/${issueNumber}`;
}

/** Locate the nearest historical exact-base authority without skipping an unresolved newer base. */
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
    const recovered = await recoverWorkStateAtBase(github, issueNumber, sha);
    if (recovered.record) return recovered.record.value;
    if (!recovered.exhausted) return undefined;
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
    let current: CanonicalWorkState | undefined;
    try {
      current = await loadCurrentCanonicalWorkState(github, issue.number, policy.identity.baseSha);
    } catch (error) {
      if (error instanceof DurableProtocolRecoveryPendingError) continue;
      throw error;
    }
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
    try {
      const before = await loadWorkLocator(github, issue.number, policy.identity.baseSha);
      const state = await loadCurrentCanonicalWorkState(github, issue.number, policy.identity.baseSha);
      if (!before && state) repaired.push(issue.number);
    } catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
    }
  }
  return repaired;
}

function renderCanonicalWorkStateComment(state: CanonicalWorkState): string {
  return `${serializeCanonicalWorkState(state)}\n\nFUGUE WORK STATE — CANONICAL\n\nWork: \`${state.metadata.work_id}\`\nIssue: #${state.issue}`;
}

export async function publishCoordinatorSnapshot(
  github: FugueGitHub,
  baseSha: string,
  snapshot: CoordinatorSnapshot,
): Promise<void> {
  const parsed = coordinatorSnapshotSchema.parse(snapshot);
  await deleteTrustedReceiptComments(github, parsed.issue, COORDINATOR_RECEIPT);
  await publishDurableProtocolRecord(github, {
    storageSha: baseSha,
    publisherSha: baseSha,
    scope: coordinatorScope(parsed.issue),
    unsignedBody: `${serializeCoordinatorSnapshot(parsed)}\n\nCOORDINATOR SNAPSHOT — DURABLE`,
    publicationTimestamp: Date.parse(parsed.captured_at),
  });
  await createProtocolComment(
    github,
    parsed.issue,
    `${serializeCoordinatorSnapshot(parsed)}\n\nCOORDINATOR SNAPSHOT — DURABLE\n\n${COORDINATOR_RECEIPT}`,
  );
}

export async function loadLatestCoordinatorSnapshot(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
): Promise<CoordinatorSnapshot | undefined> {
  const locator = await loadCoordinatorLocator(github, issueNumber);
  if (locator) return locator;
  const recovered = await recoverDurableProtocolRecord(github, {
    storageSha: baseSha,
    publisherSha: baseSha,
    scope: coordinatorScope(issueNumber),
    issueNumber,
    parse: parseCoordinatorSnapshot,
    timestamp: (value) => Date.parse(value.captured_at),
    compare: compareCoordinatorSnapshots,
    validate: (value) => value.issue === issueNumber,
  });
  if (recovered.record) {
    await deleteTrustedReceiptComments(github, issueNumber, COORDINATOR_RECEIPT);
    await createProtocolComment(
      github,
      issueNumber,
      `${serializeCoordinatorSnapshot(recovered.record.value)}\n\nCOORDINATOR SNAPSHOT — DURABLE\n\n${COORDINATOR_RECEIPT}`,
    );
    return recovered.record.value;
  }
  if (recovered.exhausted) return undefined;
  throw new DurableProtocolRecoveryPendingError(
    `Issue #${issueNumber} Coordinator snapshot recovery is progressing through bounded status history.`,
  );
}

export async function recoverCoordinatorSnapshots(
  github: FugueGitHub,
  policy: ActivePolicy,
): Promise<CoordinatorSnapshot[]> {
  const { owner, repo } = github.repository;
  const issues = await github.octokit.paginate(github.octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  const snapshots: CoordinatorSnapshot[] = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    try {
      const snapshot = await loadLatestCoordinatorSnapshot(github, issue.number, policy.identity.baseSha);
      if (snapshot) snapshots.push(snapshot);
    } catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
    }
  }
  return snapshots;
}

async function loadCoordinatorLocator(
  github: FugueGitHub,
  issueNumber: number,
): Promise<CoordinatorSnapshot | undefined> {
  const matches: CoordinatorSnapshot[] = [];
  for (const comment of await recentIssueComments(github, issueNumber)) {
    const body = comment.body ?? "";
    if (!body.includes(COORDINATOR_RECEIPT)) continue;
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    let parsed: CoordinatorSnapshot | null;
    try {
      parsed = parseCoordinatorSnapshot(body);
    } catch {
      continue;
    }
    if (parsed?.issue === issueNumber) matches.push(parsed);
  }
  return matches.sort(compareCoordinatorSnapshots).at(-1);
}

function compareCoordinatorSnapshots(left: CoordinatorSnapshot, right: CoordinatorSnapshot): number {
  const revision = Date.parse(left.issue_updated_at) - Date.parse(right.issue_updated_at);
  if (revision !== 0) return revision;
  const captured = Date.parse(left.captured_at) - Date.parse(right.captured_at);
  if (captured !== 0) return captured;
  return left.event_id.localeCompare(right.event_id);
}

function coordinatorScope(issueNumber: number): string {
  return `coord/${issueNumber}`;
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
    let canonical: CanonicalWorkState | undefined;
    try {
      canonical = await loadCurrentCanonicalWorkState(github, issue.number, policy.identity.baseSha);
    } catch (error) {
      if (error instanceof DurableProtocolRecoveryPendingError) {
        repositoryDrift.push(`Issue #${issue.number}: bounded canonical work-state recovery is in progress`);
        continue;
      }
      throw error;
    }
    if (!canonical) {
      const body = issue.body ?? "";
      const looksManaged = body.includes("<!-- fugue-work") || issue.labels.map(labelName).some((label) =>
        label === "state:ready" || label === "state:working" || label === "state:blocked" || label === "agent:ready"
      );
      if (looksManaged) {
        repositoryDrift.push(`Issue #${issue.number}: presentation state exists without a current protected canonical work-state authority`);
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

function parsePayloadBlock<T>(
  body: string,
  startMarker: string,
  schema: z.ZodType<T>,
  afterParse?: (value: T) => void,
): T | null {
  const start = body.indexOf(startMarker);
  if (start < 0) return null;
  const end = body.indexOf(END, start + startMarker.length);
  if (end < 0) throw new Error(`Unterminated ${startMarker.slice(5)} block.`);
  const block = body.slice(start + startMarker.length, end).trim();
  const match = block.match(/^version: 1\npayload: ([A-Za-z0-9_-]+)$/);
  if (!match?.[1]) throw new Error(`Malformed ${startMarker.slice(5)} block.`);
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error(`Invalid ${startMarker.slice(5)} payload.`);
  }
  const parsed = schema.parse(raw);
  afterParse?.(parsed);
  return parsed;
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
