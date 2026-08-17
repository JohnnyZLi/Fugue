import {
  createAttestationId,
  integrationAttestationSchema,
  parseAttestation,
  serializeAttestation,
  type HumanControlPlaneAttestation,
  type IntegrationAttestation,
  type IntegrationEvidenceIdentity,
  type QaAttestation,
  type QaRole,
} from "./attestations.js";
import { verifyRequiredCi } from "./ci.js";
import { captureEvaluation, sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import {
  IntegrationGateFailure,
  verifyBaseCurrent,
  verifyDependenciesSatisfied,
  verifyMergeability,
} from "./gates.js";
import type { FugueGitHub } from "./github.js";
import {
  assertValidationMatchesPlan,
  integrationPlanSchema,
  integrationValidationSchema,
  type IntegrationPlan,
  type IntegrationValidation,
} from "./integration-plan.js";
import { getCurrentIntegrationRecord, publishIntegrationRecord } from "./integration-status.js";
import { assertOwnership } from "./ownership.js";
import { FUGUE_CLI_VERSION } from "./protocol.js";
import { createProtocolComment, escapeProtocolMarkers, isTrustedProtocolComment } from "./provenance.js";
import { currentQaAttestations } from "./reviews.js";

const INTEGRATION_FAILURE_START = "<!-- fugue-integration-failure";
const MARKER_END = "-->";

export interface IntegrationResult {
  snapshot: EvaluationSnapshot;
  attestation: IntegrationAttestation;
  url: string;
}

export interface PreparedIntegration {
  snapshot: EvaluationSnapshot;
  plan: IntegrationPlan;
}

interface Prerequisites {
  qa: Map<QaRole, QaAttestation>;
  codeAttestation: QaAttestation;
  humanAcknowledgement: HumanControlPlaneAttestation | null;
}

export async function prepareIntegration(
  github: FugueGitHub,
  prNumber: number,
  integration: IntegrationEvidenceIdentity,
): Promise<PreparedIntegration> {
  const snapshot = await captureEvaluation(github, prNumber);
  const { owner, repo } = github.repository;

  await github.octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: snapshot.identity.headSha,
    state: "pending",
    context: "fugue/integration",
    description: "Fugue Integration in progress",
  });

  try {
    const prerequisites = await verifyPrerequisites(github, snapshot);
    const validationControl = prerequisites.codeAttestation.validation_control;
    const plan = integrationPlanSchema.parse({
      version: 1,
      identity: snapshot.identity,
      integration,
      validation: {
        install: snapshot.policy.config.validation.install,
        checks: snapshot.policy.config.validation.checks,
      },
      required_ci: snapshot.policy.config.validation.required_ci,
      qa_required: snapshot.qa.required.map((requirement) => requirement.role),
      agents_md: {
        update_required: prerequisites.codeAttestation.agents_md?.update_required ?? false,
        update_present: prerequisites.codeAttestation.agents_md?.update_present ?? false,
      },
      control_plane: {
        changed: snapshot.qa.controlPlaneChanged,
        human_acknowledgement: prerequisites.humanAcknowledgement ? "passed" : "not_required",
      },
      validation_control: {
        changed: snapshot.qa.validationControlChanged,
        reviewed: validationControl?.reviewed ?? !snapshot.qa.validationControlChanged,
        acceptable: validationControl?.acceptable ?? !snapshot.qa.validationControlChanged,
      },
      created_at: new Date().toISOString(),
    });
    return { snapshot, plan };
  } catch (error) {
    await publishIntegrationFailure(github, snapshot.identity, integration, error);
    throw error;
  }
}

export async function finalizeIntegration(
  github: FugueGitHub,
  plan: IntegrationPlan,
  validation: IntegrationValidation,
): Promise<IntegrationResult> {
  if (!sameEvaluationIdentity(plan.identity, validation.identity)) {
    throw new Error("Integration validation evidence does not match the prepared evaluation identity.");
  }
  assertValidationMatchesPlan(plan, validation);

  const snapshot = await captureEvaluation(github, plan.identity.prNumber);
  if (!sameEvaluationIdentity(plan.identity, snapshot.identity)) {
    throw new Error("Integration snapshot changed before finalization; rerun Integration from a fresh plan.");
  }

  const prerequisites = await verifyPrerequisites(github, snapshot);
  const ci = await verifyRequiredCi(
    github,
    snapshot.identity.headSha,
    plan.required_ci,
    snapshot.policy.config.validation.required_ci_workflow,
  );
  await verifyMergeability(github, snapshot.pr.number);

  const finalSnapshot = await captureEvaluation(github, snapshot.pr.number);
  if (!sameEvaluationIdentity(plan.identity, finalSnapshot.identity)) {
    throw new Error("Integration snapshot changed before success could be published; rerun Integration.");
  }

  const attestation = integrationAttestationSchema.parse({
    version: 1,
    kind: "integration",
    attestation_id: createAttestationId("integration"),
    identity: snapshot.identity,
    integration: plan.integration,
    fugue_version: FUGUE_CLI_VERSION,
    qa: {
      code: qaGate(snapshot, prerequisites.qa, "code"),
      security: qaGate(snapshot, prerequisites.qa, "security"),
      visual: qaGate(snapshot, prerequisites.qa, "visual"),
    },
    dependencies: { passed: true },
    agents_md: {
      impact_reviewed: true,
      update_required: prerequisites.codeAttestation.agents_md?.update_required ?? false,
      update_present: prerequisites.codeAttestation.agents_md?.update_present ?? false,
    },
    control_plane: plan.control_plane,
    validation_control: plan.validation_control,
    validation: {
      clean_worktree: true,
      passed: validation.passed,
      commands: validation.commands,
    },
    ci: {
      passed: ci.passed,
      checks: ci.checks,
    },
    base_current: { passed: true },
    conflicts: { none: true },
    verdict: "approved",
    created_at: new Date().toISOString(),
  });

  const record = await requireBoundIntegrationRecord(github, snapshot.identity, plan.integration);
  await publishIntegrationRecord(github, {
    ...record,
    terminal: {
      state: "success",
      attestation,
      created_at: new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  });

  let targetUrl = record.run?.html_url ?? "";
  try {
    const comment = await createProtocolComment(
      github,
      snapshot.pr.number,
      `INTEGRATION — PASS\n\nHead: \`${snapshot.identity.headSha}\`\nBase: \`${snapshot.identity.baseBranch}@${snapshot.identity.baseSha}\`\nRequest: \`${plan.integration.request_id}\`\nRun: \`${plan.integration.run_id}\` attempt 1\nPolicy: \`${snapshot.identity.policyDigest}\`\nWork spec: \`${snapshot.identity.workSpecDigest}\`\n\n${serializeAttestation(attestation)}`,
    );
    targetUrl = comment.data.html_url;
  } catch {
    // The durable Integration record already contains the complete terminal PASS attestation.
  }

  const { owner, repo } = github.repository;
  await github.octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: snapshot.identity.headSha,
    state: "success",
    context: "fugue/integration",
    description: "Fugue Integration passed",
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });

  return { snapshot, attestation, url: targetUrl };
}

export function renderIntegrationFailureComment(
  identity: IntegrationPlan["identity"],
  label: "FAILED" | "ERROR",
  detail: string,
  integration?: IntegrationEvidenceIdentity,
): string {
  const marker = [
    INTEGRATION_FAILURE_START,
    "version: 1",
    `pr: ${identity.prNumber}`,
    `head: ${identity.headSha}`,
    ...(integration ? [`request_id: ${integration.request_id}`, `run_id: ${integration.run_id}`, "run_attempt: 1"] : []),
    MARKER_END,
  ].join("\n");
  return `${marker}\n\nINTEGRATION — ${label}\n\nHead: \`${identity.headSha}\`\nBase: \`${identity.baseBranch}@${identity.baseSha}\`\n\n${escapeProtocolMarkers(detail)}`;
}

export async function publishIntegrationFailure(
  github: FugueGitHub,
  identity: IntegrationPlan["identity"],
  integration: IntegrationEvidenceIdentity,
  error: unknown,
): Promise<void> {
  const gateFailure = error instanceof IntegrationGateFailure;
  const state = gateFailure ? "failure" : "error";
  const label = gateFailure ? "FAILED" : "ERROR";
  const detail = message(error);
  const safeDetail = escapeProtocolMarkers(detail);
  const record = await requireBoundIntegrationRecord(github, identity, integration);

  await publishIntegrationRecord(github, {
    ...record,
    terminal: {
      state,
      detail,
      created_at: new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  });

  const { owner, repo } = github.repository;
  let targetUrl = record.run?.html_url;
  try {
    const comment = await createProtocolComment(
      github,
      identity.prNumber,
      renderIntegrationFailureComment(identity, label, detail, integration),
    );
    targetUrl = comment.data.html_url;
  } catch {
    // The durable record is primary terminal failure authority; the comment is presentation only.
  }

  await github.octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: identity.headSha,
    state,
    context: "fugue/integration",
    description: truncate(`Fugue Integration ${label.toLowerCase()}: ${safeDetail}`, 140),
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}

/** Local integrate cannot mint canonical request/run identity; authoritative Integration is GitHub-hosted. */
export async function integrate(_github: FugueGitHub, _prNumber: number): Promise<IntegrationResult> {
  throw new Error(
    "Authoritative Integration requires the protected GitHub-hosted workflow and a durable request/run binding; use local integrate only as a protocol-debugging surface.",
  );
}

async function requireBoundIntegrationRecord(
  github: FugueGitHub,
  identity: IntegrationPlan["identity"],
  integration: IntegrationEvidenceIdentity,
) {
  const record = await getCurrentIntegrationRecord(github, identity);
  if (!record || record.terminal || !record.run) {
    throw new Error(`Integration ${integration.request_id} has no active durable bound-run authority.`);
  }
  if (record.request.request_id !== integration.request_id ||
    record.run.id !== integration.run_id || record.run.attempt !== integration.run_attempt) {
    throw new Error("Integration plan does not match the durable request/run authority.");
  }
  return record;
}

async function verifyPrerequisites(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<Prerequisites> {
  await verifyBaseCurrent(github, snapshot.identity.baseSha, snapshot.identity.headSha);
  assertOwnership(snapshot.changedFiles, snapshot.workMetadata.spec.ownership);

  const qa = await currentQaAttestations(github, snapshot);
  verifyQa(snapshot, qa);
  await verifyDependenciesSatisfied(github, snapshot.workMetadata.spec.dependencies);

  const codeAttestation = qa.get("code");
  if (!codeAttestation?.agents_md?.reviewed) {
    throw new IntegrationGateFailure("agents", "Current Code QA lacks AGENTS.md impact attestation.");
  }
  if (codeAttestation.agents_md.update_required && !codeAttestation.agents_md.update_present) {
    throw new IntegrationGateFailure("agents", "AGENTS.md update is required but not present.");
  }

  if (snapshot.qa.validationControlChanged) {
    const validationControl = codeAttestation.validation_control;
    if (!validationControl?.reviewed || !validationControl.acceptable) {
      throw new IntegrationGateFailure(
        "validation-control",
        "Validation-control changes have not received an acceptable current Code QA attestation.",
      );
    }
  }

  let humanAcknowledgement: HumanControlPlaneAttestation | null = null;
  if (snapshot.qa.controlPlaneChanged) {
    humanAcknowledgement = await findCurrentHumanAcknowledgement(github, snapshot);
    if (!humanAcknowledgement) {
      throw new IntegrationGateFailure(
        "control-plane",
        "Control-plane changes require a current head-bound Human acknowledgement.",
      );
    }
  }

  return { qa, codeAttestation, humanAcknowledgement };
}

function verifyQa(snapshot: EvaluationSnapshot, attestations: Map<QaRole, QaAttestation>): void {
  for (const requirement of snapshot.qa.required) {
    const attestation = attestations.get(requirement.role);
    if (!attestation) {
      throw new IntegrationGateFailure("qa", `${requirement.role} QA is required but has no current attestation.`);
    }
    if (attestation.verdict !== "approved") {
      throw new IntegrationGateFailure(
        "qa",
        `${requirement.role} QA is required but current verdict is ${attestation.verdict}.`,
      );
    }
  }
}

function qaGate(
  snapshot: EvaluationSnapshot,
  attestations: Map<QaRole, QaAttestation>,
  role: QaRole,
): "passed" | "not_required" {
  const required = snapshot.qa.required.some((requirement) => requirement.role === role);
  if (!required) return "not_required";
  return attestations.get(role)?.verdict === "approved" ? "passed" : "not_required";
}

async function findCurrentHumanAcknowledgement(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<HumanControlPlaneAttestation | null> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });

  let current: HumanControlPlaneAttestation | null = null;
  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    let parsed;
    try {
      parsed = parseAttestation(comment.body ?? "");
    } catch {
      continue;
    }
    if (parsed?.kind !== "human_control_plane") continue;
    if (!sameEvaluationIdentity(parsed.identity, snapshot.identity)) continue;
    current = parsed;
  }
  return current;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
