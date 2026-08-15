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
import { FUGUE_CLI_VERSION } from "./protocol.js";
import { currentQaAttestations } from "./reviews.js";
import { runValidation } from "./validation.js";
import { withCleanWorktree } from "./worktree.js";

export interface IntegrationResult {
  snapshot: EvaluationSnapshot;
  attestation: IntegrationAttestation;
  url: string;
}

export async function integrate(github: FugueGitHub, prNumber: number): Promise<IntegrationResult> {
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
    await verifyBaseCurrent(github, snapshot.identity.baseSha, snapshot.identity.headSha);

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

    const validation = await withCleanWorktree(snapshot.identity.headSha, (worktree) =>
      runValidation(
        worktree,
        snapshot.policy.config.validation.install,
        snapshot.policy.config.validation.checks,
      ),
    );

    const ci = await verifyRequiredCi(
      github,
      snapshot.identity.headSha,
      snapshot.policy.config.validation.required_ci,
    );

    await verifyMergeability(github, prNumber);

    const finalSnapshot = await captureEvaluation(github, prNumber);
    if (!sameEvaluationIdentity(snapshot.identity, finalSnapshot.identity)) {
      throw new Error("Integration snapshot changed before success could be published; rerun Integration.");
    }

    const attestation = integrationAttestationSchema.parse({
      version: 1,
      kind: "integration",
      attestation_id: createAttestationId("integration"),
      identity: snapshot.identity,
      fugue_version: FUGUE_CLI_VERSION,
      qa: {
        code: qaGate(snapshot, qa, "code"),
        security: qaGate(snapshot, qa, "security"),
        visual: qaGate(snapshot, qa, "visual"),
      },
      dependencies: { passed: true },
      agents_md: {
        impact_reviewed: true,
        update_required: codeAttestation.agents_md.update_required,
        update_present: codeAttestation.agents_md.update_present,
      },
      control_plane: {
        changed: snapshot.qa.controlPlaneChanged,
        human_acknowledgement: humanAcknowledgement ? "passed" : "not_required",
      },
      validation_control: {
        changed: snapshot.qa.validationControlChanged,
        reviewed: codeAttestation.validation_control?.reviewed ?? !snapshot.qa.validationControlChanged,
        acceptable: codeAttestation.validation_control?.acceptable ?? !snapshot.qa.validationControlChanged,
      },
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

    const comment = await github.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `INTEGRATION — PASS\n\nHead: \`${snapshot.identity.headSha}\`\nBase: \`${snapshot.identity.baseBranch}@${snapshot.identity.baseSha}\`\nPolicy: \`${snapshot.identity.policyDigest}\`\nWork spec: \`${snapshot.identity.workSpecDigest}\`\n\n${serializeAttestation(attestation)}`,
    });

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
  } catch (error) {
    const gateFailure = error instanceof IntegrationGateFailure;
    const state = gateFailure ? "failure" : "error";
    const label = gateFailure ? "FAILED" : "ERROR";
    const detail = message(error);

    let targetUrl: string | undefined;
    try {
      const comment = await github.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `INTEGRATION — ${label}\n\nHead: \`${snapshot.identity.headSha}\`\nBase: \`${snapshot.identity.baseBranch}@${snapshot.identity.baseSha}\`\n\n${detail}`,
      });
      targetUrl = comment.data.html_url;
    } catch {
      // Preserve the original Integration failure even if evidence posting also fails.
    }

    await github.octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: snapshot.identity.headSha,
      state,
      context: "fugue/integration",
      description: truncate(`Fugue Integration ${label.toLowerCase()}: ${detail}`, 140),
      ...(targetUrl ? { target_url: targetUrl } : {}),
    });

    throw error;
  }
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
