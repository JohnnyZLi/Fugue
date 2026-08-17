import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { captureEvaluation, sameEvaluationIdentity } from "../core/evaluation.js";
import { discoverRepository } from "../core/git.js";
import { IntegrationGateFailure } from "../core/gates.js";
import { requireWritableGitHub } from "../core/github.js";
import {
  finalizeIntegration,
  prepareIntegration,
  publishIntegrationFailure,
} from "../core/integration.js";
import {
  assertValidationMatchesPlan,
  integrationValidationSchema,
  parseIntegrationPlan,
  parseIntegrationValidation,
} from "../core/integration-plan.js";
import { bindIntegrationRun, findCurrentIntegrationRequest } from "../core/integration-status.js";
import { runValidation } from "../core/validation.js";

export interface IntegrationPrepareOptions {
  out: string;
  requestId: string;
  runtimeSha: string;
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

  const runId = parsePositiveInteger(process.env.GITHUB_RUN_ID ?? "", "GitHub workflow run ID");
  const runAttempt = parsePositiveInteger(process.env.GITHUB_RUN_ATTEMPT ?? "", "GitHub workflow run attempt");
  if (runAttempt !== 1) {
    throw new IntegrationGateFailure(
      "request-run",
      `Integration request ${options.requestId} can only bind workflow attempt 1, not attempt ${runAttempt}.`,
    );
  }

  const requestedSnapshot = await captureEvaluation(github, prNumber);
  const request = await findCurrentIntegrationRequest(github, requestedSnapshot);
  if (!request || request.request_id !== options.requestId) {
    throw new IntegrationGateFailure(
      "request",
      `Integration dispatch ${options.requestId} is not the current durable request for PR #${prNumber}.`,
    );
  }

  const bound = await bindIntegrationRun(github, requestedSnapshot, request.request_id, runId);
  if (!bound.run) throw new Error(`Integration request ${request.request_id} did not bind protected run ${runId}.`);
  const integration = {
    request_id: request.request_id,
    run_id: bound.run.id,
    run_attempt: 1 as const,
  };

  const prepared = await prepareIntegration(github, prNumber, integration);
  if (!sameEvaluationIdentity(request.identity, prepared.plan.identity)) {
    const error = new IntegrationGateFailure(
      "request",
      "Integration evaluation identity changed after the durable dispatch request was bound.",
    );
    await publishIntegrationFailure(github, prepared.plan.identity, integration, error);
    throw error;
  }

  if (prepared.plan.identity.baseSha !== options.runtimeSha) {
    const error = new IntegrationGateFailure(
      "runtime-base",
      `Trusted Integration runtime ${options.runtimeSha.slice(0, 8)} does not match current protected base ${prepared.plan.identity.baseSha.slice(0, 8)}.`,
    );
    await publishIntegrationFailure(github, prepared.plan.identity, integration, error);
    throw error;
  }

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
    integration: plan.integration,
    passed: true,
    commands: result.commands,
    created_at: new Date().toISOString(),
  });
  await writeFile(resolve(options.out), `${JSON.stringify(validation, null, 2)}\n`, "utf8");
  console.log(`Validated exact head ${plan.identity.headSha.slice(0, 8)} for run ${plan.integration.run_id}.`);
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
    await publishIntegrationFailure(github, plan.identity, plan.integration, error);
    throw error;
  }
  if (!options.validation) throw new Error("Successful Integration finalization requires --validation <path>.");

  const validation = parseIntegrationValidation(
    JSON.parse(await readFile(resolve(options.validation), "utf8")) as unknown,
  );
  assertValidationMatchesPlan(plan, validation);

  try {
    const result = await finalizeIntegration(github, plan, validation);
    console.log(`INTEGRATION PASS — PR #${plan.identity.prNumber} @ ${result.snapshot.identity.headSha.slice(0, 8)}`);
  } catch (error) {
    await publishIntegrationFailure(github, plan.identity, plan.integration, error);
    throw error;
  }
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}
