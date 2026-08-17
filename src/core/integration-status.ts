import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { type IntegrationAttestation } from "./attestations.js";
import { sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import type { FugueGitHub } from "./github.js";
import {
  createIntegrationRecord,
  createIntegrationRequest,
  integrationDispatchAuthorizationSchema,
  integrationRunTitle,
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
  createFugueAuthorityVariable,
  DurableProtocolRecoveryPendingError,
  getFugueAuthorityVariable,
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

const INTEGRATION_RECEIPT = "Fugue-Authority-Receipt: integration-d3";
export const INTEGRATION_REQUEST_RECOVERY_GRACE_MS = 10 * 60 * 1000;
const INTEGRATION_DISPATCH_ANCHOR_START = "<!-- fugue-integration-dispatch-anchor";
const INTEGRATION_RUN_START = "<!-- fugue-integration-run-start";
const PROTOCOL_END = "-->";

const integrationDispatchAnchorSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_dispatch_anchor"),
  request_id: z.string().min(1),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  secret_digest: z.string().regex(/^[0-9a-f]{64}$/i),
  authorized_at: z.string().min(1),
});

export const integrationRunStartSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_run_start"),
  request_id: z.string().min(1),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  secret_digest: z.string().regex(/^[0-9a-f]{64}$/i),
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

export function integrationEvidenceVariableName(secretDigest: string): string {
  if (!/^[0-9a-f]{64}$/i.test(secretDigest)) throw new Error("Invalid Integration dispatch digest.");
  return `FUGUE_INT_${secretDigest.slice(0, 32).toUpperCase()}`;
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

export async function authorizeIntegrationDispatch(
  github: FugueGitHub,
  request: IntegrationRequest,
  authorizedAt = new Date().toISOString(),
  secret = randomBytes(32).toString("hex"),
): Promise<{ secret: string; authorization: IntegrationDispatchAuthorization }> {
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error("Integration dispatch secret must be 256-bit hexadecimal.");
  const secretDigest = createHash("sha256").update(secret, "utf8").digest("hex");
  const authorization = integrationDispatchAuthorizationSchema.parse({ secret_digest: secretDigest, authorized_at: authorizedAt });
  const anchor = integrationDispatchAnchorSchema.parse({
    version: 1,
    kind: "integration_dispatch_anchor",
    request_id: request.request_id,
    pr_number: request.identity.prNumber,
    head_sha: request.identity.headSha,
    base_sha: request.identity.baseSha,
    secret_digest: secretDigest,
    authorized_at: authorizedAt,
  });
  await createIntegrationDispatchAnchor(github, request, anchor);
  return { secret, authorization };
}

async function createIntegrationDispatchAnchor(
  github: FugueGitHub,
  request: IntegrationRequest,
  anchor: IntegrationDispatchAnchor,
): Promise<void> {
  await assertRepositoryDefaultBranchRevision(github, request.identity.baseSha);
  const signed = await signProtocolBody(github, serializeIntegrationDispatchAnchor(anchor));
  const timestamp = Date.parse(anchor.authorized_at);
  if (!(await verifyProtocolPublicationBodyAtRevision(github, signed, request.identity.baseSha, timestamp))) {
    throw new Error("Protected Integration dispatch anchor failed publisher self-check.");
  }
  await assertRepositoryDefaultBranchRevision(github, request.identity.baseSha);
  const name = integrationEvidenceVariableName(anchor.secret_digest);
  const created = await createFugueAuthorityVariable(github, name, signed);
  if (!created) {
    const existing = await getFugueAuthorityVariable(github, name);
    const parsed = existing ? parseIntegrationDispatchAnchor(existing) : null;
    if (!existing || !parsed || JSON.stringify(parsed) !== JSON.stringify(anchor) ||
        !(await verifyProtocolPublicationBodyAtRevision(github, existing, request.identity.baseSha, timestamp))) {
      throw new Error(`Integration dispatch authority variable ${name} already exists with different authority.`);
    }
  }
}

async function verifyIntegrationDispatchAnchor(
  github: FugueGitHub,
  record: IntegrationRecord,
  body: string,
): Promise<IntegrationDispatchAnchor | undefined> {
  let anchor: IntegrationDispatchAnchor | null;
  try { anchor = parseIntegrationDispatchAnchor(body); } catch { return undefined; }
  if (!anchor || !record.dispatch) return undefined;
  if (anchor.request_id !== record.request.request_id || anchor.pr_number !== record.identity.prNumber ||
      anchor.head_sha !== record.identity.headSha || anchor.base_sha !== record.identity.baseSha ||
      anchor.secret_digest !== record.dispatch.secret_digest || anchor.authorized_at !== record.dispatch.authorized_at) return undefined;
  const timestamp = Date.parse(anchor.authorized_at);
  if (!Number.isFinite(timestamp) ||
      !(await verifyProtocolPublicationBodyAtRevision(github, body, record.identity.baseSha, timestamp))) return undefined;
  return anchor;
}

export async function getIntegrationRunStartEvidence(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationRunStartEvidence | undefined> {
  if (!record.dispatch) return undefined;
  const name = integrationEvidenceVariableName(record.dispatch.secret_digest);
  const body = await getFugueAuthorityVariable(github, name);
  if (!body) throw new Error(`Protected Integration authority variable ${name} is missing.`);
  let start: IntegrationRunStartEvidence | null;
  try { start = parseIntegrationRunStart(body); } catch { start = null; }
  if (!start) {
    if (!(await verifyIntegrationDispatchAnchor(github, record, body))) {
      throw new Error(`Protected Integration authority variable ${name} is not a valid dispatch anchor.`);
    }
    return undefined;
  }
  if (start.request_id !== record.request.request_id || start.pr_number !== record.identity.prNumber ||
      start.head_sha !== record.identity.headSha || start.base_sha !== record.identity.baseSha ||
      start.secret_digest !== record.dispatch.secret_digest || start.run_attempt !== 1) {
    throw new Error(`Protected Integration run-start evidence ${name} does not match its durable request.`);
  }
  const timestamp = Date.parse(start.created_at);
  if (!Number.isFinite(timestamp) ||
      !(await verifyProtocolPublicationBodyAtRevision(github, body, record.identity.baseSha, timestamp))) {
    throw new Error(`Protected Integration run-start evidence ${name} has invalid provenance.`);
  }
  return start;
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

  const evidence = await getIntegrationRunStartEvidence(github, record);
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
  const match = event.displayTitle.match(/^Fugue Integration PR #(\d+) (int-[0-9a-f]{16}-[0-9a-f]{16})$/);
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
  if (record.terminal) return false;
  const evidence = await getIntegrationRunStartEvidence(github, record);
  if (!evidence || evidence.run_id !== event.runId) return false;
  const binding = integrationRunBindingFromEvidence(github, evidence);
  if (record.run && record.run.id !== binding.id) return false;
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
}

export async function publishIntegrationRecord(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationRecord> {
  const current = await getCurrentIntegrationRecord(github, record.identity);
  if (current && sameIntegrationRecord(current, record)) return current;
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
  return normalized;
}

export async function ensureIntegrationDispatch(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  now = Date.now(),
): Promise<{ request?: IntegrationRequest; dispatch: boolean; dispatchSecret?: string }> {
  let current: IntegrationRecord | undefined;
  try {
    current = await getCurrentIntegrationRecord(github, snapshot.identity);
  } catch (error) {
    if (error instanceof DurableProtocolRecoveryPendingError) return { dispatch: false };
    throw error;
  }
  if (current?.terminal && current.terminal.state !== "aborted") return { request: current.request, dispatch: false };
  if (current?.terminal?.state === "aborted") current = undefined;

  if (current) {
    const evidence = await getIntegrationRunStartEvidence(github, current);
    if (evidence && !current.run) {
      current = await publishIntegrationRecord(github, {
        ...current,
        run: integrationRunBindingFromEvidence(github, evidence),
        created_at: new Date(now).toISOString(),
      });
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
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "aborted",
          detail: "Authorized Integration dispatch never crossed its protected run-start boundary; transport may recover with a fresh request.",
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });
      current = undefined;
    }
  }

  const request = createIntegrationRequest(snapshot.identity, new Date(now).toISOString());
  const authorizedAt = new Date(now).toISOString();
  const authorized = await authorizeIntegrationDispatch(github, request, authorizedAt);
  await publishIntegrationRecord(github, createIntegrationRecord(request, {
    dispatch: authorized.authorization,
    createdAt: authorizedAt,
  }));
  await createProtocolComment(
    github,
    snapshot.identity.prNumber,
    `INTEGRATION — REQUESTED\n\nHead: \`${snapshot.identity.headSha}\`\nRequest: \`${request.request_id}\`\n\n<!-- fugue-integration-request-mirror\nversion: 1\nrequest_id: ${request.request_id}\n-->`,
  );
  return { request, dispatch: true, dispatchSecret: authorized.secret };
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
    return current;
  }
  const evidence = await getIntegrationRunStartEvidence(github, current);
  if (!evidence || evidence.run_id !== runId) {
    throw new Error(`Integration run ${runId} does not match the one-use protected dispatch evidence for request ${requestId}.`);
  }
  return publishIntegrationRecord(github, {
    ...current,
    run: integrationRunBindingFromEvidence(github, evidence),
    created_at: new Date().toISOString(),
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
  return isTrustedProtocolWorkflowRun(run) &&
    run.event === "workflow_dispatch" &&
    run.head_sha === request.identity.baseSha &&
    run.display_title === integrationRunTitle(request.request_id, request.identity.prNumber) &&
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
