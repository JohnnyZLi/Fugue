import { IntegrationGateFailure } from "./gates.js";
import { matchesAnyPath } from "./glob.js";
import type { WorkSpec } from "./metadata.js";

export type OwnershipViolationKind = "forbidden" | "unassigned";

export interface OwnershipViolation {
  path: string;
  kind: OwnershipViolationKind;
}

export interface OwnershipResolution {
  passed: boolean;
  violations: OwnershipViolation[];
}

export function resolveOwnership(
  changedFiles: readonly string[],
  ownership: WorkSpec["ownership"],
): OwnershipResolution {
  const violations: OwnershipViolation[] = [];

  for (const path of changedFiles) {
    if (matchesAnyPath(path, ownership.forbidden)) {
      violations.push({ path, kind: "forbidden" });
      continue;
    }

    if (
      matchesAnyPath(path, ownership.owned) ||
      matchesAnyPath(path, ownership.coordinate)
    ) {
      continue;
    }

    violations.push({ path, kind: "unassigned" });
  }

  return { passed: violations.length === 0, violations };
}

export function assertOwnership(
  changedFiles: readonly string[],
  ownership: WorkSpec["ownership"],
): void {
  const resolution = resolveOwnership(changedFiles, ownership);
  if (resolution.passed) return;

  const detail = resolution.violations
    .map((violation) => `${violation.path} (${violation.kind})`)
    .join(", ");
  throw new IntegrationGateFailure(
    "ownership",
    `PR changes violate the assigned work ownership contract: ${detail}.`,
  );
}

export function ownershipSummary(resolution: OwnershipResolution): string {
  if (resolution.passed) return "passed";
  return resolution.violations
    .map((violation) => `${violation.path} (${violation.kind})`)
    .join(", ");
}
