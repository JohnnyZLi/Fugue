import { randomBytes } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

const qaRoleSchema = z.enum(["code", "security", "visual"]);

const identitySchema = z.object({
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
  identity: identitySchema,
  fugue_version: z.string().min(1),
  created_at: z.string().min(1),
});

export const qaAttestationSchema = z.object({
  version: z.literal(1),
  kind: z.literal("qa"),
  attestation_id: z.string().min(1),
  session_id: z.string().min(1),
  role: qaRoleSchema,
  identity: identitySchema,
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

export type ReviewStart = z.infer<typeof reviewStartSchema>;
export type QaAttestation = z.infer<typeof qaAttestationSchema>;
export type QaRole = z.infer<typeof qaRoleSchema>;

const START = "<!-- fugue-attestation";
const END = "-->";

export function createReviewSessionId(role: QaRole): string {
  return `rev-${role}-${randomBytes(4).toString("hex")}`;
}

export function createAttestationId(role: QaRole): string {
  return `att-${role}-${randomBytes(4).toString("hex")}`;
}

export function serializeAttestation(value: ReviewStart | QaAttestation): string {
  return `${START}\n${stringifyYaml(value).trim()}\n${END}`;
}

export function parseAttestation(body: string): ReviewStart | QaAttestation | null {
  const start = body.indexOf(START);
  if (start < 0) return null;
  const end = body.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated fugue-attestation block.");

  const raw = parseYaml(body.slice(start + START.length, end).trim()) as unknown;
  const kind = z.object({ kind: z.string() }).parse(raw).kind;
  if (kind === "review_start") return reviewStartSchema.parse(raw);
  if (kind === "qa") return qaAttestationSchema.parse(raw);
  return null;
}
