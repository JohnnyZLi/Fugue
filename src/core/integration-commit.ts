import { createHash } from "node:crypto";
import { z } from "zod";
import type { FugueGitHub } from "./github.js";
import {
  createFugueAuthorityVariable,
  deleteFugueAuthorityVariable,
  getFugueAuthorityVariable,
} from "./state.js";

const INTEGRATION_COMMIT_PREFIX = "FUGUE_INT_C_";

const integrationCommitIdentitySchema = z.object({
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\d{10}_[0-9A-F]{16}$/),
});

export const integrationExactRunCommitSchema = integrationCommitIdentitySchema.extend({
  version: z.literal(1),
  kind: z.literal("integration_exact_run_commit"),
  run_id: z.number().int().positive(),
  run_attempt: z.literal(1),
  run_created_at: z.string().min(1),
  html_url: z.string().min(1),
});

export const integrationIdentityLostCommitSchema = integrationCommitIdentitySchema.extend({
  version: z.literal(1),
  kind: z.literal("integration_identity_lost_commit"),
  attempt: z.literal(1),
  boundary_created_at: z.string().min(1),
  fence_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  created_at: z.string().min(1),
});

export const integrationCommitSchema = z.discriminatedUnion("kind", [
  integrationExactRunCommitSchema,
  integrationIdentityLostCommitSchema,
]);

export type IntegrationExactRunCommit = z.infer<typeof integrationExactRunCommitSchema>;
export type IntegrationIdentityLostCommit = z.infer<typeof integrationIdentityLostCommitSchema>;
export type IntegrationCommit = z.infer<typeof integrationCommitSchema>;

export interface IntegrationCommitContext {
  requestId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  anchorName: string;
}

export interface IntegrationExactRunCandidate {
  runId: number;
  createdAt: string;
  htmlUrl: string;
}

export interface IntegrationIdentityLostCandidate {
  boundaryCreatedAt: string;
  fenceDigest: string;
  createdAt: string;
}

export interface IntegrationCommitStore {
  create(value: string): Promise<boolean>;
  read(): Promise<string | undefined>;
}

export function integrationCommitVariableName(requestId: string): string {
  if (!/^int-[0-9a-f]{16}-[0-9a-f]{16}$/.test(requestId)) {
    throw new Error("Invalid Integration request ID for request-local commit serialization.");
  }
  const suffix = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 32).toUpperCase();
  return `${INTEGRATION_COMMIT_PREFIX}${suffix}`;
}

function assertCommitIdentity(commit: IntegrationCommit, context: IntegrationCommitContext): void {
  if (commit.request_id !== context.requestId || commit.pr_number !== context.prNumber ||
      commit.head_sha.toLowerCase() !== context.headSha.toLowerCase() ||
      commit.base_sha.toLowerCase() !== context.baseSha.toLowerCase() ||
      commit.anchor_name !== context.anchorName) {
    throw new Error(`Protected Integration commit slot for ${context.requestId} belongs to another evaluation identity.`);
  }
  if (commit.kind === "integration_exact_run_commit") {
    if (!Number.isFinite(Date.parse(commit.run_created_at)) || !commit.html_url) {
      throw new Error(`Protected Integration exact-run commit for ${context.requestId} is malformed.`);
    }
  } else if (!Number.isFinite(Date.parse(commit.boundary_created_at)) || !Number.isFinite(Date.parse(commit.created_at))) {
    throw new Error(`Protected Integration identity-lost commit for ${context.requestId} is malformed.`);
  }
}

export function parseIntegrationCommit(raw: string, context: IntegrationCommitContext): IntegrationCommit {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new Error(`Protected Integration commit slot for ${context.requestId} is malformed.`); }
  const commit = integrationCommitSchema.parse(value);
  assertCommitIdentity(commit, context);
  return commit;
}

export async function claimIntegrationCommitWithStore(
  store: IntegrationCommitStore,
  context: IntegrationCommitContext,
  candidate: IntegrationCommit,
): Promise<IntegrationCommit> {
  const serialized = JSON.stringify(integrationCommitSchema.parse(candidate));
  const created = await store.create(serialized);
  const committed = created ? serialized : await store.read();
  if (!committed) {
    throw new Error(`Protected Integration commit slot ${integrationCommitVariableName(context.requestId)} disappeared during serialization.`);
  }
  return parseIntegrationCommit(committed, context);
}

export async function readIntegrationCommit(
  github: FugueGitHub,
  context: IntegrationCommitContext,
): Promise<IntegrationCommit | undefined> {
  const raw = await getFugueAuthorityVariable(github, integrationCommitVariableName(context.requestId));
  return raw === undefined ? undefined : parseIntegrationCommit(raw, context);
}

async function claimIntegrationCommit(
  github: FugueGitHub,
  context: IntegrationCommitContext,
  candidate: IntegrationCommit,
): Promise<IntegrationCommit> {
  const name = integrationCommitVariableName(context.requestId);
  return claimIntegrationCommitWithStore({
    create: (value) => createFugueAuthorityVariable(github, name, value),
    read: () => getFugueAuthorityVariable(github, name),
  }, context, candidate);
}

export async function claimExactIntegrationCommit(
  github: FugueGitHub,
  context: IntegrationCommitContext,
  candidate: IntegrationExactRunCandidate,
): Promise<IntegrationExactRunCommit> {
  if (!Number.isSafeInteger(candidate.runId) || candidate.runId <= 0 ||
      !Number.isFinite(Date.parse(candidate.createdAt)) || !candidate.htmlUrl) {
    throw new Error("Protected Integration exact-run commit candidate is malformed.");
  }
  const winner = await claimIntegrationCommit(github, context, integrationExactRunCommitSchema.parse({
    version: 1,
    kind: "integration_exact_run_commit",
    request_id: context.requestId,
    pr_number: context.prNumber,
    head_sha: context.headSha,
    base_sha: context.baseSha,
    anchor_name: context.anchorName,
    run_id: candidate.runId,
    run_attempt: 1,
    run_created_at: candidate.createdAt,
    html_url: candidate.htmlUrl,
  }));
  if (winner.kind === "integration_identity_lost_commit") {
    throw new Error(`Integration request ${context.requestId} already committed terminal identity_lost serialization.`);
  }
  // B, S, and the synchronous return-details path can observe the same run at different clocks.
  // Once one of them wins C, every other exact writer converges on that winner's canonical timestamp.
  if (winner.run_id !== candidate.runId || winner.html_url !== candidate.htmlUrl) {
    throw new Error(`Integration request ${context.requestId} already committed protected run ${winner.run_id}.`);
  }
  return winner;
}

export async function claimIdentityLostIntegrationCommit(
  github: FugueGitHub,
  context: IntegrationCommitContext,
  candidate: IntegrationIdentityLostCandidate,
): Promise<IntegrationCommit> {
  if (!Number.isFinite(Date.parse(candidate.boundaryCreatedAt)) ||
      !/^sha256:[0-9a-f]{64}$/i.test(candidate.fenceDigest) ||
      !Number.isFinite(Date.parse(candidate.createdAt))) {
    throw new Error("Protected Integration identity_lost commit candidate is malformed.");
  }
  const winner = await claimIntegrationCommit(github, context, integrationIdentityLostCommitSchema.parse({
    version: 1,
    kind: "integration_identity_lost_commit",
    request_id: context.requestId,
    pr_number: context.prNumber,
    head_sha: context.headSha,
    base_sha: context.baseSha,
    anchor_name: context.anchorName,
    attempt: 1,
    boundary_created_at: candidate.boundaryCreatedAt,
    fence_digest: candidate.fenceDigest,
    created_at: candidate.createdAt,
  }));
  if (winner.kind === "integration_identity_lost_commit" &&
      (winner.boundary_created_at !== candidate.boundaryCreatedAt ||
       winner.fence_digest.toLowerCase() !== candidate.fenceDigest.toLowerCase())) {
    throw new Error(`Integration request ${context.requestId} has conflicting identity_lost serialization evidence.`);
  }
  return winner;
}

export async function releaseIntegrationCommit(github: FugueGitHub, requestId: string): Promise<void> {
  await deleteFugueAuthorityVariable(github, integrationCommitVariableName(requestId));
}
