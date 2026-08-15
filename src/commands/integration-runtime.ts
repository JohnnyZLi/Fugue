import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverRepository } from "../core/git.js";
import { IntegrationGateFailure } from "../core/gates.js";
import { requireWritableGitHub } from "../core/github.js";
import {
  finalizeIntegration,
  prepareIntegration,
  publishIntegrationFailure,
} from "../core/integration.js";
import {
  integrationValidationSchema,
  parseIntegrationPlan,
  parseIntegrationValidation,
} from "../core/integration-plan.js";
import { runValidation } from "../core/validation.js";

export interface IntegrationPrepareOptions {
  out: string;
  githubOutput?: string;
}

export interface IntegrationValidateOptions {
  plan: string;
  cwd: string;
  out: string;
}

export interface IntegrationFinalizeOptions {
  plan: string;
  validation?: string;
  validationResult: string;
}

export async function runIntegrationPrepare(
  prValue: string,
  options: IntegrationPrepareOptions,
): Promise<void> {
  const prNumber = parsePositiveInteger(prValue, "PR");
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const prepared = await prepareIntegration(github, prNumber);
  await writeFile(resolve(options.out), `${JSON.stringify(prepared.plan, null, 2)}\n`, "utf8");

  if (options.githubOutput) {
    await appendFile(resolve(options.githubOutput), `head_sha=${prepared.plan.identity.headSha}\n`, "utf8");
  }

  console.log(`Prepared Integration for PR #${prNumber} @ ${prepared.plan.identity.headSha.slice(0, 8)}.`);
}

export async function runIntegrationValidate(options: IntegrationValidateOptions): Promise<void> {
  const plan = parseIntegrationPlan(JSON.parse(await readFile(resolve(options.plan), "utf8")) as unknown);
  const result = await runValidation(
    resolve(options.cwd),
    plan.validation.install,
    plan.validation.checks,
  );
  const validation = integrationValidationSchema.parse({
    version: 1,
    identity: plan.identity,
    passed: true,
    commands: result.commands,
    created_at: new Date().toISOString(),
  });
  await writeFile(resolve(options.out), `${JSON.stringify(validation, null, 2)}\n`, "utf8");
  console.log(`Validated exact head ${plan.identity.headSha.slice(0, 8)}.`);
}

export async function runIntegrationFinalize(options: IntegrationFinalizeOptions): Promise<void> {
  const plan = parseIntegrationPlan(JSON.parse(await readFile(resolve(options.plan), "utf8")) as unknown);
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);

  if (options.validationResult !== "success") {
    const error = new IntegrationGateFailure(
      "validation",
      `GitHub-hosted candidate validation job finished with ${options.validationResult}.`,
    );
    await publishIntegrationFailure(github, plan.identity, error);
    throw error;
  }
  if (!options.validation) throw new Error("Successful Integration finalization requires --validation <path>.");

  const validation = parseIntegrationValidation(
    JSON.parse(await readFile(resolve(options.validation), "utf8")) as unknown,
  );

  try {
    const result = await finalizeIntegration(github, plan, validation);
    console.log(`INTEGRATION PASS — PR #${plan.identity.prNumber} @ ${result.snapshot.identity.headSha.slice(0, 8)}`);
  } catch (error) {
    await publishIntegrationFailure(github, plan.identity, error);
    throw error;
  }
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}
