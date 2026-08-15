#!/usr/bin/env node

import { Command } from "commander";
import { FUGUE_PROTOCOL_VERSION } from "./core/protocol.js";

const program = new Command();

program
  .name("fugue")
  .description("GitHub-backed multi-session engineering orchestration for ChatGPT")
  .version("0.1.0-alpha.0");

program
  .command("status")
  .description("Reconstruct durable Fugue engineering state for the current repository")
  .action(() => {
    console.log(`Fugue protocol ${FUGUE_PROTOCOL_VERSION}`);
    console.log("status: bootstrap command surface only");
  });

program
  .command("handoff")
  .description("Generate a deterministic role handoff")
  .argument("<role>", "coordinator, worker, code-qa, security-qa, visual-qa, or integration")
  .option("--issue <number>", "GitHub issue number")
  .option("--pr <number>", "GitHub pull request number")
  .option("--resume", "Resume an existing Worker claim instead of creating a new claim")
  .action((role, options) => {
    console.log(JSON.stringify({ role, ...options, protocol: FUGUE_PROTOCOL_VERSION }, null, 2));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`fugue: ${message}`);
  process.exitCode = 1;
});
