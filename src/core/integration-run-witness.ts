import { z } from "zod";
import type { FugueGitHub } from "./github.js";
import type { IntegrationRecord, IntegrationRunBinding } from "./integration-plan.js";
import { verifyProtocolPublicationBodyAtRevision } from "./provenance.js";

const INTEGRATION_RUN_WITNESS_START = "<!-- fugue-integration-run-witness";
const PROTOCOL_END = "-->";

export const integrationRunWitnessSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_run_witness"),
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  pr_number: z.number().int().positive(),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  secret_digest: z.string().regex(/^[0-9a-f]{64}$/i),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\d{10}_[0-9A-F]{16}$/),
  run_id: z.number().int().positive(),
  run_attempt: z.literal(1),
  created_at: z.string().min(1),
});

export type IntegrationRunWitness = z.infer<typeof integrationRunWitnessSchema>;

export class IntegrationRunWitnessDiscoveryPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationRunWitnessDiscoveryPendingError";
  }
}

interface CommitCommentRecord {
  id: number;
  body?: string | null;
  commit_id?: string | null;
  created_at?: string | null;
}

export function serializeIntegrationRunWitness(value: IntegrationRunWitness): string {
  const payload = Buffer.from(JSON.stringify(integrationRunWitnessSchema.parse(value)), "utf8").toString("base64url");
  return `${INTEGRATION_RUN_WITNESS_START}\nversion: 1\npayload: ${payload}\n${PROTOCOL_END}\n\nINTEGRATION RUN — STARTED`;
}

export function parseIntegrationRunWitness(body: string): IntegrationRunWitness | null {
  const start = body.indexOf(INTEGRATION_RUN_WITNESS_START);
  if (start < 0) return null;
  const end = body.indexOf(PROTOCOL_END, start + INTEGRATION_RUN_WITNESS_START.length);
  if (end < 0) return null;
  const block = body.slice(start + INTEGRATION_RUN_WITNESS_START.length, end).trim();
  const match = block.match(/^version: 1\npayload: ([A-Za-z0-9_-]+)$/);
  if (!match?.[1]) return null;
  try {
    return integrationRunWitnessSchema.parse(JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

/**
 * Recover attempt-1 identity only from a protected Integration-workflow OIDC proof. Commit comments
 * are transport: their author, position, timestamp, and any Deployment/Status records are never
 * authority. An ordinary repository writer may copy or reorder a valid witness, but the protected
 * content-bound proof covers the run_id and dispatch digest, so transport edits cannot substitute it.
 */
export async function findEarliestProtectedIntegrationRunWitness(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationRunBinding | undefined> {
  if (!record.dispatch) return undefined;
  const { owner, repo } = github.repository;
  const matches = new Map<number, IntegrationRunWitness>();
  for (let page = 1; page <= 1000; page += 1) {
    const response = await github.octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/comments", {
      owner,
      repo,
      commit_sha: record.identity.baseSha,
      per_page: 100,
      page,
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    });
    const comments = response.data as unknown as CommitCommentRecord[];
    for (const comment of comments) {
      const witness = await verifiedIntegrationRunWitness(github, record, comment);
      if (witness) matches.set(witness.run_id, witness);
    }
    if (comments.length < 100) break;
    if (page === 1000) {
      throw new IntegrationRunWitnessDiscoveryPendingError("Protected Integration run-witness history exceeded the bounded scan window.");
    }
  }
  const earliest = [...matches.values()].sort((left, right) => left.run_id - right.run_id)[0];
  if (!earliest) return undefined;
  return {
    id: earliest.run_id,
    attempt: 1,
    created_at: earliest.created_at,
    html_url: `https://github.com/${github.repository.fullName}/actions/runs/${earliest.run_id}`,
  };
}

async function verifiedIntegrationRunWitness(
  github: FugueGitHub,
  record: IntegrationRecord,
  comment: CommitCommentRecord,
): Promise<IntegrationRunWitness | undefined> {
  const body = comment.body ?? "";
  const witness = parseIntegrationRunWitness(body);
  if (!witness || !record.dispatch) return undefined;
  if (comment.commit_id && comment.commit_id.toLowerCase() !== record.identity.baseSha.toLowerCase()) return undefined;
  if (witness.request_id !== record.request.request_id ||
      witness.pr_number !== record.identity.prNumber ||
      witness.base_sha.toLowerCase() !== record.identity.baseSha.toLowerCase() ||
      witness.secret_digest.toLowerCase() !== record.dispatch.secret_digest.toLowerCase() ||
      witness.anchor_name !== record.dispatch.anchor_name || witness.run_attempt !== 1) return undefined;
  const created = Date.parse(witness.created_at);
  const requestCreated = Date.parse(record.request.created_at);
  const authorized = Date.parse(record.dispatch.authorized_at);
  if (!Number.isFinite(created) || !Number.isFinite(requestCreated) || !Number.isFinite(authorized) ||
      created < Math.max(requestCreated, authorized)) return undefined;

  let verified = false;
  try {
    verified = await verifyProtocolPublicationBodyAtRevision(
      github,
      body,
      record.identity.baseSha,
      created,
      record.identity.baseBranch,
    );
  } catch {
    return undefined;
  }
  return verified ? witness : undefined;
}
