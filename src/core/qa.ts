import type { FugueConfig } from "./config.js";
import { matchesAnyPath } from "./glob.js";

export type QaRole = "code" | "security" | "visual";

export interface QaRequirement {
  role: QaRole;
  reasons: string[];
}

export interface QaResolution {
  required: QaRequirement[];
  controlPlaneChanged: boolean;
  validationControlChanged: boolean;
}

export function resolveQaRequirements(
  config: FugueConfig,
  changedFiles: readonly string[],
  explicitForce: readonly QaRole[] = [],
): QaResolution {
  const reasons = new Map<QaRole, Set<string>>();
  const add = (role: QaRole, reason: string): void => {
    const current = reasons.get(role) ?? new Set<string>();
    current.add(reason);
    reasons.set(role, current);
  };

  if (config.reviews.code.required === "always") add("code", "Code QA is required by base policy");
  if (
    config.reviews.code.required === "conditional" &&
    matchesAnyPathSet(changedFiles, config.reviews.code.paths ?? [])
  ) {
    add("code", "Changed files match Code QA paths");
  }

  if (
    config.reviews.security.required === "always" ||
    matchesAnyPathSet(changedFiles, config.reviews.security.paths ?? [])
  ) {
    add("security", "Changed files match Security QA policy");
  }

  if (
    config.reviews.visual.required === "always" ||
    matchesAnyPathSet(changedFiles, config.reviews.visual.paths ?? [])
  ) {
    add("visual", "Changed files match Visual QA policy");
  }

  const controlPlaneChanged = matchesAnyPathSet(changedFiles, config.control_plane.paths);
  if (controlPlaneChanged) {
    add("code", "Control-plane changes require Code QA");
    add("security", "Control-plane changes require Security QA");
  }

  const validationControlChanged = matchesAnyPathSet(changedFiles, config.validation.control_paths);
  if (validationControlChanged) {
    add("code", "Validation-control changes require explicit Code QA review");
  }

  for (const role of explicitForce) add(role, "Explicit additive work requirement");

  return {
    required: (["code", "security", "visual"] as const)
      .filter((role) => reasons.has(role))
      .map((role) => ({ role, reasons: [...(reasons.get(role) ?? [])] })),
    controlPlaneChanged,
    validationControlChanged,
  };
}

function matchesAnyPathSet(files: readonly string[], patterns: readonly string[]): boolean {
  return files.some((file) => matchesAnyPath(file, patterns));
}
