import {
  createAttestationId,
  integrationAttestationSchema,
  parseAttestation,
  serializeAttestation,
  type HumanControlPlaneAttestation,
  type IntegrationAttestation,
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
import { assertOwnership } from "./ownership.js";
import { FUGUE_CLI_VERSION } from "./protocol.js";
import { createProtocolComment, isTrustedProtocolComment } from "./provenance.js";
import { currentQaAttestations } from "./reviews.js";
import { runValidation } from "./validation.js";
import { withCleanWorktree } from "./worktree.js";

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
    await publishIntegrationFailure(github, snapshot.identity, error);
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

  const comment = await createProtocolComment(
    github,
    snapshot.pr.number,
    `INTEGRATION — PASS\n\nHead: \`${snapshot.identity.headSha}\`\nBase: \`${snapshot.identity.baseBranch}@${snapshot.identity.baseSha}\`\nPolicy: \`${snapshot.identity.policyDigest}\`\nWork spec: \`${snapshot.identity.workSpecDigest}\`\n\n${serializeAttestation(attestation)}`,
  );

  const { owner, repo } = github.repository;
  await github.octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: snapshot.identity.headSha,
    state: "success",
    context: "fugue/integration",
    description: "Fugue Integration passed",
    target_url: comment.data.html_url,
  });

  return { snapshot, attestation, url: comment.data.html_url };
}

export async function publishIntegrationFailure(
  github: FugueGitHub,
  identity: IntegrationPlan["identity"],
  error: unknown,
): Promise<void> {
  const gateFailure = error instanceof IntegrationGateFailure;
  const state = gateFailure ? "failure" : "error";
  const label = gateFailure ? "FAILED" : "ERROR";
  const detail = message(error);
  const { owner, repo } = github.repository;

  let targetUrl: string | undefined;
  try {
    const comment = await createProtocolComment(
      github,
      identity.prNumber,
      `INTEGRATION — ${label}\n\nHead: \`${identity.headSha}\`\nBase: \`${identity.baseBranch}@${identity.baseSha}\`\n\n${detail}`,
    );
    targetUrl = comment.data.html_url;
  } catch {
    // Preserve the original Integration failure even if evidence posting also fails.
  }

  await github.octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: identity.headSha,
    state,
    context: "fugue/integration",
    description: truncate(`Fugue Integration ${label.toLowerCase()}: ${detail}`, 140),
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}

export async function integrate(github: FugueGitHub, prNumber: number): Promise<IntegrationResult> {
  let prepared: PreparedIntegration | null = null;
  try {
    const current = await prepareIntegration(github, prNumber);
    prepared = current;
    const rawValidation = await withCleanWorktree(current.plan.identity.headSha, (worktree) =>
      runValidation(
        worktree,
        current.plan.validation.install,
        current.plan.validation.checks,
      ),
    );
    const validation = integrationValidationSchema.parse({
      version: 1,
      identity: current.plan.identity,
      passed: true,
      commands: rawValidation.commands,
      created_at: new Date().toISOString(),
    });
    return await finalizeIntegration(github, current.plan, validation);
  } catch (error) {
    if (prepared) await publishIntegrationFailure(github, prepared.plan.identity, error);
    throw error;
  }
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
