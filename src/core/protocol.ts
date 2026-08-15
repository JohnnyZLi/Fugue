export const FUGUE_PROTOCOL_VERSION = 1 as const;

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

export function assertSupportedProtocol(version: number): asserts version is FugueProtocolVersion {
  if (version !== FUGUE_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported Fugue protocol ${version}; this CLI supports protocol ${FUGUE_PROTOCOL_VERSION}.`,
    );
  }
}
