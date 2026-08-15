import { spawn } from "node:child_process";
import { IntegrationGateFailure } from "./gates.js";

export interface ValidationResult {
  passed: true;
  commands: string[];
}

export async function runValidation(
  cwd: string,
  installCommands: readonly string[],
  checkCommands: readonly string[],
): Promise<ValidationResult> {
  const commands = [...installCommands, ...checkCommands];
  for (const command of commands) {
    await runCommand(command, cwd);
  }
  return { passed: true, commands };
}

async function runCommand(command: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new IntegrationGateFailure("validation", `Validation command failed (${detail}): ${command}`));
    });
  });
}
