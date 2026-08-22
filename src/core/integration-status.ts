import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { type IntegrationAttestation } from "./attestations.js";
import { sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import type { FugueGitHub } from "./github.js";
import {
  createIntegrationRecord,
  createIntegrationRequest,
  integrationDispatchAuthorizationSchema,
  integrationRunTitle,
  integrationRequestSchema,
  parseIntegrationRecord,
  serializeIntegrationRecord,
  type IntegrationDispatchAuthorization,
  type IntegrationRecord,
  type IntegrationRequest,
  type IntegrationRunBinding,
} from "./integration-plan.js";
import {
  assertRepositoryDefaultBranchRevision,
  createProtocolComment,
  isTrustedProtocolComment,
  isTrustedProtocolWorkflowRun,
  readRepositoryDefaultBranchIdentity,
  signProtocolBody,
  verifyProtocolPublicationBodyAtRevision,
} from "./provenance.js";
import {
  compactFugueRecoveryAuthorityVariables,
  createFugueAuthorityVariable,
  deleteFugueAuthorityVariable,
  DurableProtocolRecoveryPendingError,
  getFugueAuthorityVariable,
  listFugueAuthorityVariables,
  publishDurableProtocolRecord,
  recoverDurableProtocolRecord,
  withFugueAuthorityNamespaceMutation,
} from "./state.js";

const INTEGRATION_COMMIT_PREFIX = "FUGUE_INT_C_";

const integrationCommitIdentitySchema = z.object({
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\d{10}_[0-9A-F]{16}$/),
});

export const integrationExactRunCommitSchema = integrationCommitIdentitySchema.extend({
  version: z.literal(1),
  kind: z.literal("integration_exact_run_commit"),
  run_id: z.number().int().positive(),
  run_attempt: z.literal(1),
  run_created_at: z.string().min(1),
  html_url: z.string().min(1),
});

export const integrationIdentityLostCommitSchema = integrationCommitIdentitySchema.extend({
  version: z.literal(1),
  kind: z.literal("integration_identity_lost_commit"),
  attempt: z.literal(1),
  boundary_created_at: z.string().min(1),
  fence_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  created_at: z.string().min(1),
});

export const integrationCommitSchema = z.discriminatedUnion("kind", [
  integrationExactRunCommitSchema,
  integrationIdentityLostCommitSchema,
]);

export type IntegrationExactRunCommit = z.infer<typeof integrationExactRunCommitSchema>;
export type IntegrationIdentityLostCommit = z.infer<typeof integrationIdentityLostCommitSchema>;
export type IntegrationCommit = z.infer<typeof integrationCommitSchema>;

export interface IntegrationCommitContext {
  requestId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  anchorName: string;
}

export interface IntegrationExactRunCandidate {
  runId: number;
  createdAt: string;
  htmlUrl: string;
}

export interface IntegrationIdentityLostCandidate {
  boundaryCreatedAt: string;
  fenceDigest: string;
  createdAt: string;
}

export interface IntegrationCommitStore {
  create(value: string): Promise<boolean>;
  read(): Promise<string | undefined>;
}

export function integrationCommitVariableName(requestId: string): string {
  if (!/^int-[0-9a-f]{16}-[0-9a-f]{16}$/.test(requestId)) {
    throw new Error("Invalid Integration request ID for request-local commit serialization.");
  }
  const suffix = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 32).toUpperCase();
  return `${INTEGRATION_COMMIT_PREFIX}${suffix}`;
}

function assertCommitIdentity(commit: IntegrationCommit, context: IntegrationCommitContext): void {
  if (commit.request_id !== context.requestId || commit.pr_number !== context.prNumber ||
      commit.head_sha.toLowerCase() !== context.headSha.toLowerCase() ||
      commit.base_sha.toLowerCase() !== context.baseSha.toLowerCase() ||
      commit.anchor_name !== context.anchorName) {
    throw new Error(`Protected Integration commit slot for ${context.requestId} belongs to another evaluation identity.`);
  }
  if (commit.kind === "integration_exact_run_commit") {
    if (!Number.isFinite(Date.parse(commit.run_created_at)) || !commit.html_url) {
      throw new Error(`Protected Integration exact-run commit for ${context.requestId} is malformed.`);
    }
  } else if (!Number.isFinite(Date.parse(commit.boundary_created_at)) || !Number.isFinite(Date.parse(commit.created_at))) {
    throw new Error(`Protected Integration identity-lost commit for ${context.requestId} is malformed.`);
  }
}

export function parseIntegrationCommit(raw: string, context: IntegrationCommitContext): IntegrationCommit {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new Error(`Protected Integration commit slot for ${context.requestId} is malformed.`); }
  const commit = integrationCommitSchema.parse(value);
  assertCommitIdentity(commit, context);
  return commit;
}

export async function claimIntegrationCommitWithStore(
  store: IntegrationCommitStore,
  context: IntegrationCommitContext,
  candidate: IntegrationCommit,
): Promise<IntegrationCommit> {
  const serialized = JSON.stringify(integrationCommitSchema.parse(candidate));
  const created = await store.create(serialized);
  const committed = created ? serialized : await store.read();
  if (!committed) {
    throw new Error(`Protected Integration commit slot ${integrationCommitVariableName(context.requestId)} disappeared during serialization.`);
  }
  return parseIntegrationCommit(committed, context);
}

export async function readIntegrationCommit(
  github: FugueGitHub,
  context: IntegrationCommitContext,
): Promise<IntegrationCommit | undefined> {
  const raw = await getFugueAuthorityVariable(github, integrationCommitVariableName(context.requestId));
  return raw === undefined ? undefined : parseIntegrationCommit(raw, context);
}

async function claimIntegrationCommit(
  github: FugueGitHub,
  context: IntegrationCommitContext,
  candidate: IntegrationCommit,
): Promise<IntegrationCommit> {
  const name = integrationCommitVariableName(context.requestId);
  return claimIntegrationCommitWithStore({
    create: (value) => createFugueAuthorityVariable(github, name, value),
    read: () => getFugueAuthorityVariable(github, name),
  }, context, candidate);
}

export async function claimExactIntegrationCommit(
  github: FugueGitHub,
  context: IntegrationCommitContext,
  candidate: IntegrationExactRunCandidate,
): Promise<IntegrationExactRunCommit> {
  if (!Number.isSafeInteger(candidate.runId) || candidate.runId <= 0 ||
      !Number.isFinite(Date.parse(candidate.createdAt)) || !candidate.htmlUrl) {
    throw new Error("Protected Integration exact-run commit candidate is malformed.");
  }
  const winner = await claimIntegrationCommit(github, context, integrationExactRunCommitSchema.parse({
    version: 1,
    kind: "integration_exact_run_commit",
    request_id: context.requestId,
    pr_number: context.prNumber,
    head_sha: context.headSha,
    base_sha: context.baseSha,
    anchor_name: context.anchorName,
    run_id: candidate.runId,
    run_attempt: 1,
    run_created_at: candidate.createdAt,
    html_url: candidate.htmlUrl,
  }));
  if (winner.kind === "integration_identity_lost_commit") {
    throw new Error(`Integration request ${context.requestId} already committed terminal identity_lost serialization.`);
  }
  if (winner.run_id !== candidate.runId || winner.html_url !== candidate.htmlUrl) {
    throw new Error(`Integration request ${context.requestId} already committed protected run ${winner.run_id}.`);
  }
  return winner;
}

export async function claimIdentityLostIntegrationCommit(
  github: FugueGitHub,
  context: IntegrationCommitContext,
  candidate: IntegrationIdentityLostCandidate,
): Promise<IntegrationCommit> {
  if (!Number.isFinite(Date.parse(candidate.boundaryCreatedAt)) ||
      !/^sha256:[0-9a-f]{64}$/i.test(candidate.fenceDigest) ||
      !Number.isFinite(Date.parse(candidate.createdAt))) {
    throw new Error("Protected Integration identity_lost commit candidate is malformed.");
  }
  const winner = await claimIntegrationCommit(github, context, integrationIdentityLostCommitSchema.parse({
    version: 1,
    kind: "integration_identity_lost_commit",
    request_id: context.requestId,
    pr_number: context.prNumber,
    head_sha: context.headSha,
    base_sha: context.baseSha,
    anchor_name: context.anchorName,
    attempt: 1,
    boundary_created_at: candidate.boundaryCreatedAt,
    fence_digest: candidate.fenceDigest,
    created_at: candidate.createdAt,
  }));
  if (winner.kind === "integration_identity_lost_commit" &&
      (winner.boundary_created_at !== candidate.boundaryCreatedAt ||
       winner.fence_digest.toLowerCase() !== candidate.fenceDigest.toLowerCase())) {
    throw new Error(`Integration request ${context.requestId} has conflicting identity_lost serialization evidence.`);
  }
  return winner;
}

export async function releaseIntegrationCommit(github: FugueGitHub, requestId: string): Promise<void> {
  await deleteFugueAuthorityVariable(github, integrationCommitVariableName(requestId));
}

export type IntegrationState = "none" | "pending" | "success" | "failure" | "error" | "identity_lost" | "stale";

export interface CurrentIntegrationState {
  state: IntegrationState;
  targetUrl?: string | undefined;
  attestation?: IntegrationAttestation;
  request?: IntegrationRequest;
}

export interface IntegrationWorkflowRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  attempt: 1;
}

interface WorkflowRunRecord {
  id: number;
  actor?: { login?: string | null; type?: string | null } | null;
  event: string;
  head_sha: string;
  display_title: string;
  created_at: string | null;
  run_attempt?: number;
  status: string | null;
  conclusion: string | null;
  html_url: string;
}

const INTEGRATION_RECEIPT = "Fugue-Authority-Receipt: integration-d3";
export const INTEGRATION_REQUEST_RECOVERY_GRACE_MS = 10 * 60 * 1000;
const INTEGRATION_DISPATCH_ANCHOR_START = "<!-- fugue-integration-dispatch-anchor";
const INTEGRATION_RUN_START = "<!-- fugue-integration-run-start";
const HISTORICAL_INTEGRATION_IDENTITY_LOST_START = "<!-- fugue-historical-integration-identity-lost";
const HISTORICAL_INTEGRATION_EXACT_RUN_START = "<!-- fugue-historical-integration-exact-run";
const DURABLE_RECOVERY_START = "<!-- fugue-durable-recovery";
const PROTOCOL_END = "-->";
const INTEGRATION_ELECTION_PREFIX = "FUGUE_INT_E_";
const INTEGRATION_ANCHOR_PREFIX = "FUGUE_INT_A_";
const INTEGRATION_RUN_START_PREFIX = "FUGUE_INT_S_";
const INTEGRATION_DISPATCH_FENCE_PREFIX = "FUGUE_INT_F_";
const INTEGRATION_BINDING_WITNESS_PREFIX = "FUGUE_INT_B_";
const INTEGRATION_HISTORICAL_WINNER_PREFIX = "FUGUE_INT_H_";
export const INTEGRATION_AUTHORITY_SLOT_LIMIT = 64;

export function integrationDispatchRunToken(requestId: string, dispatchSecret: string): string {
  if (!/^int-[0-9a-f]{16}-[0-9a-f]{16}$/.test(requestId) || !/^[0-9a-f]{64}$/i.test(dispatchSecret)) {
    throw new Error("Invalid Integration run-correlation input.");
  }
  return createHmac("sha256", Buffer.from(dispatchSecret, "hex"))
    .update(`fugue-integration-run\0${requestId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function integrationRunTitleWithToken(request: IntegrationRequest, token: string): string {
  return `${integrationRunTitle(request.request_id, request.identity.prNumber)} ${token}`;
}

export class IntegrationAuthorityCapacityPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationAuthorityCapacityPendingError";
  }
}

const integrationDispatchAnchorSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_dispatch_anchor"),
  election_name: z.string().regex(/^FUGUE_INT_E_\d{10}_[0-9A-F]{16}_[0-9A-F]{8}$/),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\d{10}_[0-9A-F]{16}$/),
  predecessor_request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/).nullable(),
  request: integrationRequestSchema,
  secret_digest: z.string().regex(/^[0-9a-f]{64}$/i),
  dispatch_secret: z.string().regex(/^[0-9a-f]{64}$/i),
  authorized_at: z.string().min(1),
});

export const integrationRunStartSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_run_start"),
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  secret_digest: z.string().regex(/^[0-9a-f]{64}$/i),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\d{10}_[0-9A-F]{16}$/),
  run_id: z.number().int().positive(),
  run_attempt: z.literal(1),
  created_at: z.string().min(1),
});

export type IntegrationRunStartEvidence = z.infer<typeof integrationRunStartSchema>;
type IntegrationDispatchAnchor = z.infer<typeof integrationDispatchAnchorSchema>;

const historicalIntegrationFenceSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_dispatch_fence"),
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\d{10}_[0-9A-F]{16}$/),
  secret_digest: z.string().regex(/^[0-9a-f]{64}$/i),
  run_token: z.string().regex(/^[0-9a-f]{24}$/i),
  authority_actor_id: z.number().int().positive(),
  created_at: z.string().min(1),
});

const historicalIntegrationBindingWitnessSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_binding_witness"),
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\d{10}_[0-9A-F]{16}$/),
  run_token: z.string().regex(/^[0-9a-f]{24}$/i),
  authority_actor_id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  run_attempt: z.literal(1),
  run_created_at: z.string().min(1),
  html_url: z.string().min(1),
});

const historicalIntegrationIdentityLostTombstoneSchema = z.object({
  version: z.literal(1),
  kind: z.literal("historical_integration_identity_lost"),
  request: integrationRequestSchema,
  dispatch: integrationDispatchAuthorizationSchema,
  commit: integrationIdentityLostCommitSchema,
  historical_record_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  recovery_base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  created_at: z.string().min(1),
});

const historicalIntegrationExactRunBridgeSchema = z.object({
  version: z.literal(1),
  kind: z.literal("historical_integration_exact_run"),
  request: integrationRequestSchema,
  dispatch: integrationDispatchAuthorizationSchema,
  commit: integrationExactRunCommitSchema,
  historical_record_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  recovery_base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  created_at: z.string().min(1),
});

const historicalIntegrationWinnerClaimSchema = z.object({
  version: z.literal(1),
  kind: z.literal("historical_integration_winner_claim"),
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\d{10}_[0-9A-F]{16}$/),
  historical_record_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  recovery_base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  commit: integrationCommitSchema,
  created_at: z.string().min(1),
});

type HistoricalIntegrationFence = z.infer<typeof historicalIntegrationFenceSchema>;
type HistoricalIntegrationBindingWitness = z.infer<typeof historicalIntegrationBindingWitnessSchema>;
type HistoricalIntegrationIdentityLostTombstone = z.infer<typeof historicalIntegrationIdentityLostTombstoneSchema>;
type HistoricalIntegrationExactRunBridge = z.infer<typeof historicalIntegrationExactRunBridgeSchema>;
type HistoricalIntegrationWinnerClaim = z.infer<typeof historicalIntegrationWinnerClaimSchema>;
type HistoricalIntegrationWinner = HistoricalIntegrationIdentityLostTombstone | HistoricalIntegrationExactRunBridge;

type HistoricalIntegrationHintKind = "anchor" | "fence" | "binding" | "start" | "commit_exact" | "commit_identity_lost";
interface HistoricalIntegrationAuthorityHint {
  kind: HistoricalIntegrationHintKind;
  variableName: string;
  raw: string;
  requestId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  anchorName: string;
  runId?: number;
  createdAt?: string;
  htmlUrl?: string;
  boundaryCreatedAt?: string;
  fenceDigest?: string;
}

interface RecoveredHistoricalIntegrationRecord {
  record: IntegrationRecord;
  body: string;
}

const HISTORICAL_INTEGRATION_CLEANUP_BUDGET = 16;
const HISTORICAL_INTEGRATION_RECOVERY_SLICES = 4;
const HISTORICAL_INTEGRATION_WINNER_CLAIM_CLEANUP_BUDGET = 4;
export const HISTORICAL_INTEGRATION_H_ONLY_CLEANUP_BUDGET = 16;

export interface CleanupAwareRunStartContext {
  requestId: string;
  prNumber: number;
  baseSha: string;
  anchorName: string;
  runId: number;
  runAttempt: number;
}

export function matchesCleanupAwareDurableRunStartBinding(
  record: IntegrationRecord,
  context: CleanupAwareRunStartContext,
): boolean {
  if (!record.dispatch || !record.run || context.runAttempt !== 1 || record.run.attempt !== 1) return false;
  if (!sameEvaluationIdentity(record.identity, record.request.identity)) return false;
  const nonce = context.requestId.match(/^int-[0-9a-f]{16}-([0-9a-f]{16})$/)?.[1];
  if (!nonce) return false;
  let canonical: IntegrationRequest;
  try { canonical = createIntegrationRequest(record.identity, record.request.created_at, nonce); }
  catch { return false; }
  const expectedAnchor = `${INTEGRATION_ANCHOR_PREFIX}${String(context.prNumber).padStart(10, "0")}_${integrationRequestToken(context.requestId)}`;
  return canonical.request_id === context.requestId &&
    record.request.request_id === context.requestId &&
    record.identity.prNumber === context.prNumber &&
    record.identity.baseSha.toLowerCase() === context.baseSha.toLowerCase() &&
    record.dispatch.anchor_name === context.anchorName && context.anchorName === expectedAnchor &&
    record.run.id === context.runId;
}

function encodeIntegrationEvidence(marker: string, value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${marker}\nversion: 1\npayload: ${payload}\n${PROTOCOL_END}`;
}

function parseIntegrationEvidence<T>(body: string, marker: string, schema: z.ZodType<T>): T | null {
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const end = body.indexOf(PROTOCOL_END, start + marker.length);
  if (end < 0) throw new Error(`Unterminated ${marker.slice(5)} block.`);
  const block = body.slice(start + marker.length, end).trim();
  const match = block.match(/^version: 1\npayload: ([A-Za-z0-9_-]+)$/);
  if (!match?.[1]) throw new Error(`Malformed ${marker.slice(5)} block.`);
  return schema.parse(JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as unknown);
}

function integrationRequestToken(requestId: string): string {
  return createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 16).toUpperCase();
}

function historicalIdentityLostScope(request: IntegrationRequest): string {
  return `int-hist/${request.identity.prNumber}/${integrationRequestToken(request.request_id)}`;
}

function historicalExactRunScope(request: IntegrationRequest): string {
  return `int-hist-run/${request.identity.prNumber}/${integrationRequestToken(request.request_id)}`;
}

function historicalRecordDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

function serializeHistoricalIntegrationIdentityLostTombstone(value: HistoricalIntegrationIdentityLostTombstone): string {
  return `${encodeIntegrationEvidence(
    HISTORICAL_INTEGRATION_IDENTITY_LOST_START,
    historicalIntegrationIdentityLostTombstoneSchema.parse(value),
  )}\n\nHISTORICAL INTEGRATION — IDENTITY LOST`;
}

function parseHistoricalIntegrationIdentityLostTombstone(body: string): HistoricalIntegrationIdentityLostTombstone | null {
  return parseIntegrationEvidence(
    body,
    HISTORICAL_INTEGRATION_IDENTITY_LOST_START,
    historicalIntegrationIdentityLostTombstoneSchema,
  );
}

function serializeHistoricalIntegrationExactRunBridge(value: HistoricalIntegrationExactRunBridge): string {
  return `${encodeIntegrationEvidence(
    HISTORICAL_INTEGRATION_EXACT_RUN_START,
    historicalIntegrationExactRunBridgeSchema.parse(value),
  )}\n\nHISTORICAL INTEGRATION — EXACT RUN`;
}

function parseHistoricalIntegrationExactRunBridge(body: string): HistoricalIntegrationExactRunBridge | null {
  return parseIntegrationEvidence(
    body,
    HISTORICAL_INTEGRATION_EXACT_RUN_START,
    historicalIntegrationExactRunBridgeSchema,
  );
}

function integrationIdentityToken(request: IntegrationRequest): string {
  const match = request.request_id.match(/^int-([0-9a-f]{16})-[0-9a-f]{16}$/);
  if (!match?.[1]) throw new Error("Invalid Integration request identity token.");
  return match[1].toUpperCase();
}

function predecessorToken(predecessorRequestId?: string): string {
  if (!predecessorRequestId) return "00000000";
  if (!/^int-[0-9a-f]{16}-[0-9a-f]{16}$/.test(predecessorRequestId)) {
    throw new Error("Invalid Integration predecessor request ID.");
  }
  return createHash("sha256").update(predecessorRequestId, "utf8").digest("hex").slice(0, 8).toUpperCase();
}

export function integrationElectionVariableName(request: IntegrationRequest, predecessorRequestId?: string): string {
  return `${INTEGRATION_ELECTION_PREFIX}${String(request.identity.prNumber).padStart(10, "0")}_${integrationIdentityToken(request)}_${predecessorToken(predecessorRequestId)}`;
}

export function integrationAnchorVariableName(request: IntegrationRequest): string {
  return `${INTEGRATION_ANCHOR_PREFIX}${String(request.identity.prNumber).padStart(10, "0")}_${integrationRequestToken(request.request_id)}`;
}

export function integrationRunStartVariableName(request: IntegrationRequest): string {
  return `${INTEGRATION_RUN_START_PREFIX}${String(request.identity.prNumber).padStart(10, "0")}_${integrationRequestToken(request.request_id)}`;
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

function historicalIntegrationWinnerClaimPrefix(requestId: string): string {
  return `${INTEGRATION_HISTORICAL_WINNER_PREFIX}${integrationRecoverySuffix(requestId)}_`;
}

function historicalIntegrationWinnerClaimName(requestId: string, recoveryBaseSha: string): string {
  if (!/^[0-9a-f]{40}$/i.test(recoveryBaseSha)) throw new Error("Invalid historical Integration recovery base SHA.");
  return `${historicalIntegrationWinnerClaimPrefix(requestId)}${recoveryBaseSha.toUpperCase()}`;
}

export function serializeIntegrationRunStartEvidence(value: IntegrationRunStartEvidence): string {
  return `${encodeIntegrationEvidence(INTEGRATION_RUN_START, integrationRunStartSchema.parse(value))}\n\nINTEGRATION RUN — STARTED`;
}

function serializeIntegrationDispatchAnchor(value: IntegrationDispatchAnchor): string {
  return `${encodeIntegrationEvidence(INTEGRATION_DISPATCH_ANCHOR_START, integrationDispatchAnchorSchema.parse(value))}\n\nINTEGRATION DISPATCH — AUTHORIZED`;
}

function parseIntegrationDispatchAnchor(body: string): IntegrationDispatchAnchor | null {
  return parseIntegrationEvidence(body, INTEGRATION_DISPATCH_ANCHOR_START, integrationDispatchAnchorSchema);
}

function parseIntegrationRunStart(body: string): IntegrationRunStartEvidence | null {
  return parseIntegrationEvidence(body, INTEGRATION_RUN_START, integrationRunStartSchema);
}

function integrationCommitContext(record: IntegrationRecord): IntegrationCommitContext | undefined {
  if (!record.dispatch) return undefined;
  return {
    requestId: record.request.request_id,
    prNumber: record.identity.prNumber,
    headSha: record.identity.headSha,
    baseSha: record.identity.baseSha,
    anchorName: record.dispatch.anchor_name,
  };
}

function integrationRunBindingFromCommit(github: FugueGitHub, commit: IntegrationExactRunCommit): IntegrationRunBinding {
  const expectedUrl = `https://github.com/${github.repository.fullName}/actions/runs/${commit.run_id}`;
  if (commit.html_url !== expectedUrl) {
    throw new Error(`Protected Integration exact-run commit ${commit.request_id} has an invalid run URL.`);
  }
  return { id: commit.run_id, attempt: 1, created_at: commit.run_created_at, html_url: commit.html_url };
}

async function verifiedIntegrationAnchor(
  github: FugueGitHub,
  body: string,
  expectedIdentity?: IntegrationRequest["identity"],
): Promise<IntegrationDispatchAnchor | undefined> {
  let anchor: IntegrationDispatchAnchor | null;
  try { anchor = parseIntegrationDispatchAnchor(body); } catch { return undefined; }
  if (!anchor) return undefined;
  const nonce = anchor.request.request_id.match(/^int-[0-9a-f]{16}-([0-9a-f]{16})$/)?.[1];
  if (!nonce) return undefined;
  const canonicalRequest = createIntegrationRequest(anchor.request.identity, anchor.request.created_at, nonce);
  if (canonicalRequest.request_id !== anchor.request.request_id || canonicalRequest.created_at !== anchor.request.created_at) {
    return undefined;
  }
  if (anchor.election_name !== integrationElectionVariableName(anchor.request, anchor.predecessor_request_id ?? undefined) ||
      anchor.anchor_name !== integrationAnchorVariableName(anchor.request) ||
      createHash("sha256").update(anchor.dispatch_secret, "utf8").digest("hex") !== anchor.secret_digest) {
    return undefined;
  }
  if (expectedIdentity && !sameEvaluationIdentity(anchor.request.identity, expectedIdentity)) return undefined;
  const timestamp = Date.parse(anchor.authorized_at);
  if (!Number.isFinite(timestamp)) return undefined;
  try {
    if (!(await verifyProtocolPublicationBodyAtRevision(github, body, anchor.request.identity.baseSha, timestamp))) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return anchor;
}

export async function authorizeIntegrationDispatch(
  github: FugueGitHub,
  request: IntegrationRequest,
  authorizedAt = new Date().toISOString(),
  secret = randomBytes(32).toString("hex"),
  predecessorRequestId?: string,
): Promise<{ secret: string; authorization: IntegrationDispatchAuthorization; request: IntegrationRequest; electionName: string }> {
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error("Integration dispatch secret must be 256-bit hexadecimal.");
  const timestamp = Date.parse(authorizedAt);
  if (!Number.isFinite(timestamp)) throw new Error("Integration dispatch authorization time is invalid.");
  await reclaimOrphanIntegrationAuthorityVariables(github, timestamp, [request.identity]);
  await compactFugueRecoveryAuthorityVariables(github, undefined, 2);
  await assertRepositoryDefaultBranchRevision(github, request.identity.baseSha);

  const electionName = integrationElectionVariableName(request, predecessorRequestId);
  const candidateAnchor = integrationDispatchAnchorSchema.parse({
    version: 1,
    kind: "integration_dispatch_anchor",
    election_name: electionName,
    anchor_name: integrationAnchorVariableName(request),
    predecessor_request_id: predecessorRequestId ?? null,
    request,
    secret_digest: createHash("sha256").update(secret, "utf8").digest("hex"),
    dispatch_secret: secret,
    authorized_at: authorizedAt,
  });
  const signedCandidate = await signProtocolBody(github, serializeIntegrationDispatchAnchor(candidateAnchor));
  if (!(await verifyProtocolPublicationBodyAtRevision(github, signedCandidate, request.identity.baseSha, timestamp))) {
    throw new Error("Protected Integration election anchor failed publisher self-check.");
  }

  let electionBody = await getFugueAuthorityVariable(github, electionName);
  if (!electionBody) {
    const active = await listFugueAuthorityVariables(github, INTEGRATION_ANCHOR_PREFIX);
    if (active.length >= INTEGRATION_AUTHORITY_SLOT_LIMIT) {
      await reclaimOrphanIntegrationAuthorityVariables(github, timestamp, [request.identity]);
      const remaining = await listFugueAuthorityVariables(github, INTEGRATION_ANCHOR_PREFIX);
      if (remaining.length >= INTEGRATION_AUTHORITY_SLOT_LIMIT) {
        throw new IntegrationAuthorityCapacityPendingError(
          `Protected Integration authority has ${remaining.length} active request anchors; scheduled reclamation found no safe pre-d3 orphan to reclaim.`,
        );
      }
    }
  }

  return withFugueAuthorityNamespaceMutation(github, async () => {
    electionBody = await getFugueAuthorityVariable(github, electionName);
    if (!electionBody) {
      const created = await createFugueAuthorityVariable(github, electionName, signedCandidate);
      electionBody = created ? signedCandidate : await getFugueAuthorityVariable(github, electionName);
      if (!electionBody) {
        throw new IntegrationAuthorityCapacityPendingError(
          "Repository Authority-variable capacity is temporarily full; Fugue retained every live d3 cursor/request authority and will retry after safe reclamation.",
        );
      }
    }

    const winner = await verifiedIntegrationAnchor(github, electionBody, request.identity);
    if (!winner || winner.election_name !== electionName ||
        (winner.predecessor_request_id ?? undefined) !== predecessorRequestId) {
      throw new Error(`Protected Integration election ${electionName} is malformed or belongs to another retry generation.`);
    }

    let anchorBody = await getFugueAuthorityVariable(github, winner.anchor_name);
    if (!anchorBody) {
      const created = await createFugueAuthorityVariable(github, winner.anchor_name, electionBody);
      anchorBody = created ? electionBody : await getFugueAuthorityVariable(github, winner.anchor_name);
    }
    if (anchorBody !== electionBody) {
      throw new Error(`Protected Integration request anchor ${winner.anchor_name} did not preserve the elected immutable value.`);
    }

    return {
      secret: winner.dispatch_secret,
      request: winner.request,
      electionName,
      authorization: integrationDispatchAuthorizationSchema.parse({
        secret_digest: winner.secret_digest,
        authorized_at: winner.authorized_at,
        anchor_name: winner.anchor_name,
      }),
    };
  });
}

async function verifyIntegrationDispatchAnchor(
  github: FugueGitHub,
  record: IntegrationRecord,
  body: string,
): Promise<IntegrationDispatchAnchor | undefined> {
  const anchor = await verifiedIntegrationAnchor(github, body, record.identity);
  if (!anchor || !record.dispatch) return undefined;
  if (anchor.request.request_id !== record.request.request_id ||
      anchor.secret_digest !== record.dispatch.secret_digest ||
      anchor.authorized_at !== record.dispatch.authorized_at ||
      anchor.anchor_name !== record.dispatch.anchor_name) return undefined;
  return anchor;
}

export async function getIntegrationRunStartEvidence(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationRunStartEvidence | undefined> {
  if (!record.dispatch) return undefined;
  const context = integrationCommitContext(record)!;
  const commit = await readIntegrationCommit(github, context);
  if (commit?.kind === "integration_identity_lost_commit") return undefined;
  if (commit?.kind === "integration_exact_run_commit") {
    const binding = integrationRunBindingFromCommit(github, commit);
    return integrationRunStartSchema.parse({
      version: 1,
      kind: "integration_run_start",
      request_id: record.request.request_id,
      pr_number: record.identity.prNumber,
      head_sha: record.identity.headSha,
      base_sha: record.identity.baseSha,
      secret_digest: record.dispatch.secret_digest,
      anchor_name: record.dispatch.anchor_name,
      run_id: binding.id,
      run_attempt: 1,
      created_at: binding.created_at,
    });
  }

  const anchorBody = await getFugueAuthorityVariable(github, record.dispatch.anchor_name);
  const startName = integrationRunStartVariableName(record.request);
  const body = await getFugueAuthorityVariable(github, startName);
  if (!anchorBody) {
    if (!body) return undefined;
  } else if (!(await verifyIntegrationDispatchAnchor(github, record, anchorBody))) {
    throw new Error(`Protected Integration request anchor ${record.dispatch.anchor_name} does not match its durable request.`);
  }
  if (!body) return undefined;
  let start: IntegrationRunStartEvidence | null;
  try { start = parseIntegrationRunStart(body); } catch { start = null; }
  if (!start || start.request_id !== record.request.request_id || start.pr_number !== record.identity.prNumber ||
      start.head_sha !== record.identity.headSha || start.base_sha !== record.identity.baseSha ||
      start.secret_digest !== record.dispatch.secret_digest || start.anchor_name !== record.dispatch.anchor_name ||
      start.run_attempt !== 1) {
    throw new Error(`Protected Integration run-start evidence ${startName} does not match its durable request.`);
  }
  const startTimestamp = Date.parse(start.created_at);
  if (!Number.isFinite(startTimestamp) ||
      !(await verifyProtocolPublicationBodyAtRevision(github, body, record.identity.baseSha, startTimestamp))) {
    throw new Error(`Protected Integration run-start evidence ${startName} has invalid provenance.`);
  }
  return start;
}

export async function releaseIntegrationAuthorityVariable(github: FugueGitHub, record: IntegrationRecord): Promise<void> {
  if (!record.dispatch) return;
  await withFugueAuthorityNamespaceMutation(github, async () => {
    await deleteFugueAuthorityVariable(github, integrationDispatchFenceName(record.request.request_id));
    await deleteFugueAuthorityVariable(github, record.dispatch!.anchor_name);
    await deleteFugueAuthorityVariable(github, integrationBindingWitnessName(record.request.request_id));
    await deleteFugueAuthorityVariable(github, integrationRunStartVariableName(record.request));
    await releaseIntegrationCommit(github, record.request.request_id);
  });
}

async function retireIntegrationElection(github: FugueGitHub, electionName: string): Promise<void> {
  await deleteFugueAuthorityVariable(github, electionName);
}

function parseHistoricalJson<T>(raw: string, schema: z.ZodType<T>): T | undefined {
  try { return schema.parse(JSON.parse(raw) as unknown); }
  catch { return undefined; }
}

async function historicalIntegrationAuthorityHint(
  github: FugueGitHub,
  variable: { name: string; value: string },
): Promise<HistoricalIntegrationAuthorityHint | undefined> {
  const { name, value } = variable;
  if (name.startsWith(INTEGRATION_ANCHOR_PREFIX)) {
    const anchor = await verifiedIntegrationAnchor(github, value);
    if (!anchor || anchor.anchor_name !== name) return undefined;
    return {
      kind: "anchor", variableName: name, raw: value,
      requestId: anchor.request.request_id, prNumber: anchor.request.identity.prNumber,
      headSha: anchor.request.identity.headSha, baseSha: anchor.request.identity.baseSha,
      anchorName: anchor.anchor_name,
    };
  }
  if (name.startsWith(INTEGRATION_DISPATCH_FENCE_PREFIX)) {
    const fence = parseHistoricalJson(value, historicalIntegrationFenceSchema);
    if (!fence || integrationDispatchFenceName(fence.request_id) !== name || !Number.isFinite(Date.parse(fence.created_at))) return undefined;
    return {
      kind: "fence", variableName: name, raw: value,
      requestId: fence.request_id, prNumber: fence.pr_number, headSha: fence.head_sha, baseSha: fence.base_sha,
      anchorName: fence.anchor_name, createdAt: fence.created_at,
    };
  }
  if (name.startsWith(INTEGRATION_BINDING_WITNESS_PREFIX)) {
    const witness = parseHistoricalJson(value, historicalIntegrationBindingWitnessSchema);
    if (!witness || integrationBindingWitnessName(witness.request_id) !== name ||
        !Number.isFinite(Date.parse(witness.run_created_at))) return undefined;
    return {
      kind: "binding", variableName: name, raw: value,
      requestId: witness.request_id, prNumber: witness.pr_number, headSha: witness.head_sha, baseSha: witness.base_sha,
      anchorName: witness.anchor_name, runId: witness.run_id, createdAt: witness.run_created_at, htmlUrl: witness.html_url,
    };
  }
  if (name.startsWith(INTEGRATION_RUN_START_PREFIX)) {
    let start: IntegrationRunStartEvidence | null;
    try { start = parseIntegrationRunStart(value); } catch { start = null; }
    if (!start) return undefined;
    const expectedName = `${INTEGRATION_RUN_START_PREFIX}${String(start.pr_number).padStart(10, "0")}_${integrationRequestToken(start.request_id)}`;
    const timestamp = Date.parse(start.created_at);
    if (name !== expectedName || !Number.isFinite(timestamp)) return undefined;
    try {
      if (!(await verifyProtocolPublicationBodyAtRevision(github, value, start.base_sha, timestamp))) return undefined;
    } catch { return undefined; }
    return {
      kind: "start", variableName: name, raw: value,
      requestId: start.request_id, prNumber: start.pr_number, headSha: start.head_sha, baseSha: start.base_sha,
      anchorName: start.anchor_name, runId: start.run_id, createdAt: start.created_at,
      htmlUrl: `https://github.com/${github.repository.fullName}/actions/runs/${start.run_id}`,
    };
  }
  if (name.startsWith(INTEGRATION_COMMIT_PREFIX)) {
    let parsed: unknown;
    try { parsed = JSON.parse(value) as unknown; } catch { return undefined; }
    const result = integrationCommitSchema.safeParse(parsed);
    if (!result.success || integrationCommitVariableName(result.data.request_id) !== name) return undefined;
    const commit = result.data;
    return commit.kind === "integration_exact_run_commit"
      ? {
          kind: "commit_exact", variableName: name, raw: value,
          requestId: commit.request_id, prNumber: commit.pr_number, headSha: commit.head_sha, baseSha: commit.base_sha,
          anchorName: commit.anchor_name, runId: commit.run_id, createdAt: commit.run_created_at, htmlUrl: commit.html_url,
        }
      : {
          kind: "commit_identity_lost", variableName: name, raw: value,
          requestId: commit.request_id, prNumber: commit.pr_number, headSha: commit.head_sha, baseSha: commit.base_sha,
          anchorName: commit.anchor_name, boundaryCreatedAt: commit.boundary_created_at,
          fenceDigest: commit.fence_digest, createdAt: commit.created_at,
        };
  }
  return undefined;
}

function historicalHintKey(hint: HistoricalIntegrationAuthorityHint): string {
  return `${hint.prNumber}:${hint.headSha.toLowerCase()}:${hint.baseSha.toLowerCase()}:${hint.requestId}`;
}

async function recoverHistoricalIntegrationRecord(
  github: FugueGitHub,
  hint: HistoricalIntegrationAuthorityHint,
): Promise<RecoveredHistoricalIntegrationRecord | undefined> {
  for (let attempt = 0; attempt < HISTORICAL_INTEGRATION_RECOVERY_SLICES; attempt += 1) {
    try {
      const recovered = await recoverDurableProtocolRecord(github, {
        storageSha: hint.headSha,
        publisherSha: hint.baseSha,
        scope: integrationScope(hint.prNumber),
        issueNumber: hint.prNumber,
        parse: parseIntegrationRecord,
        timestamp: (value) => Date.parse(value.created_at),
        order: (value) => value.created_at,
        validate: (value) => value.identity.prNumber === hint.prNumber &&
          value.identity.headSha.toLowerCase() === hint.headSha.toLowerCase() &&
          value.identity.baseSha.toLowerCase() === hint.baseSha.toLowerCase() &&
          sameEvaluationIdentity(value.identity, value.request.identity) &&
          value.request.request_id === hint.requestId && value.dispatch?.anchor_name === hint.anchorName,
      });
      if (recovered.record) return { record: recovered.record.value, body: recovered.record.body };
      if (recovered.exhausted) return undefined;
    } catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return undefined;
}

function historicalFenceMatchesRecord(fence: HistoricalIntegrationFence, record: IntegrationRecord): boolean {
  return Boolean(record.dispatch) && fence.request_id === record.request.request_id &&
    fence.pr_number === record.identity.prNumber && fence.head_sha.toLowerCase() === record.identity.headSha.toLowerCase() &&
    fence.base_sha.toLowerCase() === record.identity.baseSha.toLowerCase() && fence.anchor_name === record.dispatch!.anchor_name &&
    fence.secret_digest.toLowerCase() === record.dispatch!.secret_digest.toLowerCase() && Number.isFinite(Date.parse(fence.created_at));
}

function historicalBindingMatchesRequest(
  github: FugueGitHub,
  witness: HistoricalIntegrationBindingWitness,
  record: IntegrationRecord,
): boolean {
  if (!record.dispatch) return false;
  const requestCreatedAt = Date.parse(record.request.created_at);
  const runCreatedAt = Date.parse(witness.run_created_at);
  return witness.request_id === record.request.request_id && witness.pr_number === record.identity.prNumber &&
    witness.head_sha.toLowerCase() === record.identity.headSha.toLowerCase() &&
    witness.base_sha.toLowerCase() === record.identity.baseSha.toLowerCase() && witness.anchor_name === record.dispatch.anchor_name &&
    witness.run_attempt === 1 && Number.isFinite(runCreatedAt) && Number.isFinite(requestCreatedAt) && runCreatedAt >= requestCreatedAt &&
    witness.html_url === `https://github.com/${github.repository.fullName}/actions/runs/${witness.run_id}`;
}

async function historicalRunStartMatchesRequest(
  github: FugueGitHub,
  start: IntegrationRunStartEvidence,
  raw: string,
  record: IntegrationRecord,
): Promise<boolean> {
  if (!record.dispatch) return false;
  const timestamp = Date.parse(start.created_at);
  const requestCreatedAt = Date.parse(record.request.created_at);
  if (start.request_id !== record.request.request_id || start.pr_number !== record.identity.prNumber ||
      start.head_sha.toLowerCase() !== record.identity.headSha.toLowerCase() ||
      start.base_sha.toLowerCase() !== record.identity.baseSha.toLowerCase() ||
      start.secret_digest.toLowerCase() !== record.dispatch.secret_digest.toLowerCase() ||
      start.anchor_name !== record.dispatch.anchor_name || start.run_attempt !== 1 ||
      !Number.isFinite(timestamp) || !Number.isFinite(requestCreatedAt) || timestamp < requestCreatedAt) return false;
  try { return await verifyProtocolPublicationBodyAtRevision(github, raw, record.identity.baseSha, timestamp); }
  catch { return false; }
}

function recoveryAuthorityBodies(value: string): string[] {
  if (value.trimStart().startsWith(DURABLE_RECOVERY_START)) return [value];
  try {
    const parsed = JSON.parse(value) as { kind?: unknown; entries?: unknown };
    if (parsed.kind !== "durable_recovery_pack" || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function recoveryPublisherHint(body: string, storageSha: string, scope: string): string | undefined {
  const start = body.indexOf(DURABLE_RECOVERY_START);
  if (start < 0) return undefined;
  const end = body.indexOf(PROTOCOL_END, start + DURABLE_RECOVERY_START.length);
  if (end < 0) return undefined;
  const block = body.slice(start + DURABLE_RECOVERY_START.length, end).trim();
  const payload = block.match(/^version: 1\npayload: ([A-Za-z0-9_-]+)$/)?.[1];
  if (!payload) return undefined;
  try {
    const cursor = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      scope?: unknown; storage_sha?: unknown; publisher_sha?: unknown; commit_witness?: unknown;
    };
    if (cursor.commit_witness !== true || cursor.scope !== scope ||
        typeof cursor.storage_sha !== "string" || cursor.storage_sha.toLowerCase() !== storageSha.toLowerCase() ||
        typeof cursor.publisher_sha !== "string" || !/^[0-9a-f]{40}$/i.test(cursor.publisher_sha)) return undefined;
    return cursor.publisher_sha.toLowerCase();
  } catch {
    return undefined;
  }
}

function historicalIdentityLostTombstoneMatches(
  tombstone: HistoricalIntegrationIdentityLostTombstone,
  historical: RecoveredHistoricalIntegrationRecord,
  publisherSha: string,
): boolean {
  const { record, body } = historical;
  if (!record.dispatch) return false;
  const commit = tombstone.commit;
  return tombstone.recovery_base_sha.toLowerCase() === publisherSha.toLowerCase() &&
    tombstone.historical_record_digest.toLowerCase() === historicalRecordDigest(body).toLowerCase() &&
    JSON.stringify(tombstone.request) === JSON.stringify(record.request) &&
    JSON.stringify(tombstone.dispatch) === JSON.stringify(record.dispatch) &&
    sameEvaluationIdentity(tombstone.request.identity, record.identity) &&
    commit.request_id === record.request.request_id && commit.pr_number === record.identity.prNumber &&
    commit.head_sha.toLowerCase() === record.identity.headSha.toLowerCase() &&
    commit.base_sha.toLowerCase() === record.identity.baseSha.toLowerCase() &&
    commit.anchor_name === record.dispatch.anchor_name && commit.attempt === 1 &&
    Number.isFinite(Date.parse(commit.boundary_created_at)) && Number.isFinite(Date.parse(commit.created_at)) &&
    Number.isFinite(Date.parse(tombstone.created_at)) && Date.parse(tombstone.created_at) >= Date.parse(commit.created_at);
}

function historicalExactRunBridgeMatches(
  github: FugueGitHub,
  bridge: HistoricalIntegrationExactRunBridge,
  historical: RecoveredHistoricalIntegrationRecord,
  publisherSha: string,
): boolean {
  const { record, body } = historical;
  if (!record.dispatch || record.run || record.terminal) return false;
  const commit = bridge.commit;
  const expectedUrl = `https://github.com/${github.repository.fullName}/actions/runs/${commit.run_id}`;
  return bridge.recovery_base_sha.toLowerCase() === publisherSha.toLowerCase() &&
    bridge.historical_record_digest.toLowerCase() === historicalRecordDigest(body).toLowerCase() &&
    JSON.stringify(bridge.request) === JSON.stringify(record.request) &&
    JSON.stringify(bridge.dispatch) === JSON.stringify(record.dispatch) &&
    sameEvaluationIdentity(bridge.request.identity, record.identity) &&
    commit.request_id === record.request.request_id && commit.pr_number === record.identity.prNumber &&
    commit.head_sha.toLowerCase() === record.identity.headSha.toLowerCase() &&
    commit.base_sha.toLowerCase() === record.identity.baseSha.toLowerCase() &&
    commit.anchor_name === record.dispatch.anchor_name && commit.run_attempt === 1 && commit.html_url === expectedUrl &&
    Number.isFinite(Date.parse(commit.run_created_at)) && Number.isFinite(Date.parse(bridge.created_at)) &&
    Date.parse(bridge.created_at) >= Date.parse(commit.run_created_at);
}

function historicalWinnerClaimMatches(
  github: FugueGitHub,
  claim: HistoricalIntegrationWinnerClaim,
  historical: RecoveredHistoricalIntegrationRecord,
): boolean {
  const record = historical.record;
  if (!record.dispatch) return false;
  const context = integrationCommitContext(record)!;
  try { assertCommitIdentity(claim.commit, context); } catch { return false; }
  if (claim.request_id !== record.request.request_id || claim.pr_number !== record.identity.prNumber ||
      claim.head_sha.toLowerCase() !== record.identity.headSha.toLowerCase() ||
      claim.base_sha.toLowerCase() !== record.identity.baseSha.toLowerCase() ||
      claim.anchor_name !== record.dispatch.anchor_name ||
      claim.historical_record_digest.toLowerCase() !== historicalRecordDigest(historical.body).toLowerCase() ||
      !Number.isFinite(Date.parse(claim.created_at)) ||
      historicalIntegrationWinnerClaimName(record.request.request_id, claim.recovery_base_sha) !==
        historicalIntegrationWinnerClaimName(claim.request_id, claim.recovery_base_sha)) return false;
  if (claim.commit.kind === "integration_exact_run_commit") {
    return claim.commit.html_url === `https://github.com/${github.repository.fullName}/actions/runs/${claim.commit.run_id}` &&
      Number.isFinite(Date.parse(claim.commit.run_created_at));
  }
  return Number.isFinite(Date.parse(claim.commit.boundary_created_at)) && Number.isFinite(Date.parse(claim.commit.created_at));
}

function sameHistoricalIntegrationCommit(left: IntegrationCommit, right: IntegrationCommit): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function historicalIntegrationWinnerClaimCanBeReclaimed(input: {
  repositoryFullName: string;
  variableName: string;
  rawClaim: string;
  historicalRecord: IntegrationRecord;
  historicalBody: string;
  durableWinnerCommit: IntegrationCommit;
}): boolean {
  const claim = parseHistoricalJson(input.rawClaim, historicalIntegrationWinnerClaimSchema);
  if (!claim || !input.historicalRecord.dispatch) return false;
  if (input.variableName !== historicalIntegrationWinnerClaimName(claim.request_id, claim.recovery_base_sha)) return false;
  if (claim.recovery_base_sha.toLowerCase() === input.historicalRecord.identity.baseSha.toLowerCase()) return false;
  const historical: RecoveredHistoricalIntegrationRecord = { record: input.historicalRecord, body: input.historicalBody };
  const github = { repository: { fullName: input.repositoryFullName } } as FugueGitHub;
  if (!historicalWinnerClaimMatches(github, claim, historical)) return false;
  const durable = integrationCommitSchema.safeParse(input.durableWinnerCommit);
  if (!durable.success) return false;
  try { assertCommitIdentity(durable.data, integrationCommitContext(input.historicalRecord)!); }
  catch { return false; }
  const selectedAt = claim.commit.kind === "integration_exact_run_commit"
    ? Date.parse(claim.commit.run_created_at)
    : Date.parse(claim.commit.created_at);
  if (!Number.isFinite(selectedAt) || Date.parse(claim.created_at) < selectedAt) return false;
  return sameHistoricalIntegrationCommit(claim.commit, durable.data);
}

async function historicalRecoveryPublishers(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
  scope: string,
): Promise<string[]> {
  const publishers = new Set<string>();
  for (const variable of await listFugueAuthorityVariables(github, "FUGUE_D3")) {
    for (const body of recoveryAuthorityBodies(variable.value)) {
      const publisher = recoveryPublisherHint(body, historical.record.identity.headSha, scope);
      if (publisher) publishers.add(publisher);
    }
  }
  return [...publishers].sort();
}

async function recoverHistoricalIdentityLostTombstone(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
): Promise<HistoricalIntegrationIdentityLostTombstone | undefined> {
  const scope = historicalIdentityLostScope(historical.record.request);
  const publishers = await historicalRecoveryPublishers(github, historical, scope);
  let winner: HistoricalIntegrationIdentityLostTombstone | undefined;
  let pending = false;
  for (const publisherSha of publishers) {
    try {
      const recovered = await recoverDurableProtocolRecord(github, {
        storageSha: historical.record.identity.headSha,
        publisherSha,
        scope,
        issueNumber: historical.record.identity.prNumber,
        parse: parseHistoricalIntegrationIdentityLostTombstone,
        timestamp: (value) => Date.parse(value.created_at),
        order: (value) => value.created_at,
        validate: (value) => historicalIdentityLostTombstoneMatches(value, historical, publisherSha),
      });
      if (!recovered.record) continue;
      const candidate = recovered.record.value;
      if (winner && JSON.stringify(winner.commit) !== JSON.stringify(candidate.commit)) {
        throw new Error(`Historical Integration request ${historical.record.request.request_id} has conflicting protected identity_lost tombstones.`);
      }
      winner = candidate;
    } catch (error) {
      if (error instanceof DurableProtocolRecoveryPendingError) {
        pending = true;
        continue;
      }
      throw error;
    }
  }
  if (winner) return winner;
  if (pending) {
    throw new DurableProtocolRecoveryPendingError(
      `Historical Integration identity_lost tombstone for ${historical.record.request.request_id} exists but is not currently verifiable.`,
    );
  }
  return undefined;
}

async function recoverHistoricalExactRunBridge(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
): Promise<HistoricalIntegrationExactRunBridge | undefined> {
  const scope = historicalExactRunScope(historical.record.request);
  const publishers = await historicalRecoveryPublishers(github, historical, scope);
  let winner: HistoricalIntegrationExactRunBridge | undefined;
  let pending = false;
  for (const publisherSha of publishers) {
    try {
      const recovered = await recoverDurableProtocolRecord(github, {
        storageSha: historical.record.identity.headSha,
        publisherSha,
        scope,
        issueNumber: historical.record.identity.prNumber,
        parse: parseHistoricalIntegrationExactRunBridge,
        timestamp: (value) => Date.parse(value.created_at),
        order: (value) => value.created_at,
        validate: (value) => historicalExactRunBridgeMatches(github, value, historical, publisherSha),
      });
      if (!recovered.record) continue;
      const candidate = recovered.record.value;
      if (winner && JSON.stringify(winner.commit) !== JSON.stringify(candidate.commit)) {
        throw new Error(`Historical Integration request ${historical.record.request.request_id} has conflicting protected exact-run bridges.`);
      }
      winner = candidate;
    } catch (error) {
      if (error instanceof DurableProtocolRecoveryPendingError) {
        pending = true;
        continue;
      }
      throw error;
    }
  }
  if (winner) return winner;
  if (pending) {
    throw new DurableProtocolRecoveryPendingError(
      `Historical Integration exact-run bridge for ${historical.record.request.request_id} exists but is not currently verifiable.`,
    );
  }
  return undefined;
}

async function recoverHistoricalIntegrationWinner(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
): Promise<HistoricalIntegrationWinner | undefined> {
  const [exact, lost] = await Promise.all([
    recoverHistoricalExactRunBridge(github, historical),
    recoverHistoricalIdentityLostTombstone(github, historical),
  ]);
  if (exact && lost) {
    throw new Error(`Historical Integration request ${historical.record.request.request_id} has conflicting exact-run and identity_lost bridge authority.`);
  }
  return exact ?? lost;
}

async function claimHistoricalIntegrationWinnerForRevision(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
  commit: IntegrationCommit,
  recoveryBaseSha: string,
  createdAt: string,
): Promise<HistoricalIntegrationWinnerClaim> {
  const record = historical.record;
  if (!record.dispatch) throw new Error(`Historical Integration request ${record.request.request_id} has no dispatch authority.`);
  const candidate = historicalIntegrationWinnerClaimSchema.parse({
    version: 1,
    kind: "historical_integration_winner_claim",
    request_id: record.request.request_id,
    pr_number: record.identity.prNumber,
    head_sha: record.identity.headSha,
    base_sha: record.identity.baseSha,
    anchor_name: record.dispatch.anchor_name,
    historical_record_digest: historicalRecordDigest(historical.body),
    recovery_base_sha: recoveryBaseSha,
    commit,
    created_at: createdAt,
  });
  const name = historicalIntegrationWinnerClaimName(record.request.request_id, recoveryBaseSha);
  const serialized = JSON.stringify(candidate);
  await assertRepositoryDefaultBranchRevision(github, recoveryBaseSha);
  let raw = await getFugueAuthorityVariable(github, name);
  if (raw === undefined) {
    const created = await createFugueAuthorityVariable(github, name, serialized);
    raw = created ? serialized : await getFugueAuthorityVariable(github, name);
  }
  if (raw === undefined) {
    throw new DurableProtocolRecoveryPendingError(
      `Historical Integration winner serialization for ${record.request.request_id} could not allocate protected Authority state.`,
    );
  }
  const claim = parseHistoricalJson(raw, historicalIntegrationWinnerClaimSchema);
  if (!claim || name !== historicalIntegrationWinnerClaimName(claim.request_id, claim.recovery_base_sha) ||
      !historicalWinnerClaimMatches(github, claim, historical)) {
    throw new Error(`Historical Integration winner claim ${name} is malformed or belongs to another historical identity.`);
  }
  await assertRepositoryDefaultBranchRevision(github, recoveryBaseSha);
  return claim;
}

function historicalWinnerCreatedAt(commit: IntegrationCommit, now: number): string {
  const commitTime = commit.kind === "integration_exact_run_commit"
    ? Date.parse(commit.run_created_at)
    : Date.parse(commit.created_at);
  return new Date(Math.max(Date.now(), now, Number.isFinite(commitTime) ? commitTime : 0)).toISOString();
}

interface HistoricalIntegrationCommitTransaction {
  commit: IntegrationCommit;
  protectedBaseSha: string;
  winnerClaim?: HistoricalIntegrationWinnerClaim;
}

async function claimHistoricalIntegrationCommitTransaction(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
  now: number,
  claimCommit: () => Promise<IntegrationCommit>,
  validateCommit?: (commit: IntegrationCommit) => void,
): Promise<HistoricalIntegrationCommitTransaction> {
  return withFugueAuthorityNamespaceMutation(github, async () => {
    const commit = await claimCommit();
    validateCommit?.(commit);
    const protectedBase = await readRepositoryDefaultBranchIdentity(github);
    if (protectedBase.sha.toLowerCase() === historical.record.identity.baseSha.toLowerCase()) {
      return { commit, protectedBaseSha: protectedBase.sha };
    }
    const winnerClaim = await claimHistoricalIntegrationWinnerForRevision(
      github,
      historical,
      commit,
      protectedBase.sha,
      historicalWinnerCreatedAt(commit, now),
    );
    return { commit, protectedBaseSha: protectedBase.sha, winnerClaim };
  });
}

async function ensureHistoricalIntegrationWinner(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
  proposedCommit: IntegrationCommit,
  now: number,
  preclaimedClaim?: HistoricalIntegrationWinnerClaim,
): Promise<HistoricalIntegrationWinner | undefined> {
  let claim = preclaimedClaim;
  if (claim) {
    if (!historicalWinnerClaimMatches(github, claim, historical)) {
      throw new Error(`Historical Integration winner claim for ${historical.record.request.request_id} is malformed or belongs to another historical identity.`);
    }
  } else {
    const existing = await recoverHistoricalIntegrationWinner(github, historical);
    if (existing) return existing;
    const protectedBase = await readRepositoryDefaultBranchIdentity(github);
    const claimCreatedAt = historicalWinnerCreatedAt(proposedCommit, now);
    try {
      claim = await claimHistoricalIntegrationWinnerForRevision(
        github, historical, proposedCommit, protectedBase.sha, claimCreatedAt,
      );
    } catch (error) {
      const latest = await readRepositoryDefaultBranchIdentity(github);
      if (latest.sha.toLowerCase() !== protectedBase.sha.toLowerCase()) return undefined;
      throw error;
    }
  }

  // This read is causally after acquiring the revision-qualified create-only H claim. If a stale
  // producer can recreate H only because an earlier winner released it, that earlier winner's d3
  // commit necessarily precedes this read. Thus the reread is linearized with the serialization
  // primitive rather than being another advisory pre-publication check.
  const afterClaim = await recoverHistoricalIntegrationWinner(github, historical);
  if (afterClaim) return afterClaim;

  const createdAt = historicalWinnerCreatedAt(claim.commit, now);
  const winner = claim.commit.kind === "integration_exact_run_commit"
    ? historicalIntegrationExactRunBridgeSchema.parse({
        version: 1,
        kind: "historical_integration_exact_run",
        request: historical.record.request,
        dispatch: historical.record.dispatch,
        commit: claim.commit,
        historical_record_digest: historicalRecordDigest(historical.body),
        recovery_base_sha: claim.recovery_base_sha,
        created_at: createdAt,
      })
    : historicalIntegrationIdentityLostTombstoneSchema.parse({
        version: 1,
        kind: "historical_integration_identity_lost",
        request: historical.record.request,
        dispatch: historical.record.dispatch,
        commit: claim.commit,
        historical_record_digest: historicalRecordDigest(historical.body),
        recovery_base_sha: claim.recovery_base_sha,
        created_at: createdAt,
      });
  const scope = winner.kind === "historical_integration_exact_run"
    ? historicalExactRunScope(historical.record.request)
    : historicalIdentityLostScope(historical.record.request);
  const unsignedBody = winner.kind === "historical_integration_exact_run"
    ? serializeHistoricalIntegrationExactRunBridge(winner)
    : serializeHistoricalIntegrationIdentityLostTombstone(winner);
  try {
    const committedBody = await publishDurableProtocolRecord(github, {
      storageSha: historical.record.identity.headSha,
      publisherSha: claim.recovery_base_sha,
      scope,
      unsignedBody,
      publicationTimestamp: Date.parse(createdAt),
      authorityOrder: createdAt,
    });
    const committed = winner.kind === "historical_integration_exact_run"
      ? parseHistoricalIntegrationExactRunBridge(committedBody)
      : parseHistoricalIntegrationIdentityLostTombstone(committedBody);
    const valid = committed && (committed.kind === "historical_integration_exact_run"
      ? historicalExactRunBridgeMatches(github, committed, historical, claim.recovery_base_sha)
      : historicalIdentityLostTombstoneMatches(committed, historical, claim.recovery_base_sha));
    if (!valid) {
      throw new Error(`Historical Integration winner for ${historical.record.request.request_id} returned another identity.`);
    }
    const durable = await recoverHistoricalIntegrationWinner(github, historical);
    if (!durable) {
      throw new DurableProtocolRecoveryPendingError(
        `Historical Integration winner for ${historical.record.request.request_id} did not become durably readable.`,
      );
    }
    return durable;
  } catch (error) {
    const latest = await readRepositoryDefaultBranchIdentity(github);
    if (latest.sha.toLowerCase() !== claim.recovery_base_sha.toLowerCase()) return undefined;
    throw error;
  }
}

function historicalIdentityLostRecord(
  historical: RecoveredHistoricalIntegrationRecord,
  tombstone: HistoricalIntegrationIdentityLostTombstone,
): IntegrationRecord {
  const commit = tombstone.commit;
  return {
    ...historical.record,
    dispatch_started_at: historical.record.dispatch_started_at ?? commit.boundary_created_at,
    run: null,
    terminal: {
      state: "identity_lost",
      attempt: 1,
      boundary_created_at: commit.boundary_created_at,
      fence_digest: commit.fence_digest,
      detail: "Historical protected may-have-dispatched request is sealed by current-revision identity_lost tombstone authority; it can never retry or bind a later run.",
      created_at: commit.created_at,
    },
    created_at: commit.created_at,
  };
}

function historicalExactRunRecord(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
  bridge: HistoricalIntegrationExactRunBridge,
): IntegrationRecord {
  const binding = integrationRunBindingFromCommit(github, bridge.commit);
  return {
    ...historical.record,
    dispatch_started_at: historical.record.dispatch_started_at ?? binding.created_at,
    run: binding,
    terminal: null,
    created_at: binding.created_at,
  };
}

function historicalRecordFromWinner(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
  winner: HistoricalIntegrationWinner,
): IntegrationRecord {
  return winner.kind === "historical_integration_exact_run"
    ? historicalExactRunRecord(github, historical, winner)
    : historicalIdentityLostRecord(historical, winner);
}

async function historicalExactCandidateFromHint(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
  hint: HistoricalIntegrationAuthorityHint,
): Promise<IntegrationExactRunCandidate | undefined> {
  const record = historical.record;
  if (!record.dispatch || hint.requestId !== record.request.request_id || hint.prNumber !== record.identity.prNumber ||
      hint.headSha.toLowerCase() !== record.identity.headSha.toLowerCase() ||
      hint.baseSha.toLowerCase() !== record.identity.baseSha.toLowerCase() || hint.anchorName !== record.dispatch.anchor_name) return undefined;
  if (hint.kind === "binding") {
    const witness = parseHistoricalJson(hint.raw, historicalIntegrationBindingWitnessSchema);
    if (!witness || !historicalBindingMatchesRequest(github, witness, record)) return undefined;
    return { runId: witness.run_id, createdAt: witness.run_created_at, htmlUrl: witness.html_url };
  }
  if (hint.kind === "start") {
    let start: IntegrationRunStartEvidence | null;
    try { start = parseIntegrationRunStart(hint.raw); } catch { start = null; }
    if (!start || !(await historicalRunStartMatchesRequest(github, start, hint.raw, record))) return undefined;
    return {
      runId: start.run_id,
      createdAt: start.created_at,
      htmlUrl: `https://github.com/${github.repository.fullName}/actions/runs/${start.run_id}`,
    };
  }
  return undefined;
}

async function historicalExactCandidateFromHints(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
  group: HistoricalIntegrationAuthorityHint[],
): Promise<IntegrationExactRunCandidate | undefined> {
  const candidates: IntegrationExactRunCandidate[] = [];
  for (const hint of group) {
    const candidate = await historicalExactCandidateFromHint(github, historical, hint);
    if (candidate) candidates.push(candidate);
  }
  if (!candidates.length) return undefined;
  const first = candidates[0]!;
  if (candidates.some((candidate) => candidate.runId !== first.runId || candidate.htmlUrl !== first.htmlUrl)) {
    throw new Error(`Historical Integration request ${historical.record.request.request_id} has conflicting protected exact-run evidence.`);
  }
  return [...candidates].sort((left, right) => {
    const timestampOrder = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return timestampOrder !== 0 ? timestampOrder : left.createdAt.localeCompare(right.createdAt);
  })[0]!;
}

function historicalRecordHasPermanentCommitWinner(record: IntegrationRecord): boolean {
  return Boolean(record.run) || record.terminal?.state === "identity_lost";
}

async function historicalTransientMatchesRecord(
  github: FugueGitHub,
  name: string,
  value: string,
  record: IntegrationRecord,
): Promise<boolean> {
  if (!record.dispatch) return false;
  const permanentWinner = historicalRecordHasPermanentCommitWinner(record);
  if (name === integrationDispatchFenceName(record.request.request_id)) {
    const fence = parseHistoricalJson(value, historicalIntegrationFenceSchema);
    return Boolean(fence && historicalFenceMatchesRecord(fence, record));
  }
  if (name === record.dispatch.anchor_name) {
    const anchor = await verifiedIntegrationAnchor(github, value, record.identity);
    return Boolean(anchor && anchor.request.request_id === record.request.request_id && anchor.anchor_name === name);
  }
  if (name === integrationBindingWitnessName(record.request.request_id)) {
    const witness = parseHistoricalJson(value, historicalIntegrationBindingWitnessSchema);
    if (!witness || !historicalBindingMatchesRequest(github, witness, record)) return false;
    return permanentWinner;
  }
  if (name === integrationRunStartVariableName(record.request)) {
    let start: IntegrationRunStartEvidence | null;
    try { start = parseIntegrationRunStart(value); } catch { start = null; }
    if (!start || !(await historicalRunStartMatchesRequest(github, start, value, record))) return false;
    return permanentWinner;
  }
  if (name === integrationCommitVariableName(record.request.request_id)) {
    const context = integrationCommitContext(record)!;
    try { parseIntegrationCommit(value, context); } catch { return false; }
    return permanentWinner;
  }
  return false;
}

async function releaseVerifiedHistoricalIntegrationAuthority(
  github: FugueGitHub,
  historical: RecoveredHistoricalIntegrationRecord,
  record: IntegrationRecord,
): Promise<void> {
  if (!record.dispatch) return;
  await withFugueAuthorityNamespaceMutation(github, async () => {
    const beforeCommit = [
      integrationDispatchFenceName(record.request.request_id),
      record.dispatch!.anchor_name,
      integrationBindingWitnessName(record.request.request_id),
      integrationRunStartVariableName(record.request),
    ];
    for (const name of beforeCommit) {
      const value = await getFugueAuthorityVariable(github, name);
      if (value === undefined) continue;
      if (await historicalTransientMatchesRecord(github, name, value, record)) {
        await deleteFugueAuthorityVariable(github, name);
      }
    }

    const claimPrefix = historicalIntegrationWinnerClaimPrefix(record.request.request_id);
    const claims = (await listFugueAuthorityVariables(github, claimPrefix)).sort((left, right) => left.name.localeCompare(right.name));
    let claimBudget = HISTORICAL_INTEGRATION_WINNER_CLAIM_CLEANUP_BUDGET;
    for (const variable of claims) {
      if (claimBudget <= 0) break;
      const claim = parseHistoricalJson(variable.value, historicalIntegrationWinnerClaimSchema);
      if (!claim || variable.name !== historicalIntegrationWinnerClaimName(claim.request_id, claim.recovery_base_sha) ||
          !historicalWinnerClaimMatches(github, claim, historical)) continue;
      await deleteFugueAuthorityVariable(github, variable.name);
      claimBudget -= 1;
    }
    const remainingClaim = (await listFugueAuthorityVariables(github, claimPrefix)).some((variable) => {
      const claim = parseHistoricalJson(variable.value, historicalIntegrationWinnerClaimSchema);
      return Boolean(claim && variable.name === historicalIntegrationWinnerClaimName(claim.request_id, claim.recovery_base_sha) &&
        historicalWinnerClaimMatches(github, claim, historical));
    });
    if (remainingClaim) return;

    // C is deliberately last. A producer that was already running before historical cleanup either
    // still owns a valid H transaction claim (so C is retained) or recreates H after cleanup and must
    // perform the post-H durable-winner read before it can publish an opposite historical outcome.
    const commitName = integrationCommitVariableName(record.request.request_id);
    const commitValue = await getFugueAuthorityVariable(github, commitName);
    if (commitValue !== undefined && await historicalTransientMatchesRecord(github, commitName, commitValue, record)) {
      await deleteFugueAuthorityVariable(github, commitName);
    }
  });
}

async function reclaimHistoricalIntegrationWinnerClaimOrphans(
  github: FugueGitHub,
  variables: Array<{ name: string; value: string }>,
  currentIdentities: IntegrationRequest["identity"][],
): Promise<void> {
  let budget = HISTORICAL_INTEGRATION_H_ONLY_CLEANUP_BUDGET;
  const claims = variables
    .filter((variable) => variable.name.startsWith(INTEGRATION_HISTORICAL_WINNER_PREFIX))
    .sort((left, right) => left.name.localeCompare(right.name));
  const reclaimable: Array<{ name: string; value: string }> = [];
  for (const variable of claims) {
    if (budget <= 0) break;
    const claim = parseHistoricalJson(variable.value, historicalIntegrationWinnerClaimSchema);
    if (!claim || variable.name !== historicalIntegrationWinnerClaimName(claim.request_id, claim.recovery_base_sha)) continue;
    budget -= 1;
    const hint: HistoricalIntegrationAuthorityHint = claim.commit.kind === "integration_exact_run_commit"
      ? {
          kind: "commit_exact",
          variableName: variable.name,
          raw: variable.value,
          requestId: claim.request_id,
          prNumber: claim.pr_number,
          headSha: claim.head_sha,
          baseSha: claim.base_sha,
          anchorName: claim.anchor_name,
          runId: claim.commit.run_id,
          createdAt: claim.commit.run_created_at,
          htmlUrl: claim.commit.html_url,
        }
      : {
          kind: "commit_identity_lost",
          variableName: variable.name,
          raw: variable.value,
          requestId: claim.request_id,
          prNumber: claim.pr_number,
          headSha: claim.head_sha,
          baseSha: claim.base_sha,
          anchorName: claim.anchor_name,
          boundaryCreatedAt: claim.commit.boundary_created_at,
          fenceDigest: claim.commit.fence_digest,
          createdAt: claim.commit.created_at,
        };
    const historical = await recoverHistoricalIntegrationRecord(github, hint);
    if (!historical) continue;
    if (currentIdentities.some((candidate) => sameEvaluationIdentity(candidate, historical.record.identity))) continue;
    let winner: HistoricalIntegrationWinner | undefined;
    try { winner = await recoverHistoricalIntegrationWinner(github, historical); }
    catch (error) {
      if (error instanceof DurableProtocolRecoveryPendingError) continue;
      throw error;
    }
    if (!winner || !historicalIntegrationWinnerClaimCanBeReclaimed({
      repositoryFullName: github.repository.fullName,
      variableName: variable.name,
      rawClaim: variable.value,
      historicalRecord: historical.record,
      historicalBody: historical.body,
      durableWinnerCommit: winner.commit,
    })) continue;
    reclaimable.push(variable);
  }
  if (!reclaimable.length) return;
  await withFugueAuthorityNamespaceMutation(github, async () => {
    for (const variable of reclaimable) {
      if (await getFugueAuthorityVariable(github, variable.name) !== variable.value) continue;
      await deleteFugueAuthorityVariable(github, variable.name);
    }
  });
}

async function reclaimHistoricalIntegrationAuthorityVariables(
  github: FugueGitHub,
  variables: Array<{ name: string; value: string }>,
  now: number,
  currentIdentities: IntegrationRequest["identity"][],
): Promise<void> {
  const hints = new Map<string, HistoricalIntegrationAuthorityHint[]>();
  for (const variable of variables) {
    const hint = await historicalIntegrationAuthorityHint(github, variable);
    if (!hint) continue;
    const key = historicalHintKey(hint);
    const group = hints.get(key) ?? [];
    group.push(hint);
    hints.set(key, group);
  }

  let budget = HISTORICAL_INTEGRATION_CLEANUP_BUDGET;
  for (const key of [...hints.keys()].sort()) {
    if (budget <= 0) break;
    const group = hints.get(key)!;
    const hint = group[0]!;
    const historical = await recoverHistoricalIntegrationRecord(github, hint);
    if (!historical) continue;
    const record = historical.record;
    const currentIdentity = currentIdentities.find((candidate) => sameEvaluationIdentity(candidate, record.identity));
    if (currentIdentity) continue;
    budget -= 1;

    if (record.run || record.terminal) {
      await releaseVerifiedHistoricalIntegrationAuthority(github, historical, record);
      continue;
    }

    const existingWinner = await recoverHistoricalIntegrationWinner(github, historical);
    if (existingWinner) {
      await releaseVerifiedHistoricalIntegrationAuthority(github, historical, historicalRecordFromWinner(github, historical, existingWinner));
      continue;
    }

    const context = integrationCommitContext(record)!;
    let commit = await readIntegrationCommit(github, context);
    let commitProtectedBaseSha: string | undefined;
    let preclaimedWinnerClaim: HistoricalIntegrationWinnerClaim | undefined;
    if (!commit) {
      const candidate = await historicalExactCandidateFromHints(github, historical, group);
      if (candidate) {
        const candidateCommit = integrationExactRunCommitSchema.parse({
          version: 1,
          kind: "integration_exact_run_commit",
          request_id: context.requestId,
          pr_number: context.prNumber,
          head_sha: context.headSha,
          base_sha: context.baseSha,
          anchor_name: context.anchorName,
          run_id: candidate.runId,
          run_attempt: 1,
          run_created_at: candidate.createdAt,
          html_url: candidate.htmlUrl,
        });
        const transaction = await claimHistoricalIntegrationCommitTransaction(
          github,
          historical,
          now,
          () => claimIntegrationCommit(github, context, candidateCommit),
          (winner) => {
            if (winner.kind === "integration_exact_run_commit" &&
                (winner.run_id !== candidate.runId || winner.html_url !== candidate.htmlUrl)) {
              throw new Error(`Historical Integration request ${record.request.request_id} has protected exact-run evidence conflicting with C.`);
            }
          },
        );
        commit = transaction.commit;
        commitProtectedBaseSha = transaction.protectedBaseSha;
        preclaimedWinnerClaim = transaction.winnerClaim;
      }
    }

    if (commit?.kind === "integration_exact_run_commit") {
      const binding = integrationRunBindingFromCommit(github, commit);
      const exactEvidence = await historicalExactCandidateFromHints(github, historical, group);
      if (exactEvidence && (exactEvidence.runId !== binding.id || exactEvidence.htmlUrl !== binding.html_url)) {
        throw new Error(`Historical Integration request ${record.request.request_id} has protected exact-run evidence conflicting with C.`);
      }
      const protectedBaseSha = commitProtectedBaseSha ?? (await readRepositoryDefaultBranchIdentity(github)).sha;
      if (protectedBaseSha.toLowerCase() === record.identity.baseSha.toLowerCase()) {
        await bindDispatchedIntegrationRun(
          github,
          { identity: record.identity } as EvaluationSnapshot,
          record.request.request_id,
          binding.id,
          binding.html_url,
          binding.created_at,
        );
        continue;
      }
      const winner = await ensureHistoricalIntegrationWinner(github, historical, commit, now, preclaimedWinnerClaim);
      if (!winner) continue;
      await releaseVerifiedHistoricalIntegrationAuthority(
        github, historical, historicalRecordFromWinner(github, historical, winner),
      );
      continue;
    }

    const fenceHint = group.find((candidate) => candidate.kind === "fence");
    if (!commit && fenceHint?.createdAt && now - Date.parse(fenceHint.createdAt) >= INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
      const fence = parseHistoricalJson(fenceHint.raw, historicalIntegrationFenceSchema);
      if (fence && historicalFenceMatchesRecord(fence, record)) {
        const terminalAt = new Date(Math.max(now, Date.parse(record.created_at) + 1)).toISOString();
        const identityLostCandidate: IntegrationIdentityLostCandidate = {
          boundaryCreatedAt: fence.created_at,
          fenceDigest: `sha256:${createHash("sha256").update(fenceHint.raw, "utf8").digest("hex")}`,
          createdAt: terminalAt,
        };
        const transaction = await claimHistoricalIntegrationCommitTransaction(
          github,
          historical,
          now,
          () => claimIdentityLostIntegrationCommit(github, context, identityLostCandidate),
        );
        commit = transaction.commit;
        commitProtectedBaseSha = transaction.protectedBaseSha;
        preclaimedWinnerClaim = transaction.winnerClaim;
      }
    }

    if (commit?.kind === "integration_exact_run_commit") {
      const protectedBaseSha = commitProtectedBaseSha ?? (await readRepositoryDefaultBranchIdentity(github)).sha;
      if (protectedBaseSha.toLowerCase() === record.identity.baseSha.toLowerCase()) continue;
      const winner = await ensureHistoricalIntegrationWinner(github, historical, commit, now, preclaimedWinnerClaim);
      if (!winner) continue;
      await releaseVerifiedHistoricalIntegrationAuthority(
        github, historical, historicalRecordFromWinner(github, historical, winner),
      );
      continue;
    }
    if (commit?.kind === "integration_identity_lost_commit") {
      const protectedBaseSha = commitProtectedBaseSha ?? (await readRepositoryDefaultBranchIdentity(github)).sha;
      if (protectedBaseSha.toLowerCase() === record.identity.baseSha.toLowerCase()) {
        await publishIntegrationRecord(github, {
          ...record,
          dispatch_started_at: record.dispatch_started_at ?? commit.boundary_created_at,
          run: null,
          terminal: {
            state: "identity_lost", attempt: 1,
            boundary_created_at: commit.boundary_created_at,
            fence_digest: commit.fence_digest,
            detail: "Historical protected may-have-dispatched request completed identity_lost serialization before evaluation drift; scavenging finishes the durable terminal transition without retry.",
            created_at: commit.created_at,
          },
          created_at: commit.created_at,
        });
        continue;
      }
      const winner = await ensureHistoricalIntegrationWinner(github, historical, commit, now, preclaimedWinnerClaim);
      if (!winner) continue;
      await releaseVerifiedHistoricalIntegrationAuthority(
        github, historical, historicalRecordFromWinner(github, historical, winner),
      );
      continue;
    }

    if (!record.dispatch_started_at && !fenceHint) await releaseVerifiedHistoricalIntegrationAuthority(github, historical, record);
  }
}

async function abandonIntegrationAuthorization(
  github: FugueGitHub,
  electionName: string,
  request: IntegrationRequest,
): Promise<void> {
  await withFugueAuthorityNamespaceMutation(github, async () => {
    await deleteFugueAuthorityVariable(github, integrationAnchorVariableName(request));
    await deleteFugueAuthorityVariable(github, electionName);
  });
}

function integrationAuthorizationAge(anchor: IntegrationDispatchAnchor, now: number): number {
  const timestamp = Date.parse(anchor.authorized_at);
  return Number.isFinite(timestamp) ? now - timestamp : Number.POSITIVE_INFINITY;
}

export async function reclaimOrphanIntegrationAuthorityVariables(
  github: FugueGitHub,
  now = Date.now(),
  currentIdentities?: IntegrationRequest["identity"][],
): Promise<void> {
  const variables = await listFugueAuthorityVariables(github, "FUGUE_INT_");
  const expectedValues = new Map(variables.map((variable) => [variable.name, variable.value]));
  const scheduled = new Set<string>();
  const reclaimable: string[] = [];
  const scheduleReclaim = (name: string): void => {
    if (!expectedValues.has(name) || scheduled.has(name)) return;
    scheduled.add(name);
    reclaimable.push(name);
  };
  const anchors = new Map<string, IntegrationDispatchAnchor>();
  for (const variable of variables) {
    if (!variable.name.startsWith(INTEGRATION_ELECTION_PREFIX) && !variable.name.startsWith(INTEGRATION_ANCHOR_PREFIX)) continue;
    const anchor = await verifiedIntegrationAnchor(github, variable.value);
    if (!anchor) {
      scheduleReclaim(variable.name);
      continue;
    }
    if (variable.name.startsWith(INTEGRATION_ANCHOR_PREFIX)) anchors.set(variable.name, anchor);
  }

  for (const variable of variables.filter((entry) => entry.name.startsWith(INTEGRATION_ELECTION_PREFIX))) {
    const anchor = await verifiedIntegrationAnchor(github, variable.value);
    if (!anchor || integrationAuthorizationAge(anchor, now) < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) continue;
    let current: IntegrationRecord | undefined;
    try { current = await getCurrentIntegrationRecord(github, anchor.request.identity); }
    catch (error) {
      if (error instanceof DurableProtocolRecoveryPendingError) continue;
      throw error;
    }
    scheduleReclaim(variable.name);
    if (current?.request.request_id === anchor.request.request_id) continue;
    scheduleReclaim(anchor.anchor_name);
  }

  for (const [name, anchor] of anchors) {
    if (integrationAuthorizationAge(anchor, now) < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) continue;
    let current: IntegrationRecord | undefined;
    try { current = await getCurrentIntegrationRecord(github, anchor.request.identity); }
    catch (error) {
      if (error instanceof DurableProtocolRecoveryPendingError) continue;
      throw error;
    }
    if (current?.request.request_id === anchor.request.request_id) continue;
    scheduleReclaim(name);
  }

  if (reclaimable.length) {
    await withFugueAuthorityNamespaceMutation(github, async () => {
      for (const name of reclaimable) {
        const expected = expectedValues.get(name);
        if (expected === undefined || await getFugueAuthorityVariable(github, name) !== expected) continue;
        await deleteFugueAuthorityVariable(github, name);
      }
    });
  }

  if (currentIdentities !== undefined) {
    await reclaimHistoricalIntegrationAuthorityVariables(github, variables, now, currentIdentities);
    await reclaimHistoricalIntegrationWinnerClaimOrphans(github, variables, currentIdentities);
  }
}

function integrationRunBindingFromEvidence(github: FugueGitHub, evidence: IntegrationRunStartEvidence): IntegrationRunBinding {
  return {
    id: evidence.run_id,
    attempt: 1,
    created_at: evidence.created_at,
    html_url: `https://github.com/${github.repository.fullName}/actions/runs/${evidence.run_id}`,
  };
}

export async function currentIntegrationState(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  now = Date.now(),
): Promise<CurrentIntegrationState> {
  let record: IntegrationRecord | undefined;
  try {
    record = await getCurrentIntegrationRecord(github, snapshot.identity);
  } catch (error) {
    if (error instanceof DurableProtocolRecoveryPendingError) return { state: "pending" };
    throw error;
  }
  if (!record) return { state: "none" };
  const request = record.request;
  if (record.terminal) {
    if (record.terminal.state === "success") {
      return { state: "success", request, attestation: record.terminal.attestation, targetUrl: record.run?.html_url };
    }
    if (record.terminal.state === "aborted") return { state: "none" };
    return { state: record.terminal.state, request, targetUrl: record.run?.html_url };
  }

  const evidence = record.run ? undefined : await getIntegrationRunStartEvidence(github, record);
  const binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (binding) {
    const live = await getIntegrationWorkflowRunForBinding(github, request, binding);
    if (!live) {
      const started = Date.parse(binding.created_at);
      return Number.isFinite(started) && now - started >= INTEGRATION_REQUEST_RECOVERY_GRACE_MS
        ? { state: "failure", request, targetUrl: binding.html_url }
        : { state: "pending", request, targetUrl: binding.html_url };
    }
    if (live.status !== "completed") return { state: "pending", request, targetUrl: live.htmlUrl };
    if (live.conclusion === "failure") return { state: "failure", request, targetUrl: live.htmlUrl };
    if (live.conclusion !== "success") return { state: "error", request, targetUrl: live.htmlUrl };
    return { state: "pending", request, targetUrl: live.htmlUrl };
  }

  const created = Date.parse(request.created_at);
  if (!Number.isFinite(created)) return { state: "error", request };
  return now - created >= INTEGRATION_REQUEST_RECOVERY_GRACE_MS
    ? { state: "none", request }
    : { state: "pending", request };
}

export interface DurableIntegrationWorkflowRunEvent {
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

export async function sealIntegrationWorkflowRunEvent(
  github: FugueGitHub,
  event: DurableIntegrationWorkflowRunEvent | undefined,
): Promise<boolean> {
  if (!event || event.workflowName !== "Fugue Integration" || event.runAttempt !== 1 ||
      event.actor !== "github-actions[bot]" || event.status !== "completed") return false;
  const match = event.displayTitle.match(/^Fugue Integration PR #(\d+) (int-[0-9a-f]{16}-[0-9a-f]{16})(?: ([0-9a-f]{24}))?$/);
  if (!match?.[1] || !match[2]) return false;
  const prNumber = Number(match[1]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return false;
  const { owner, repo } = github.repository;
  const pr = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  let record: IntegrationRecord | undefined;
  try {
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: pr.data.head.sha,
      publisherSha: event.headSha,
      scope: integrationScope(prNumber),
      issueNumber: prNumber,
      parse: parseIntegrationRecord,
      timestamp: (value) => Date.parse(value.created_at),
      order: (value) => value.created_at,
      validate: (value) => value.identity.prNumber === prNumber && value.identity.headSha === pr.data.head.sha &&
        value.identity.baseSha === event.headSha && value.request.request_id === match[2],
    });
    if (!recovered.record) return false;
    record = recovered.record.value;
  } catch (error) {
    if (error instanceof DurableProtocolRecoveryPendingError) return false;
    throw error;
  }
  if (record.terminal) {
    await releaseIntegrationAuthorityVariable(github, record);
    return false;
  }
  const evidence = record.run ? undefined : await getIntegrationRunStartEvidence(github, record);
  const binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (!binding || binding.id !== event.runId) return false;
  const createdAt = new Date().toISOString();
  if (event.conclusion === "failure") {
    await publishIntegrationRecord(github, {
      ...record, run: binding,
      terminal: { state: "failure", detail: "Protected attempt 1 completed failure.", created_at: createdAt },
      created_at: createdAt,
    });
    return true;
  }
  if (event.conclusion === "success") {
    await publishIntegrationRecord(github, {
      ...record, run: binding,
      terminal: { state: "error", detail: "Protected attempt 1 completed success without durable terminal PASS evidence.", created_at: createdAt },
      created_at: createdAt,
    });
    return true;
  }
  await publishIntegrationRecord(github, {
    ...record, run: binding,
    terminal: {
      state: "error",
      detail: `Protected attempt 1 completed ${event.conclusion ?? "without conclusion"}; a known attempt is never retryable transport.`,
      created_at: createdAt,
    },
    created_at: createdAt,
  });
  return true;
}

export async function findCurrentIntegrationRequest(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<IntegrationRequest | undefined> {
  try {
    const record = await getCurrentIntegrationRecord(github, snapshot.identity);
    if (!record || record.terminal?.state === "aborted") return undefined;
    return record.request;
  } catch (error) {
    if (error instanceof DurableProtocolRecoveryPendingError) return undefined;
    throw error;
  }
}

export async function getCurrentIntegrationRecord(
  github: FugueGitHub,
  identity: IntegrationRequest["identity"],
): Promise<IntegrationRecord | undefined> {
  let lastPending: DurableProtocolRecoveryPendingError | undefined;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      const recovered = await recoverDurableProtocolRecord(github, {
        storageSha: identity.headSha,
        publisherSha: identity.baseSha,
        scope: integrationScope(identity.prNumber),
        issueNumber: identity.prNumber,
        parse: parseIntegrationRecord,
        timestamp: (value) => Date.parse(value.created_at),
        order: (value) => value.created_at,
        validate: (value) => sameEvaluationIdentity(value.identity, identity),
      });
      if (recovered.record) {
        await replaceIntegrationLocator(github, recovered.record.value);
        return recovered.record.value;
      }
      if (recovered.exhausted) return undefined;
      throw new DurableProtocolRecoveryPendingError(
        `PR #${identity.prNumber} Integration authority recovery is progressing through bounded status history.`,
      );
    } catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
      lastPending = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastPending ?? new DurableProtocolRecoveryPendingError("Protected Integration authority remained busy.");
}

export async function publishIntegrationRecord(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationRecord> {
  let current = await getCurrentIntegrationRecord(github, record.identity);
  if (current && sameIntegrationRecord(current, record)) {
    if (current.terminal) await releaseIntegrationAuthorityVariable(github, current);
    return current;
  }
  if (current && current.terminal && current.terminal.state !== "aborted") {
    throw new Error(`Integration request ${current.request.request_id} already has terminal ${current.terminal.state} authority.`);
  }
  if (current && record.request.request_id !== current.request.request_id && current.terminal?.state !== "aborted") {
    throw new Error(`Cannot replace active Integration request ${current.request.request_id}.`);
  }
  if (current && record.request.request_id === current.request.request_id &&
      JSON.stringify(current.dispatch) !== JSON.stringify(record.dispatch)) {
    throw new Error(`Integration request ${record.request.request_id} cannot replace its protected dispatch authorization.`);
  }
  if (current?.dispatch_started_at && record.dispatch_started_at !== current.dispatch_started_at) {
    throw new Error(`Integration request ${record.request.request_id} cannot clear or replace its durable dispatch-start boundary.`);
  }
  if (current?.run && !record.run) {
    throw new Error(`Integration request ${record.request.request_id} cannot clear protected run ${current.run.id}.`);
  }
  if (current?.run && record.run && current.run.id !== record.run.id) {
    throw new Error(`Integration request ${record.request.request_id} is already bound to protected run ${current.run.id}.`);
  }

  if (record.terminal?.state === "identity_lost") {
    if (!current || !current.dispatch || current.request.request_id !== record.request.request_id || current.run || current.terminal) {
      throw new Error(`Integration request ${record.request.request_id} is not an active unbound identity_lost candidate.`);
    }
    const context = integrationCommitContext(current)!;
    const winner = await claimIdentityLostIntegrationCommit(github, context, {
      boundaryCreatedAt: record.terminal.boundary_created_at,
      fenceDigest: record.terminal.fence_digest,
      createdAt: record.terminal.created_at,
    });
    if (winner.kind === "integration_exact_run_commit") {
      const binding = integrationRunBindingFromCommit(github, winner);
      const latest = await getCurrentIntegrationRecord(github, record.identity);
      if (!latest || latest.request.request_id !== record.request.request_id) {
        throw new Error(`Integration request ${record.request.request_id} changed while exact-run serialization was committing.`);
      }
      if (latest.terminal && latest.terminal.state !== "aborted") {
        throw new Error(`Integration request ${record.request.request_id} already has terminal ${latest.terminal.state} authority.`);
      }
      if (latest.run) {
        if (latest.run.id !== binding.id) throw new Error(`Integration request ${record.request.request_id} is already bound to protected run ${latest.run.id}.`);
        await releaseIntegrationAuthorityVariable(github, latest);
        return latest;
      }
      const bound = await publishIntegrationRecord(github, {
        ...latest,
        dispatch_started_at: latest.dispatch_started_at ?? binding.created_at,
        run: binding,
        terminal: null,
        created_at: binding.created_at,
      });
      await releaseIntegrationAuthorityVariable(github, bound);
      return bound;
    }
    record = {
      ...record,
      terminal: {
        ...record.terminal,
        attempt: 1,
        boundary_created_at: winner.boundary_created_at,
        fence_digest: winner.fence_digest,
        created_at: winner.created_at,
      },
      created_at: winner.created_at,
    };
    current = await getCurrentIntegrationRecord(github, record.identity);
    if (!current || current.request.request_id !== record.request.request_id || current.run || current.terminal) {
      throw new Error(`Integration request ${record.request.request_id} changed after identity_lost serialization committed.`);
    }
  }

  const minimum = current ? Date.parse(current.created_at) + 1 : 0;
  const requested = Date.parse(record.created_at);
  const createdAt = record.terminal?.state === "identity_lost"
    ? new Date(Math.max(minimum, Number.isFinite(requested) ? requested : 0)).toISOString()
    : new Date(Math.max(Date.now(), minimum, Number.isFinite(requested) ? requested : 0)).toISOString();
  const normalized = record.terminal?.state === "identity_lost"
    ? {
        ...record,
        terminal: { ...record.terminal, created_at: createdAt },
        created_at: createdAt,
      } as IntegrationRecord
    : { ...record, created_at: createdAt } as IntegrationRecord;

  await publishDurableProtocolRecord(github, {
    storageSha: normalized.identity.headSha,
    publisherSha: normalized.identity.baseSha,
    scope: integrationScope(normalized.identity.prNumber),
    unsignedBody: `${serializeIntegrationRecord(normalized)}\n\nINTEGRATION RECORD — CANONICAL`,
    publicationTimestamp: Date.parse(normalized.created_at),
    authorityOrder: normalized.created_at,
  });
  await replaceIntegrationLocator(github, normalized);
  if (normalized.terminal) await releaseIntegrationAuthorityVariable(github, normalized);
  return normalized;
}

export async function markIntegrationDispatchStarted(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  requestId: string,
  startedAt = new Date().toISOString(),
): Promise<IntegrationRecord> {
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.request.request_id !== requestId || current.terminal || !current.dispatch) {
    throw new Error(`Integration request ${requestId} is not an active authorized dispatch.`);
  }
  if (current.dispatch_started_at) return current;
  return publishIntegrationRecord(github, {
    ...current,
    dispatch_started_at: startedAt,
    created_at: startedAt,
  });
}

export async function ensureIntegrationDispatch(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  now = Date.now(),
): Promise<{ request?: IntegrationRequest; dispatch: boolean; dispatchSecret?: string; authorityAnchor?: string }> {
  let current: IntegrationRecord | undefined;
  try {
    current = await getCurrentIntegrationRecord(github, snapshot.identity);
  } catch (error) {
    if (error instanceof DurableProtocolRecoveryPendingError) return { dispatch: false };
    throw error;
  }
  let predecessorRequestId: string | undefined;
  if (current?.terminal && current.terminal.state !== "aborted") {
    await releaseIntegrationAuthorityVariable(github, current);
    return { request: current.request, dispatch: false };
  }
  if (current?.terminal?.state === "aborted") {
    predecessorRequestId = current.request.request_id;
    await releaseIntegrationAuthorityVariable(github, current);
    current = undefined;
  }

  if (current) {
    const evidence = current.run ? undefined : await getIntegrationRunStartEvidence(github, current);
    if (evidence && !current.run) {
      current = await bindIntegrationRun(github, snapshot, current.request.request_id, evidence.run_id);
    }
    if (current.run) {
      const bound = await getBoundIntegrationWorkflowRun(github, current);
      if (!bound) {
        const started = Date.parse(current.run.created_at);
        if (!Number.isFinite(started) || now - started < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
          return { request: current.request, dispatch: false };
        }
        await publishIntegrationRecord(github, {
          ...current,
          terminal: {
            state: "failure",
            detail: "Protected attempt 1 crossed its durable run-start boundary but the Actions run disappeared before terminal publication; deletion can never downgrade possible failure into retry.",
            created_at: new Date(now).toISOString(),
          },
          created_at: new Date(now).toISOString(),
        });
        return { request: current.request, dispatch: false };
      }
      if (bound.status !== "completed") return { request: current.request, dispatch: false };
      if (bound.conclusion === "failure") {
        await publishIntegrationRecord(github, {
          ...current,
          terminal: { state: "failure", detail: "Protected Integration attempt 1 completed failure before terminal publication.", created_at: new Date(now).toISOString() },
          created_at: new Date(now).toISOString(),
        });
        return { request: current.request, dispatch: false };
      }
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "error",
          detail: bound.conclusion === "success"
            ? "Protected Integration attempt 1 completed without durable terminal PASS evidence."
            : `Protected Integration attempt 1 completed ${bound.conclusion ?? "without conclusion"}; known attempt 1 cannot become retryable transport.`,
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });
      return { request: current.request, dispatch: false };
    }
    if (!evidence) {
      const created = Date.parse(current.request.created_at);
      if (!Number.isFinite(created) || now - created < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
        return { request: current.request, dispatch: false };
      }
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "aborted",
          detail: "Authorized Integration request has no discoverable protected attempt-1 run after the recovery grace period; protected evidence proves no attempt was created, so transport may recover with a fresh request.",
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });
      predecessorRequestId = current.request.request_id;
      current = undefined;
    }
  }

  const request = createIntegrationRequest(snapshot.identity, new Date(now).toISOString());
  const authorizedAt = new Date(now).toISOString();
  let authorized: Awaited<ReturnType<typeof authorizeIntegrationDispatch>>;
  try {
    authorized = await authorizeIntegrationDispatch(github, request, authorizedAt, undefined, predecessorRequestId);
  } catch (error) {
    if (error instanceof IntegrationAuthorityCapacityPendingError) return { dispatch: false };
    throw error;
  }

  const anchorBody = await getFugueAuthorityVariable(github, authorized.authorization.anchor_name);
  if (!anchorBody || !(await verifyIntegrationDispatchAnchor(github, createIntegrationRecord(authorized.request, {
    dispatch: authorized.authorization,
    createdAt: authorized.authorization.authorized_at,
  }), anchorBody))) {
    await abandonIntegrationAuthorization(github, authorized.electionName, authorized.request);
    return { dispatch: false };
  }

  let afterElection = await getCurrentIntegrationRecord(github, snapshot.identity);
  const predecessorStillCurrent = predecessorRequestId
    ? afterElection?.request.request_id === predecessorRequestId && afterElection.terminal?.state === "aborted"
    : afterElection === undefined;
  if (afterElection && afterElection.request.request_id === authorized.request.request_id && !afterElection.terminal) {
  } else if (!predecessorStillCurrent) {
    await abandonIntegrationAuthorization(github, authorized.electionName, authorized.request);
    return afterElection ? { request: afterElection.request, dispatch: false } : { dispatch: false };
  } else {
    afterElection = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization,
      createdAt: authorized.authorization.authorized_at,
    }));
  }
  const confirmed = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!confirmed || confirmed.request.request_id !== authorized.request.request_id || confirmed.terminal) {
    await abandonIntegrationAuthorization(github, authorized.electionName, authorized.request);
    return confirmed ? { request: confirmed.request, dispatch: false } : { dispatch: false };
  }
  await retireIntegrationElection(github, authorized.electionName);
  await createProtocolComment(
    github,
    snapshot.identity.prNumber,
    `INTEGRATION — REQUESTED\n\nHead: \`${snapshot.identity.headSha}\`\nRequest: \`${authorized.request.request_id}\`\n\n<!-- fugue-integration-request-mirror\nversion: 1\nrequest_id: ${authorized.request.request_id}\n-->`,
  );
  return {
    request: confirmed.request,
    dispatch: true,
    dispatchSecret: authorized.secret,
    authorityAnchor: authorized.authorization.anchor_name,
  };
}

async function revalidateExactIntegrationCommit(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  requestId: string,
  runId: number,
): Promise<IntegrationRecord> {
  const latest = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!latest || latest.request.request_id !== requestId || latest.terminal || !latest.dispatch) {
    await releaseIntegrationCommit(github, requestId);
    throw new Error(`Integration run ${runId} ceased to be active after exact-run serialization for request ${requestId}.`);
  }
  if (latest.run && latest.run.id !== runId) {
    await releaseIntegrationCommit(github, requestId);
    throw new Error(`Integration request ${requestId} is already bound to protected run ${latest.run.id}.`);
  }
  return latest;
}

export async function bindIntegrationRun(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  requestId: string,
  runId: number,
): Promise<IntegrationRecord> {
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.request.request_id !== requestId || current.terminal || !current.dispatch) {
    throw new Error(`Integration run ${runId} does not match an active durable request ${requestId}.`);
  }
  if (current.run) {
    if (current.run.id !== runId) throw new Error(`Integration request ${requestId} is already bound to protected run ${current.run.id}.`);
    await releaseIntegrationAuthorityVariable(github, current);
    return current;
  }
  const evidence = await getIntegrationRunStartEvidence(github, current);
  if (!evidence || evidence.run_id !== runId) {
    throw new Error(`Integration run ${runId} does not match the one-use protected dispatch evidence for request ${requestId}.`);
  }
  const proposed = integrationRunBindingFromEvidence(github, evidence);
  const winner = await claimExactIntegrationCommit(github, integrationCommitContext(current)!, {
    runId: proposed.id,
    createdAt: proposed.created_at,
    htmlUrl: proposed.html_url,
  });
  const binding = integrationRunBindingFromCommit(github, winner);
  const latest = await revalidateExactIntegrationCommit(github, snapshot, requestId, binding.id);
  if (latest.run) {
    await releaseIntegrationAuthorityVariable(github, latest);
    return latest;
  }
  const bound = await publishIntegrationRecord(github, {
    ...latest,
    dispatch_started_at: latest.dispatch_started_at ?? binding.created_at,
    run: binding,
    created_at: binding.created_at,
  });
  await releaseIntegrationAuthorityVariable(github, bound);
  return bound;
}

export async function bindDispatchedIntegrationRun(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  requestId: string,
  runId: number,
  htmlUrl: string,
  createdAt = new Date().toISOString(),
): Promise<IntegrationRecord> {
  if (!Number.isInteger(runId) || runId <= 0 || !htmlUrl) throw new Error("Protected Integration dispatch did not return a valid run identity.");
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.request.request_id !== requestId || current.terminal || !current.dispatch) {
    throw new Error(`Integration run ${runId} does not match an active authorized durable request ${requestId}.`);
  }
  if (current.run) {
    if (current.run.id !== runId) throw new Error(`Integration request ${requestId} is already bound to protected run ${current.run.id}.`);
    return current;
  }
  const winner = await claimExactIntegrationCommit(github, integrationCommitContext(current)!, { runId, createdAt, htmlUrl });
  const binding = integrationRunBindingFromCommit(github, winner);
  const latest = await revalidateExactIntegrationCommit(github, snapshot, requestId, binding.id);
  if (latest.run) {
    await releaseIntegrationAuthorityVariable(github, latest);
    return latest;
  }
  const bound = await publishIntegrationRecord(github, {
    ...latest,
    dispatch_started_at: latest.dispatch_started_at ?? binding.created_at,
    run: binding,
    created_at: binding.created_at,
  });
  await releaseIntegrationAuthorityVariable(github, bound);
  return bound;
}

export async function getBoundIntegrationWorkflowRun(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationWorkflowRun | undefined> {
  if (!record.run) return undefined;
  return getIntegrationWorkflowRunForBinding(github, record.request, record.run);
}

async function getIntegrationWorkflowRunForBinding(
  github: FugueGitHub,
  request: IntegrationRequest,
  binding: IntegrationRunBinding,
): Promise<IntegrationWorkflowRun | undefined> {
  const { owner, repo } = github.repository;
  try {
    const response = await github.octokit.rest.actions.getWorkflowRunAttempt({
      owner,
      repo,
      run_id: binding.id,
      attempt_number: 1,
    });
    const run = response.data as unknown as WorkflowRunRecord;
    const requestCreated = Date.parse(request.created_at);
    if (!matchesIntegrationRunIdentity(run, request, requestCreated)) return undefined;
    if (normalizedRunAttempt(run.run_attempt) !== 1) return undefined;
    return workflowRun(run);
  } catch (error) {
    if (httpStatus(error) === 404) return undefined;
    throw error;
  }
}

function workflowRun(run: WorkflowRunRecord): IntegrationWorkflowRun {
  return { id: run.id, status: run.status, conclusion: run.conclusion, htmlUrl: run.html_url, createdAt: run.created_at ?? "", attempt: 1 };
}

function matchesIntegrationRunIdentity(run: WorkflowRunRecord, request: IntegrationRequest, requestCreated: number): boolean {
  const runCreated = Date.parse(run.created_at ?? "");
  const baseTitle = integrationRunTitle(request.request_id, request.identity.prNumber);
  const titleMatches = run.display_title === baseTitle ||
    new RegExp(`^${baseTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} [0-9a-f]{24}$`).test(run.display_title);
  return isTrustedProtocolWorkflowRun(run) &&
    run.event === "workflow_dispatch" &&
    run.head_sha === request.identity.baseSha && titleMatches &&
    Number.isFinite(runCreated) && runCreated >= requestCreated;
}

function normalizedRunAttempt(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function integrationScope(prNumber: number): string {
  return `integration/${prNumber}`;
}

async function loadIntegrationLocator(github: FugueGitHub, identity: IntegrationRequest["identity"]): Promise<IntegrationRecord | undefined> {
  const records: IntegrationRecord[] = [];
  for (const comment of await recentPrComments(github, identity.prNumber)) {
    const body = comment.body ?? "";
    if (!body.includes(INTEGRATION_RECEIPT)) continue;
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    let record: IntegrationRecord | null;
    try { record = parseIntegrationRecord(body); } catch { continue; }
    if (record && sameEvaluationIdentity(record.identity, identity)) records.push(record);
  }
  if (!records.length) return undefined;
  const newest = records.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1)!;
  if (records.some((candidate) => !sameIntegrationRecord(candidate, newest))) return undefined;
  return newest;
}

async function replaceIntegrationLocator(github: FugueGitHub, record: IntegrationRecord): Promise<void> {
  const locator = await loadIntegrationLocator(github, record.identity);
  if (locator && sameIntegrationRecord(locator, record)) return;
  await deleteIntegrationLocators(github, record.identity.prNumber);
  await createIntegrationLocator(github, record);
}

async function createIntegrationLocator(github: FugueGitHub, record: IntegrationRecord): Promise<void> {
  const label = record.terminal?.state === "success" ? "PASS" :
    record.terminal?.state === "failure" ? "FAILED" :
    record.terminal?.state === "error" ? "ERROR" :
    record.terminal?.state === "identity_lost" ? "IDENTITY LOST" :
    record.terminal?.state === "aborted" ? "ABORTED" : record.run ? "BOUND" : "REQUESTED";
  await createProtocolComment(
    github,
    record.identity.prNumber,
    `${serializeIntegrationRecord(record)}\n\nINTEGRATION — ${label}\n\nRequest: \`${record.request.request_id}\`${record.run ? `\nRun: \`${record.run.id}\` attempt 1` : ""}\n\n${INTEGRATION_RECEIPT}`,
  );
}

async function deleteIntegrationLocators(github: FugueGitHub, prNumber: number): Promise<void> {
  const { owner, repo } = github.repository;
  for (const comment of await recentPrComments(github, prNumber)) {
    if (!(comment.body ?? "").includes(INTEGRATION_RECEIPT)) continue;
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try { await github.octokit.rest.issues.deleteComment({ owner, repo, comment_id: comment.id }); }
    catch (error) { if (httpStatus(error) !== 404) throw error; }
  }
}

async function recentPrComments(github: FugueGitHub, prNumber: number) {
  const { owner, repo } = github.repository;
  const issue = await github.octokit.rest.issues.get({ owner, repo, issue_number: prNumber });
  const total = issue.data.comments ?? 0;
  const page = Math.max(1, Math.ceil(total / 100));
  const response = await github.octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 100, page });
  return response.data;
}

function sameIntegrationRecord(left: IntegrationRecord, right: IntegrationRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
