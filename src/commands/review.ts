import type { QaRole } from "../core/attestations.js";
import { discoverRepository } from "../core/git.js";
import { requireWritableGitHub } from "../core/github.js";
import { completeReview } from "../core/reviews.js";

export interface ReviewCommandOptions {
  role: string;
  approve?: boolean;
  changesRequested?: boolean;
  error?: boolean;
  agentsUpdate?: string;
  validationControl?: string;
  runtimeTested?: boolean;
  viewports?: string;
  summary?: string;
}

export async function runReview(prValue: string, options: ReviewCommandOptions): Promise<void> {
  const prNumber = parsePositiveInteger(prValue, "PR");
  const role = parseRole(options.role);
  const verdict = parseVerdict(options);
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);

  const result = await completeReview(github, prNumber, role, {
    verdict,
    agentsUpdate: parseAgentsUpdate(options.agentsUpdate),
    validationControl: parseValidationControl(options.validationControl),
    runtimeTested: options.runtimeTested,
    viewports: parseViewports(options.viewports),
    summary: options.summary,
  });

  console.log(`${role.toUpperCase()} QA ${verdict === "approved" ? "APPROVED" : verdict === "changes_requested" ? "CHANGES REQUESTED" : "ERROR"}`);
  console.log(`PR           #${prNumber}`);
  console.log(`Head         ${result.snapshot.identity.headSha}`);
  console.log(`Attestation  ${result.attestation.attestation_id}`);
  console.log(`Evidence     ${result.url}`);
}

function parseRole(value: string): QaRole {
  if (value === "code" || value === "security" || value === "visual") return value;
  throw new Error(`Invalid QA role: ${value}`);
}

function parseVerdict(options: ReviewCommandOptions): "approved" | "changes_requested" | "error" {
  const selected = [options.approve, options.changesRequested, options.error].filter(Boolean).length;
  if (selected !== 1) {
    throw new Error("Choose exactly one of --approve, --changes-requested, or --error.");
  }
  if (options.approve) return "approved";
  if (options.changesRequested) return "changes_requested";
  return "error";
}

function parseAgentsUpdate(value?: string): "not-required" | "present" | "missing" | undefined {
  if (value === undefined) return undefined;
  if (value === "not-required" || value === "present" || value === "missing") return value;
  throw new Error("--agents-update must be not-required, present, or missing.");
}

function parseValidationControl(value?: string): "acceptable" | "unacceptable" | undefined {
  if (value === undefined) return undefined;
  if (value === "acceptable" || value === "unacceptable") return value;
  throw new Error("--validation-control must be acceptable or unacceptable.");
}

function parseViewports(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}
