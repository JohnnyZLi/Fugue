import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  createAttestationId,
  evaluationIdentitySchema,
  humanControlPlaneAttestationSchema,
  parseAttestation,
  serializeAttestation,
  type QaRole,
} from "./attestations.js";
import { captureEvaluation, sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import type { FugueGitHub } from "./github.js";
import { FUGUE_CLI_VERSION, type EvaluationIdentity } from "./protocol.js";
import { isTrustedProtocolComment, type GitHubCommentLike } from "./provenance.js";
import { completeReview, currentReviewActivities, type CompleteReviewOptions } from "./reviews.js";

const REVIEW_START = "<!-- fugue-review-submit";
const HUMAN_START = "<!-- fugue-human-submit";
const REJECTION_START = "<!-- fugue-submission-rejection";
const END = "-->";

const qaSubmissionSchema = z.object({
  version: z.literal(1),
  session_id: z.string().min(1),
  role: z.enum(["code", "security", "visual"]),
  verdict: z.enum(["approved", "changes_requested", "error"]),
  agents_update: z.enum(["not-required", "present", "missing"]).optional(),
  validation_control: z.enum(["acceptable", "unacceptable"]).optional(),
  runtime_tested: z.boolean().optional(),
  viewports: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

const humanSubmissionSchema = z.object({
  version: z.literal(1),
  kind: z.literal("control_plane_ack"),
  identity: evaluationIdentitySchema,
});

const submissionRejectionSchema = z.object({
  version: z.literal(1),
  comment_ids: z.array(z.number().int().positive()).min(1),
});

export type QaSubmission = z.infer<typeof qaSubmissionSchema>;
export type HumanSubmission = z.infer<typeof humanSubmissionSchema>;

interface SubmissionInput<T> {
  submission: T;
  actor: string;
  commentId: number;
}

interface SubmissionComment extends GitHubCommentLike {
  body?: string | null;
}

export interface SubmissionProcessingResult {
  accepted: number;
  blockedReason?: string;
}

export function parseQaSubmission(body: string): QaSubmission | null {
  return parseMarked(body, REVIEW_START, qaSubmissionSchema);
}

export function parseHumanSubmission(body: string): HumanSubmission | null {
  return parseMarked(body, HUMAN_START, humanSubmissionSchema);
}

export function qaSubmissionToReviewOptions(submission: QaSubmission): CompleteReviewOptions {
  const options: CompleteReviewOptions = { verdict: submission.verdict };
  if (submission.agents_update !== undefined) options.agentsUpdate = submission.agents_update;
  if (submission.validation_control !== undefined) options.validationControl = submission.validation_control;
  if (submission.runtime_tested !== undefined) options.runtimeTested = submission.runtime_tested;
  if (submission.viewports !== undefined) options.viewports = submission.viewports;
  if (submission.summary !== undefined) options.summary = submission.summary;
  return options;
}

export async function processCurrentSubmissions(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<SubmissionProcessingResult> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });

  const rejectedIds = rejectedSubmissionIds(comments);
  const qaInputs: Array<SubmissionInput<QaSubmission>> = [];
  const humanInputs: Array<SubmissionInput<HumanSubmission>> = [];

  for (const comment of comments) {
    if (rejectedIds.has(comment.id)) continue;
    const body = comment.body ?? "";
    if (!body.includes(REVIEW_START) && !body.includes(HUMAN_START)) continue;

    const actor = comment.user?.login;
    if (!actor) {
      await rejectSubmissions(github, snapshot.pr.number, [comment.id], "Submission has no attributable GitHub actor.");
      return { accepted: 1 };
    }

    try {
      const qa = parseQaSubmission(body);
      if (qa) qaInputs.push({ submission: qa, actor, commentId: comment.id });
      const human = parseHumanSubmission(body);
      if (human) humanInputs.push({ submission: human, actor, commentId: comment.id });
    } catch (error) {
      await rejectSubmissions(
        github,
        snapshot.pr.number,
        [comment.id],
        `Malformed Fugue submission: ${message(error)}`,
      );
      return { accepted: 1 };
    }
  }

  let accepted = 0;
  const activities = await currentReviewActivities(github, snapshot);

  for (const input of qaInputs) {
    const activity = activities.get(input.submission.role);
    if (activity?.completed?.session_id === input.submission.session_id) continue;
    if (activity?.active?.session_id === input.submission.session_id) continue;

    await rejectSubmissions(
      github,
      snapshot.pr.number,
      [input.commentId],
      `QA session ${input.submission.session_id} is not current for the exact PR evaluation identity.`,
    );
    return { accepted: accepted + 1 };
  }

  for (const requirement of snapshot.qa.required) {
    const activity = activities.get(requirement.role);
    if (!activity?.active) continue;

    const matches = qaInputs.filter((input) =>
      input.submission.role === requirement.role && input.submission.session_id === activity.active?.session_id,
    );
    if (!matches.length) continue;

    for (const match of matches) {
      if (!(await canSubmitProtocolEvidence(github, match.actor))) {
        await rejectSubmissions(
          github,
          snapshot.pr.number,
          [match.commentId],
          `@${match.actor} does not have repository write permission required to submit Fugue protocol evidence.`,
        );
        return { accepted: accepted + 1 };
      }
    }

    const unique = new Map<string, typeof matches[number]>();
    for (const match of matches) unique.set(JSON.stringify(match.submission), match);
    if (unique.size > 1) {
      await rejectSubmissions(
        github,
        snapshot.pr.number,
        matches.map((match) => match.commentId),
        `Conflicting ${roleHeading(requirement.role)} submissions exist for session ${activity.active.session_id}; submit one fresh verdict.`,
      );
      return { accepted: accepted + 1 };
    }

    const selected = [...unique.values()][0];
    if (!selected) continue;
    await completeReview(
      github,
      snapshot.pr.number,
      requirement.role,
      qaSubmissionToReviewOptions(selected.submission),
    );
    accepted += 1;
  }

  if (snapshot.qa.controlPlaneChanged && !(await hasCurrentHumanAcknowledgement(github, snapshot))) {
    for (const input of humanInputs) {
      if (!sameEvaluationIdentity(input.submission.identity, snapshot.identity)) {
        await rejectSubmissions(
          github,
          snapshot.pr.number,
          [input.commentId],
          "Human control-plane acknowledgement is bound to a stale PR evaluation identity.",
        );
        return { accepted: accepted + 1 };
      }
    }

    const matches = humanInputs
      .filter((input) => sameEvaluationIdentity(input.submission.identity, snapshot.identity))
      .sort((a, b) => a.commentId - b.commentId);
    const selected = matches.at(-1);
    if (selected) {
      if (!(await canSubmitProtocolEvidence(github, selected.actor))) {
        await rejectSubmissions(
          github,
          snapshot.pr.number,
          [selected.commentId],
          `@${selected.actor} does not have repository write permission required for control-plane acknowledgement.`,
        );
        return { accepted: accepted + 1 };
      }
      await recordHumanControlPlaneAcknowledgement(
        github,
        snapshot.pr.number,
        selected.actor,
        selected.submission.identity,
      );
      accepted += 1;
    }
  }

  return { accepted };
}

export async function recordHumanControlPlaneAcknowledgement(
  github: FugueGitHub,
  prNumber: number,
  actor: string,
  expectedIdentity?: EvaluationIdentity,
): Promise<void> {
  const snapshot = await captureEvaluation(github, prNumber);
  if (expectedIdentity && !sameEvaluationIdentity(expectedIdentity, snapshot.identity)) {
    throw new Error("Human acknowledgement request is stale for the current PR evaluation identity.");
  }
  if (!snapshot.qa.controlPlaneChanged) {
    throw new Error(`PR #${prNumber} does not modify the active control-plane path set.`);
  }
  if (await hasCurrentHumanAcknowledgement(github, snapshot)) return;

  const attestation = humanControlPlaneAttestationSchema.parse({
    version: 1,
    kind: "human_control_plane",
    attestation_id: createAttestationId("human-cp"),
    identity: snapshot.identity,
    fugue_version: FUGUE_CLI_VERSION,
    actor,
    verdict: "acknowledged",
    created_at: new Date().toISOString(),
  });

  const finalSnapshot = await captureEvaluation(github, prNumber);
  if (!sameEvaluationIdentity(snapshot.identity, finalSnapshot.identity)) {
    throw new Error("PR evaluation identity changed before acknowledgement could be recorded.");
  }

  const { owner, repo } = github.repository;
  await github.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `HUMAN CONTROL-PLANE ACKNOWLEDGEMENT\n\nHead: \`${snapshot.identity.headSha}\`\nPolicy: \`${snapshot.identity.policyDigest}\`\nActor: @${actor}\n\n${serializeAttestation(attestation)}`,
  });
}

export async function hasCurrentHumanAcknowledgement(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<boolean> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });

  for (const comment of comments) {
    if (!isTrustedProtocolComment(comment)) continue;
    try {
      const value = parseAttestation(comment.body ?? "");
      if (value?.kind !== "human_control_plane") continue;
      if (sameEvaluationIdentity(value.identity, snapshot.identity)) return true;
    } catch {
      // Historical malformed evidence is not current acknowledgement.
    }
  }
  return false;
}

function rejectedSubmissionIds(comments: SubmissionComment[]): Set<number> {
  const ids = new Set<number>();
  for (const comment of comments) {
    if (!isTrustedProtocolComment(comment)) continue;
    try {
      const rejection = parseMarked(comment.body ?? "", REJECTION_START, submissionRejectionSchema);
      for (const id of rejection?.comment_ids ?? []) ids.add(id);
    } catch {
      // Invalid rejection-looking text is not protocol state.
    }
  }
  return ids;
}

async function rejectSubmissions(
  github: FugueGitHub,
  prNumber: number,
  commentIds: number[],
  reason: string,
): Promise<void> {
  const { owner, repo } = github.repository;
  const marker = `${REJECTION_START}\n${stringifyYaml({ version: 1, comment_ids: commentIds }).trim()}\n${END}`;
  await github.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `FUGUE SUBMISSION — REJECTED\n\n${reason}\n\n${marker}`,
  });
}

async function canSubmitProtocolEvidence(github: FugueGitHub, actor: string): Promise<boolean> {
  const { owner, repo } = github.repository;
  try {
    const response = await github.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: actor,
    });
    return response.data.permission === "write" ||
      response.data.permission === "maintain" ||
      response.data.permission === "admin";
  } catch {
    return false;
  }
}

function parseMarked<T>(body: string, startMarker: string, schema: z.ZodType<T>): T | null {
  const start = body.indexOf(startMarker);
  if (start < 0) return null;
  const end = body.indexOf(END, start + startMarker.length);
  if (end < 0) throw new Error(`Unterminated ${startMarker.slice(5)} block.`);
  const raw = parseYaml(body.slice(start + startMarker.length, end).trim()) as unknown;
  return schema.parse(raw);
}

function roleHeading(role: QaRole): string {
  if (role === "code") return "Code QA";
  if (role === "security") return "Security QA";
  return "Visual QA";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
