import { createHash, createPublicKey, verify, type JsonWebKey as CryptoJsonWebKey } from "node:crypto";
import type { FugueGitHub } from "./github.js";

export const FUGUE_PROTOCOL_ACTOR = "github-actions[bot]";
export const FUGUE_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const FUGUE_OIDC_JWKS_URL = `${FUGUE_OIDC_ISSUER}/.well-known/jwks`;

const PROOF_START = "<!-- fugue-publisher-proof";
const PROOF_END = "-->";
const CLOCK_SKEW_SECONDS = 60;
const TRUSTED_WORKFLOWS = new Map<string, ReadonlySet<string>>([
  [
    ".github/workflows/fugue-control-plane.yml",
    new Set(["issues", "issue_comment", "pull_request_target", "workflow_run", "schedule", "workflow_dispatch"]),
  ],
  [".github/workflows/fugue-integration.yml", new Set(["workflow_dispatch"])],
]);
const defaultBranchCache = new Map<string, string>();

export interface GitHubActorLike {
  login?: string | null;
  type?: string | null;
}

export interface GitHubCommentLike {
  body?: string | null;
  user?: GitHubActorLike | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface GitHubWorkflowRunLike {
  actor?: GitHubActorLike | null;
}

export interface GitHubCommitStatusLike {
  creator?: GitHubActorLike | null;
}

export interface ProtocolCommentResponse {
  data: { html_url: string };
}

interface OidcHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface OidcClaims {
  aud?: string | string[];
  iss?: string;
  repository?: string;
  workflow_ref?: string;
  workflow_sha?: string;
  event_name?: string;
  iat?: number;
  nbf?: number;
  exp?: number;
}

interface PublisherJwk extends CryptoJsonWebKey {
  kid?: string;
}

interface JwkSet {
  keys?: PublisherJwk[];
}

let jwksCache: JwkSet | undefined;

export function isTrustedProtocolActor(actor: GitHubActorLike | null | undefined): boolean {
  if (actor?.login !== FUGUE_PROTOCOL_ACTOR) return false;
  return actor.type == null || actor.type === "Bot";
}

/**
 * Workflow-run actor identity alone is not canonical protocol provenance. This predicate is
 * retained only as a cheap prefilter for workflow-run discovery; callers must also bind runs
 * to the protected workflow file/ref and a trusted durable request.
 */
export function isTrustedProtocolWorkflowRun(run: GitHubWorkflowRunLike): boolean {
  return isTrustedProtocolActor(run.actor);
}

/**
 * Commit-status actor identity alone is not canonical protocol provenance. Commit statuses are
 * presentation/merge-gate signals only; Fugue's durable state readers use signed comments and
 * protected workflow-run identity instead.
 */
export function isTrustedProtocolCommitStatus(status: GitHubCommitStatusLike): boolean {
  return isTrustedProtocolActor(status.creator);
}

export async function isTrustedProtocolComment(
  github: FugueGitHub,
  comment: GitHubCommentLike,
): Promise<boolean> {
  if (!isTrustedProtocolActor(comment.user)) return false;
  const body = comment.body ?? "";
  const proof = parsePublisherProof(body);
  if (!proof) return false;

  const canonicalBody = stripProtocolPublisherProof(body);
  const audience = protocolAudience(github.repository.fullName, canonicalBody);
  const timestamp = Date.parse(comment.updated_at ?? comment.created_at ?? "");
  if (!Number.isFinite(timestamp)) return false;

  try {
    const [jwks, branch] = await Promise.all([
      loadGitHubOidcJwks(),
      repositoryDefaultBranch(github),
    ]);
    return verifyPublisherToken(
      proof,
      audience,
      github.repository.fullName,
      branch,
      timestamp,
      jwks,
    );
  } catch {
    return false;
  }
}

export async function createProtocolComment(
  github: FugueGitHub,
  issueNumber: number,
  body: string,
): Promise<ProtocolCommentResponse> {
  const signed = await attachPublisherProof(github.repository.fullName, body);
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: signed,
  });
  return { data: { html_url: response.data.html_url } };
}

export async function updateProtocolComment(
  github: FugueGitHub,
  commentId: number,
  body: string,
): Promise<ProtocolCommentResponse> {
  const signed = await attachPublisherProof(github.repository.fullName, body);
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: signed,
  });
  return { data: { html_url: response.data.html_url } };
}

export function stripProtocolPublisherProof(body: string): string {
  const start = body.lastIndexOf(`\n\n${PROOF_START}`);
  if (start < 0) return body;
  const end = body.indexOf(PROOF_END, start + PROOF_START.length);
  if (end < 0) return body;
  if (body.slice(end + PROOF_END.length).trim()) return body;
  return body.slice(0, start);
}

export function protocolAudience(repository: string, body: string): string {
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return `fugue:v1:${repository}:comment:${digest}`;
}

export function verifyPublisherToken(
  token: string,
  expectedAudience: string,
  repository: string,
  defaultBranch: string,
  commentTimestampMs: number,
  jwks: JwkSet,
): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return false;

  let header: OidcHeader;
  let claims: OidcClaims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as OidcHeader;
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as OidcClaims;
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || !header.kid) return false;

  const jwk = jwks.keys?.find((candidate) => candidate.kid === header.kid);
  if (!jwk) return false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const signature = Buffer.from(encodedSignature, "base64url");
    const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8");
    if (!verify("RSA-SHA256", signed, key, signature)) return false;
  } catch {
    return false;
  }

  if (claims.iss !== FUGUE_OIDC_ISSUER) return false;
  if (!audienceContains(claims.aud, expectedAudience)) return false;
  if (claims.repository !== repository) return false;
  if (!claims.workflow_sha || !/^[0-9a-f]{40}$/i.test(claims.workflow_sha)) return false;

  const workflow = trustedWorkflowPath(repository, claims.workflow_ref, defaultBranch);
  if (!workflow) return false;
  const allowedEvents = TRUSTED_WORKFLOWS.get(workflow);
  if (!claims.event_name || !allowedEvents?.has(claims.event_name)) return false;

  if (!Number.isFinite(commentTimestampMs)) return false;
  const timestamp = Math.floor(commentTimestampMs / 1000);
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) return false;
  const nbf = Number.isFinite(claims.nbf) ? claims.nbf! : claims.iat!;
  if (timestamp < nbf - CLOCK_SKEW_SECONDS) return false;
  if (timestamp < claims.iat! - CLOCK_SKEW_SECONDS) return false;
  if (timestamp > claims.exp! + CLOCK_SKEW_SECONDS) return false;
  return true;
}

async function attachPublisherProof(repository: string, body: string): Promise<string> {
  if (body.includes(PROOF_START)) {
    throw new Error("Canonical Fugue comment body contains a reserved publisher-proof marker.");
  }
  const token = await requestGitHubOidcToken(protocolAudience(repository, body));
  return `${body}\n\n${PROOF_START}\nversion: 1\ntoken: ${token}\n${PROOF_END}`;
}

async function requestGitHubOidcToken(audience: string): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "Canonical Fugue publication requires protected GitHub Actions OIDC (id-token: write).",
    );
  }

  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  if (!response.ok) {
    throw new Error(`Unable to acquire GitHub Actions OIDC publisher proof (${response.status}).`);
  }
  const payload = await response.json() as { value?: unknown };
  if (typeof payload.value !== "string" || !payload.value) {
    throw new Error("GitHub Actions OIDC response did not contain a token.");
  }
  return payload.value;
}

async function loadGitHubOidcJwks(): Promise<JwkSet> {
  if (jwksCache) return jwksCache;
  const response = await fetch(FUGUE_OIDC_JWKS_URL);
  if (!response.ok) throw new Error(`Unable to fetch GitHub OIDC JWKS (${response.status}).`);
  const jwks = await response.json() as JwkSet;
  if (!Array.isArray(jwks.keys) || !jwks.keys.length) throw new Error("GitHub OIDC JWKS is empty.");
  jwksCache = jwks;
  return jwks;
}

async function repositoryDefaultBranch(github: FugueGitHub): Promise<string> {
  const key = github.repository.fullName;
  const cached = defaultBranchCache.get(key);
  if (cached) return cached;
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.repos.get({ owner, repo });
  const branch = response.data.default_branch;
  if (!branch) throw new Error(`Repository ${key} has no default branch.`);
  defaultBranchCache.set(key, branch);
  return branch;
}

function parsePublisherProof(body: string): string | null {
  const canonical = stripProtocolPublisherProof(body);
  if (canonical === body) return null;
  const suffix = body.slice(canonical.length);
  const match = suffix.match(
    /^\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: ([A-Za-z0-9._-]+)\n-->\s*$/,
  );
  return match?.[1] ?? null;
}

function audienceContains(aud: OidcClaims["aud"], expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.includes(expected);
}

function trustedWorkflowPath(
  repository: string,
  workflowRef: string | undefined,
  defaultBranch: string,
): string | null {
  if (!workflowRef) return null;
  for (const path of TRUSTED_WORKFLOWS.keys()) {
    if (workflowRef === `${repository}/${path}@refs/heads/${defaultBranch}`) return path;
  }
  return null;
}
