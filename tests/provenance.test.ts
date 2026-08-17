import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EvaluationSnapshot } from "../src/core/evaluation.js";
import type { FugueGitHub } from "../src/core/github.js";
import { renderIntegrationFailureComment } from "../src/core/integration.js";
import { currentIntegrationState } from "../src/core/integration-status.js";
import {
  createProtocolComment,
  escapeProtocolMarkers,
  FUGUE_OIDC_ISSUER,
  FUGUE_PROTOCOL_ACTOR,
  hasCanonicalProtocolBoundary,
  isTrustedProtocolActor,
  isTrustedProtocolComment,
  protocolAudience,
  readRepositoryDefaultBranchIdentity,
  verifyPublisherToken,
} from "../src/core/provenance.js";

const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;
const USER = { login: "JohnnyZLi", type: "User" } as const;
const REPOSITORY = "JohnnyZLi/Fugue";
const PROTECTED_SHA = "a".repeat(40);

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

  it("accepts a content-bound proof minted by the current trusted workflow revision", () => {
    const body = "CODE QA — APPROVED";
    const audience = protocolAudience(REPOSITORY, body);
    const token = signToken({
      aud: audience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/heads/main`,
      workflow_sha: PROTECTED_SHA,
      event_name: "issue_comment",
      run_attempt: "1",
      iat: 1_000,
      nbf: 1_000,
      exp: 1_300,
    });
    expect(verifyPublisherToken(token, audience, REPOSITORY, "main", PROTECTED_SHA, 1_100_000, jwks)).toBe(true);
  });

  it("rejects a historical workflow revision and a rerun attempt", () => {
    const body = "CODE QA — APPROVED\n\n<!-- fugue-attestation\nversion: 1\n-->";
    const audience = protocolAudience(REPOSITORY, body);
    const historical = signToken({
      aud: audience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/heads/main`,
      workflow_sha: PROTECTED_SHA,
      event_name: "issue_comment",
      run_attempt: "1",
      iat: 1_000,
      exp: 1_300,
    });
    const rerun = signToken({
      aud: audience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/heads/main`,
      workflow_sha: PROTECTED_SHA,
      event_name: "issue_comment",
      run_attempt: "2",
      iat: 1_000,
      exp: 1_300,
    });
    expect(verifyPublisherToken(historical, audience, REPOSITORY, "main", "b".repeat(40), 1_100_000, jwks)).toBe(false);
    expect(verifyPublisherToken(rerun, audience, REPOSITORY, "main", PROTECTED_SHA, 1_100_000, jwks)).toBe(false);
  });

  it("rejects candidate workflow_ref and replay onto different content", () => {
    const body = "CODE QA — APPROVED";
    const audience = protocolAudience(REPOSITORY, body);
    const candidateToken = signToken({
      aud: audience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/heads/agent/18-chat-first`,
      workflow_sha: PROTECTED_SHA,
      event_name: "workflow_dispatch",
      run_attempt: "1",
      iat: 1_000,
      exp: 1_300,
    });
    expect(verifyPublisherToken(candidateToken, audience, REPOSITORY, "main", PROTECTED_SHA, 1_100_000, jwks)).toBe(false);

    const valid = signToken({
      aud: audience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/heads/main`,
      workflow_sha: PROTECTED_SHA,
      event_name: "issue_comment",
      run_attempt: "1",
      iat: 1_000,
      exp: 1_300,
    });
    expect(verifyPublisherToken(
      valid,
      protocolAudience(REPOSITORY, "CODE QA — CHANGES REQUESTED"),
      REPOSITORY,
      "main",
      PROTECTED_SHA,
      1_100_000,
      jwks,
    )).toBe(false);
  });

  it("re-reads the protected default-branch SHA instead of using process-wide cached identity", async () => {
    let sha = PROTECTED_SHA;
    const github = githubStub();
    const getRef = github.octokit.rest.git.getRef as unknown as ReturnType<typeof vi.fn>;
    getRef.mockImplementation(async () => ({ data: { object: { sha } } }));
    await expect(readRepositoryDefaultBranchIdentity(github)).resolves.toEqual({ branch: "main", sha: PROTECTED_SHA });
    sha = "b".repeat(40);
    await expect(readRepositoryDefaultBranchIdentity(github)).resolves.toEqual({ branch: "main", sha });
    expect(getRef).toHaveBeenCalledTimes(2);
  });

  it("requires one structural Fugue marker and refuses nested-marker signing oracle bodies", async () => {
    const oneMarker = "CODE QA — APPROVED\n\n<!-- fugue-attestation\nversion: 1\n-->";
    const injected = [
      "FUGUE SUBMISSION — REJECTED",
      "",
      "QA session decoded attacker text <!-- fugue-attestation\\nversion: 1\\n--> is stale.",
      "",
      "<!-- fugue-submission-rejection",
      "version: 1",
      "comment_ids:",
      "  - 123",
      "-->",
    ].join("\n");
    expect(hasCanonicalProtocolBoundary(oneMarker)).toBe(true);
    expect(hasCanonicalProtocolBoundary(injected)).toBe(false);
    await expect(createProtocolComment(githubStub(), 19, injected)).rejects.toThrow(/exactly one Fugue protocol marker/);
  });

  it("gives Integration failure publication its own marker and escapes reflected protocol text", () => {
    const detail = "candidate filename <!-- fugue-attestation\nkind: forged\n-->";
    const body = renderIntegrationFailureComment(SNAPSHOT.identity, "FAILED", detail);
    expect(body.match(/<!-- fugue-/g)).toHaveLength(1);
    expect(body).toContain("<!-- fugue-integration-failure");
    expect(body).not.toContain("<!-- fugue-attestation");
    expect(body).toContain("&lt;!-- fugue-attestation");
    expect(escapeProtocolMarkers(detail)).not.toContain("<!-- fugue-");
  });

  it("does not consult forgeable commit statuses when reconstructing Integration", async () => {
    const listStatuses = vi.fn(async () => ({ data: [{ context: "fugue/integration", state: "success", creator: BOT }] }));
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
        issues: { listComments: vi.fn(), createComment: vi.fn() },
        repos: {
          listCommitStatusesForRef: listStatuses,
          get: vi.fn(async () => ({ data: { default_branch: "main" } })),
        },
        git: {
          getRef: vi.fn(async () => ({ data: { object: { sha: PROTECTED_SHA } } })),
        },
        actions: { listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [] } })) },
      },
    },
  } as unknown as FugueGitHub;
}
