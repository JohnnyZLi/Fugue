#!/usr/bin/env node

import { Command } from "commander";
import { runAcknowledge } from "./commands/acknowledge.js";
import { runAdvance } from "./commands/advance.js";
import { runHandoff } from "./commands/handoff.js";
import { runInit } from "./commands/init.js";
import { runIntegrate } from "./commands/integrate.js";
import {
  runIntegrationFinalize,
  runIntegrationPrepare,
  runIntegrationValidate,
} from "./commands/integration-runtime.js";
import { runLinkPr } from "./commands/link-pr.js";
import { runReconcile } from "./commands/reconcile.js";
import { runReview } from "./commands/review.js";
import { runOrchestrator } from "./commands/run.js";
import { runStatus } from "./commands/status.js";
import { FUGUE_CLI_VERSION } from "./core/protocol.js";

const program = new Command();

program
  .name("fugue")
  .description("GitHub-backed multi-session engineering orchestration for ChatGPT")
  .version(FUGUE_CLI_VERSION);

program
  .command("init")
  .description("Provision Fugue protocol labels and protected-base GitHub enforcement")
  .option("--no-protection", "Create protocol labels without changing branch protection")
  .action(runInit);

program
  .command("status")
  .description("Reconstruct durable Fugue engineering state for the current repository")
  .action(runStatus);

program
  .command("reconcile")
  .description("Run one idempotent protected-state reconciliation pass")
  .option("--issue <number>", "Reconcile only one Fugue work issue")
  .option("--pr <number>", "Reconcile only the work item linked to one PR")
  .action(runReconcile);

program
  .command("advance")
  .description("Perform the next deterministic workflow transition for current Fugue work")
  .option("--issue <number>", "Advance only one Fugue work issue")
  .option("--pr <number>", "Advance only the work item linked to one PR")
  .option("--dry-run", "Plan the next transition without mutating GitHub")
  .action(runAdvance);

program
  .command("run")
  .description("Local recovery watcher; normal coordination runs in GitHub Actions")
  .option("--issue <number>", "Watch only one Fugue work issue")
  .option("--pr <number>", "Watch only the work item linked to one PR")
  .option("--interval <seconds>", "GitHub polling interval in seconds", "30")
  .action(runOrchestrator);

program
  .command("handoff")
  .description("Generate a deterministic role handoff (advanced/recovery)")
  .argument("<role>", "coordinator, worker, code-qa, security-qa, visual-qa, or integration")
  .option("--issue <number>", "GitHub issue number")
  .option("--pr <number>", "GitHub pull request number")
  .option("--resume", "Resume an existing Worker claim instead of creating a new claim")
  .action(runHandoff);

program
  .command("link-pr")
  .description("Attach Fugue work metadata to an implementation PR (advanced/recovery)")
  .argument("<pr>", "GitHub pull request number")
  .requiredOption("--issue <number>", "Fugue work issue number")
  .action(runLinkPr);

program
  .command("review")
  .description("Record a structured QA verdict (advanced/recovery)")
  .argument("<pr>", "GitHub pull request number")
  .requiredOption("--role <role>", "code, security, or visual")
  .option("--approve", "Approve the current review session")
  .option("--changes-requested", "Request changes for the current review session")
  .option("--error", "Record that QA could not produce a verdict")
  .option("--agents-update <state>", "Code QA: not-required, present, or missing")
  .option("--validation-control <state>", "Code QA: acceptable or unacceptable")
  .option("--runtime-tested", "Visual QA: exact committed head was run and inspected")
  .option("--viewports <list>", "Visual QA: comma-separated viewports")
  .option("--summary <text>", "Human-readable verdict summary")
  .action(runReview);

program
  .command("acknowledge")
  .description("Record a head-bound Human acknowledgement (advanced/recovery)")
  .argument("<pr>", "GitHub pull request number")
  .option("--control-plane", "Acknowledge the current control-plane change")
  .action(runAcknowledge);

program
  .command("integrate")
  .description("Run the composite Integration gate locally (advanced/recovery)")
  .argument("<pr>", "GitHub pull request number")
  .action(runIntegrate);

const integrationRuntime = program
  .command("integration-runtime")
  .description("Internal GitHub-hosted Integration runtime");

integrationRuntime
  .command("prepare")
  .argument("<pr>", "GitHub pull request number")
  .requiredOption("--out <path>", "Write the immutable Integration plan JSON")
  .option("--github-output <path>", "Append GitHub Actions job outputs")
  .action(runIntegrationPrepare);

integrationRuntime
  .command("validate")
  .requiredOption("--plan <path>", "Prepared Integration plan JSON")
  .requiredOption("--cwd <path>", "Exact-head candidate checkout")
  .requiredOption("--out <path>", "Write validation evidence JSON")
  .action(runIntegrationValidate);

integrationRuntime
  .command("finalize")
  .requiredOption("--plan <path>", "Prepared Integration plan JSON")
  .requiredOption("--validation-result <state>", "GitHub Actions validation job result")
  .option("--validation <path>", "Validation evidence JSON when validation succeeded")
  .action(runIntegrationFinalize);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`fugue: ${message}`);
  process.exitCode = 1;
});
