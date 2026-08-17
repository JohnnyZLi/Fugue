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
  verifyProtocolPublicationBodyAtRevision,
  createDurableManifestProof,
  verifyDurableManifestProof,
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
const MANIFEST_PROOFS_PER_RECOVERY_SLICE = 8;
const STATUS_PAGES_PER_RECOVERY_SLICE = 32;
// Page numbers are reverse-chronological presentation coordinates and shift under append.
// Each slice may spend a separate bounded seek budget to relocate its signed before_id.
const STATUS_PAGE_SEEK_PROBE_LIMIT = 112;
const REPOSITORY_AUTHORITY_VARIABLE_CAPACITY = 500;
const RECOVERY_AUTHORITY_PREFIX = "FUGUE_D3_";
const RECOVERY_PACK_PREFIX = "FUGUE_D3P_";
const RECOVERY_RESERVE_PREFIX = "FUGUE_D3R_";
const RECOVERY_RESERVE_COUNT = 8;
const RECOVERY_PACK_MAX_ENTRIES = 16;
// GitHub configuration variables are limited to 48 KB. Keep immutable recovery packs below
// that ceiling so the signed cursor bodies and JSON framing always have safety margin.
const RECOVERY_PACK_VALUE_LIMIT = 44 * 1024;
const MANIFEST_PATTERN = /^n=(\d+);c=([0-9a-f]{32});b=([0-9a-f]{64});a=(\d+);z=(\d+)$/i;
const DURABLE_MANIFEST_URL = "https://token.actions.githubusercontent.com/fugue/d3";

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
  event_sequence: z.number().int().nonnegative().default(0),
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

const recoveryManifestSchema = z.object({
  id: z.number().int().positive(),
  key: z.string().regex(/^[0-9a-f]{32}$/i),
  nonce: z.string().regex(/^[0-9a-f]{32}$/i),
  body_digest: z.string().regex(/^[0-9a-f]{64}$/i),
  authority_order_b64: z.string().min(1),
  first_status_id: z.number().int().positive(),
  last_status_id: z.number().int().positive(),
  chunk_count: z.number().int().positive().max(DURABLE_MAX_CHUNKS),
  status_ids: z.array(z.number().int().positive()).min(1).max(DURABLE_MAX_CHUNKS),
});

const recoveryCursorSchema = z.object({
  version: z.literal(1),
  kind: z.literal("durable_recovery"),
  scope: z.string().min(1),
  storage_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  publisher_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  checkpoint_at: z.string().min(1).default("1970-01-01T00:00:00.000Z"),
  complete_top_id: z.number().int().nonnegative(),
  scan_top_id: z.number().int().nonnegative(),
  scan_floor_id: z.number().int().nonnegative(),
  before_id: z.number().int().positive(),
  page: z.number().int().positive(),
  phase: z.enum(["discover", "materialize"]),
  best_body_b64: z.string().optional(),
  best_manifest: recoveryManifestSchema.optional(),
  chunks: z.array(z.string().nullable()).max(DURABLE_MAX_CHUNKS).optional(),
});

const recoveryPackSchema = z.object({
  version: z.literal(1),
  kind: z.literal("durable_recovery_pack"),
  entries: z.array(z.string().min(1)).min(1).max(RECOVERY_PACK_MAX_ENTRIES),
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
  targetUrl?: string | null;
  createdAt?: string | null;
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
  order: (value: T) => string;
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
 * redacted from every pre-commit status chunk. The final manifest reveals them and carries a
 * second protected OIDC proof binding the ordered exact server-assigned ID of every chunk, body
 * digest, authority order, key, and nonce. Same-context hostile interleaving is ignored unless its
 * server ID is one of those exact protected IDs, so it cannot make a committed record
 * unreconstructible, and candidate statuses:write cannot finish an aborted prospective record.
 */
export async function publishDurableProtocolRecord(
  github: FugueGitHub,
  input: {
    storageSha: string;
    publisherSha: string;
    scope: string;
    unsignedBody: string;
    publicationTimestamp: number;
    authorityOrder: string;
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
      if (!writtenIds.length) throw new Error("Durable record wrote no data chunks.");

      await assertRepositoryDefaultBranchRevision(github, input.publisherSha);
      if (!(await verifyProtocolPublicationBodyAtRevision(
        github,
        signedBody,
        input.publisherSha,
        input.publicationTimestamp,
      ))) {
        throw new Error("Protected publisher identity changed before durable authority commit.");
      }

      const firstStatusId = Math.min(...writtenIds);
      const lastStatusId = Math.max(...writtenIds);
      const bodyDigest = createHash("sha256").update(signedBody, "utf8").digest("hex");
      const manifestBinding = {
        storageSha: input.storageSha,
        scope: input.scope,
        key,
        nonce,
        bodyDigest,
        authorityOrder: input.authorityOrder,
        firstStatusId,
        lastStatusId,
        chunkCount: bundle.data.length,
        statusIds: writtenIds,
      };
      const manifestProof = await createDurableManifestProof(github, manifestBinding);
      const manifestTarget = durableManifestTargetUrl(input.authorityOrder, manifestProof, writtenIds);

      await assertRepositoryDefaultBranchRevision(github, input.publisherSha);
      await github.octokit.rest.repos.createCommitStatus({
        owner,
        repo,
        sha: input.storageSha,
        state: "success",
        context: bundle.manifest.context,
        description: `n=${bundle.data.length};c=${nonce};b=${bodyDigest};a=${firstStatusId};z=${lastStatusId}`,
        target_url: manifestTarget,
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
 * Recover bounded d3 work from a frozen status-ID ceiling. The signed cursor keeps the ceiling
 * and low-water status ID stable while newer hostile statuses are appended. API page numbers are
 * never durable progress: each slice re-seeks the signed before_id by bounded ID search. Manifest proof
 * verification and chunk materialization each have fixed per-call budgets; locators never select
 * authority. A completed slice advances the durable ceiling monotonically instead of restarting.
 */
export async function recoverDurableProtocolRecord<T>(
  github: FugueGitHub,
  options: DurableRecordOptions<T>,
): Promise<DurableRecoveryResult<T>> {
  const firstPage = await statusPage(github, options.storageSha, 1);
  const topId = firstPage.statuses[0]?.id ?? 0;
  let cursorEntry = await findRecoveryCursor(github, options);
  let cursor = cursorEntry?.cursor;
  let bestBody = cursor?.best_body_b64
    ? Buffer.from(cursor.best_body_b64, "base64url").toString("utf8")
    : undefined;
  let bestValue = bestBody ? await validateDurableBody(github, options, bestBody) : undefined;
  if (!bestValue) bestBody = undefined;

  if (!cursor) {
    if (topId === 0) return { exhausted: true };
    cursor = recoveryCursorSchema.parse({
      version: 1,
      kind: "durable_recovery",
      scope: options.scope,
      storage_sha: options.storageSha,
      publisher_sha: options.publisherSha,
      complete_top_id: 0,
      scan_top_id: topId,
      scan_floor_id: 0,
      before_id: topId + 1,
      page: 1,
      phase: "discover",
    });
  } else if (cursor.phase === "discover" && cursor.scan_top_id === cursor.complete_top_id) {
    if (topId <= cursor.complete_top_id) {
      return bestValue && bestBody
        ? { record: { value: bestValue, body: bestBody }, exhausted: true }
        : { exhausted: true };
    }
    cursor = recoveryCursorSchema.parse({
      ...cursor,
      scan_top_id: topId,
      scan_floor_id: cursor.complete_top_id,
      before_id: topId + 1,
      page: 1,
      best_manifest: undefined,
      chunks: undefined,
    });
  }

  if (cursor.phase === "discover") {
    let bestManifest = cursor.best_manifest;
    let proofBudget = MANIFEST_PROOFS_PER_RECOVERY_SLICE;
    const scan = await scanFrozenStatuses(
      github,
      options.storageSha,
      cursor.scan_top_id,
      cursor.scan_floor_id,
      cursor.before_id,
      async (status) => {
        if (!status.context.startsWith(`${durablePrefix(options.scope)}/m/`)) return true;
        if (proofBudget <= 0) return false;
        proofBudget -= 1;
        const manifest = await authenticatedManifest(github, options, status);
        if (!manifest) return true;
        if (!bestManifest || compareManifest(manifest, bestManifest) > 0) bestManifest = manifest;
        return true;
      },
    );
    cursor = recoveryCursorSchema.parse({
      ...cursor,
      before_id: scan.beforeId,
      page: 1,
      ...(bestManifest ? { best_manifest: bestManifest } : { best_manifest: undefined }),
    });
    if (!scan.exhausted) {
      await writeRecoveryCursor(github, options, cursor);
      return { exhausted: false };
    }

    const bestOrder = bestValue ? options.order(bestValue) : undefined;
    if (bestManifest && (!bestOrder || compareAuthorityOrder(manifestOrder(bestManifest), bestOrder) > 0)) {
      cursor = recoveryCursorSchema.parse({
        ...cursor,
        phase: "materialize",
        before_id: bestManifest.last_status_id + 1,
        page: 1,
        chunks: Array.from({ length: bestManifest.chunk_count }, () => null),
      });
      await writeRecoveryCursor(github, options, cursor);
      // Discovery and materialization are each independently bounded; finish a found manifest
      // in the same public recovery call so normal reads do not depend on presentation locators.
      return recoverDurableProtocolRecord(github, options);
    }

    cursor = recoveryCursorSchema.parse({
      ...cursor,
      complete_top_id: cursor.scan_top_id,
      scan_floor_id: cursor.scan_top_id,
      before_id: cursor.scan_top_id + 1,
      page: 1,
      best_manifest: undefined,
      chunks: undefined,
    });
    await writeRecoveryCursor(github, options, cursor);
    return bestValue && bestBody
      ? { record: { value: bestValue, body: bestBody }, exhausted: true }
      : { exhausted: true };
  }

  const manifest = cursor.best_manifest;
  if (!manifest) throw new CanonicalWorkStateIntegrityError(`Durable recovery lost its authenticated manifest for ${options.scope}.`);
  const chunks = [...(cursor.chunks ?? Array.from({ length: manifest.chunk_count }, () => null))];
  const expected = new Map<number, { index: number; context: string }>();
  for (let index = 0; index < manifest.chunk_count; index += 1) {
    expected.set(manifest.status_ids[index]!, { index, context: durableDataContext(options.scope, manifest.key, index) });
  }
  const materialized = await scanFrozenStatuses(
    github,
    options.storageSha,
    manifest.last_status_id,
    manifest.first_status_id - 1,
    cursor.before_id,
    async (status) => {
      const protectedChunk = expected.get(status.id);
      if (protectedChunk && status.context === protectedChunk.context && chunks[protectedChunk.index] == null && status.description) {
        chunks[protectedChunk.index] = status.description;
      }
      return true;
    },
  );
  cursor = recoveryCursorSchema.parse({ ...cursor, before_id: materialized.beforeId, page: 1, chunks });
  if (!materialized.exhausted) {
    await writeRecoveryCursor(github, options, cursor);
    return { exhausted: false };
  }
  if (chunks.some((chunk) => !chunk)) {
    throw new CanonicalWorkStateIntegrityError(`Authenticated durable manifest ${manifest.id} is missing committed chunks.`);
  }
  const encoded = (chunks as string[]).join("");
  let redacted: string;
  try {
    redacted = gunzipSync(Buffer.from(encoded, "base64url")).toString("utf8");
  } catch {
    throw new CanonicalWorkStateIntegrityError(`Authenticated durable manifest ${manifest.id} has invalid chunk encoding.`);
  }
  const restored = restoreAuthorityBody(redacted, manifest.key, manifest.nonce);
  if (!restored || createHash("sha256").update(restored, "utf8").digest("hex") !== manifest.body_digest) {
    throw new CanonicalWorkStateIntegrityError(`Authenticated durable manifest ${manifest.id} failed body reconstruction.`);
  }
  const value = await validateDurableBody(github, options, restored);
  if (!value || options.order(value) !== manifestOrder(manifest)) {
    throw new CanonicalWorkStateIntegrityError(`Authenticated durable manifest ${manifest.id} failed protected body validation.`);
  }
  if (!bestValue || compareDurable(options, value, bestValue) > 0) {
    bestValue = value;
    bestBody = restored;
  }

  cursor = recoveryCursorSchema.parse({
    ...cursor,
    phase: "discover",
    complete_top_id: cursor.scan_top_id,
    scan_floor_id: cursor.scan_top_id,
    before_id: cursor.scan_top_id + 1,
    page: 1,
    ...(bestBody ? { best_body_b64: Buffer.from(bestBody, "utf8").toString("base64url") } : { best_body_b64: undefined }),
    best_manifest: undefined,
    chunks: undefined,
  });
  await writeRecoveryCursor(github, options, cursor);
  return bestValue && bestBody
    ? { record: { value: bestValue, body: bestBody }, exhausted: true }
    : { exhausted: true };
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

interface RecoveryManifest {
  id: number;
  key: string;
  nonce: string;
  body_digest: string;
  authority_order_b64: string;
  first_status_id: number;
  last_status_id: number;
  chunk_count: number;
  status_ids: number[];
}

async function authenticatedManifest<T>(
  github: FugueGitHub,
  options: DurableRecordOptions<T>,
  status: CommitStatusRecord,
): Promise<RecoveryManifest | undefined> {
  const keyPattern = new RegExp(`^${escapeRegex(durablePrefix(options.scope))}/m/([0-9a-f]{${SECRET_HEX_LENGTH}})$`, "i");
  const key = status.context.match(keyPattern)?.[1]?.toLowerCase();
  const match = status.description?.match(MANIFEST_PATTERN);
  if (!key || !match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) return undefined;
  const chunkCount = Number(match[1]);
  const nonce = match[2].toLowerCase();
  const bodyDigest = match[3].toLowerCase();
  const firstStatusId = Number(match[4]);
  const lastStatusId = Number(match[5]);
  if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > DURABLE_MAX_CHUNKS ||
      !Number.isInteger(firstStatusId) || firstStatusId <= 0 ||
      !Number.isInteger(lastStatusId) || lastStatusId < firstStatusId || lastStatusId >= status.id) return undefined;
  const target = parseDurableManifestTarget(status.targetUrl ?? "");
  if (!target || !status.createdAt || target.statusIds.length !== chunkCount ||
      target.statusIds[0] !== firstStatusId || target.statusIds.at(-1) !== lastStatusId) return undefined;
  const timestamp = Date.parse(status.createdAt);
  if (!Number.isFinite(timestamp)) return undefined;
  const binding = {
    storageSha: options.storageSha,
    scope: options.scope,
    key,
    nonce,
    bodyDigest,
    authorityOrder: target.order,
    firstStatusId,
    lastStatusId,
    chunkCount,
    statusIds: target.statusIds,
  };
  if (!(await verifyDurableManifestProof(github, target.proof, binding, options.publisherSha, timestamp))) return undefined;
  return recoveryManifestSchema.parse({
    id: status.id,
    key,
    nonce,
    body_digest: bodyDigest,
    authority_order_b64: Buffer.from(target.order, "utf8").toString("base64url"),
    first_status_id: firstStatusId,
    last_status_id: lastStatusId,
    chunk_count: chunkCount,
    status_ids: target.statusIds,
  });
}

async function scanFrozenStatuses(
  github: FugueGitHub,
  sha: string,
  topId: number,
  floorId: number,
  startingBeforeId: number,
  visit: (status: CommitStatusRecord) => Promise<boolean>,
): Promise<{ beforeId: number; exhausted: boolean }> {
  let beforeId = startingBeforeId;
  const located = await seekFrozenStatusPage(github, sha, beforeId);
  let page = located.page;
  let statuses = located.statuses;
  for (let pages = 0; pages < STATUS_PAGES_PER_RECOVERY_SLICE; pages += 1) {
    if (pages > 0) statuses = (await statusPage(github, sha, page)).statuses;
    if (!statuses.length) return { beforeId, exhausted: true };
    const eligible = statuses
      .filter((status) => status.id <= topId && status.id > floorId && status.id < beforeId)
      .sort((left, right) => right.id - left.id);
    for (const status of eligible) {
      const shouldContinue = await visit(status);
      if (!shouldContinue) return { beforeId: status.id + 1, exhausted: false };
      beforeId = status.id;
    }
    if (statuses.some((status) => status.id <= floorId) || statuses.length < STATUS_PAGE_SIZE) {
      return { beforeId, exhausted: true };
    }
    page += 1;
  }
  return { beforeId, exhausted: false };
}

function encodeStatusIds(ids: readonly number[]): string {
  let previous = 0;
  return ids.map((id, index) => {
    const value = index === 0 ? id : id - previous;
    previous = id;
    return value.toString(36);
  }).join(".");
}

function decodeStatusIds(value: string): number[] | undefined {
  if (!value || value.length > 512) return undefined;
  const parts = value.split(".");
  if (!parts.length || parts.length > DURABLE_MAX_CHUNKS) return undefined;
  const ids: number[] = [];
  let previous = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || !/^[0-9a-z]+$/i.test(part)) return undefined;
    const encoded = Number.parseInt(part, 36);
    if (!Number.isSafeInteger(encoded) || encoded <= 0) return undefined;
    const id = index === 0 ? encoded : previous + encoded;
    if (!Number.isSafeInteger(id) || id <= previous) return undefined;
    ids.push(id);
    previous = id;
  }
  return ids;
}

function durableManifestTargetUrl(order: string, proof: string, statusIds: readonly number[]): string {
  const target = new URL(DURABLE_MANIFEST_URL);
  target.searchParams.set("o", Buffer.from(order, "utf8").toString("base64url"));
  target.searchParams.set("i", encodeStatusIds(statusIds));
  target.searchParams.set("p", proof);
  return target.toString();
}

function parseDurableManifestTarget(value: string): { order: string; proof: string; statusIds: number[] } | undefined {
  try {
    const target = new URL(value);
    if (`${target.origin}${target.pathname}` !== DURABLE_MANIFEST_URL) return undefined;
    const encodedOrder = target.searchParams.get("o");
    const encodedIds = target.searchParams.get("i");
    const proof = target.searchParams.get("p");
    if (!encodedOrder || !encodedIds || !proof) return undefined;
    const order = Buffer.from(encodedOrder, "base64url").toString("utf8");
    const statusIds = decodeStatusIds(encodedIds);
    if (!order || order.length > 512 || !statusIds) return undefined;
    return { order, proof, statusIds };
  } catch {
    return undefined;
  }
}

function manifestOrder(manifest: RecoveryManifest): string {
  return Buffer.from(manifest.authority_order_b64, "base64url").toString("utf8");
}

function compareManifest(left: RecoveryManifest, right: RecoveryManifest): number {
  const order = compareAuthorityOrder(manifestOrder(left), manifestOrder(right));
  if (order !== 0) return order;
  return right.id - left.id;
}

function compareAuthorityOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface CommitStatusPageResult {
  statuses: CommitStatusRecord[];
  lastPage?: number;
}

function lastStatusPageFromLink(link: string | undefined): number | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    if (!/rel="last"/.test(part)) continue;
    const href = part.match(/<([^>]+)>/)?.[1];
    if (!href) continue;
    try {
      const page = Number(new URL(href).searchParams.get("page"));
      if (Number.isSafeInteger(page) && page > 0) return page;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function statusPageReachesBefore(statuses: readonly CommitStatusRecord[], beforeId: number): boolean {
  return statuses.length === 0 || statuses.some((status) => status.id < beforeId);
}

async function seekFrozenStatusPage(
  github: FugueGitHub,
  sha: string,
  beforeId: number,
): Promise<{ page: number; statuses: CommitStatusRecord[] }> {
  const cache = new Map<number, CommitStatusPageResult>();
  let probes = 0;
  const read = async (page: number): Promise<CommitStatusPageResult> => {
    const cached = cache.get(page);
    if (cached) return cached;
    if (!Number.isSafeInteger(page) || page <= 0 || probes >= STATUS_PAGE_SEEK_PROBE_LIMIT) {
      throw new CanonicalWorkStateIntegrityError(
        `Durable recovery could not relocate frozen status ID ${beforeId} within the bounded seek budget.`,
      );
    }
    probes += 1;
    const value = await statusPage(github, sha, page);
    cache.set(page, value);
    return value;
  };

  const first = await read(1);
  if (statusPageReachesBefore(first.statuses, beforeId)) return { page: 1, statuses: first.statuses };

  let low = 2;
  let high: number | undefined;
  if (first.lastPage !== undefined) {
    if (first.lastPage >= Number.MAX_SAFE_INTEGER) {
      throw new CanonicalWorkStateIntegrityError("Durable status pagination exceeds the supported safe-integer range.");
    }
    // lastPage + 1 is an empty sentinel, so exhaustion below beforeId is searchable too.
    high = first.lastPage + 1;
  } else {
    let probe = 2;
    while (high === undefined) {
      const candidate = await read(probe);
      if (statusPageReachesBefore(candidate.statuses, beforeId)) {
        high = probe;
        break;
      }
      low = probe + 1;
      if (probe > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
        throw new CanonicalWorkStateIntegrityError("Durable status pagination exceeds the supported safe-integer range.");
      }
      probe *= 2;
    }
  }

  let best: { page: number; statuses: CommitStatusRecord[] } | undefined;
  while (low <= high) {
    const middle: number = low + Math.floor((high - low) / 2);
    const candidate = await read(middle);
    if (statusPageReachesBefore(candidate.statuses, beforeId)) {
      best = { page: middle, statuses: candidate.statuses };
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (!best) {
    throw new CanonicalWorkStateIntegrityError(
      `Durable recovery could not relocate frozen status ID ${beforeId} without using an append-unstable page cursor.`,
    );
  }
  return best;
}

async function statusPage(github: FugueGitHub, sha: string, page: number): Promise<CommitStatusPageResult> {
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.repos.listCommitStatusesForRef({
    owner,
    repo,
    ref: sha,
    per_page: STATUS_PAGE_SIZE,
    page,
  });
  const statuses = response.data.map((status) => ({
    id: status.id,
    context: status.context,
    description: status.description,
    targetUrl: status.target_url,
    createdAt: status.created_at,
  }));
  const link = typeof response.headers?.link === "string" ? response.headers.link : undefined;
  const lastPage = lastStatusPageFromLink(link);
  return { statuses, ...(lastPage !== undefined ? { lastPage } : {}) };
}

interface FugueAuthorityVariable {
  name: string;
  value: string;
}

function injectedAuthorityVariables(github: FugueGitHub): Map<string, string> | undefined {
  return (github as FugueGitHub & { __authorityVariables?: Map<string, string> }).__authorityVariables;
}

function requireAuthorityToken(): string {
  const token = process.env.FUGUE_AUTHORITY_TOKEN?.trim();
  if (!token) {
    throw new CanonicalWorkStateIntegrityError(
      "Protected Fugue authority token is unavailable. Hosted mutation must use the Authority App; local status/debug reads require an explicitly supplied repository-Variables read credential in FUGUE_AUTHORITY_TOKEN.",
    );
  }
  return token;
}

async function authorityRequest(
  github: FugueGitHub,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = requireAuthorityToken();
  return fetch(`https://api.github.com/repos/${github.repository.owner}/${github.repository.repo}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function listFugueAuthorityVariables(
  github: FugueGitHub,
  prefix: string,
): Promise<FugueAuthorityVariable[]> {
  const injected = injectedAuthorityVariables(github);
  if (injected) {
    return [...injected.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => ({ name, value }));
  }
  const variables: FugueAuthorityVariable[] = [];
  for (let page = 1; ; page += 1) {
    const response = await authorityRequest(github, `/actions/variables?per_page=30&page=${page}`);
    if (!response.ok) {
      throw new CanonicalWorkStateIntegrityError(`Unable to list protected Fugue authority variables (${response.status}).`);
    }
    const payload = await response.json() as { variables?: Array<{ name?: unknown; value?: unknown }> };
    const pageVariables = payload.variables ?? [];
    for (const variable of pageVariables) {
      if (typeof variable.name === "string" && typeof variable.value === "string" && variable.name.startsWith(prefix)) {
        variables.push({ name: variable.name, value: variable.value });
      }
    }
    if (pageVariables.length < 30) break;
  }
  return variables;
}

export async function getFugueAuthorityVariable(github: FugueGitHub, name: string): Promise<string | undefined> {
  const injected = injectedAuthorityVariables(github);
  if (injected) return injected.get(name);
  const response = await authorityRequest(github, `/actions/variables/${encodeURIComponent(name)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new CanonicalWorkStateIntegrityError(`Unable to read protected Fugue authority variable ${name} (${response.status}).`);
  }
  const payload = await response.json() as { value?: unknown };
  if (typeof payload.value !== "string") {
    throw new CanonicalWorkStateIntegrityError(`Protected Fugue authority variable ${name} has no string value.`);
  }
  return payload.value;
}

export async function createFugueAuthorityVariable(github: FugueGitHub, name: string, value: string): Promise<boolean> {
  const injected = injectedAuthorityVariables(github);
  if (injected) {
    if (injected.has(name)) return false;
    if (injected.size >= REPOSITORY_AUTHORITY_VARIABLE_CAPACITY) return false;
    injected.set(name, value);
    return true;
  }
  const response = await authorityRequest(github, "/actions/variables", {
    method: "POST",
    body: JSON.stringify({ name, value }),
  });
  if (response.status === 201) return true;
  if (response.status === 409 || response.status === 422) return false;
  throw new CanonicalWorkStateIntegrityError(`Unable to create protected Fugue authority variable ${name} (${response.status}).`);
}

export async function updateFugueAuthorityVariable(github: FugueGitHub, name: string, value: string): Promise<void> {
  const injected = injectedAuthorityVariables(github);
  if (injected) {
    if (!injected.has(name)) throw new CanonicalWorkStateIntegrityError(`Protected Fugue authority variable ${name} is missing.`);
    injected.set(name, value);
    return;
  }
  const response = await authorityRequest(github, `/actions/variables/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ name, value }),
  });
  if (!response.ok) {
    throw new CanonicalWorkStateIntegrityError(`Unable to update protected Fugue authority variable ${name} (${response.status}).`);
  }
}

export async function deleteFugueAuthorityVariable(github: FugueGitHub, name: string): Promise<void> {
  const injected = injectedAuthorityVariables(github);
  if (injected) {
    injected.delete(name);
    return;
  }
  const response = await authorityRequest(github, `/actions/variables/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new CanonicalWorkStateIntegrityError(`Unable to delete stale Fugue authority variable ${name} (${response.status}).`);
  }
}

interface VerifiedRecoveryEntry {
  sourceVariableName: string;
  signedBody: string;
  cursor: RecoveryCursor;
}

function recoveryIdentity(cursor: RecoveryCursor): string {
  return `${cursor.storage_sha.toLowerCase()}\0${cursor.publisher_sha.toLowerCase()}\0${cursor.scope}`;
}

function recoveryOptionsIdentity<T>(options: DurableRecordOptions<T>): string {
  return `${options.storageSha.toLowerCase()}\0${options.publisherSha.toLowerCase()}\0${options.scope}`;
}

function recoveryBucket(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 2).toUpperCase();
}

function recoveryCursorBucket(cursor: RecoveryCursor): string {
  return recoveryBucket(recoveryIdentity(cursor));
}

function recoveryOptionsBucket<T>(options: DurableRecordOptions<T>): string {
  return recoveryBucket(recoveryOptionsIdentity(options));
}

function recoveryPackPrefix(bucket: string): string {
  return `${RECOVERY_PACK_PREFIX}${bucket}_`;
}

function recoveryVariablePrefix<T>(options: DurableRecordOptions<T>): string {
  const digest = createHash("sha256")
    .update(recoveryOptionsIdentity(options), "utf8")
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `FUGUE_D3_${digest}_`;
}

function recoveryVariableName<T>(options: DurableRecordOptions<T>, signedBody: string): string {
  const checkpoint = createHash("sha256").update(signedBody, "utf8").digest("hex").slice(0, 16).toUpperCase();
  return `${recoveryVariablePrefix(options)}${checkpoint}`;
}

function compareRecoveryProgress(left: RecoveryCursor, right: RecoveryCursor): number {
  if (left.complete_top_id !== right.complete_top_id) return left.complete_top_id - right.complete_top_id;
  if (left.scan_top_id !== right.scan_top_id) return left.scan_top_id - right.scan_top_id;
  if (left.phase !== right.phase) return left.phase === "materialize" ? 1 : -1;
  if (left.before_id !== right.before_id) return right.before_id - left.before_id;
  // Reverse-chronological API page numbers are deliberately not progress coordinates.
  const leftChunks = left.chunks?.filter((chunk) => chunk != null).length ?? 0;
  const rightChunks = right.chunks?.filter((chunk) => chunk != null).length ?? 0;
  return leftChunks - rightChunks;
}

function recoveryBodyTieBreak(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function parseRecoveryCursorBody(body: string): RecoveryCursor | undefined {
  try {
    return parsePayloadBlock(body, RECOVERY_START, recoveryCursorSchema) ?? undefined;
  } catch {
    return undefined;
  }
}

async function verifyRecoveryCursorBody(github: FugueGitHub, body: string): Promise<RecoveryCursor | undefined> {
  const cursor = parseRecoveryCursorBody(body);
  if (!cursor) return undefined;
  const timestamp = Date.parse(cursor.checkpoint_at);
  if (!Number.isFinite(timestamp)) return undefined;
  try {
    if (!(await verifyProtocolPublicationBodyAtRevision(github, body, cursor.publisher_sha, timestamp))) return undefined;
  } catch {
    return undefined;
  }
  return cursor;
}

function parseRecoveryPack(value: string): string[] | undefined {
  try {
    const parsed = recoveryPackSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data.entries : undefined;
  } catch {
    return undefined;
  }
}

function serializeRecoveryPack(entries: readonly string[]): string {
  return JSON.stringify(recoveryPackSchema.parse({ version: 1, kind: "durable_recovery_pack", entries }));
}

function recoveryPackName(bucket: string, value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24).toUpperCase();
  return `${recoveryPackPrefix(bucket)}${digest}`;
}

function variableRecoveryBucket(name: string): string | undefined {
  const leaf = name.match(/^FUGUE_D3_([0-9A-F]{2})[0-9A-F]{14}_/i)?.[1];
  if (leaf) return leaf.toUpperCase();
  return name.match(/^FUGUE_D3P_([0-9A-F]{2})_/i)?.[1]?.toUpperCase();
}

function recoveryReserveName(index: number): string {
  return `${RECOVERY_RESERVE_PREFIX}${String(index).padStart(2, "0")}`;
}

async function ensureRecoveryReserveVariables(github: FugueGitHub): Promise<void> {
  const existing = new Set((await listFugueAuthorityVariables(github, RECOVERY_RESERVE_PREFIX)).map((entry) => entry.name));
  let allCount = (await listFugueAuthorityVariables(github, "")).length;
  for (let index = 0; index < RECOVERY_RESERVE_COUNT; index += 1) {
    const name = recoveryReserveName(index);
    if (existing.has(name) || allCount >= REPOSITORY_AUTHORITY_VARIABLE_CAPACITY) continue;
    if (await createFugueAuthorityVariable(github, name, "reserved-for-fugue-recovery-compaction")) {
      allCount += 1;
    }
  }
}

async function releaseRecoveryReserveSlots(github: FugueGitHub, slots: number): Promise<boolean> {
  let all = await listFugueAuthorityVariables(github, "");
  if (all.length + slots <= REPOSITORY_AUTHORITY_VARIABLE_CAPACITY) return true;
  const reserves = (await listFugueAuthorityVariables(github, RECOVERY_RESERVE_PREFIX))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const reserve of reserves) {
    await deleteFugueAuthorityVariable(github, reserve.name);
    all = await listFugueAuthorityVariables(github, "");
    if (all.length + slots <= REPOSITORY_AUTHORITY_VARIABLE_CAPACITY) return true;
  }
  return all.length + slots <= REPOSITORY_AUTHORITY_VARIABLE_CAPACITY;
}

async function verifiedRecoveryEntriesForBucket(
  github: FugueGitHub,
  bucket: string,
  variables?: readonly FugueAuthorityVariable[],
): Promise<VerifiedRecoveryEntry[]> {
  const source = variables ?? await listFugueAuthorityVariables(github, "FUGUE_D3");
  const verified: VerifiedRecoveryEntry[] = [];
  for (const variable of source) {
    if (variable.name.startsWith(RECOVERY_RESERVE_PREFIX)) continue;
    if (variableRecoveryBucket(variable.name) !== bucket) continue;
    if (variable.name.startsWith(RECOVERY_PACK_PREFIX)) {
      const bodies = parseRecoveryPack(variable.value);
      if (!bodies) continue; // Never delete an unreadable pack: it may be the sole surviving progress copy.
      for (const signedBody of bodies) {
        const parsed = parseRecoveryCursorBody(signedBody);
        if (!parsed || recoveryCursorBucket(parsed) !== bucket) continue;
        const cursor = await verifyRecoveryCursorBody(github, signedBody);
        if (cursor) verified.push({ sourceVariableName: variable.name, signedBody, cursor });
      }
      continue;
    }
    const cursor = await verifyRecoveryCursorBody(github, variable.value);
    if (!cursor || recoveryCursorBucket(cursor) !== bucket) {
      await deleteFugueAuthorityVariable(github, variable.name);
      continue;
    }
    verified.push({ sourceVariableName: variable.name, signedBody: variable.value, cursor });
  }
  return verified;
}

async function findRecoveryCursor<T>(
  github: FugueGitHub,
  options: DurableRecordOptions<T>,
): Promise<{ variableName: string; cursor: RecoveryCursor } | undefined> {
  const identity = recoveryOptionsIdentity(options);
  let best: VerifiedRecoveryEntry | undefined;
  const variables = await listFugueAuthorityVariables(github, "FUGUE_D3");
  for (const entry of await verifiedRecoveryEntriesForBucket(github, recoveryOptionsBucket(options), variables)) {
    if (recoveryIdentity(entry.cursor) !== identity) continue;
    if (!best || compareRecoveryProgress(entry.cursor, best.cursor) > 0 ||
        (compareRecoveryProgress(entry.cursor, best.cursor) === 0 &&
          recoveryBodyTieBreak(entry.signedBody) < recoveryBodyTieBreak(best.signedBody))) {
      best = entry;
    }
  }
  return best ? { variableName: best.sourceVariableName, cursor: best.cursor } : undefined;
}

function buildRecoveryPackGroups(entries: readonly VerifiedRecoveryEntry[]): {
  groups: string[][];
  protectedSources: Set<string>;
} {
  const groups: string[][] = [];
  const protectedSources = new Set<string>();
  let current: string[] = [];
  for (const entry of entries) {
    const single = serializeRecoveryPack([entry.signedBody]);
    if (Buffer.byteLength(single, "utf8") > RECOVERY_PACK_VALUE_LIMIT) {
      protectedSources.add(entry.sourceVariableName);
      continue;
    }
    const candidate = [...current, entry.signedBody];
    if (current.length >= RECOVERY_PACK_MAX_ENTRIES ||
        Buffer.byteLength(serializeRecoveryPack(candidate), "utf8") > RECOVERY_PACK_VALUE_LIMIT) {
      if (current.length) groups.push(current);
      current = [entry.signedBody];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);
  return { groups, protectedSources };
}

async function compactRecoveryBucket(
  github: FugueGitHub,
  bucket: string,
  variables: readonly FugueAuthorityVariable[],
): Promise<void> {
  const entries = await verifiedRecoveryEntriesForBucket(github, bucket, variables);
  if (!entries.length) return;
  const grouped = new Map<string, VerifiedRecoveryEntry[]>();
  const bySource = new Map<string, VerifiedRecoveryEntry[]>();
  for (const entry of entries) {
    const identity = recoveryIdentity(entry.cursor);
    const group = grouped.get(identity) ?? [];
    group.push(entry);
    grouped.set(identity, group);
    const sourceEntries = bySource.get(entry.sourceVariableName) ?? [];
    sourceEntries.push(entry);
    bySource.set(entry.sourceVariableName, sourceEntries);
  }

  const winners: VerifiedRecoveryEntry[] = [];
  for (const [identity, group] of grouped) {
    group.sort((left, right) => {
      const progress = compareRecoveryProgress(right.cursor, left.cursor);
      if (progress !== 0) return progress;
      const bodyOrder = recoveryBodyTieBreak(left.signedBody).localeCompare(recoveryBodyTieBreak(right.signedBody));
      if (bodyOrder !== 0) return bodyOrder;
      return left.sourceVariableName.localeCompare(right.sourceVariableName);
    });
    winners.push(group[0]!);
  }
  winners.sort((left, right) => recoveryIdentity(left.cursor).localeCompare(recoveryIdentity(right.cursor)));

  // Sources containing no greatest cursor are already redundant and can be removed before packing.
  // This is same-identity deduplication only; no scope loses its sole monotonic checkpoint.
  const winnerSources = new Set(winners.map((entry) => entry.sourceVariableName));
  for (const sourceName of bySource.keys()) {
    if (!winnerSources.has(sourceName)) {
      await deleteFugueAuthorityVariable(github, sourceName);
      bySource.delete(sourceName);
    }
  }

  const liveSources = winnerSources;
  if (liveSources.size <= 1 && winners.length <= 1) return;

  const { groups: packGroups, protectedSources } = buildRecoveryPackGroups(winners);
  const outputs = new Map<string, string>();
  for (const group of packGroups) {
    const value = serializeRecoveryPack(group);
    outputs.set(recoveryPackName(bucket, value), value);
  }

  const missingOutputs: Array<[string, string]> = [];
  for (const [name, value] of outputs) {
    const existing = await getFugueAuthorityVariable(github, name);
    if (existing === value) continue;
    if (existing !== undefined) return; // Hash/name collision: fail closed without deleting a source.
    missingOutputs.push([name, value]);
  }
  if (missingOutputs.length && !(await releaseRecoveryReserveSlots(github, missingOutputs.length))) return;
  for (const [name, value] of missingOutputs) {
    const created = await createFugueAuthorityVariable(github, name, value);
    const durable = created ? value : await getFugueAuthorityVariable(github, name);
    if (durable !== value) return; // Source deletion happens only after every replacement pack is durable.
  }

  const outputNames = new Set(outputs.keys());
  for (const sourceName of liveSources) {
    if (outputNames.has(sourceName) || protectedSources.has(sourceName)) continue;
    await deleteFugueAuthorityVariable(github, sourceName);
  }
  await ensureRecoveryReserveVariables(github);
}

/**
 * Recovery checkpoints are performance state, never d3 authority. Every resumable identity keeps
 * one greatest signed cursor. Capacity is reduced by packing greatest cursors into immutable,
 * bucket-sharded Authority variables; a pack is created and re-read before any source containing
 * its progress is deleted. No cross-scope cursor is ever reclaimed merely because it is caught up.
 * Reserved empty Authority slots let a full Fugue-owned namespace publish a replacement pack first.
 * If crashes consume every reserve, a required allocation performs repository-wide safe dedup/packing
 * before failing, so redundant recovery state in another bucket can replenish capacity without deleting
 * any scope's sole greatest cursor. Concurrent compactors converge on content-addressed immutable packs.
 */
export async function compactFugueRecoveryAuthorityVariables(
  github: FugueGitHub,
  preserveIdentity?: string,
  reserveSlots = 0,
): Promise<void> {
  await ensureRecoveryReserveVariables(github);
  const variables = await listFugueAuthorityVariables(github, "FUGUE_D3");
  const buckets = preserveIdentity
    ? [recoveryBucket(preserveIdentity)]
    : [...new Set(variables.map((entry) => variableRecoveryBucket(entry.name)).filter((value): value is string => Boolean(value)))].sort();
  for (const bucket of buckets) {
    await compactRecoveryBucket(github, bucket, variables.filter((entry) => variableRecoveryBucket(entry.name) === bucket));
  }
  if (reserveSlots > 0) await releaseRecoveryReserveSlots(github, reserveSlots);
}

async function writeRecoveryCursor<T>(
  github: FugueGitHub,
  options: DurableRecordOptions<T>,
  supplied: RecoveryCursor,
): Promise<void> {
  const identity = recoveryOptionsIdentity(options);
  await compactFugueRecoveryAuthorityVariables(github, identity, 1);
  const current = await findRecoveryCursor(github, options);
  if (current && compareRecoveryProgress(current.cursor, supplied) >= 0) {
    await compactFugueRecoveryAuthorityVariables(github, identity);
    return;
  }

  const cursor = recoveryCursorSchema.parse({ ...supplied, checkpoint_at: new Date().toISOString() });
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const unsigned = `${RECOVERY_START}\nversion: 1\npayload: ${payload}\n${END}\n\nDurable Fugue recovery checkpoint: ${options.scope}`;
  const signed = await signProtocolBody(github, unsigned);
  const timestamp = Date.parse(cursor.checkpoint_at);
  if (!(await verifyProtocolPublicationBodyAtRevision(github, signed, options.publisherSha, timestamp))) {
    throw new CanonicalWorkStateIntegrityError("Durable recovery checkpoint failed protected provenance self-check.");
  }

  const name = recoveryVariableName(options, signed);
  let created = await createFugueAuthorityVariable(github, name, signed);
  let existing = created ? signed : await getFugueAuthorityVariable(github, name);
  if (!created && existing === undefined) {
    await compactFugueRecoveryAuthorityVariables(github, identity, 1);
    created = await createFugueAuthorityVariable(github, name, signed);
    existing = created ? signed : await getFugueAuthorityVariable(github, name);
  }
  if (!created && existing === undefined) {
    // Reserve slots may all have been consumed by crashes after create in other buckets. Before
    // refusing this required checkpoint, compact repository-wide redundant recovery sources.
    await compactFugueRecoveryAuthorityVariables(github, undefined, 1);
    created = await createFugueAuthorityVariable(github, name, signed);
    existing = created ? signed : await getFugueAuthorityVariable(github, name);
  }
  if (!created && existing !== signed) {
    throw new CanonicalWorkStateIntegrityError(
      existing === undefined
        ? "Protected Fugue Authority-variable namespace is full after bucket-local and repository-wide immutable recovery packing/reserve reclamation; refusing to corrupt unrelated repository variables."
        : `Protected Fugue authority variable collision at ${name}.`,
    );
  }

  const durable = await findRecoveryCursor(github, options);
  if (!durable || compareRecoveryProgress(durable.cursor, cursor) < 0) {
    throw new CanonicalWorkStateIntegrityError("Protected Fugue recovery progress did not become durable.");
  }

  await compactFugueRecoveryAuthorityVariables(github, identity);
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

/** Canonical work-state publication commits d3 authority before repairing presentation receipts. */
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

  await publishDurableProtocolRecord(github, {
    storageSha: parsed.base_sha,
    publisherSha: parsed.base_sha,
    scope: workScope(parsed.issue),
    unsignedBody: renderCanonicalWorkStateComment(parsed),
    publicationTimestamp: Date.parse(parsed.created_at),
    authorityOrder: parsed.created_at,
  });
  await replaceWorkLocator(github, parsed);
  return true;
}

export async function loadCurrentCanonicalWorkState(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
): Promise<CanonicalWorkState | undefined> {
  const recovered = await recoverWorkStateAtBase(github, issueNumber, baseSha);
  if (recovered.record) {
    await replaceWorkLocator(github, recovered.record.value);
    return recovered.record.value;
  }
  if (recovered.exhausted) return undefined;
  throw new DurableProtocolRecoveryPendingError(
    `Issue #${issueNumber} canonical work-state recovery is progressing through bounded status history.`,
  );
}

async function replaceWorkLocator(github: FugueGitHub, state: CanonicalWorkState): Promise<void> {
  const locator = await loadWorkLocator(github, state.issue, state.base_sha);
  if (locator && exactCanonicalWorkState(locator, state)) return;
  await deleteTrustedReceiptComments(github, state.issue, WORK_RECEIPT);
  await createWorkLocator(github, state);
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
    order: (value) => value.created_at,
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
  const current = await loadLatestCoordinatorSnapshot(github, parsed.issue, baseSha);
  if (current && compareCoordinatorSnapshots(parsed, current) <= 0) return;
  await publishDurableProtocolRecord(github, {
    storageSha: baseSha,
    publisherSha: baseSha,
    scope: coordinatorScope(parsed.issue),
    unsignedBody: `${serializeCoordinatorSnapshot(parsed)}

COORDINATOR SNAPSHOT — DURABLE`,
    publicationTimestamp: Date.parse(parsed.captured_at),
    authorityOrder: coordinatorAuthorityOrder(parsed),
  });
  await replaceCoordinatorLocator(github, parsed);
}

export async function loadLatestCoordinatorSnapshot(
  github: FugueGitHub,
  issueNumber: number,
  baseSha: string,
): Promise<CoordinatorSnapshot | undefined> {
  const recovered = await recoverDurableProtocolRecord(github, {
    storageSha: baseSha,
    publisherSha: baseSha,
    scope: coordinatorScope(issueNumber),
    issueNumber,
    parse: parseCoordinatorSnapshot,
    timestamp: (value) => Date.parse(value.captured_at),
    order: coordinatorAuthorityOrder,
    compare: compareCoordinatorSnapshots,
    validate: (value) => value.issue === issueNumber,
  });
  if (recovered.record) {
    await replaceCoordinatorLocator(github, recovered.record.value);
    return recovered.record.value;
  }
  if (recovered.exhausted) return undefined;
  throw new DurableProtocolRecoveryPendingError(
    `Issue #${issueNumber} Coordinator snapshot recovery is progressing through bounded status history.`,
  );
}

async function replaceCoordinatorLocator(github: FugueGitHub, snapshot: CoordinatorSnapshot): Promise<void> {
  const locator = await loadCoordinatorLocator(github, snapshot.issue);
  if (locator && compareCoordinatorSnapshots(locator, snapshot) === 0) return;
  await deleteTrustedReceiptComments(github, snapshot.issue, COORDINATOR_RECEIPT);
  await createProtocolComment(
    github,
    snapshot.issue,
    `${serializeCoordinatorSnapshot(snapshot)}

COORDINATOR SNAPSHOT — DURABLE

${COORDINATOR_RECEIPT}`,
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

export function compareCoordinatorSnapshots(left: CoordinatorSnapshot, right: CoordinatorSnapshot): number {
  return compareAuthorityOrder(coordinatorAuthorityOrder(left), coordinatorAuthorityOrder(right));
}

function coordinatorAuthorityOrder(snapshot: CoordinatorSnapshot): string {
  return `${snapshot.issue_updated_at}\u0000${String(snapshot.event_sequence).padStart(20, "0")}\u0000${snapshot.event_id}`;
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
