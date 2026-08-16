import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EvaluationSnapshot } from "../src/core/evaluation.js";
import type { FugueGitHub } from "../src/core/github.js";
import { currentIntegrationState } from "../src/core/integration-status.js";
import {
  FUGUE_OIDC_ISSUER,
  FUGUE_PROTOCOL_ACTOR,
  isTrustedProtocolActor,
  isTrustedProtocolComment,
  protocolAudience,
  verifyPublisherToken,
} from "../src/core/provenance.js";

const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;
const USER = { login: "JohnnyZLi", type: "User" } as const;
const REPOSITORY = "JohnnyZLi/Fugue";

const SNAPSHOT = {
  identity: {
    prNumber: 19,
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseBranch: "main",
    baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    policyDigest: "sha256:policy",
    protocolVersion: 1,
    issueNumber: 18,
    workId: "work-18",
    workSpecDigest: "sha256:spec",
  },
  pr: { number: 19 },
} as unknown as EvaluationSnapshot;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
const jwks = { keys: [publicJwk] };

describe("Fugue protocol provenance", () => {
  it("treats the shared Actions bot only as a prefilter, not canonical comment provenance", async () => {
    const github = githubStub();
    expect(isTrustedProtocolActor(BOT)).toBe(true);
    expect(isTrustedProtocolActor(USER)).toBe(false);
    await expect(isTrustedProtocolComment(github, { user: USER, body: "canonical-looking" })).resolves.toBe(false);
    await expect(isTrustedProtocolComment(github, { user: BOT, body: "canonical-looking" })).resolves.toBe(false);
  });

  it("accepts a content-bound proof minted by the protected control-plane workflow", () => {
    const body = "CODE QA — APPROVED";
    const audience = protocolAudience(REPOSITORY, body);
    const token = signToken({
      aud: audience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/heads/main`,
      workflow_sha: "a".repeat(40),
      ref_protected: true,
      event_name: "issue_comment",
      iat: 1_000,
      nbf: 1_000,
      exp: 1_300,
    });

    expect(verifyPublisherToken(token, audience, REPOSITORY, 1_100_000, jwks)).toBe(true);
  });

  it("rejects the same signed body when the workflow ref is candidate-controlled", () => {
    const body = "CODE QA — APPROVED";
    const audience = protocolAudience(REPOSITORY, body);
    const token = signToken({
      aud: audience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/pull/19/merge`,
      workflow_sha: "a".repeat(40),
      ref_protected: false,
      event_name: "pull_request",
      iat: 1_000,
      nbf: 1_000,
      exp: 1_300,
    });

    expect(verifyPublisherToken(token, audience, REPOSITORY, 1_100_000, jwks)).toBe(false);
  });

  it("rejects replay of a valid protected-workflow token onto different canonical content", () => {
    const original = "CODE QA — APPROVED";
    const originalAudience = protocolAudience(REPOSITORY, original);
    const token = signToken({
      aud: originalAudience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/heads/main`,
      workflow_sha: "a".repeat(40),
      ref_protected: true,
      event_name: "issue_comment",
      iat: 1_000,
      exp: 1_300,
    });

    expect(
      verifyPublisherToken(
        token,
        protocolAudience(REPOSITORY, "CODE QA — CHANGES REQUESTED"),
        REPOSITORY,
        1_100_000,
        jwks,
      ),
    ).toBe(false);
  });

  it("does not consult forgeable commit statuses when reconstructing Integration", async () => {
    const listStatuses = vi.fn(async () => ({
      data: [{ context: "fugue/integration", state: "success", creator: BOT }],
    }));
    const github = githubStub(listStatuses);
    const current = await currentIntegrationState(github, SNAPSHOT);
    expect(current.state).toBe("none");
    expect(listStatuses).not.toHaveBeenCalled();
  });
});

function signToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function githubStub(listStatuses = vi.fn(async () => ({ data: [] }))): FugueGitHub {
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: REPOSITORY },
    octokit: {
      paginate: vi.fn(async () => []),
      rest: {
        issues: { listComments: vi.fn() },
        repos: { listCommitStatusesForRef: listStatuses },
        actions: { listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [] } })) },
      },
    },
  } as unknown as FugueGitHub;
}
