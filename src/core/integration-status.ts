import type { EvaluationSnapshot } from "./evaluation.js";
import type { FugueGitHub } from "./github.js";
import { parseIntegrationRecord, type IntegrationRecord, type IntegrationRequest } from "./integration-plan.js";
import {
  findEarliestProtectedIntegrationRunWitness,
  IntegrationRunWitnessDiscoveryPendingError,
} from "./integration-run-witness.js";
import { DurableProtocolRecoveryPendingError, recoverDurableProtocolRecord } from "./state.js";
import * as legacy from "./integration-status-legacy.js";

export {
  INTEGRATION_AUTHORITY_SLOT_LIMIT,
  INTEGRATION_REQUEST_RECOVERY_GRACE_MS,
  IntegrationAuthorityCapacityPendingError,
  authorizeIntegrationDispatch,
  bindDispatchedIntegrationRun,
  bindIntegrationRun,
  currentIntegrationState,
  findCurrentIntegrationRequest,
  getBoundIntegrationWorkflowRun,
  getCurrentIntegrationRecord,
  getIntegrationRunStartEvidence,
  integrationAnchorVariableName,
  integrationDispatchRunToken,
  integrationElectionVariableName,
  integrationRunStartSchema,
  integrationRunStartVariableName,
  markIntegrationDispatchStarted,
  publishIntegrationRecord,
  reclaimOrphanIntegrationAuthorityVariables,
  releaseIntegrationAuthorityVariable,
  serializeIntegrationRunStartEvidence,
} from "./integration-status-legacy.js";
export type {
  CurrentIntegrationState,
  DurableIntegrationWorkflowRunEvent,
  IntegrationRunStartEvidence,
  IntegrationState,
  IntegrationWorkflowRun,
} from "./integration-status-legacy.js";

/**
 * Integration attempt identity is sealed by a protected, content-bound workflow witness before the
 * privileged environment/App-token path. Deployment and Deployment Status APIs are deliberately
 * hidden from the legacy reconciler so repository-writable deployment metadata is correlation only.
 */
export async function ensureIntegrationDispatch(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  now = Date.now(),
): Promise<{ request?: IntegrationRequest; dispatch: boolean; dispatchSecret?: string; authorityAnchor?: string }> {
  let current: IntegrationRecord | undefined;
  try {
    current = await legacy.getCurrentIntegrationRecord(github, snapshot.identity);
  } catch (error) {
    if (error instanceof DurableProtocolRecoveryPendingError) return { dispatch: false };
    throw error;
  }
  if (current && !current.run && !current.terminal && current.dispatch) {
    try {
      const witness = await findEarliestProtectedIntegrationRunWitness(github, current);
      if (witness) {
        await legacy.publishIntegrationRecord(github, {
          ...current,
          dispatch_started_at: current.dispatch_started_at ?? witness.created_at,
          run: witness,
          created_at: new Date(now).toISOString(),
        });
      }
    } catch (error) {
      if (error instanceof IntegrationRunWitnessDiscoveryPendingError) {
        return { request: current.request, dispatch: false };
      }
      throw error;
    }
  }
  return legacy.ensureIntegrationDispatch(withoutDeploymentAuthority(github), snapshot, now);
}

export async function sealIntegrationWorkflowRunEvent(
  github: FugueGitHub,
  event: legacy.DurableIntegrationWorkflowRunEvent | undefined,
): Promise<boolean> {
  if (event) await bindWitnessForWorkflowEvent(github, event);
  return legacy.sealIntegrationWorkflowRunEvent(withoutDeploymentAuthority(github), event);
}

async function bindWitnessForWorkflowEvent(
  github: FugueGitHub,
  event: legacy.DurableIntegrationWorkflowRunEvent,
): Promise<void> {
  if (event.workflowName !== "Fugue Integration" || event.runAttempt !== 1 || event.status !== "completed") return;
  const match = event.displayTitle.match(/^Fugue Integration PR #(\d+) (int-[0-9a-f]{16}-[0-9a-f]{16})(?: [0-9a-f]{24})?$/);
  if (!match?.[1] || !match[2]) return;
  const prNumber = Number(match[1]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return;
  const { owner, repo } = github.repository;
  const pr = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  let record: IntegrationRecord | undefined;
  try {
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: pr.data.head.sha,
      publisherSha: event.headSha,
      scope: `integration/${prNumber}`,
      issueNumber: prNumber,
      parse: parseIntegrationRecord,
      timestamp: (value) => Date.parse(value.created_at),
      order: (value) => value.created_at,
      validate: (value) => value.identity.prNumber === prNumber && value.identity.headSha === pr.data.head.sha &&
        value.identity.baseSha === event.headSha && value.request.request_id === match[2],
    });
    record = recovered.record?.value;
  } catch (error) {
    if (error instanceof DurableProtocolRecoveryPendingError) return;
    throw error;
  }
  if (!record || record.run || record.terminal || !record.dispatch) return;
  let witness;
  try {
    witness = await findEarliestProtectedIntegrationRunWitness(github, record);
  } catch (error) {
    if (error instanceof IntegrationRunWitnessDiscoveryPendingError) return;
    throw error;
  }
  if (!witness) return;
  await legacy.publishIntegrationRecord(github, {
    ...record,
    dispatch_started_at: record.dispatch_started_at ?? witness.created_at,
    run: witness,
    created_at: new Date().toISOString(),
  });
}

function withoutDeploymentAuthority(github: FugueGitHub): FugueGitHub {
  const request = github.octokit.request.bind(github.octokit) as unknown as (route: string, args: unknown) => Promise<unknown>;
  const octokit = new Proxy(github.octokit, {
    get(target, property, receiver) {
      if (property !== "request") return Reflect.get(target, property, receiver);
      return async (route: string, args: unknown) => {
        if (route === "GET /repos/{owner}/{repo}/deployments" ||
            route === "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses") {
          return { data: [] };
        }
        return request(route, args);
      };
    },
  });
  return new Proxy(github, {
    get(target, property, receiver) {
      if (property === "octokit") return octokit;
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as FugueGitHub;
}
