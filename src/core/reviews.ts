import type { FugueGitHub } from "./github.js";
import {
  createAttestationId,
  createReviewSessionId,
  parseAttestation,
  qaAttestationSchema,
  reviewStartSchema,
  serializeAttestation,
  type QaAttestation,
  type QaRole,
  type ReviewStart,
} from "./attestations.js";
import { captureEvaluation, sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import { FUGUE_CLI_VERSION } from "./protocol.js";

export interface CompleteReviewOptions {
  verdict: "approved" | "changes_requested" | "error";
  agentsUpdate?: "not-required" | "present" | "missing";
  validationControl?: "acceptable" | "unacceptable";
  runtimeTested?: boolean;
  viewports?: string[];
  summary?: string;
}

export async function beginReview(
  github: FugueGitHub,
  prNumber: number,
  role: QaRole,
): Promise<{ snapshot: EvaluationSnapshot; session: ReviewStart }> {
  const snapshot = await captureEvaluation(github, prNumber);
  assertRoleRequired(snapshot, role);

  const session = reviewStartSchema.parse({
    version: 1,
    kind: "review_start",
    session_id: createReviewSessionId(role),
    role,
    identity: snapshot.identity,
    fugue_version: FUGUE_CLI_VERSION,
    created_at: new Date().toISOString(),
  });

  const { owner, repo } = github.repository;
  const comment = await github.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `${roleHeading(role)} — REVIEW STARTED\n\nHead: \`${snapshot.identity.headSha}\`\nBase: \`${snapshot.identity.baseBranch}@${snapshot.identity.baseSha}\`\nWork spec: \`${snapshot.identity.workSpecDigest}\`\n\n${serializeAttestation(session)}`,
  });

  await github.octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: snapshot.identity.headSha,
    state: "pending",
    context: statusContext(role),
    description: `${roleHeading(role)} review in progress`,
    target_url: comment.data.html_url,
  });

  return { snapshot, session };
}

export async function completeReview(
  github: FugueGitHub,
  prNumber: number,
  role: QaRole,
  options: CompleteReviewOptions,
): Promise<{ snapshot: EvaluationSnapshot; attestation: QaAttestation; url: string }> {
  const snapshot = await captureEvaluation(github, prNumber);
  assertRoleRequired(snapshot, role);
  const { owner, repo } = github.repository;

  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const parsed = comments
    .map((comment) => {
      try {
        return { value: parseAttestation(comment.body ?? ""), url: comment.html_url, id: comment.id };
      } catch {
        return { value: null, url: comment.html_url, id: comment.id };
      }
    })
    .filter((entry) => entry.value !== null);

  const sessions = parsed
    .map((entry) => entry.value)
    .filter((value): value is ReviewStart => value?.kind === "review_start")
    .filter((value) => value.role === role && sameEvaluationIdentity(value.identity, snapshot.identity));

  const session = sessions.at(-1);
  if (!session) {
    throw new Error(
      `No current ${role} review session exists for PR #${prNumber}. Run fugue handoff ${role}-qa --pr ${prNumber} first.`,
    );
  }

  const alreadyCompleted = parsed
    .map((entry) => entry.value)
    .some((value) => value?.kind === "qa" && value.session_id === session.session_id);
  if (alreadyCompleted) {
    throw new Error(`Review session ${session.session_id} is already completed; start a fresh QA handoff.`);
  }

  const roleEvidence = buildRoleEvidence(snapshot, role, options);
  const attestation = qaAttestationSchema.parse({
    version: 1,
    kind: "qa",
    attestation_id: createAttestationId(role),
    session_id: session.session_id,
    role,
    identity: snapshot.identity,
    fugue_version: FUGUE_CLI_VERSION,
    verdict: options.verdict,
    ...roleEvidence,
    created_at: new Date().toISOString(),
  });

  const finalSnapshot = await captureEvaluation(github, prNumber);
  if (!sameEvaluationIdentity(snapshot.identity, finalSnapshot.identity)) {
    throw new Error("PR evaluation identity changed while recording review; no verdict was published.");
  }

  const heading = `${roleHeading(role)} — ${verdictHeading(options.verdict)}`;
  const summary = options.summary?.trim() ? `\n\n${options.summary.trim()}` : "";
  const comment = await github.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `${heading}\n\nHead: \`${snapshot.identity.headSha}\`\nWork spec: \`${snapshot.identity.workSpecDigest}\`${summary}\n\n${serializeAttestation(attestation)}`,
  });

  await github.octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: snapshot.identity.headSha,
    state: statusState(options.verdict),
    context: statusContext(role),
    description: `${roleHeading(role)} ${verdictHeading(options.verdict).toLowerCase()}`,
    target_url: comment.data.html_url,
  });

  return { snapshot, attestation, url: comment.data.html_url };
}

export async function currentQaAttestations(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<Map<QaRole, QaAttestation>> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });

  const current = new Map<QaRole, QaAttestation>();
  for (const comment of comments) {
    let value: ReturnType<typeof parseAttestation>;
    try {
      value = parseAttestation(comment.body ?? "");
    } catch {
      continue;
    }
    if (value?.kind !== "qa") continue;
    if (!sameEvaluationIdentity(value.identity, snapshot.identity)) continue;
    current.set(value.role, value);
  }
  return current;
}

function buildRoleEvidence(
  snapshot: EvaluationSnapshot,
  role: QaRole,
  options: CompleteReviewOptions,
): Record<string, unknown> {
  if (role === "code") {
    if (!options.agentsUpdate) {
      throw new Error("Code QA requires --agents-update not-required|present|missing.");
    }
    const updateRequired = options.agentsUpdate !== "not-required";
    const updatePresent = options.agentsUpdate === "present";
    if (options.verdict === "approved" && options.agentsUpdate === "missing") {
      throw new Error("Code QA cannot approve while an AGENTS.md update is required but missing.");
    }

    let validationControl = {
      reviewed: true,
      materially_changed: snapshot.qa.validationControlChanged,
      acceptable: true,
    };
    if (snapshot.qa.validationControlChanged) {
      if (!options.validationControl) {
        throw new Error("Validation-control changes require --validation-control acceptable|unacceptable.");
      }
      validationControl = {
        reviewed: true,
        materially_changed: true,
        acceptable: options.validationControl === "acceptable",
      };
      if (options.verdict === "approved" && !validationControl.acceptable) {
        throw new Error("Code QA cannot approve unacceptable validation-control changes.");
      }
    }

    return {
      agents_md: {
        reviewed: true,
        update_required: updateRequired,
        update_present: updatePresent,
      },
      validation_control: validationControl,
    };
  }

  if (role === "visual") {
    const tested = options.runtimeTested ?? false;
    if (options.verdict === "approved" && !tested) {
      throw new Error("Visual QA approval requires --runtime-tested for the exact committed head.");
    }
    return {
      runtime: {
        tested,
        exact_head: tested,
        viewports: options.viewports ?? [],
      },
    };
  }

  return {};
}

function assertRoleRequired(snapshot: EvaluationSnapshot, role: QaRole): void {
  if (!snapshot.qa.required.some((requirement) => requirement.role === role)) {
    throw new Error(`${roleHeading(role)} is not required for PR #${snapshot.pr.number} under current base policy.`);
  }
}

function statusContext(role: QaRole): string {
  return `fugue/${role}-qa`;
}

function statusState(verdict: CompleteReviewOptions["verdict"]): "success" | "failure" | "error" {
  if (verdict === "approved") return "success";
  if (verdict === "changes_requested") return "failure";
  return "error";
}

function roleHeading(role: QaRole): string {
  if (role === "code") return "CODE QA";
  if (role === "security") return "SECURITY QA";
  return "VISUAL / UX QA";
}

function verdictHeading(verdict: CompleteReviewOptions["verdict"]): string {
  if (verdict === "approved") return "APPROVED";
  if (verdict === "changes_requested") return "CHANGES REQUESTED";
  return "ERROR";
}
