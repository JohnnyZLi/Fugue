import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EvaluationSnapshot } from "../src/core/evaluation.js";
import type { FugueGitHub } from "../src/core/github.js";
import { renderIntegrationFailureComment } from "../src/core/integration.js";
import {
  createProtocolComment,
  escapeProtocolMarkers,
  FUGUE_OIDC_ISSUER,
  FUGUE_PROTOCOL_ACTOR,
  hasCanonicalProtocolBoundary,
  isTrustedProtocolActor,
  isTrustedProtocolComment,
  protocolAudience,
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

  it("rejects historical workflow revisions and rerun attempts", () => {
    const body = "CODE QA — APPROVED";
    const audience = protocolAudience(REPOSITORY, body);
    const base = {
      aud: audience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/heads/main`,
      workflow_sha: PROTECTED_SHA,
      event_name: "issue_comment",
      iat: 1_000,
      nbf: 1_000,
      exp: 1_300,
    };
    expect(verifyPublisherToken(signToken(base), audience, REPOSITORY, "main", "b".repeat(40), 1_100_000, jwks)).toBe(false);
    expect(verifyPublisherToken(signToken({ ...base, run_attempt: "2" }), audience, REPOSITORY, "main", PROTECTED_SHA, 1_100_000, jwks)).toBe(false);
  });

  it("rejects candidate workflow_ref and replay onto different content", () => {
    const body = "CODE QA — APPROVED";
    const audience = protocolAudience(REPOSITORY, body);
    const candidate = signToken({
      aud: audience,
      iss: FUGUE_OIDC_ISSUER,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/fugue-control-plane.yml@refs/heads/agent/18-chat-first`,
      workflow_sha: PROTECTED_SHA,
      event_name: "workflow_dispatch",
      run_attempt: "1",
      iat: 1_000,
      nbf: 1_000,
      exp: 1_300,
    });
    expect(verifyPublisherToken(candidate, audience, REPOSITORY, "main", PROTECTED_SHA, 1_100_000, jwks)).toBe(false);

    const protectedToken = signToken({
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
    expect(verifyPublisherToken(
      protectedToken,
      protocolAudience(REPOSITORY, "CODE QA — CHANGES REQUESTED"),
      REPOSITORY,
      "main",
      PROTECTED_SHA,
      1_100_000,
      jwks,
    )).toBe(false);
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
    const body = renderIntegrationFailureComment(SNAPSHOT.identity, "FAILED", detail, {
      request_id: "int-0123456789abcdef-fedcba9876543210",
      run_id: 12,
      run_attempt: 1,
    });
    expect(body.match(/<!-- fugue-/g)).toHaveLength(1);
    expect(body).toContain("<!-- fugue-integration-failure");
    expect(body).not.toContain("<!-- fugue-attestation");
    expect(body).toContain("&lt;!-- fugue-attestation");
    expect(body).toContain("run_id: 12");
    expect(hasCanonicalProtocolBoundary(body)).toBe(true);
    expect(escapeProtocolMarkers(detail)).not.toContain("<!-- fugue-");
  });
});

function signToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function githubStub(): FugueGitHub {
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: REPOSITORY },
    octokit: {
      rest: {
        repos: { get: vi.fn(async () => ({ data: { default_branch: "main" } })) },
        git: { getRef: vi.fn(async () => ({ data: { object: { sha: PROTECTED_SHA } } })) },
        issues: { createComment: vi.fn() },
      },
    },
  } as unknown as FugueGitHub;
}
