import { createHash, createPublicKey, verify, type JsonWebKey as CryptoJsonWebKey } from "node:crypto";
import type { FugueGitHub } from "./github.js";

export const FUGUE_PROTOCOL_ACTOR = "github-actions[bot]";
export const FUGUE_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const FUGUE_OIDC_JWKS_URL = `${FUGUE_OIDC_ISSUER}/.well-known/jwks`;

const PROTOCOL_MARKER_PREFIX = "<!-- fugue-";
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
  data: { id: number; html_url: string; body: string; created_at?: string };
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
  run_attempt?: string | number;
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

/** Actor identity is only a cheap workflow-run prefilter; exact protected identity is bound elsewhere. */
export function isTrustedProtocolWorkflowRun(run: GitHubWorkflowRunLike): boolean {
  return isTrustedProtocolActor(run.actor);
}

/** Commit-status actor identity alone is never canonical Fugue authority. */
export function isTrustedProtocolCommitStatus(status: GitHubCommitStatusLike): boolean {
  return isTrustedProtocolActor(status.creator);
}

/** Canonical publication has exactly one writer-owned Fugue protocol marker. */
export function hasCanonicalProtocolBoundary(body: string): boolean {
  const start = body.indexOf(PROTOCOL_MARKER_PREFIX);
  if (start < 0) return false;
  if (body.indexOf(PROTOCOL_MARKER_PREFIX, start + PROTOCOL_MARKER_PREFIX.length) >= 0) return false;
  if (body.startsWith(PROOF_START, start)) return false;
  return body.indexOf(PROOF_END, start + PROTOCOL_MARKER_PREFIX.length) >= 0;
}

/** Escape reflected text before placing it beside a writer-owned canonical marker. */
export function escapeProtocolMarkers(value: string): string {
  return value.replaceAll(PROTOCOL_MARKER_PREFIX, "&lt;!-- fugue-");
}

export async function isTrustedProtocolComment(
  github: FugueGitHub,
  comment: GitHubCommentLike,
): Promise<boolean> {
  if (!isTrustedProtocolActor(comment.user)) return false;
  const body = comment.body ?? "";
  const timestamp = Date.parse(comment.updated_at ?? comment.created_at ?? "");
  if (!Number.isFinite(timestamp)) return false;
  try {
    const protectedBase = await readRepositoryDefaultBranchIdentity(github);
    return verifyProtocolPublicationBodyAtRevision(github, body, protectedBase.sha, timestamp, protectedBase.branch);
  } catch {
    return false;
  }
}

/** Historical comment verification for current protected rollover code only. */
export async function isReusableProtocolComment(
  github: FugueGitHub,
  comment: GitHubCommentLike,
  protectedWorkflowSha: string,
): Promise<boolean> {
  if (!isTrustedProtocolActor(comment.user)) return false;
  const timestamp = Date.parse(comment.updated_at ?? comment.created_at ?? "");
  if (!Number.isFinite(timestamp)) return false;
  try {
    const identity = await readRepositoryDefaultBranchIdentity(github);
    return verifyProtocolPublicationBodyAtRevision(
      github,
      comment.body ?? "",
      protectedWorkflowSha,
      timestamp,
      identity.branch,
    );
  } catch {
    return false;
  }
}

/** Verify a stored canonical publication body independently of an issue comment. */
export async function verifyProtocolPublicationBodyAtRevision(
  github: FugueGitHub,
  body: string,
  protectedWorkflowSha: string,
  publicationTimestampMs: number,
  suppliedDefaultBranch?: string,
): Promise<boolean> {
  const proof = parsePublisherProof(body);
  if (!proof) return false;
  const canonicalBody = stripProtocolPublisherProof(body);
  if (!hasCanonicalProtocolBoundary(canonicalBody)) return false;
  if (!Number.isFinite(publicationTimestampMs)) return false;
  const defaultBranch = suppliedDefaultBranch ?? (await readRepositoryDefaultBranchIdentity(github)).branch;
  const jwks = await loadGitHubOidcJwks();
  return verifyPublisherTokenInternal(
    proof,
    protocolAudience(github.repository.fullName, canonicalBody),
    github.repository.fullName,
    defaultBranch,
    protectedWorkflowSha,
    publicationTimestampMs,
    jwks,
  );
}

/** Read the default branch identity fresh. Never cache this mutable revocation boundary. */
export async function readRepositoryDefaultBranchIdentity(
  github: FugueGitHub,
): Promise<{ branch: string; sha: string }> {
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.repos.get({ owner, repo });
  const branch = response.data.default_branch;
  if (!branch) throw new Error(`Repository ${github.repository.fullName} has no default branch.`);
  const ref = await github.octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const sha = ref.data.object.sha;
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Repository ${github.repository.fullName} default branch has an invalid head SHA.`);
  }
  return { branch, sha };
}

export async function assertRepositoryDefaultBranchRevision(
  github: FugueGitHub,
  expectedSha: string,
): Promise<void> {
  const current = await readRepositoryDefaultBranchIdentity(github);
  if (current.sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(
      `Protected default branch advanced from ${expectedSha.slice(0, 8)} to ${current.sha.slice(0, 8)}; stale Fugue publication is refused.`,
    );
  }
}

/**
 * Mint an OIDC-bound canonical body without publishing it. Callers that use this for durable
 * authority MUST keep any commit capability redacted from all pre-commit transport and only reveal
 * it in their final protected commit write.
 */
export interface DurableManifestProofBinding {
  storageSha: string;
  scope: string;
  key: string;
  nonce: string;
  bodyDigest: string;
  authorityOrder: string;
  firstStatusId: number;
  lastStatusId: number;
  chunkCount: number;
  statusIds: readonly number[];
}

export async function createDurableManifestProof(
  github: FugueGitHub,
  binding: DurableManifestProofBinding,
): Promise<string> {
  validateDurableManifestBinding(binding);
  return requestGitHubOidcToken(durableManifestAudience(github.repository.fullName, binding));
}

export async function verifyDurableManifestProof(
  github: FugueGitHub,
  token: string,
  binding: DurableManifestProofBinding,
  protectedWorkflowSha: string,
  publicationTimestampMs: number,
): Promise<boolean> {
  try {
    validateDurableManifestBinding(binding);
    const identity = await readRepositoryDefaultBranchIdentity(github);
    const jwks = await loadGitHubOidcJwks();
    return verifyPublisherTokenInternal(
      token,
      durableManifestAudience(github.repository.fullName, binding),
      github.repository.fullName,
      identity.branch,
      protectedWorkflowSha,
      publicationTimestampMs,
      jwks,
    );
  } catch {
    return false;
  }
}

function durableManifestAudience(repository: string, binding: DurableManifestProofBinding): string {
  const scopeDigest = createHash("sha256").update(binding.scope, "utf8").digest("hex").slice(0, 24);
  const orderDigest = createHash("sha256").update(binding.authorityOrder, "utf8").digest("hex").slice(0, 24);
  const statusIdsDigest = createHash("sha256").update(binding.statusIds.join(","), "utf8").digest("hex");
  return [
    "fugue:v1",
    repository,
    "durable-manifest",
    binding.storageSha.toLowerCase(),
    scopeDigest,
    binding.key.toLowerCase(),
    binding.nonce.toLowerCase(),
    binding.bodyDigest.toLowerCase(),
    orderDigest,
    String(binding.firstStatusId),
    String(binding.lastStatusId),
    String(binding.chunkCount),
    statusIdsDigest,
  ].join(":");
}

function validateDurableManifestBinding(binding: DurableManifestProofBinding): void {
  if (!/^[0-9a-f]{40}$/i.test(binding.storageSha)) throw new Error("Invalid durable storage SHA.");
  if (!/^[A-Za-z0-9._/-]{1,56}$/.test(binding.scope)) throw new Error("Invalid durable scope.");
  if (!/^[0-9a-f]{32}$/i.test(binding.key) || !/^[0-9a-f]{32}$/i.test(binding.nonce)) {
    throw new Error("Invalid durable manifest secret.");
  }
  if (!/^[0-9a-f]{64}$/i.test(binding.bodyDigest)) throw new Error("Invalid durable body digest.");
  if (!binding.authorityOrder || binding.authorityOrder.length > 512) throw new Error("Invalid durable authority order.");
  if (!Number.isInteger(binding.firstStatusId) || binding.firstStatusId <= 0 ||
      !Number.isInteger(binding.lastStatusId) || binding.lastStatusId < binding.firstStatusId ||
      !Number.isInteger(binding.chunkCount) || binding.chunkCount <= 0 || binding.chunkCount > 48) {
    throw new Error("Invalid durable status range.");
  }
  if (!Array.isArray(binding.statusIds) || binding.statusIds.length !== binding.chunkCount) {
    throw new Error("Durable manifest must bind every exact chunk status ID.");
  }
  let previous = 0;
  for (const id of binding.statusIds) {
    if (!Number.isSafeInteger(id) || id <= previous) throw new Error("Durable chunk status IDs must be strictly increasing positive integers.");
    previous = id;
  }
  if (binding.statusIds[0] !== binding.firstStatusId || binding.statusIds.at(-1) !== binding.lastStatusId) {
    throw new Error("Durable chunk status IDs do not match their authenticated range.");
  }
}

export async function signProtocolBody(github: FugueGitHub, body: string): Promise<string> {
  return attachPublisherProof(github.repository.fullName, body);
}

export async function createProtocolComment(
  github: FugueGitHub,
  issueNumber: number,
  body: string,
): Promise<ProtocolCommentResponse> {
  const signed = await signProtocolBody(github, body);
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: signed,
  });
  return {
    data: {
      id: response.data.id,
      html_url: response.data.html_url,
      body: response.data.body ?? signed,
      created_at: response.data.created_at,
    },
  };
}

export async function updateProtocolComment(
  github: FugueGitHub,
  commentId: number,
  body: string,
): Promise<ProtocolCommentResponse> {
  const signed = await signProtocolBody(github, body);
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: signed,
  });
  return {
    data: {
      id: response.data.id,
      html_url: response.data.html_url,
      body: response.data.body ?? signed,
      created_at: response.data.created_at,
    },
  };
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
  protectedWorkflowSha: string,
  commentTimestampMs: number,
  jwks: JwkSet,
): boolean {
  return verifyPublisherTokenInternal(
    token,
    expectedAudience,
    repository,
    defaultBranch,
    protectedWorkflowSha,
    commentTimestampMs,
    jwks,
  );
}

function verifyPublisherTokenInternal(
  token: string,
  expectedAudience: string,
  repository: string,
  defaultBranch: string,
  protectedWorkflowSha: string | undefined,
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
  if (normalizedRunAttempt(claims.run_attempt) !== 1) return false;
  if (!claims.workflow_sha || !/^[0-9a-f]{40}$/i.test(claims.workflow_sha)) return false;
  if (protectedWorkflowSha !== undefined) {
    if (!/^[0-9a-f]{40}$/i.test(protectedWorkflowSha)) return false;
    if (claims.workflow_sha.toLowerCase() !== protectedWorkflowSha.toLowerCase()) return false;
  }

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
  if (!hasCanonicalProtocolBoundary(body)) {
    throw new Error("Canonical Fugue comment body must contain exactly one Fugue protocol marker block.");
  }
  const token = await requestGitHubOidcToken(protocolAudience(repository, body));
  return `${body}\n\n${PROOF_START}\nversion: 1\ntoken: ${token}\n${PROOF_END}`;
}

async function requestGitHubOidcToken(audience: string): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("Canonical Fugue publication requires protected GitHub Actions OIDC (id-token: write).");
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

function parsePublisherProof(body: string): string | null {
  const canonical = stripProtocolPublisherProof(body);
  if (canonical === body) return null;
  const suffix = body.slice(canonical.length);
  const match = suffix.match(
    /^\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: ([A-Za-z0-9._-]+)\n-->\s*$/,
  );
  return match?.[1] ?? null;
}

function normalizedRunAttempt(value: OidcClaims["run_attempt"]): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
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
