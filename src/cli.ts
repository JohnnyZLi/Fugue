#!/usr/bin/env node

import { Command } from "commander";
import { runAcknowledge } from "./commands/acknowledge.js";
import { runAdvance } from "./commands/advance.js";
import { runHandoff } from "./commands/handoff.js";
import { runIntegrate } from "./commands/integrate.js";
import { runLinkPr } from "./commands/link-pr.js";
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
  .command("status")
  .description("Reconstruct durable Fugue engineering state for the current repository")
  .action(runStatus);

program
  .command("advance")
  .description("Perform the next deterministic workflow transition for current Fugue work")
  .option("--issue <number>", "Advance only one Fugue work issue")
  .option("--pr <number>", "Advance only the work item linked to one PR")
  .option("--dry-run", "Plan the next transition without mutating GitHub")
  .action(runAdvance);

program
  .command("run")
  .description("Continuously watch GitHub and advance Fugue work until external or Human action changes")
  .option("--issue <number>", "Watch only one Fugue work issue")
  .option("--pr <number>", "Watch only the work item linked to one PR")
  .option("--interval <seconds>", "GitHub polling interval in seconds", "30")
  .action(runOrchestrator);

program
  .command("handoff")
  .description("Generate a deterministic role handoff")
  .argument("<role>", "coordinator, worker, code-qa, security-qa, visual-qa, or integration")
  .option("--issue <number>", "GitHub issue number")
  .option("--pr <number>", "GitHub pull request number")
  .option("--resume", "Resume an existing Worker claim instead of creating a new claim")
  .action(runHandoff);

program
  .command("link-pr")
  .description("Attach Fugue work metadata to an implementation PR")
  .argument("<pr>", "GitHub pull request number")
  .requiredOption("--issue <number>", "Fugue work issue number")
  .action(runLinkPr);

program
  .command("review")
  .description("Record a structured, identity-bound QA verdict")
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
  .description("Record a head-bound Human acknowledgement")
  .argument("<pr>", "GitHub pull request number")
  .option("--control-plane", "Acknowledge the current control-plane change")
  .action(runAcknowledge);

program
  .command("integrate")
  .description("Run the composite Integration gate against an exact PR snapshot")
  .argument("<pr>", "GitHub pull request number")
  .action(runIntegrate);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`fugue: ${message}`);
  process.exitCode = 1;
});
