import { randomBytes } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

const qaRoleSchema = z.enum(["code", "security", "visual"]);

export const evaluationIdentitySchema = z.object({
  prNumber: z.number().int().positive(),
  headSha: z.string().min(7),
  baseBranch: z.string().min(1),
  baseSha: z.string().min(7),
  policyDigest: z.string().min(1),
  protocolVersion: z.literal(1),
  issueNumber: z.number().int().positive(),
  workId: z.string().min(1),
  workSpecDigest: z.string().min(1),
});

export const reviewStartSchema = z.object({
  version: z.literal(1),
  kind: z.literal("review_start"),
  session_id: z.string().min(1),
  role: qaRoleSchema,
  identity: evaluationIdentitySchema,
  fugue_version: z.string().min(1),
  created_at: z.string().min(1),
});

export const qaAttestationSchema = z.object({
  version: z.literal(1),
  kind: z.literal("qa"),
  attestation_id: z.string().min(1),
  session_id: z.string().min(1),
  role: qaRoleSchema,
  identity: evaluationIdentitySchema,
  fugue_version: z.string().min(1),
  verdict: z.enum(["approved", "changes_requested", "error"]),
  agents_md: z.object({
    reviewed: z.boolean(),
    update_required: z.boolean(),
    update_present: z.boolean(),
    invariant_change_authorized: z.boolean().optional(),
  }).optional(),
  validation_control: z.object({
    reviewed: z.boolean(),
    materially_changed: z.boolean(),
    acceptable: z.boolean(),
  }).optional(),
  runtime: z.object({
    tested: z.boolean(),
    exact_head: z.boolean(),
    viewports: z.array(z.string()).default([]),
  }).optional(),
  created_at: z.string().min(1),
});

export const humanControlPlaneAttestationSchema = z.object({
  version: z.literal(1),
  kind: z.literal("human_control_plane"),
  attestation_id: z.string().min(1),
  identity: evaluationIdentitySchema,
  fugue_version: z.string().min(1),
  actor: z.string().min(1),
  verdict: z.literal("acknowledged"),
  created_at: z.string().min(1),
});

const qaGateSchema = z.enum(["passed", "not_required"]);

export const integrationEvidenceIdentitySchema = z.object({
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  run_id: z.number().int().positive(),
  run_attempt: z.literal(1),
});

export const integrationAttestationSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration"),
  attestation_id: z.string().min(1),
  identity: evaluationIdentitySchema,
  integration: integrationEvidenceIdentitySchema,
  fugue_version: z.string().min(1),
  qa: z.object({
    code: qaGateSchema,
    security: qaGateSchema,
    visual: qaGateSchema,
  }),
  dependencies: z.object({ passed: z.boolean() }),
  agents_md: z.object({
    impact_reviewed: z.boolean(),
    update_required: z.boolean(),
    update_present: z.boolean(),
  }),
  control_plane: z.object({
    changed: z.boolean(),
    human_acknowledgement: z.enum(["passed", "not_required"]),
  }),
  validation_control: z.object({
    changed: z.boolean(),
    reviewed: z.boolean(),
    acceptable: z.boolean(),
  }),
  validation: z.object({
    clean_worktree: z.boolean(),
    passed: z.boolean(),
    commands: z.array(z.string()),
  }),
  ci: z.object({
    passed: z.boolean(),
    checks: z.array(z.string()),
  }),
  base_current: z.object({ passed: z.boolean() }),
  conflicts: z.object({ none: z.boolean() }),
  verdict: z.literal("approved"),
  created_at: z.string().min(1),
});

export type ReviewStart = z.infer<typeof reviewStartSchema>;
export type QaAttestation = z.infer<typeof qaAttestationSchema>;
export type HumanControlPlaneAttestation = z.infer<typeof humanControlPlaneAttestationSchema>;
export type IntegrationAttestation = z.infer<typeof integrationAttestationSchema>;
export type IntegrationEvidenceIdentity = z.infer<typeof integrationEvidenceIdentitySchema>;
export type QaRole = z.infer<typeof qaRoleSchema>;
export type FugueAttestation = ReviewStart | QaAttestation | HumanControlPlaneAttestation | IntegrationAttestation;

const START = "<!-- fugue-attestation";
const END = "-->";

export function createReviewSessionId(role: QaRole): string {
  return `rev-${role}-${randomBytes(4).toString("hex")}`;
}

export function createAttestationId(kind: string): string {
  return `att-${kind}-${randomBytes(4).toString("hex")}`;
}

export function serializeAttestation(value: FugueAttestation): string {
  return `${START}\n${stringifyYaml(value).trim()}\n${END}`;
}

export function parseAttestation(body: string): FugueAttestation | null {
  const start = body.lastIndexOf(START);
  if (start < 0) return null;
  const end = body.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated fugue-attestation block.");

  const raw = parseYaml(body.slice(start + START.length, end).trim()) as unknown;
  const kind = z.object({ kind: z.string() }).parse(raw).kind;
  if (kind === "review_start") return reviewStartSchema.parse(raw);
  if (kind === "qa") return qaAttestationSchema.parse(raw);
  if (kind === "human_control_plane") return humanControlPlaneAttestationSchema.parse(raw);
  if (kind === "integration") return integrationAttestationSchema.parse(raw);
  return null;
}
