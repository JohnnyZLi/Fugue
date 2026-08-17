import { randomBytes } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { evaluationIdentitySchema } from "./attestations.js";
import { digestCanonical } from "./hash.js";

export const integrationRequestSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_request"),
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  identity: evaluationIdentitySchema,
  created_at: z.string().min(1),
});

export const integrationPlanSchema = z.object({
  version: z.literal(1),
  identity: evaluationIdentitySchema,
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
  passed: z.literal(true),
  commands: z.array(z.string()),
  created_at: z.string().min(1),
});

export type IntegrationRequest = z.infer<typeof integrationRequestSchema>;
export type IntegrationPlan = z.infer<typeof integrationPlanSchema>;
export type IntegrationValidation = z.infer<typeof integrationValidationSchema>;

const REQUEST_START = "<!-- fugue-integration-request";
const REQUEST_END = "-->";

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

export function serializeIntegrationRequest(request: IntegrationRequest): string {
  return `${REQUEST_START}\n${stringifyYaml(request).trim()}\n${REQUEST_END}`;
}

export function parseIntegrationRequest(body: string): IntegrationRequest | null {
  const start = body.indexOf(REQUEST_START);
  if (start < 0) return null;
  const end = body.indexOf(REQUEST_END, start + REQUEST_START.length);
  if (end < 0) throw new Error("Unterminated fugue-integration-request block.");
  const raw = parseYaml(body.slice(start + REQUEST_START.length, end).trim()) as unknown;
  return integrationRequestSchema.parse(raw);
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
  const expected = expectedValidationCommands(plan);
  if (validation.commands.length !== expected.length ||
    validation.commands.some((command, index) => command !== expected[index])) {
    throw new Error("Integration validation evidence does not match the protected-base command plan.");
  }
}
