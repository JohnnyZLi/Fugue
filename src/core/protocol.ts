export const FUGUE_PROTOCOL_VERSION = 1 as const;
export const FUGUE_CLI_VERSION = "0.1.0-alpha.0" as const;

export type FugueProtocolVersion = typeof FUGUE_PROTOCOL_VERSION;

export interface PolicyIdentity {
  baseBranch: string;
  baseSha: string;
  policyDigest: string;
  protocolVersion: FugueProtocolVersion;
}

export interface WorkIdentity {
  issueNumber: number;
  workId: string;
  workSpecDigest: string;
}

export interface WorkerClaim {
  workId: string;
  workerId: string;
  branch: string;
}

export interface EvaluationIdentity extends PolicyIdentity, WorkIdentity {
  prNumber: number;
  headSha: string;
}

export type ReviewRole = "code" | "security" | "visual";

export type Verdict = "approved" | "changes_requested" | "error";

export interface ReviewAttestation {
  version: 1;
  attestationId: string;
  role: ReviewRole;
  identity: EvaluationIdentity;
  fugueVersion: string;
  verdict: Verdict;
}

export interface IntegrationSnapshot extends EvaluationIdentity {
  capturedAt: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function assertSupportedProtocol(version: number): asserts version is FugueProtocolVersion {
  if (version !== FUGUE_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported Fugue protocol ${version}; this CLI supports protocol ${FUGUE_PROTOCOL_VERSION}.`,
    );
  }
}

export function assertCompatibleCliVersion(
  minimum: string,
  maximumCompatible: string,
  current = FUGUE_CLI_VERSION,
): void {
  const currentVersion = parseVersion(current);
  const minimumVersion = parseVersion(minimum);

  if (compareVersions(currentVersion, minimumVersion) < 0) {
    throw new Error(`Fugue ${current} is older than repository minimum ${minimum}.`);
  }

  if (maximumCompatible.endsWith(".x")) {
    const parts = maximumCompatible.split(".");
    const major = Number(parts[0]);
    const minorPart = parts[1];
    if (!Number.isInteger(major) || major < 0) {
      throw new Error(`Invalid fugue_max_compatible_version: ${maximumCompatible}`);
    }
    if (currentVersion.major !== major) {
      throw new Error(`Fugue ${current} is outside repository compatibility line ${maximumCompatible}.`);
    }
    if (minorPart !== "x") {
      const minor = Number(minorPart);
      if (!Number.isInteger(minor) || minor < 0) {
        throw new Error(`Invalid fugue_max_compatible_version: ${maximumCompatible}`);
      }
      if (currentVersion.minor !== minor) {
        throw new Error(`Fugue ${current} is outside repository compatibility line ${maximumCompatible}.`);
      }
    }
    return;
  }

  const maximumVersion = parseVersion(maximumCompatible);
  if (compareVersions(currentVersion, maximumVersion) > 0) {
    throw new Error(`Fugue ${current} is newer than repository maximum compatible version ${maximumCompatible}.`);
  }
}

function parseVersion(value: string): ParsedVersion {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`Invalid Fugue version: ${value}`);

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }

  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }

  return 0;
}
