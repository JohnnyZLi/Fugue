import { type IntegrationAttestation } from "./attestations.js";
import { sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import type { FugueGitHub } from "./github.js";
import {
  createIntegrationRecord,
  createIntegrationRequest,
  integrationRunTitle,
  parseIntegrationRecord,
  serializeIntegrationRecord,
  type IntegrationRecord,
  type IntegrationRequest,
  type IntegrationRunBinding,
} from "./integration-plan.js";
import { createProtocolComment, isTrustedProtocolComment, isTrustedProtocolWorkflowRun } from "./provenance.js";
import {
  DurableProtocolRecoveryPendingError,
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
      return {
        state: "success",
        request,
        attestation: record.terminal.attestation,
        targetUrl: record.run?.html_url,
      };
    }
    if (record.terminal.state === "aborted") return { state: "none" };
    return { state: record.terminal.state, request, targetUrl: record.run?.html_url };
  }

  if (record.run) {
    const bound = await getBoundIntegrationWorkflowRun(github, record);
    if (!bound) return { state: "pending", request };
    if (bound.status !== "completed") return { state: "pending", request, targetUrl: bound.htmlUrl };
    if (isRecoverableAbortedRun(bound.status, bound.conclusion)) return { state: "none", request };
    if (bound.conclusion === "failure") return { state: "failure", request, targetUrl: bound.htmlUrl };
    return { state: "pending", request, targetUrl: bound.htmlUrl };
  }

  const first = await findIntegrationWorkflowRun(github, request);
  if (first) {
    if (first.status !== "completed") return { state: "pending", request, targetUrl: first.htmlUrl };
    if (first.conclusion === "failure") return { state: "failure", request, targetUrl: first.htmlUrl };
    if (isRecoverableAbortedRun(first.status, first.conclusion)) return { state: "none", request };
    return { state: "pending", request, targetUrl: first.htmlUrl };
  }

  const created = Date.parse(request.created_at);
  if (!Number.isFinite(created)) return { state: "error", request };
  if (now - created < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) return { state: "pending", request };
  // Absence is ambiguous under actions:write: a protected run may have completed and been deleted
  // while its immutable workflow_run completion event is still queued for protected reconciliation.
  return { state: "pending", request };
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
  const identity = {
    prNumber,
    headSha: pr.data.head.sha,
    baseBranch: pr.data.base.ref,
    baseSha: event.headSha,
  };
  let record: IntegrationRecord | undefined;
  try {
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: identity.headSha,
      publisherSha: identity.baseSha,
      scope: integrationScope(prNumber),
      issueNumber: prNumber,
      parse: parseIntegrationRecord,
      timestamp: (value) => Date.parse(value.created_at),
      order: (value) => value.created_at,
      validate: (value) => value.identity.prNumber === prNumber &&
        value.identity.headSha === identity.headSha && value.identity.baseSha === identity.baseSha &&
        value.request.request_id === match[2],
    });
    if (!recovered.record) return false;
    record = recovered.record.value;
  } catch (error) {
    if (error instanceof DurableProtocolRecoveryPendingError) return false;
    throw error;
  }
  if (record.terminal && (!record.run || record.run.id <= event.runId)) return false;
  if (Date.parse(event.createdAt) < Date.parse(record.request.created_at)) return false;
  if (record.run && record.run.id < event.runId) return false;

  const visibleFirst = await findIntegrationWorkflowRun(github, record.request);
  if (visibleFirst && visibleFirst.id < event.runId) return false;
  const binding: IntegrationRunBinding = { id: event.runId, attempt: 1, created_at: event.createdAt, html_url: event.htmlUrl };
  const conclusion = event.conclusion;
  if (conclusion === "cancelled") {
    await publishIntegrationRecord(github, {
      ...record,
      run: binding,
      terminal: { state: "aborted", detail: "Protected attempt 1 completed cancelled.", created_at: new Date().toISOString() },
      created_at: new Date().toISOString(),
    });
    return true;
  }
  if (conclusion === "failure") {
    await publishIntegrationRecord(github, {
      ...record,
      run: binding,
      terminal: { state: "failure", detail: "Protected attempt 1 completed failure (sealed from immutable workflow_run event).", created_at: new Date().toISOString() },
      created_at: new Date().toISOString(),
    });
    return true;
  }
  if (conclusion === "success") {
    // A successful workflow must already have committed terminal PASS. Missing PASS is fail-closed.
    await publishIntegrationRecord(github, {
      ...record,
      run: binding,
      terminal: { state: "error", detail: "Protected attempt 1 completed success without durable terminal PASS evidence.", created_at: new Date().toISOString() },
      created_at: new Date().toISOString(),
    });
    return true;
  }
  await publishIntegrationRecord(github, {
    ...record,
    run: binding,
    terminal: { state: "error", detail: `Protected attempt 1 completed ${conclusion ?? "without conclusion"}; only observed cancellation is retryable.`, created_at: new Date().toISOString() },
    created_at: new Date().toISOString(),
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
  const correctingEarlierRun = Boolean(
    current?.run && record.run &&
    current.request.request_id === record.request.request_id &&
    record.run.id < current.run.id
  );
  if (current && current.terminal && current.terminal.state !== "aborted" && !correctingEarlierRun) {
    throw new Error(`Integration request ${current.request.request_id} already has terminal ${current.terminal.state} authority.`);
  }
  if (current && record.request.request_id !== current.request.request_id && current.terminal?.state !== "aborted") {
    throw new Error(`Cannot replace active Integration request ${current.request.request_id}.`);
  }
  if (current?.run && record.run && current.run.id !== record.run.id && !correctingEarlierRun) {
    throw new Error(`Integration request ${record.request.request_id} is already bound to earlier protected run ${current.run.id}.`);
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
): Promise<{ request?: IntegrationRequest; dispatch: boolean }> {
  let current: IntegrationRecord | undefined;
  try {
    current = await getCurrentIntegrationRecord(github, snapshot.identity);
  } catch (error) {
    if (error instanceof DurableProtocolRecoveryPendingError) return { dispatch: false };
    throw error;
  }

  if (current?.terminal && current.terminal.state !== "aborted") {
    return { request: current.request, dispatch: false };
  }

  if (current?.run) {
    const bound = await getBoundIntegrationWorkflowRun(github, current);
    if (!bound) {
      // The immutable workflow_run completion event is the authority for failure vs cancellation.
      // Until it is sealed, disappearance is fail-closed pending and never permits redispatch.
      return { request: current.request, dispatch: false };
    } else if (isRecoverableAbortedRun(bound.status, bound.conclusion)) {
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "aborted",
          detail: `Protected attempt 1 concluded ${bound.conclusion}.`,
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });
      current = undefined;
    } else if (bound.status === "completed" && bound.conclusion === "failure") {
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "failure",
          detail: "Protected Integration attempt 1 completed failure before its terminal mirror was observed.",
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });
      return { request: current.request, dispatch: false };
    } else {
      return { request: current.request, dispatch: false };
    }
  }

  if (current && !current.terminal) {
    const first = await findIntegrationWorkflowRun(github, current.request);
    const requestCreated = Date.parse(current.request.created_at);
    if (first && first.status !== "completed") return { request: current.request, dispatch: false };
    if (first?.conclusion === "failure") {
      const run = integrationRunBinding(first);
      await publishIntegrationRecord(github, {
        ...current,
        run,
        terminal: {
          state: "failure",
          detail: "The request's first protected attempt completed failure before Fugue prepare could bind it.",
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });
      return { request: current.request, dispatch: false };
    }
    if (first && !isRecoverableAbortedRun(first.status, first.conclusion)) {
      const run = integrationRunBinding(first);
      await publishIntegrationRecord(github, {
        ...current,
        run,
        terminal: {
          state: "error",
          detail: `The request's first protected attempt completed ${first.conclusion ?? "without a conclusion"} without durable terminal Integration evidence.`,
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });
      return { request: current.request, dispatch: false };
    }
    if (!first) {
      // Absence is ambiguous under actions:write because a genuine failed attempt may have been deleted.
      // The protected workflow_run completion event seals observable cancellation/failure; no missing run is retried.
      return { request: current.request, dispatch: false };
    }
    await publishIntegrationRecord(github, {
      ...current,
      run: integrationRunBinding(first),
      terminal: {
        state: "aborted",
        detail: `First protected run ${first.id} concluded ${first.conclusion}; only an observed aborted transport outcome permits a fresh request.`,
        created_at: new Date(now).toISOString(),
      },
      created_at: new Date(now).toISOString(),
    });
  }

  const request = createIntegrationRequest(snapshot.identity, new Date(now).toISOString());
  await publishIntegrationRecord(github, createIntegrationRecord(request, { createdAt: new Date(now).toISOString() }));
  await createProtocolComment(
    github,
    snapshot.identity.prNumber,
    `INTEGRATION — REQUESTED\n\nHead: \`${snapshot.identity.headSha}\`\nRequest: \`${request.request_id}\`\n\n<!-- fugue-integration-request-mirror\nversion: 1\nrequest_id: ${request.request_id}\n-->`,
  );
  return { request, dispatch: true };
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
    if (current.run.id !== runId) {
      throw new Error(`Integration request ${requestId} is already bound to protected run ${current.run.id}.`);
    }
    return current;
  }

  const first = await findIntegrationWorkflowRun(github, current.request);
  if (!first || first.id !== runId) {
    throw new Error(`Integration run ${runId} is not the first causally valid protected attempt for request ${requestId}.`);
  }
  return publishIntegrationRecord(github, {
    ...current,
    run: integrationRunBinding(first),
    created_at: new Date().toISOString(),
  });
}

export async function findIntegrationWorkflowRun(
  github: FugueGitHub,
  request: IntegrationRequest,
): Promise<IntegrationWorkflowRun | undefined> {
  const { owner, repo } = github.repository;
  const requestCreated = Date.parse(request.created_at);
  if (!Number.isFinite(requestCreated)) return undefined;
  const runs = await github.octokit.paginate(github.octokit.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: "fugue-integration.yml",
    event: "workflow_dispatch",
    head_sha: request.identity.baseSha,
    per_page: 100,
  });
  const candidates = (runs as unknown as WorkflowRunRecord[])
    .filter((run) => matchesIntegrationRunIdentity(run, request, requestCreated))
    .sort((left, right) => left.id - right.id);
  for (const run of candidates) {
    const attempt = await firstAttempt(github, run);
    if (!attempt || !matchesIntegrationRunIdentity(attempt, request, requestCreated)) continue;
    if (normalizedRunAttempt(attempt.run_attempt) !== 1) continue;
    return workflowRun(attempt);
  }
  return undefined;
}

export async function getBoundIntegrationWorkflowRun(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationWorkflowRun | undefined> {
  if (!record.run) return undefined;
  const { owner, repo } = github.repository;
  try {
    const response = await github.octokit.rest.actions.getWorkflowRunAttempt({
      owner,
      repo,
      run_id: record.run.id,
      attempt_number: 1,
    });
    const run = response.data as unknown as WorkflowRunRecord;
    const requestCreated = Date.parse(record.request.created_at);
    if (!matchesIntegrationRunIdentity(run, record.request, requestCreated)) return undefined;
    if (normalizedRunAttempt(run.run_attempt) !== 1) return undefined;
    return workflowRun(run);
  } catch (error) {
    if (httpStatus(error) === 404) return undefined;
    throw error;
  }
}

async function firstAttempt(github: FugueGitHub, run: WorkflowRunRecord): Promise<WorkflowRunRecord | undefined> {
  if (normalizedRunAttempt(run.run_attempt) === 1) return run;
  const { owner, repo } = github.repository;
  try {
    const response = await github.octokit.rest.actions.getWorkflowRunAttempt({ owner, repo, run_id: run.id, attempt_number: 1 });
    return response.data as unknown as WorkflowRunRecord;
  } catch (error) {
    if (httpStatus(error) === 404) return undefined;
    throw error;
  }
}

function integrationRunBinding(run: IntegrationWorkflowRun): IntegrationRunBinding {
  return { id: run.id, attempt: 1, created_at: run.createdAt, html_url: run.htmlUrl };
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
