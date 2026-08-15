import { currentQaAttestations } from "../core/reviews.js";
import { captureEvaluation } from "../core/evaluation.js";
import { createGitHub } from "../core/github.js";
import { discoverRepository } from "../core/git.js";
import { reconstructState } from "../core/state.js";

export async function runStatus(): Promise<void> {
  const repository = await discoverRepository();
  const github = await createGitHub(repository);
  const state = await reconstructState(github);

  console.log(`FUGUE — ${repository.fullName}`);
  console.log("");
  console.log(`BASE       ${state.policy.identity.baseBranch} @ ${short(state.policy.identity.baseSha)}`);
  console.log(`POLICY     ${shortDigest(state.policy.identity.policyDigest)}`);
  console.log(`PROTOCOL   ${state.policy.identity.protocolVersion}`);
  console.log("");

  if (!state.works.length) {
    console.log("No open Fugue work items.");
  }

  for (const work of state.works) {
    console.log(`#${work.issueNumber} ${work.title}`);
    console.log(`  Work ID      ${work.metadata.work_id}`);
    console.log(`  State        ${work.stateLabel.replace("state:", "")}`);
    console.log(`  Work spec    ${shortDigest(work.workSpecDigest)}`);
    console.log(`  Worker       ${work.metadata.execution.worker_id ?? "—"}`);
    console.log(`  Branch       ${work.metadata.execution.branch ?? "—"}`);
    console.log(`  PR           ${work.pr ? `#${work.pr.number}${work.pr.draft ? " (draft)" : ""}` : "—"}`);
    console.log(`  Head         ${work.pr ? short(work.pr.headSha) : "—"}`);
    console.log(`  Dependencies ${work.metadata.spec.dependencies.length ? work.metadata.spec.dependencies.map((n) => `#${n}`).join(", ") : "none"}`);

    if (work.pr) {
      try {
        const snapshot = await captureEvaluation(github, work.pr.number);
        const attestations = await currentQaAttestations(github, snapshot);
        for (const requirement of snapshot.qa.required) {
          const attestation = attestations.get(requirement.role);
          const value = !attestation
            ? "waiting"
            : attestation.verdict === "approved"
              ? `approved @ ${short(snapshot.identity.headSha)}`
              : attestation.verdict.replace("_", " ");
          console.log(`  ${qaLabel(requirement.role).padEnd(12)} ${value}`);
        }
        if (snapshot.qa.controlPlaneChanged) console.log("  Control      control-plane review required");
        if (snapshot.qa.validationControlChanged) console.log("  Validation   validation-control review required");
      } catch (error) {
        console.log(`  QA           unable to resolve: ${message(error)}`);
      }
    }

    if (work.drift.length) {
      console.log("  STATE DRIFT");
      for (const drift of work.drift) console.log(`    - ${drift}`);
    }
    console.log("");
  }

  if (state.drift.length) {
    console.log("REPOSITORY DRIFT");
    for (const drift of state.drift) console.log(`  - ${drift}`);
  }
}

function qaLabel(role: "code" | "security" | "visual"): string {
  if (role === "code") return "Code QA";
  if (role === "security") return "Security QA";
  return "Visual QA";
}

function short(value: string): string {
  return value.slice(0, 8);
}

function shortDigest(value: string): string {
  const raw = value.startsWith("sha256:") ? value.slice(7) : value;
  return raw.slice(0, 12);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
