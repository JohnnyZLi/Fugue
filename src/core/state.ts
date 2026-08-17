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
});

const recoveryCursorSchema = z.object({
  version: z.literal(1),
  kind: z.literal("durable_recovery"),
  scope: z.string().min(1),
  storage_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  publisher_sha: z.string().regex(/^[0-9a-f]{40}$/i),
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
 * second protected OIDC proof binding the exact server-assigned chunk-ID range, body digest,
 * authority order, key, and nonce. Interleaved hostile statuses cannot make a committed record
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
      };
      const manifestProof = await createDurableManifestProof(github, manifestBinding);
      const manifestTarget = durableManifestTargetUrl(input.authorityOrder, manifestProof);

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
 * Recover bounded d3 work from a frozen status-ID ceiling. The signed cursor keeps the ceiling,
 * low-water ID and page progress stable while newer hostile statuses are appended. Manifest proof
 * verification and chunk materialization each have fixed per-call budgets; locators never select
 * authority. A completed slice advances the durable ceiling monotonically instead of restarting.
 */
export async function recoverDurableProtocolRecord<T>(
  github: FugueGitHub,
  options: DurableRecordOptions<T>,
): Promise<DurableRecoveryResult<T>> {
  const firstPage = await statusPage(github, options.storageSha, 1);
  const topId = firstPage[0]?.id ?? 0;
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
      cursor.page,
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
      page: scan.page,
      ...(bestManifest ? { best_manifest: bestManifest } : { best_manifest: undefined }),
    });
    if (!scan.exhausted) {
      await writeRecoveryCursor(github, options, cursor, cursorEntry?.id);
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
      await writeRecoveryCursor(github, options, cursor, cursorEntry?.id);
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
    await writeRecoveryCursor(github, options, cursor, cursorEntry?.id);
    return bestValue && bestBody
      ? { record: { value: bestValue, body: bestBody }, exhausted: true }
      : { exhausted: true };
  }

  const manifest = cursor.best_manifest;
  if (!manifest) throw new CanonicalWorkStateIntegrityError(`Durable recovery lost its authenticated manifest for ${options.scope}.`);
  const chunks = [...(cursor.chunks ?? Array.from({ length: manifest.chunk_count }, () => null))];
  const expected = new Map<string, number>();
  for (let index = 0; index < manifest.chunk_count; index += 1) {
    expected.set(durableDataContext(options.scope, manifest.key, index), index);
  }
  const materialized = await scanFrozenStatuses(
    github,
    options.storageSha,
    manifest.last_status_id,
    manifest.first_status_id - 1,
    cursor.before_id,
    cursor.page,
    async (status) => {
      const index = expected.get(status.context);
      if (index !== undefined && chunks[index] == null && status.description) chunks[index] = status.description;
      return true;
    },
  );
  cursor = recoveryCursorSchema.parse({ ...cursor, before_id: materialized.beforeId, page: materialized.page, chunks });
  if (!materialized.exhausted) {
    await writeRecoveryCursor(github, options, cursor, cursorEntry?.id);
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
  await writeRecoveryCursor(github, options, cursor, cursorEntry?.id);
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
  if (!target || !status.createdAt) return undefined;
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
  });
}

async function scanFrozenStatuses(
  github: FugueGitHub,
  sha: string,
  topId: number,
  floorId: number,
  startingBeforeId: number,
  startingPage: number,
  visit: (status: CommitStatusRecord) => Promise<boolean>,
): Promise<{ beforeId: number; page: number; exhausted: boolean }> {
  let beforeId = startingBeforeId;
  let page = startingPage;
  for (let pages = 0; pages < STATUS_PAGES_PER_RECOVERY_SLICE; pages += 1) {
    const statuses = await statusPage(github, sha, page);
    if (!statuses.length) return { beforeId, page, exhausted: true };
    const eligible = statuses
      .filter((status) => status.id <= topId && status.id > floorId && status.id < beforeId)
      .sort((left, right) => right.id - left.id);
    for (const status of eligible) {
      const shouldContinue = await visit(status);
      if (!shouldContinue) return { beforeId: status.id + 1, page, exhausted: false };
      beforeId = status.id;
    }
    if (statuses.some((status) => status.id <= floorId) || statuses.length < STATUS_PAGE_SIZE) {
      return { beforeId, page, exhausted: true };
    }
    page += 1;
  }
  return { beforeId, page, exhausted: false };
}

function durableManifestTargetUrl(order: string, proof: string): string {
  const target = new URL(DURABLE_MANIFEST_URL);
  target.searchParams.set("o", Buffer.from(order, "utf8").toString("base64url"));
  target.searchParams.set("p", proof);
  return target.toString();
}

function parseDurableManifestTarget(value: string): { order: string; proof: string } | undefined {
  try {
    const target = new URL(value);
    if (`${target.origin}${target.pathname}` !== DURABLE_MANIFEST_URL) return undefined;
    const encodedOrder = target.searchParams.get("o");
    const proof = target.searchParams.get("p");
    if (!encodedOrder || !proof) return undefined;
    const order = Buffer.from(encodedOrder, "base64url").toString("utf8");
    if (!order || order.length > 512) return undefined;
    return { order, proof };
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
    targetUrl: status.target_url,
    createdAt: status.created_at,
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
    if (!current || compareRecoveryProgress(cursor, current.cursor) > 0 ||
        (compareRecoveryProgress(cursor, current.cursor) === 0 && comment.id > current.id)) {
      current = { id: comment.id, cursor };
    }
  }
  return current;
}

function compareRecoveryProgress(left: RecoveryCursor, right: RecoveryCursor): number {
  if (left.complete_top_id !== right.complete_top_id) return left.complete_top_id - right.complete_top_id;
  if (left.scan_top_id !== right.scan_top_id) return left.scan_top_id - right.scan_top_id;
  if (left.phase !== right.phase) return left.phase === "materialize" ? 1 : -1;
  if (left.before_id !== right.before_id) return right.before_id - left.before_id;
  return left.page - right.page;
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

function compareCoordinatorSnapshots(left: CoordinatorSnapshot, right: CoordinatorSnapshot): number {
  return compareAuthorityOrder(coordinatorAuthorityOrder(left), coordinatorAuthorityOrder(right));
}

function coordinatorAuthorityOrder(snapshot: CoordinatorSnapshot): string {
  return `${snapshot.issue_updated_at}\u0000${snapshot.event_id}`;
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
