import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { assertSupportedProtocol } from "./protocol.js";

const stringArray = z.array(z.string()).default([]);

const reviewRuleSchema = z.object({
  required: z.enum(["always", "conditional"]),
  paths: stringArray.optional(),
});

export const fugueConfigSchema = z.object({
  version: z.literal(1),
  protocol: z.object({ version: z.number().int().positive() }),
  repository: z.object({
    default_branch: z.string().min(1),
    agents_file: z.string().min(1).default("AGENTS.md"),
  }),
  control_plane: z.object({ paths: stringArray }),
  validation: z.object({
    install: stringArray,
    checks: stringArray,
    required_ci: stringArray,
    control_paths: stringArray,
  }),
  reviews: z.object({
    code: reviewRuleSchema,
    security: reviewRuleSchema,
    visual: reviewRuleSchema,
  }),
  branches: z.object({
    worker_pattern: z.string().min(1),
    require_up_to_date: z.boolean(),
  }),
  allocation: z.object({
    coordinator_only: z.boolean(),
    require_assignment: z.boolean(),
    require_worker_id: z.boolean(),
    one_active_pr_per_issue: z.boolean(),
  }),
  dependencies: z.object({ require_satisfied_before_integration: z.boolean() }),
  enforcement: z.object({ prefer_hard_merge_gate: z.boolean() }),
  github: z.object({ source_of_truth: z.literal(true) }),
});

export type FugueConfig = z.infer<typeof fugueConfigSchema>;

export async function loadConfig(path: string): Promise<FugueConfig> {
  const raw = await readFile(path, "utf8");
  return parseConfig(raw);
}

export function parseConfig(raw: string): FugueConfig {
  const parsed = fugueConfigSchema.parse(parseYaml(raw));
  assertSupportedProtocol(parsed.protocol.version);
  return parsed;
}
