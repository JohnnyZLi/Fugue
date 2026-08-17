import { randomBytes } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  evaluationIdentitySchema,
  integrationAttestationSchema,
  integrationEvidenceIdentitySchema,
} from "./attestations.js";
import { digestCanonical } from "./hash.js";

export const integrationRequestSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_request"),
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  identity: evaluationIdentitySchema,
  created_at: z.string().min(1),
});

export const integrationRunBindingSchema = z.object({
  id: z.number().int().positive(),
  attempt: z.literal(1),
  created_at: z.string().min(1),
  html_url: z.string().min(1),
});

const integrationTerminalSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("success"),
    attestation: integrationAttestationSchema,
    created_at: z.string().min(1),
  }),
  z.object({
    state: z.enum(["failure", "error", "aborted"]),
    detail: z.string(),
    created_at: z.string().min(1),
  }),
]);

export const integrationRecordSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_record"),
  identity: evaluationIdentitySchema,
  request: integrationRequestSchema,
  run: integrationRunBindingSchema.nullable(),
  terminal: integrationTerminalSchema.nullable(),
  created_at: z.string().min(1),
});

export const integrationPlanSchema = z.object({
  version: z.literal(1),
  identity: evaluationIdentitySchema,
  integration: integrationEvidenceIdentitySchema,
  validation: z.object({
    install: z.array(z.string()),
    checks: z.array(z.string()),
  }),
  required_ci: z.array(z.string()),
  qa_required: z.array(z.enum(["code", "security", "visual"])),
  agents_md: z.object({
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
  created_at: z.string().min(1),
});

export const integrationValidationSchema = z.object({
  version: z.literal(1),
  identity: evaluationIdentitySchema,
  integration: integrationEvidenceIdentitySchema,
  passed: z.literal(true),
  commands: z.array(z.string()),
  created_at: z.string().min(1),
});

export type IntegrationRequest = z.infer<typeof integrationRequestSchema>;
export type IntegrationRunBinding = z.infer<typeof integrationRunBindingSchema>;
export type IntegrationRecord = z.infer<typeof integrationRecordSchema>;
export type IntegrationPlan = z.infer<typeof integrationPlanSchema>;
export type IntegrationValidation = z.infer<typeof integrationValidationSchema>;

const REQUEST_START = "<!-- fugue-integration-request";
const RECORD_START = "<!-- fugue-integration-record";
const END = "-->";

export function createIntegrationRequest(
  identity: z.infer<typeof evaluationIdentitySchema>,
  createdAt = new Date().toISOString(),
  nonce = randomBytes(8).toString("hex"),
): IntegrationRequest {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid Integration request creation time.");
  const canonicalCreatedAt = new Date(Math.floor(timestamp / 1000) * 1000).toISOString();
  const digest = digestCanonical(identity).slice("sha256:".length, "sha256:".length + 16);
  return integrationRequestSchema.parse({
    version: 1,
    kind: "integration_request",
    request_id: `int-${digest}-${nonce}`,
    identity,
    created_at: canonicalCreatedAt,
  });
}

export function createIntegrationRecord(
  request: IntegrationRequest,
  input: {
    run?: IntegrationRunBinding | null;
    terminal?: IntegrationRecord["terminal"];
    createdAt?: string;
  } = {},
): IntegrationRecord {
  return integrationRecordSchema.parse({
    version: 1,
    kind: "integration_record",
    identity: request.identity,
    request,
    run: input.run ?? null,
    terminal: input.terminal ?? null,
    created_at: input.createdAt ?? new Date().toISOString(),
  });
}

export function serializeIntegrationRequest(request: IntegrationRequest): string {
  return `${REQUEST_START}\n${stringifyYaml(request).trim()}\n${END}`;
}

export function parseIntegrationRequest(body: string): IntegrationRequest | null {
  const start = body.indexOf(REQUEST_START);
  if (start < 0) return null;
  const end = body.indexOf(END, start + REQUEST_START.length);
  if (end < 0) throw new Error("Unterminated fugue-integration-request block.");
  const raw = parseYaml(body.slice(start + REQUEST_START.length, end).trim()) as unknown;
  return integrationRequestSchema.parse(raw);
}

export function serializeIntegrationRecord(record: IntegrationRecord): string {
  return `${RECORD_START}\n${stringifyYaml(integrationRecordSchema.parse(record)).trim()}\n${END}`;
}

export function parseIntegrationRecord(body: string): IntegrationRecord | null {
  const start = body.indexOf(RECORD_START);
  if (start < 0) return null;
  const end = body.indexOf(END, start + RECORD_START.length);
  if (end < 0) throw new Error("Unterminated fugue-integration-record block.");
  const raw = parseYaml(body.slice(start + RECORD_START.length, end).trim()) as unknown;
  return integrationRecordSchema.parse(raw);
}

export function integrationRunTitle(requestId: string, prNumber: number): string {
  return `Fugue Integration PR #${prNumber} ${requestId}`;
}

export function parseIntegrationPlan(value: unknown): IntegrationPlan {
  return integrationPlanSchema.parse(value);
}

export function parseIntegrationValidation(value: unknown): IntegrationValidation {
  return integrationValidationSchema.parse(value);
}

export function expectedValidationCommands(plan: IntegrationPlan): string[] {
  return [...plan.validation.install, ...plan.validation.checks];
}

export function assertValidationMatchesPlan(
  plan: IntegrationPlan,
  validation: IntegrationValidation,
): void {
  if (JSON.stringify(plan.integration) !== JSON.stringify(validation.integration)) {
    throw new Error("Integration validation evidence does not match the protected request/run identity.");
  }
  const expected = expectedValidationCommands(plan);
  if (validation.commands.length !== expected.length ||
    validation.commands.some((command, index) => command !== expected[index])) {
    throw new Error("Integration validation evidence does not match the protected-base command plan.");
  }
}
