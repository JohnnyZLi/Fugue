import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  createAttestationId,
  evaluationIdentitySchema,
  humanControlPlaneAttestationSchema,
  parseAttestation,
  serializeAttestation,
  type HumanControlPlaneAttestation,
  type QaRole,
} from "./attestations.js";
import { captureEvaluation, sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";
import type { FugueGitHub } from "./github.js";
import { FUGUE_CLI_VERSION, type EvaluationIdentity } from "./protocol.js";
import {
  createProtocolComment,
  isTrustedProtocolComment,
  type GitHubCommentLike,
} from "./provenance.js";
import { completeReview, currentReviewActivities, type CompleteReviewOptions } from "./reviews.js";
import { publishDurableProtocolRecord, recoverDurableProtocolRecord } from "./state.js";

const REVIEW_START = "<!-- fugue-review-submit";
const HUMAN_START = "<!-- fugue-human-submit";
const REJECTION_START = "<!-- fugue-submission-rejection";
const RESERVED_PROTOCOL_START = "<!-- fugue-";
const END = "-->";

const untrustedSubmissionText = z.string().refine(
  (value) => !value.includes(RESERVED_PROTOCOL_START),
  "Submission text contains a reserved Fugue protocol marker.",
);

const qaSubmissionSchema = z.object({
  version: z.literal(1),
  session_id: z.string()
    .min(1)
    .max(128)
    .regex(/^rev-(?:code|security|visual)-[A-Za-z0-9]+$/, "Invalid Fugue review session ID."),
  role: z.enum(["code", "security", "visual"]),
  verdict: z.enum(["approved", "changes_requested", "error"]),
  agents_update: z.enum(["not-required", "present", "missing"]).optional(),
  validation_control: z.enum(["acceptable", "unacceptable"]).optional(),
  runtime_tested: z.boolean().optional(),
  viewports: z.array(untrustedSubmissionText).optional(),
  summary: untrustedSubmissionText.optional(),
});

const humanSubmissionSchema = z.object({
  version: z.literal(1),
  kind: z.literal("control_plane_ack"),
  identity: evaluationIdentitySchema,
});

const legacySubmissionRejectionProgressSchema = z.object({
  version: z.literal(1),
  kind: z.literal("submission_rejection_progress"),
  identity: evaluationIdentitySchema,
  sequence: z.number().int().nonnegative(),
  comment_ids: z.array(z.number().int().positive()),
  fingerprints: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
  created_at: z.string().min(1),
});

const SUBMISSION_REJECTION_BLOOM_BYTES = 256;
const submissionRejectionProgressV2Schema = z.object({
  version: z.literal(2),
  kind: z.literal("submission_rejection_progress"),
  identity: evaluationIdentitySchema,
  sequence: z.number().int().nonnegative(),
  bloom_b64: z.string().min(1).max(512).refine(
    (value) => Buffer.from(value, "base64url").length === SUBMISSION_REJECTION_BLOOM_BYTES,
    "Invalid bounded Fugue submission-rejection bloom filter.",
  ),
  created_at: z.string().min(1),
});

const submissionRejectionProgressSchema = z.union([
  legacySubmissionRejectionProgressSchema,
  submissionRejectionProgressV2Schema,
]);

type SubmissionRejectionProgress = z.infer<typeof submissionRejectionProgressSchema>;

export type QaSubmission = z.infer<typeof qaSubmissionSchema>;
export type HumanSubmission = z.infer<typeof humanSubmissionSchema>;

interface SubmissionInput<T> {
  submission: T;
  actor: string;
  commentId: number;
}

interface SubmissionComment extends GitHubCommentLike {
  id: number;
  node_id?: string;
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
  }) as SubmissionComment[];

  let progress = await recoverSubmissionRejectionProgress(github, snapshot);
  const ignored = new Set<number>();

  const reject = async (commentIds: number[], semanticKey: string, reason: string): Promise<boolean> => {
    for (const id of commentIds) ignored.add(id);
    if (rejectionProgressContains(progress, semanticKey)) return false;
    progress = await recordSubmissionRejectionProgress(github, snapshot, semanticKey);
    try {
      await rejectSubmissions(github, snapshot.pr.number, commentIds, reason);
    } catch {
      // The fixed-size d3 semantic filter is authority. Receipt publication is presentation only.
    }
    return true;
  };

  const qaInputs: Array<SubmissionInput<QaSubmission>> = [];
  const humanInputs: Array<SubmissionInput<HumanSubmission>> = [];

  for (const comment of comments) {
    const body = comment.body ?? "";
    const hasQa = body.includes(REVIEW_START);
    const hasHuman = body.includes(HUMAN_START);
    if (!hasQa && !hasHuman) continue;
    const kind = hasQa && hasHuman ? "mixed" : hasQa ? "qa" : "human";
    const actor = comment.user?.login ?? "";

    if (!(await hasImmutableSubmissionProvenance(github, comment))) {
      if (await reject(
        [comment.id],
        semanticRejectionKey("edited-or-unverifiable", kind),
        "Edited or provenance-unverifiable GitHub comments are not authoritative Fugue submissions; submit a fresh immutable comment.",
      )) return { accepted: 1 };
      continue;
    }

    if (!actor) {
      if (await reject(
        [comment.id],
        semanticRejectionKey("missing-actor", kind),
        "Submission has no attributable GitHub actor.",
      )) return { accepted: 1 };
      continue;
    }

    try {
      const qa = parseQaSubmission(body);
      if (qa) qaInputs.push({ submission: qa, actor, commentId: comment.id });
      const human = parseHumanSubmission(body);
      if (human) humanInputs.push({ submission: human, actor, commentId: comment.id });
    } catch (error) {
      if (await reject(
        [comment.id],
        semanticRejectionKey("malformed", kind),
        `Malformed Fugue submission: ${message(error)}`,
      )) return { accepted: 1 };
    }
  }

  let accepted = 0;
  const activities = await currentReviewActivities(github, snapshot);

  for (const input of qaInputs) {
    const activity = activities.get(input.submission.role);
    if (activity?.completed?.session_id === input.submission.session_id) continue;
    if (activity?.active?.session_id === input.submission.session_id) continue;
    const currentSession = activity?.active?.session_id ?? activity?.completed?.session_id ?? "none";
    if (await reject(
      [input.commentId],
      semanticRejectionKey("qa-stale-session", input.submission.role, currentSession),
      `QA session ${input.submission.session_id} is not current for the exact PR evaluation identity.`,
    )) return { accepted: accepted + 1 };
  }

  for (const requirement of snapshot.qa.required) {
    const activity = activities.get(requirement.role);
    if (!activity?.active) continue;

    let matches = qaInputs.filter((input) =>
      !ignored.has(input.commentId) && input.submission.role === requirement.role &&
      input.submission.session_id === activity.active?.session_id,
    );
    if (!matches.length) continue;

    for (const match of matches) {
      if (await canSubmitProtocolEvidence(github, match.actor)) continue;
      if (await reject(
        [match.commentId],
        semanticRejectionKey("qa-permission", requirement.role, activity.active.session_id),
        `@${match.actor} does not have repository write permission required to submit Fugue protocol evidence.`,
      )) return { accepted: accepted + 1 };
    }
    matches = matches.filter((input) => !ignored.has(input.commentId));
    if (!matches.length) continue;

    const unique = new Map<string, typeof matches[number]>();
    for (const match of matches) unique.set(JSON.stringify(match.submission), match);
    if (unique.size > 1) {
      if (await reject(
        matches.map((match) => match.commentId),
        semanticRejectionKey("qa-conflict", requirement.role, activity.active.session_id),
        `Conflicting ${roleHeading(requirement.role)} submissions exist for session ${activity.active.session_id}; submit one fresh verdict.`,
      )) return { accepted: accepted + 1 };
      continue;
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
      if (sameEvaluationIdentity(input.submission.identity, snapshot.identity)) continue;
      if (await reject(
        [input.commentId],
        semanticRejectionKey("human-stale-identity"),
        "Human control-plane acknowledgement is bound to a stale PR evaluation identity.",
      )) return { accepted: accepted + 1 };
    }

    const matches = humanInputs
      .filter((input) => !ignored.has(input.commentId) && sameEvaluationIdentity(input.submission.identity, snapshot.identity))
      .sort((a, b) => b.commentId - a.commentId);
    for (const selected of matches) {
      if (!(await canSubmitProtocolEvidence(github, selected.actor))) {
        if (await reject(
          [selected.commentId],
          semanticRejectionKey("human-permission"),
          `@${selected.actor} does not have repository write permission required for control-plane acknowledgement.`,
        )) return { accepted: accepted + 1 };
        continue;
      }
      await recordHumanControlPlaneAcknowledgement(
        github,
        snapshot.pr.number,
        selected.actor,
        selected.submission.identity,
      );
      accepted += 1;
      break;
    }
  }

  return { accepted };
}

async function hasImmutableSubmissionProvenance(github: FugueGitHub, comment: SubmissionComment): Promise<boolean> {
  if (!comment.node_id || !comment.user?.login) return false;
  try {
    const response = await github.octokit.graphql<{
      node?: {
        author?: { login?: string | null } | null;
        editor?: { login?: string | null } | null;
        lastEditedAt?: string | null;
      } | null;
    }>(
      `query FugueSubmissionProvenance($id: ID!) {
        node(id: $id) {
          ... on IssueComment {
            author { login }
            editor { login }
            lastEditedAt
          }
        }
      }`,
      { id: comment.node_id },
    );
    const node = response.node;
    return Boolean(node && node.author?.login === comment.user.login && !node.editor && !node.lastEditedAt);
  } catch {
    return false;
  }
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

  await publishHumanAcknowledgementAuthority(github, snapshot, attestation);
  await createProtocolComment(
    github,
    prNumber,
    `HUMAN CONTROL-PLANE ACKNOWLEDGEMENT\n\nHead: \`${snapshot.identity.headSha}\`\nPolicy: \`${snapshot.identity.policyDigest}\`\nActor: @${actor}\n\n${serializeAttestation(attestation)}`,
  );
}

export async function currentHumanAcknowledgement(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<HumanControlPlaneAttestation | undefined> {
  const durable = await recoverHumanAcknowledgementAuthority(github, snapshot);
  if (durable) return durable;

  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner, repo, issue_number: snapshot.pr.number, per_page: 100,
  });
  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const value = parseAttestation(comment.body ?? "");
      if (value?.kind !== "human_control_plane" || !sameEvaluationIdentity(value.identity, snapshot.identity)) continue;
      await publishHumanAcknowledgementAuthority(github, snapshot, value);
      return value;
    } catch {
      // Historical malformed evidence is not current acknowledgement.
    }
  }
  return undefined;
}

export async function hasCurrentHumanAcknowledgement(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<boolean> {
  return Boolean(await currentHumanAcknowledgement(github, snapshot));
}

function humanIdentityToken(snapshot: EvaluationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot.identity), "utf8").digest("hex").slice(0, 20);
}

function humanAcknowledgementScope(snapshot: EvaluationSnapshot): string {
  return `human-cp/${snapshot.identity.prNumber}/${humanIdentityToken(snapshot)}`;
}

async function publishHumanAcknowledgementAuthority(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  value: ReturnType<typeof humanControlPlaneAttestationSchema.parse>,
): Promise<void> {
  await publishDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: humanAcknowledgementScope(snapshot),
    unsignedBody: `${serializeAttestation(value)}\n\nHUMAN CONTROL-PLANE ACKNOWLEDGEMENT — CANONICAL`,
    publicationTimestamp: Date.parse(value.created_at),
    authorityOrder: `human-cp-v1:${value.created_at}`,
  });
}

async function recoverHumanAcknowledgementAuthority(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<ReturnType<typeof humanControlPlaneAttestationSchema.parse> | undefined> {
  const recovered = await recoverDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: humanAcknowledgementScope(snapshot),
    issueNumber: snapshot.pr.number,
    parse: (body) => {
      const value = parseAttestation(body);
      return value?.kind === "human_control_plane" ? value : null;
    },
    timestamp: (value) => Date.parse(value.created_at),
    order: (value) => `human-cp-v1:${value.created_at}`,
    validate: (value) => sameEvaluationIdentity(value.identity, snapshot.identity) && value.verdict === "acknowledged",
  });
  return recovered.record?.value;
}

function submissionRejectionIdentityToken(snapshot: EvaluationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot.identity), "utf8").digest("hex").slice(0, 20);
}

function submissionRejectionScope(snapshot: EvaluationSnapshot): string {
  return `submission-rejection/${snapshot.identity.prNumber}/${submissionRejectionIdentityToken(snapshot)}`;
}

function semanticRejectionKey(...parts: string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex")}`;
}

function rejectionBloom(progress?: SubmissionRejectionProgress): Buffer {
  if (!progress || progress.version !== 2) return Buffer.alloc(SUBMISSION_REJECTION_BLOOM_BYTES);
  const decoded = Buffer.from(progress.bloom_b64, "base64url");
  return decoded.length === SUBMISSION_REJECTION_BLOOM_BYTES
    ? Buffer.from(decoded)
    : Buffer.alloc(SUBMISSION_REJECTION_BLOOM_BYTES);
}

function rejectionBloomPositions(semanticKey: string): number[] {
  const digest = createHash("sha256").update(semanticKey, "utf8").digest();
  const bits = SUBMISSION_REJECTION_BLOOM_BYTES * 8;
  return [0, 2, 4, 6].map((offset) => digest.readUInt16BE(offset) % bits);
}

function rejectionProgressContains(progress: SubmissionRejectionProgress | undefined, semanticKey: string): boolean {
  if (!progress || progress.version !== 2) return false;
  const bloom = rejectionBloom(progress);
  return rejectionBloomPositions(semanticKey).every((position) =>
    (bloom[Math.floor(position / 8)]! & (1 << (position % 8))) !== 0,
  );
}

async function recoverSubmissionRejectionProgress(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<SubmissionRejectionProgress | undefined> {
  const recovered = await recoverDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: submissionRejectionScope(snapshot),
    issueNumber: snapshot.pr.number,
    parse: (body) => parseMarked(body, "<!-- fugue-submission-rejection-progress", submissionRejectionProgressSchema),
    timestamp: (value) => Date.parse(value.created_at),
    // Keep the historical v1 authority prefix so a v2 migration remains comparable with an existing
    // v1 durable record. The monotonically increasing sequence, not schema version, orders progress.
    order: (value) => `submission-rejection-v1:${String(value.sequence).padStart(20, "0")}`,
    validate: (value) => sameEvaluationIdentity(value.identity, snapshot.identity),
  });
  return recovered.record?.value;
}

async function recordSubmissionRejectionProgress(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  semanticKey: string,
): Promise<SubmissionRejectionProgress> {
  const current = await recoverSubmissionRejectionProgress(github, snapshot);
  if (rejectionProgressContains(current, semanticKey)) return current!;
  const bloom = rejectionBloom(current);
  for (const position of rejectionBloomPositions(semanticKey)) {
    bloom[Math.floor(position / 8)] = bloom[Math.floor(position / 8)]! | (1 << (position % 8));
  }
  const sequence = (current?.sequence ?? -1) + 1;
  const createdAt = new Date().toISOString();
  const value = submissionRejectionProgressV2Schema.parse({
    version: 2,
    kind: "submission_rejection_progress",
    identity: snapshot.identity,
    sequence,
    bloom_b64: bloom.toString("base64url"),
    created_at: createdAt,
  });
  const marker = `<!-- fugue-submission-rejection-progress\n${stringifyYaml(value).trim()}\n${END}`;
  await publishDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: submissionRejectionScope(snapshot),
    unsignedBody: `${marker}\n\nFUGUE SUBMISSION REJECTION PROGRESS — CANONICAL`,
    publicationTimestamp: Date.parse(createdAt),
    authorityOrder: `submission-rejection-v1:${String(sequence).padStart(20, "0")}`,
  });
  return (await recoverSubmissionRejectionProgress(github, snapshot)) ?? value;
}

async function rejectSubmissions(
  github: FugueGitHub,
  prNumber: number,
  commentIds: number[],
  reason: string,
): Promise<void> {
  const marker = `${REJECTION_START}\n${stringifyYaml({ version: 1, comment_ids: commentIds }).trim()}\n${END}`;
  await createProtocolComment(
    github,
    prNumber,
    `FUGUE SUBMISSION — REJECTED\n\n${safeRejectionReason(reason)}\n\n${marker}`,
  );
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

function safeRejectionReason(reason: string): string {
  return reason.replaceAll(RESERVED_PROTOCOL_START, "&lt;!-- fugue-");
}

function roleHeading(role: QaRole): string {
  if (role === "code") return "Code QA";
  if (role === "security") return "Security QA";
  return "Visual QA";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
