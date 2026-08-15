import { createAttestationId, humanControlPlaneAttestationSchema, serializeAttestation } from "../core/attestations.js";
import { captureEvaluation, sameEvaluationIdentity } from "../core/evaluation.js";
import { discoverRepository } from "../core/git.js";
import { requireWritableGitHub } from "../core/github.js";
import { FUGUE_CLI_VERSION } from "../core/protocol.js";

export interface AcknowledgeOptions {
  controlPlane?: boolean;
}

export async function runAcknowledge(prValue: string, options: AcknowledgeOptions): Promise<void> {
  if (!options.controlPlane) throw new Error("Only --control-plane acknowledgement is implemented in v0.1.");
  const prNumber = parsePositiveInteger(prValue, "PR");
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const snapshot = await captureEvaluation(github, prNumber);

  if (!snapshot.qa.controlPlaneChanged) {
    throw new Error(`PR #${prNumber} does not modify the active control-plane path set.`);
  }

  const { owner, repo } = repository;
  const actor = await github.octokit.rest.users.getAuthenticated();
  const attestation = humanControlPlaneAttestationSchema.parse({
    version: 1,
    kind: "human_control_plane",
    attestation_id: createAttestationId("human-cp"),
    identity: snapshot.identity,
    fugue_version: FUGUE_CLI_VERSION,
    actor: actor.data.login,
    verdict: "acknowledged",
    created_at: new Date().toISOString(),
  });

  const finalSnapshot = await captureEvaluation(github, prNumber);
  if (!sameEvaluationIdentity(snapshot.identity, finalSnapshot.identity)) {
    throw new Error("PR evaluation identity changed before acknowledgement could be recorded.");
  }

  const comment = await github.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `HUMAN CONTROL-PLANE ACKNOWLEDGEMENT\n\nHead: \`${snapshot.identity.headSha}\`\nPolicy: \`${snapshot.identity.policyDigest}\`\nActor: @${actor.data.login}\n\n${serializeAttestation(attestation)}`,
  });

  console.log("CONTROL-PLANE ACKNOWLEDGED");
  console.log(`PR           #${prNumber}`);
  console.log(`Head         ${snapshot.identity.headSha}`);
  console.log(`Actor        ${actor.data.login}`);
  console.log(`Attestation  ${attestation.attestation_id}`);
  console.log(`Evidence     ${comment.data.html_url}`);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}
