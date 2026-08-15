import {
  diagnoseRepository,
  doctorFailed,
  parseDoctorExecutor,
  type DoctorReport,
} from "../core/doctor.js";
import { discoverRepository, type RepositoryRef } from "../core/git.js";
import { createGitHub } from "../core/github.js";

export interface DoctorCommandOptions {
  executor?: string;
}

export async function runDoctor(options: DoctorCommandOptions): Promise<void> {
  const executor = parseDoctorExecutor(options.executor);
  let repository: RepositoryRef;
  try {
    repository = await discoverRepository();
  } catch (error) {
    console.log(formatDiscoveryFailure(executor, error));
    process.exitCode = 1;
    return;
  }
  const github = await createGitHub(repository);
  const report = await diagnoseRepository(github, { executor });

  console.log(formatDoctorReport(report));
  if (doctorFailed(report)) process.exitCode = 1;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `FUGUE DOCTOR — ${report.repository}`,
    `Executor     ${report.executor}`,
    "",
  ];
  const checkWidth = Math.max(...report.diagnostics.map((diagnostic) => diagnostic.check.length));

  for (const diagnostic of report.diagnostics) {
    lines.push(`${diagnostic.status.padEnd(5)} ${diagnostic.check.padEnd(checkWidth)}  ${diagnostic.message}`);
  }

  const failures = report.diagnostics.filter((diagnostic) => diagnostic.status === "FAIL").length;
  const warnings = report.diagnostics.filter((diagnostic) => diagnostic.status === "WARN").length;
  lines.push("");
  lines.push(failures
    ? `RESULT FAIL — ${failures} failure(s), ${warnings} warning(s)`
    : warnings
      ? `RESULT PASS — ${warnings} warning(s)`
      : "RESULT PASS — repository is ready for Fugue workflows");
  return lines.join("\n");
}

function formatDiscoveryFailure(executor: string, error: unknown): string {
  const gitUnavailable = typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
  const check = gitUnavailable ? "Git" : "Repository";
  const detail = gitUnavailable
    ? "Git is unavailable. Install Git and ensure `git` is on PATH before running Fugue workflows."
    : `Unable to discover a GitHub repository: ${message(error)}`;
  return [
    "FUGUE DOCTOR",
    `Executor     ${executor}`,
    "",
    `FAIL  ${check}  ${detail}`,
    "",
    "RESULT FAIL — 1 failure(s), 0 warning(s)",
  ].join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
