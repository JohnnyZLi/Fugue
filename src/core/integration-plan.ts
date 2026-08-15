import { z } from "zod";
import { evaluationIdentitySchema } from "./attestations.js";

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

export type IntegrationPlan = z.infer<typeof integrationPlanSchema>;
export type IntegrationValidation = z.infer<typeof integrationValidationSchema>;

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
