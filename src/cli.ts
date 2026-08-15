#!/usr/bin/env node

import { Command } from "commander";
import { runHandoff } from "./commands/handoff.js";
import { runStatus } from "./commands/status.js";

const program = new Command();

program
  .name("fugue")
  .description("GitHub-backed multi-session engineering orchestration for ChatGPT")
  .version("0.1.0-alpha.0");

program
  .command("status")
  .description("Reconstruct durable Fugue engineering state for the current repository")
  .action(runStatus);

program
  .command("handoff")
  .description("Generate a deterministic role handoff")
  .argument("<role>", "coordinator, worker, code-qa, security-qa, visual-qa, or integration")
  .option("--issue <number>", "GitHub issue number")
  .option("--pr <number>", "GitHub pull request number")
  .option("--resume", "Resume an existing Worker claim instead of creating a new claim")
  .action(runHandoff);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`fugue: ${message}`);
  process.exitCode = 1;
});
