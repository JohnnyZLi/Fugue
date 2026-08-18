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
} from "./state.js";

export type IntegrationState = "none" | "pending" | "success" | "failure" | "error" | "stale";

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

interface DeploymentRecord {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  created_at: string;
}

interface DeploymentStatusRecord {
  id: number;
  state: string;
  environment?: string | null;
  environment_url?: string | null;
  created_at?: string | null;
}

interface CorrelatedDeploymentSnapshot {
  fingerprint: string;
  runs: IntegrationWorkflowRun[];
}

const INTEGRATION_RECEIPT = "Fugue-Authority-Receipt: integration-d3";
export const INTEGRATION_REQUEST_RECOVERY_GRACE_MS = 10 * 60 * 1000;
const INTEGRATION_DISPATCH_ANCHOR_START = "<!-- fugue-integration-dispatch-anchor";
const INTEGRATION_RUN_START = "<!-- fugue-integration-run-start";
const PROTOCOL_END = "-->";
const INTEGRATION_ELECTION_PREFIX = "FUGUE_INT_E_";
const INTEGRATION_ANCHOR_PREFIX = "FUGUE_INT_A_";
const INTEGRATION_RUN_START_PREFIX = "FUGUE_INT_S_";
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

class IntegrationRunDiscoveryPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationRunDiscoveryPendingError";
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
  await reclaimOrphanIntegrationAuthorityVariables(github, timestamp);
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
      await reclaimOrphanIntegrationAuthorityVariables(github, timestamp);
      const remaining = await listFugueAuthorityVariables(github, INTEGRATION_ANCHOR_PREFIX);
      if (remaining.length >= INTEGRATION_AUTHORITY_SLOT_LIMIT) {
        throw new IntegrationAuthorityCapacityPendingError(
          `Protected Integration authority has ${remaining.length} active request anchors; scheduled reclamation found no safe pre-d3 orphan to reclaim.`,
        );
      }
    }
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
  const anchorBody = await getFugueAuthorityVariable(github, record.dispatch.anchor_name);
  const startName = integrationRunStartVariableName(record.request);
  const body = await getFugueAuthorityVariable(github, startName);
  if (!anchorBody) {
    // Once request-specific run-start exists it is independently signed and bound to the d3 dispatch
    // digest/name; the transient secret anchor is no longer required for durable authority.
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
  // Request-specific immutable names are never reused. A stale cleanup for request A therefore
  // cannot erase request/run-start B; no read/check/delete CAS assumption is involved.
  await deleteFugueAuthorityVariable(github, integrationRunStartVariableName(record.request));
  await deleteFugueAuthorityVariable(github, record.dispatch.anchor_name);
}

async function retireIntegrationElection(github: FugueGitHub, electionName: string): Promise<void> {
  await deleteFugueAuthorityVariable(github, electionName);
}

async function abandonIntegrationAuthorization(
  github: FugueGitHub,
  electionName: string,
  request: IntegrationRequest,
): Promise<void> {
  await deleteFugueAuthorityVariable(github, integrationAnchorVariableName(request));
  await deleteFugueAuthorityVariable(github, electionName);
}

function integrationAuthorizationAge(anchor: IntegrationDispatchAnchor, now: number): number {
  const timestamp = Date.parse(anchor.authorized_at);
  return Number.isFinite(timestamp) ? now - timestamp : Number.POSITIVE_INFINITY;
}

export async function reclaimOrphanIntegrationAuthorityVariables(
  github: FugueGitHub,
  now = Date.now(),
): Promise<void> {
  const variables = await listFugueAuthorityVariables(github, "FUGUE_INT_");
  const anchors = new Map<string, IntegrationDispatchAnchor>();
  for (const variable of variables) {
    if (!variable.name.startsWith(INTEGRATION_ELECTION_PREFIX) && !variable.name.startsWith(INTEGRATION_ANCHOR_PREFIX)) continue;
    const anchor = await verifiedIntegrationAnchor(github, variable.value);
    if (!anchor) {
      await deleteFugueAuthorityVariable(github, variable.name);
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
    if (current?.request.request_id === anchor.request.request_id && !current.terminal) {
      // The request is durable. The election is no longer needed, but its request anchor remains
      // live until run binding/terminal publication has replaced transient authority with d3.
      await deleteFugueAuthorityVariable(github, variable.name);
      continue;
    }
    // No matching durable request exists after the grace window. Since dispatch happens only after
    // d3 request publication, this is a pre-d3 orphan. Deleting only its own immutable names cannot
    // affect a newer request. A very late stale writer is fenced by the d3 re-read before publish;
    // if it still publishes after reclamation, missing anchor is treated as unstarted and aborted.
    await deleteFugueAuthorityVariable(github, variable.name);
    await deleteFugueAuthorityVariable(github, anchor.anchor_name);
  }

  for (const [name, anchor] of anchors) {
    if (integrationAuthorizationAge(anchor, now) < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) continue;
    let current: IntegrationRecord | undefined;
    try { current = await getCurrentIntegrationRecord(github, anchor.request.identity); }
    catch (error) {
      if (error instanceof DurableProtocolRecoveryPendingError) continue;
      throw error;
    }
    if (current?.request.request_id === anchor.request.request_id && !current.terminal) continue;
    await deleteFugueAuthorityVariable(github, name);
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


/**
 * Recover the globally earliest protected attempt-1 run for an unbound request from GitHub's
 * environment-deployment history, not from mutable workflow-run pages. A job that references the
 * protected fugue-authority environment creates a platform deployment/status before its first step;
 * the configured environment URL carries only request/run correlation data and therefore survives
 * Actions-write deletion of the workflow-run record. Two identical complete scans are required so a
 * changing deployment set fails closed instead of producing a page-shifted winner.
 */
async function findEarliestCorrelatedIntegrationWorkflowRun(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationWorkflowRun | undefined> {
  if (!record.dispatch) return undefined;
  const anchorBody = await getFugueAuthorityVariable(github, record.dispatch.anchor_name);
  if (!anchorBody) return undefined;
  const anchor = await verifyIntegrationDispatchAnchor(github, record, anchorBody);
  if (!anchor) throw new Error(`Protected Integration request anchor ${record.dispatch.anchor_name} is not valid for earliest-run recovery.`);
  const token = integrationDispatchRunToken(record.request.request_id, anchor.dispatch_secret);

  let previous: CorrelatedDeploymentSnapshot | undefined;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await correlatedIntegrationDeploymentSnapshot(github, record, token);
    if (previous?.fingerprint === current.fingerprint) {
      return [...current.runs].sort((left, right) => left.id - right.id)[0];
    }
    previous = current;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new IntegrationRunDiscoveryPendingError(
    `Protected Integration deployment history for request ${record.request.request_id} changed during recovery; retry before choosing a run.`,
  );
}

async function correlatedIntegrationDeploymentSnapshot(
  github: FugueGitHub,
  record: IntegrationRecord,
  token: string,
): Promise<CorrelatedDeploymentSnapshot> {
  const { owner, repo, fullName } = github.repository;
  const minimumCreated = Math.max(Date.parse(record.request.created_at), Date.parse(record.dispatch!.authorized_at));
  if (!Number.isFinite(minimumCreated)) return { fingerprint: "invalid-time", runs: [] };
  const matches: Array<{ deploymentId: number; statusId: number; run: IntegrationWorkflowRun }> = [];

  for (let page = 1; page <= 1000; page += 1) {
    const response = await github.octokit.request("GET /repos/{owner}/{repo}/deployments", {
      owner,
      repo,
      sha: record.identity.baseSha,
      environment: "fugue-authority",
      per_page: 100,
      page,
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    });
    const deployments = response.data as unknown as DeploymentRecord[];
    for (const deployment of deployments) {
      const created = Date.parse(deployment.created_at);
      if (deployment.sha !== record.identity.baseSha || deployment.ref !== record.identity.baseBranch ||
          deployment.environment !== "fugue-authority" || deployment.task !== "deploy" ||
          !Number.isFinite(created) || created < minimumCreated) continue;
      const statusesResponse = await github.octokit.request(
        "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses",
        {
          owner,
          repo,
          deployment_id: deployment.id,
          per_page: 100,
          page: 1,
          headers: { "X-GitHub-Api-Version": "2026-03-10" },
        },
      );
      const statuses = statusesResponse.data as unknown as DeploymentStatusRecord[];
      for (const status of statuses) {
        const run = integrationRunFromDeploymentUrl(github, record.request, token, status.environment_url, deployment.created_at);
        if (!run || (status.environment && status.environment !== "fugue-authority")) continue;
        matches.push({ deploymentId: deployment.id, statusId: status.id, run });
        break;
      }
    }
    if (deployments.length < 100) break;
    if (page === 1000) {
      throw new IntegrationRunDiscoveryPendingError("Protected Integration deployment history exceeded the bounded stable-scan window.");
    }
  }

  matches.sort((left, right) => left.deploymentId - right.deploymentId || left.statusId - right.statusId);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(matches.map((match) => [match.deploymentId, match.statusId, match.run.id])), "utf8")
    .digest("hex");
  return { fingerprint, runs: matches.map((match) => match.run) };
}

function integrationRunFromDeploymentUrl(
  github: FugueGitHub,
  request: IntegrationRequest,
  token: string,
  rawUrl: string | null | undefined,
  createdAt: string,
): IntegrationWorkflowRun | undefined {
  if (!rawUrl) return undefined;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return undefined; }
  const prefix = `/${github.repository.fullName}/actions/runs/`;
  if (url.origin !== "https://github.com" || !url.pathname.startsWith(prefix) ||
      url.searchParams.get("fugue_request") !== request.request_id ||
      url.searchParams.get("fugue_run_token") !== token) return undefined;
  const suffix = url.pathname.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return undefined;
  const runId = Number(suffix);
  if (!Number.isSafeInteger(runId) || runId <= 0) return undefined;
  return {
    id: runId,
    status: null,
    conclusion: null,
    htmlUrl: `${url.origin}${url.pathname}`,
    createdAt,
    attempt: 1,
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
    if (isRecoverableAbortedRun(live.status, live.conclusion)) return { state: "none", request };
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
  let binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (!binding) {
    // A token in a run title is public presentation after the first run exists. Never bind from the
    // completion event itself. Reconstruct the entire matching protected-workflow set and accept this
    // event only if GitHub's globally earliest matching attempt-1 run is this exact run ID.
    if (!match[3] || !record.dispatch) return false;
    let earliest: IntegrationWorkflowRun | undefined;
    try { earliest = await findEarliestCorrelatedIntegrationWorkflowRun(github, record); }
    catch (error) { if (error instanceof IntegrationRunDiscoveryPendingError) return false; throw error; }
    if (!earliest || earliest.id !== event.runId) return false;
    binding = { id: earliest.id, attempt: 1, created_at: earliest.createdAt, html_url: earliest.htmlUrl };
  }
  if (binding.id !== event.runId) return false;
  const createdAt = new Date().toISOString();
  if (event.conclusion === "cancelled") {
    await publishIntegrationRecord(github, {
      ...record, run: binding,
      terminal: { state: "aborted", detail: "Protected attempt 1 completed cancelled.", created_at: createdAt },
      created_at: createdAt,
    });
    return true;
  }
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
    terminal: { state: "error", detail: `Protected attempt 1 completed ${event.conclusion ?? "without conclusion"}.`, created_at: createdAt },
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
  const current = await getCurrentIntegrationRecord(github, record.identity);
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
  if (current?.run && record.run && current.run.id !== record.run.id) {
    throw new Error(`Integration request ${record.request.request_id} is already bound to protected run ${current.run.id}.`);
  }

  const minimum = current ? Date.parse(current.created_at) + 1 : 0;
  const requested = Date.parse(record.created_at);
  const createdAt = new Date(Math.max(Date.now(), minimum, Number.isFinite(requested) ? requested : 0)).toISOString();
  const normalized = { ...record, created_at: createdAt } as IntegrationRecord;

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
      current = await publishIntegrationRecord(github, {
        ...current,
        dispatch_started_at: current.dispatch_started_at ?? evidence.created_at,
        run: integrationRunBindingFromEvidence(github, evidence),
        created_at: new Date(now).toISOString(),
      });
    }
    if (!current.run) {
      let earliest: IntegrationWorkflowRun | undefined;
      try { earliest = await findEarliestCorrelatedIntegrationWorkflowRun(github, current); }
      catch (error) {
        if (error instanceof IntegrationRunDiscoveryPendingError) return { request: current.request, dispatch: false };
        throw error;
      }
      if (earliest) {
        current = await publishIntegrationRecord(github, {
          ...current,
          dispatch_started_at: current.dispatch_started_at ?? earliest.createdAt,
          run: { id: earliest.id, attempt: 1, created_at: earliest.createdAt, html_url: earliest.htmlUrl },
          created_at: new Date(now).toISOString(),
        });
      }
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
      if (isRecoverableAbortedRun(bound.status, bound.conclusion)) {
        await publishIntegrationRecord(github, {
          ...current,
          terminal: { state: "aborted", detail: `Protected attempt 1 concluded ${bound.conclusion}.`, created_at: new Date(now).toISOString() },
          created_at: new Date(now).toISOString(),
        });
        predecessorRequestId = current.request.request_id;
        current = undefined;
      } else if (bound.conclusion === "failure") {
        await publishIntegrationRecord(github, {
          ...current,
          terminal: { state: "failure", detail: "Protected Integration attempt 1 completed failure before terminal publication.", created_at: new Date(now).toISOString() },
          created_at: new Date(now).toISOString(),
        });
        return { request: current.request, dispatch: false };
      } else {
        await publishIntegrationRecord(github, {
          ...current,
          terminal: { state: "error", detail: "Protected Integration attempt 1 completed without durable terminal PASS evidence.", created_at: new Date(now).toISOString() },
          created_at: new Date(now).toISOString(),
        });
        return { request: current.request, dispatch: false };
      }
    } else if (!evidence) {
      const created = Date.parse(current.request.created_at);
      if (!Number.isFinite(created) || now - created < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
        return { request: current.request, dispatch: false };
      }
      // No exact returned binding, protected run-start, or globally earliest correlated workflow run
      // exists after the recovery grace period. This includes legacy records carrying the old
      // pre-POST dispatch_started_at marker: that marker is no longer evidence that GitHub created a
      // run, so a crash before the POST cannot wedge the request forever.
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "aborted",
          detail: "Authorized Integration request has no discoverable protected attempt-1 run after the recovery grace period; transport may recover with a fresh request.",
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
    // A concurrent protected writer already published the elected request; converge on it.
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

export async function bindIntegrationRun(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  requestId: string,
  runId: number,
): Promise<IntegrationRecord> {
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.request.request_id !== requestId || current.terminal) {
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
  const bound = await publishIntegrationRecord(github, {
    ...current,
    run: integrationRunBindingFromEvidence(github, evidence),
    created_at: new Date().toISOString(),
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
  return publishIntegrationRecord(github, {
    ...current,
    dispatch_started_at: current.dispatch_started_at ?? createdAt,
    run: { id: runId, attempt: 1, created_at: createdAt, html_url: htmlUrl },
    created_at: createdAt,
  });
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

function isRecoverableAbortedRun(status: string | null, conclusion: string | null): boolean {
  return status === "completed" && conclusion !== null && conclusion !== "success" && conclusion !== "failure";
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
  if (records.some((record) => !sameIntegrationRecord(record, newest))) return undefined;
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
