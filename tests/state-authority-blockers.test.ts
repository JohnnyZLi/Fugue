import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FugueGitHub } from "../src/core/github.js";
import type { EvaluationSnapshot } from "../src/core/evaluation.js";
import type { ActivePolicy } from "../src/core/policy.js";
import { workMetadataSchema } from "../src/core/metadata.js";
import { cleanupTerminalProtectedIntegrationRecovery, ingestCoordinatorIssueEvent, protectedIntegrationRecoveryDecision, recoverExistingProtectedIntegration } from "../src/core/reconcile.js";
import { completeReview, currentReviewActivities } from "../src/core/reviews.js";
import { hasCurrentHumanAcknowledgement, processCurrentSubmissions } from "../src/core/submissions.js";
import { verifyHumanControlPlanePrerequisite } from "../src/core/integration.js";
import { createIntegrationRecord, createIntegrationRequest, serializeIntegrationRecord, type IntegrationRecord } from "../src/core/integration-plan.js";
import { authorizeIntegrationDispatch, bindDispatchedIntegrationRun, ensureIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationCommitVariableName, integrationDispatchRunToken, integrationRunStartVariableName, publishIntegrationRecord, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent, serializeIntegrationRunStartEvidence } from "../src/core/integration-status.js";
import { claimIdentityLostIntegrationCommit } from "../src/core/integration-status.js";
import { humanControlPlaneAttestationSchema, qaAttestationSchema, reviewStartSchema, serializeAttestation } from "../src/core/attestations.js";
import {
  assertRepositoryDefaultBranchRevision,
  createDurableManifestProof,
  FUGUE_PROTOCOL_ACTOR,
  signProtocolBody,
  verifyDurableManifestProof,
  verifyProtocolPublicationBodyAtRevision,
} from "../src/core/provenance.js";
import {
  canonicalRequirements,
  compactFugueRecoveryAuthorityVariables,
  createCanonicalWorkState,
  DurableProtocolRecoveryPendingError,
  loadCurrentCanonicalWorkState,
  parseCanonicalWorkState,
  publishCanonicalWorkState,
  publishDurableProtocolRecord,
  recoverDurableProtocolRecord,
} from "../src/core/state.js";

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  return {
    ...actual,
    readRepositoryDefaultBranchIdentity: vi.fn(async (github: FugueGitHub) => ({
      branch: "main",
      sha: (github as TestGithub).__baseSha,
    })),
    assertRepositoryDefaultBranchRevision: vi.fn(async (github: FugueGitHub, expected: string) => {
      await (github as TestGithub).__beforeRevisionCheck?.();
      const actualSha = (github as TestGithub).__baseSha;
      if (actualSha.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`stale protected revision ${actualSha.slice(0, 8)}`);
      }
    }),
    signProtocolBody: vi.fn(async (github: FugueGitHub, body: string) => {
      if (body.includes("<!-- fugue-durable-recovery")) {
        await (github as TestGithub).__beforeRecoverySign?.(body);
      }
      return `${body}\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: test-proof\n-->`;
    }),
    createDurableManifestProof: vi.fn(async () => "manifest-proof"),
    verifyDurableManifestProof: vi.fn(async (_github: FugueGitHub, proof: string) => proof === "manifest-proof"),
    verifyProtocolPublicationBodyAtRevision: vi.fn(defaultPublicationVerifier),
    isTrustedProtocolComment: vi.fn(async (_github: FugueGitHub, comment: TestComment) =>
      comment.user?.login === FUGUE_PROTOCOL_ACTOR),
    createProtocolComment: vi.fn(async (github: FugueGitHub, issueNumber: number, body: string) =>
      github.octokit.rest.issues.createComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        issue_number: issueNumber,
        body,
      })),
  };
});

vi.mock("../src/core/reviews.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/reviews.js")>();
  return { ...actual, completeReview: vi.fn(async () => undefined) };
});

const BASE = "b".repeat(40);
const NEXT_BASE = "c".repeat(40);
const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;

async function defaultPublicationVerifier(
  github: FugueGitHub,
  body: string,
  expected: string,
): Promise<boolean> {
  const publisherSha = (github as TestGithub).__publisherSha ?? expected;
  if (publisherSha.toLowerCase() !== expected.toLowerCase()) return false;
  if (body.includes("<!-- fugue-durable-recovery") || body.includes("INTEGRATION DISPATCH — AUTHORIZED") ||
      body.includes("INTEGRATION RUN — STARTED")) return body.includes("token: test-proof");
  const key = body.match(/Fugue-Authority-Key: ([0-9a-f]{32})/i)?.[1];
  const commit = body.match(/Fugue-Authority-Commit: ([0-9a-f]{32})/i)?.[1];
  return Boolean(key && commit && !/^0+$/.test(key) && !/^0+$/.test(commit));
}

function metadata(execution = false) {
  return workMetadataSchema.parse({
    version: 1,
    work_id: "work-18",
    spec: {
      dependencies: [],
      ownership: { owned: ["src/**"], coordinate: [], forbidden: [] },
      qa: { force: ["code", "security"] },
      authorized_changes: { agents_invariants: [] },
    },
    execution: execution
      ? { worker_id: "wkr-b0057a9e", branch: "agent/18-migrate-fugue-to-chat-first-github-hosted-orchestration" }
      : {},
  });
}

interface TestComment {
  id: number;
  node_id?: string;
  issueNumber: number;
  body: string;
  user?: { login: string; type: string };
  created_at?: string;
  updated_at?: string;
  editedBy?: string;
}

interface TestDeploymentStatus {
  id: number;
  state: string;
  environment: string;
  environment_url: string;
  created_at: string;
}

interface TestDeployment {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  created_at: string;
  statuses: TestDeploymentStatus[];
}

interface TestStatus {
  id: number;
  sha: string;
  context: string;
  description: string;
  target_url?: string;
  created_at: string;
}

interface TestGithub extends FugueGitHub {
  __baseSha: string;
  __publisherSha?: string;
  __authorityVariables: Map<string, string>;
  __comments: TestComment[];
  __statuses: TestStatus[];
  __workflowRuns: Array<{ id: number; actor: typeof BOT; event: string; head_sha: string; display_title: string; created_at: string; run_attempt: number; status: string; conclusion: string | null; html_url: string }>;
  __deployments: TestDeployment[];
  __hooks: { onDeploymentPage?: (page: number) => Promise<void> | void };
  __beforeRecoverySign?: (body: string) => Promise<void> | void;
  __beforeRevisionCheck?: () => Promise<void> | void;
}

function makeGithub(): TestGithub {
  const authorityVariables = new Map<string, string>();
  const comments: TestComment[] = [];
  const statuses: TestStatus[] = [];
  const workflowRuns: TestGithub["__workflowRuns"] = [];
  const deployments: TestDeployment[] = [];
  const hooks: TestGithub["__hooks"] = {};
  let nextCommentId = 0;
  let nextStatusId = 0;

  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    __baseSha: BASE,
    __authorityVariables: authorityVariables,
    __comments: comments,
    __statuses: statuses,
    __workflowRuns: workflowRuns,
    __deployments: deployments,
    __hooks: hooks,
    octokit: {
      graphql: vi.fn(async (_query: string, variables: { id?: string }) => {
        const comment = comments.find((candidate) => candidate.node_id === variables.id);
        if (!comment) return { node: null };
        return {
          node: {
            author: comment.user ? { login: comment.user.login } : null,
            editor: comment.editedBy ? { login: comment.editedBy } : null,
            lastEditedAt: comment.editedBy ? (comment.updated_at ?? new Date().toISOString()) : null,
          },
        };
      }),
      request: vi.fn(async (route: string, args: { page?: number; per_page?: number; deployment_id?: number }) => {
        if (route === "GET /repos/{owner}/{repo}/deployments") {
          const page = args.page ?? 1;
          const perPage = args.per_page ?? 100;
          await hooks.onDeploymentPage?.(page);
          const ordered = [...deployments].sort((a, b) => b.id - a.id);
          return { data: ordered.slice((page - 1) * perPage, page * perPage) };
        }
        if (route === "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses") {
          const deployment = deployments.find((candidate) => candidate.id === args.deployment_id);
          return { data: deployment ? [...deployment.statuses].sort((a, b) => b.id - a.id) : [] };
        }
        throw new Error(`unexpected test route ${route}`);
      }),
      paginate: vi.fn(async (method: (args: Record<string, unknown>) => Promise<{ data: unknown }>, args: Record<string, unknown>) => (await method(args)).data),
      rest: {
        issues: {
          get: vi.fn(async (args: { issue_number: number }) => ({
            data: { comments: comments.filter((comment) => comment.issueNumber === args.issue_number).length },
          })),
          listComments: vi.fn(async (args: { issue_number: number; page?: number; per_page?: number }) => {
            const perPage = args.per_page ?? 100;
            const page = args.page ?? 1;
            const filtered = comments
              .filter((comment) => comment.issueNumber === args.issue_number)
              .sort((left, right) => left.id - right.id);
            return { data: filtered.slice((page - 1) * perPage, page * perPage) };
          }),
          createComment: vi.fn(async (args: { issue_number: number; body: string }) => {
            const created = new Date().toISOString();
            const comment: TestComment = {
              id: ++nextCommentId,
              node_id: `IC_${nextCommentId}`,
              issueNumber: args.issue_number,
              body: args.body,
              user: BOT,
              created_at: created,
              updated_at: created,
            };
            comments.push(comment);
            return { data: { id: comment.id, body: comment.body, created_at: created } };
          }),
          deleteComment: vi.fn(async (args: { comment_id: number }) => {
            const index = comments.findIndex((comment) => comment.id === args.comment_id);
            if (index >= 0) comments.splice(index, 1);
            return { data: {} };
          }),
        },
        pulls: {
          get: vi.fn(async (args: { pull_number: number }) => ({ data: { number: args.pull_number, head: { sha: "a".repeat(40) } } })),
        },
        actions: {
          listWorkflowRuns: vi.fn(async (args: { page?: number; per_page?: number }) => {
            const page = args.page ?? 1;
            const perPage = args.per_page ?? 100;
            const ordered = [...workflowRuns].sort((a, b) => b.id - a.id);
            return { data: { workflow_runs: ordered.slice((page - 1) * perPage, page * perPage) } };
          }),
          getWorkflowRunAttempt: vi.fn(async (args: { run_id: number }) => {
            const found = workflowRuns.find((run) => run.id === args.run_id);
            if (!found) throw Object.assign(new Error("not found"), { status: 404 });
            return { data: found };
          }),
        },
        repos: {
          getCollaboratorPermissionLevel: vi.fn(async (args: { username: string }) => ({
            data: { permission: args.username === "human" ? "write" : "read" },
          })),
          createCommitStatus: vi.fn(async (args: {
            sha: string;
            context: string;
            description?: string;
            target_url?: string;
          }) => {
            const status: TestStatus = {
              id: ++nextStatusId,
              sha: args.sha,
              context: args.context,
              description: args.description ?? "",
              target_url: args.target_url,
              created_at: new Date().toISOString(),
            };
            statuses.push(status);
            return { data: status };
          }),
        },
      },
    },
  } as unknown as TestGithub;
}

function recoveryCursorBody(body: string): Record<string, unknown> | undefined {
  const payload = body.match(/<!-- fugue-durable-recovery\nversion: 1\npayload: ([A-Za-z0-9_-]+)/)?.[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function recoveryCheckpointBodies(github: TestGithub): string[] {
  const result: string[] = [];
  for (const [name, value] of github.__authorityVariables) {
    if (name.startsWith("FUGUE_D3_")) {
      result.push(value);
      continue;
    }
    if (!name.startsWith("FUGUE_D3P_")) continue;
    try {
      const pack = JSON.parse(value) as { kind?: string; entries?: unknown[] };
      if (pack.kind !== "durable_recovery_pack" || !Array.isArray(pack.entries)) continue;
      for (const entry of pack.entries) if (typeof entry === "string") result.push(entry);
    } catch {
      // Unreadable packs intentionally remain opaque to readers and compactors.
    }
  }
  return result;
}

function recoveryScopes(github: TestGithub): Set<string> {
  return new Set(recoveryCheckpointBodies(github)
    .map((body) => recoveryCursorBody(body)?.scope)
    .filter((scope): scope is string => typeof scope === "string"));
}

function recoveryOrders(github: TestGithub, scope: string): string[] {
  return recoveryCheckpointBodies(github).flatMap((body) => {
    const cursor = recoveryCursorBody(body);
    if (cursor?.scope !== scope || cursor.commit_witness !== true) return [];
    const manifest = cursor.best_manifest as { authority_order_b64?: unknown } | undefined;
    if (typeof manifest?.authority_order_b64 !== "string") return [];
    return [Buffer.from(manifest.authority_order_b64, "base64url").toString("utf8")];
  });
}

function recoveryBucket(scope: string): string {
  return createHash("sha256")
    .update(`${BASE.toLowerCase()}\0${BASE.toLowerCase()}\0${scope}`, "utf8")
    .digest("hex")
    .slice(0, 2)
    .toUpperCase();
}

function sameBucketScopes(): { bucket: string; first: string; second: string } {
  const firstByBucket = new Map<string, string>();
  for (let index = 0; index < 10_000; index += 1) {
    const scope = `mixed-validity/${index}`;
    const bucket = recoveryBucket(scope);
    const first = firstByBucket.get(bucket);
    if (first) return { bucket, first, second: scope };
    firstByBucket.set(bucket, scope);
  }
  throw new Error("unable to find two recovery scopes in one bucket");
}

class AdvanceBaseOnRecoveryLeafMap extends Map<string, string> {
  armed = false;
  onLeaf?: () => void;

  override set(key: string, value: string): this {
    super.set(key, value);
    if (this.armed && /^FUGUE_D3_[0-9A-F]{16}_[0-9A-F]{16}$/i.test(key)) {
      this.armed = false;
      this.onLeaf?.();
    }
    return this;
  }
}

function fillAuthorityCapacity(github: TestGithub, prefix: string): void {
  let index = 0;
  while (github.__authorityVariables.size < 500) {
    github.__authorityVariables.set(`${prefix}${String(index++).padStart(4, "0")}`, "unrelated");
  }
}

function addIntegrationDeploymentWitness(
  github: TestGithub,
  requestId: string,
  token: string,
  run: TestGithub["__workflowRuns"][number],
  deploymentId = 100_000 + run.id,
): void {
  github.__deployments.push({
    id: deploymentId,
    sha: run.head_sha,
    ref: "main",
    task: "deploy",
    environment: "fugue-authority",
    created_at: run.created_at,
    statuses: [{
      id: deploymentId * 10,
      state: run.conclusion === "failure" ? "failure" : run.status === "completed" ? "success" : "in_progress",
      environment: "fugue-authority",
      environment_url: `https://github.com/JohnnyZLi/Fugue/actions/runs/${run.id}?fugue_request=${requestId}&fugue_run_token=${token}`,
      created_at: run.created_at,
    }],
  });
}

function immutableUserComment(id: number, body: string, login = "attacker"): TestComment {
  const timestamp = `2026-08-17T08:${String(id % 60).padStart(2, "0")}:00.000Z`;
  return {
    id,
    node_id: `IC_${id}`,
    issueNumber: 19,
    body,
    user: { login, type: "User" },
    created_at: timestamp,
    updated_at: timestamp,
  };
}


const TEST_AUTHORITY_ACTOR_ID = 424242;

function protectedRecoveryNames(requestId: string): { fence: string; binding: string } {
  const suffix = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 32).toUpperCase();
  return { fence: `FUGUE_INT_F_${suffix}`, binding: `FUGUE_INT_B_${suffix}` };
}

function installProtectedFence(
  github: TestGithub,
  record: IntegrationRecord,
  secret: string,
  createdAt: string,
): { raw: string; runToken: string; fence: Record<string, unknown>; names: { fence: string; binding: string } } {
  if (!record.dispatch) throw new Error("test request lacks dispatch authorization");
  const runToken = integrationDispatchRunToken(record.request.request_id, secret);
  const fence = {
    version: 1,
    kind: "integration_dispatch_fence",
    request_id: record.request.request_id,
    pr_number: record.identity.prNumber,
    head_sha: record.identity.headSha,
    base_sha: record.identity.baseSha,
    anchor_name: record.dispatch.anchor_name,
    secret_digest: record.dispatch.secret_digest,
    run_token: runToken,
    authority_actor_id: TEST_AUTHORITY_ACTOR_ID,
    created_at: createdAt,
  };
  const raw = JSON.stringify(fence);
  const names = protectedRecoveryNames(record.request.request_id);
  github.__authorityVariables.set(names.fence, raw);
  return { raw, runToken, fence, names };
}

function installProtectedBinding(
  github: TestGithub,
  record: IntegrationRecord,
  fence: Record<string, unknown>,
  runId: number,
  runCreatedAt: string,
): string {
  const names = protectedRecoveryNames(record.request.request_id);
  const htmlUrl = `https://github.com/JohnnyZLi/Fugue/actions/runs/${runId}`;
  github.__authorityVariables.set(names.binding, JSON.stringify({
    version: 1,
    kind: "integration_binding_witness",
    request_id: record.request.request_id,
    pr_number: record.identity.prNumber,
    head_sha: record.identity.headSha,
    base_sha: record.identity.baseSha,
    anchor_name: record.dispatch?.anchor_name,
    run_token: fence.run_token,
    authority_actor_id: TEST_AUTHORITY_ACTOR_ID,
    run_id: runId,
    run_attempt: 1,
    run_created_at: runCreatedAt,
    html_url: htmlUrl,
  }));
  return htmlUrl;
}

async function withHostedAuthority<T>(callback: () => Promise<T>): Promise<T> {
  const oldToken = process.env.FUGUE_AUTHORITY_TOKEN;
  const oldActor = process.env.FUGUE_AUTHORITY_ACTOR_ID;
  process.env.FUGUE_AUTHORITY_TOKEN = "test-authority-token";
  process.env.FUGUE_AUTHORITY_ACTOR_ID = String(TEST_AUTHORITY_ACTOR_ID);
  try { return await callback(); }
  finally {
    if (oldToken === undefined) delete process.env.FUGUE_AUTHORITY_TOKEN; else process.env.FUGUE_AUTHORITY_TOKEN = oldToken;
    if (oldActor === undefined) delete process.env.FUGUE_AUTHORITY_ACTOR_ID; else process.env.FUGUE_AUTHORITY_ACTOR_ID = oldActor;
  }
}

describe("absorbed Code QA / Security QA authority blockers", () => {
  it("keeps a later Worker successor authoritative when an older overlapping publisher finishes last", async () => {
    const github = makeGithub();
    const root = createCanonicalWorkState({
      issue: 18,
      title: "Causal root",
      state: "state:ready",
      agentReady: true,
      requirements: "## Outcome\nroot intent",
      metadata: metadata(false),
      pr: null,
      baseSha: BASE,
      createdAt: "2026-08-17T05:00:00.000Z",
      logicalRoot: true,
    });
    await expect(publishCanonicalWorkState(github, root)).resolves.toBe(true);
    const predecessor = (await loadCurrentCanonicalWorkState(github, 18, BASE))!;

    const stale = createCanonicalWorkState({
      issue: 18,
      title: "Older Human edit",
      state: "state:ready",
      agentReady: true,
      requirements: "## Outcome\nolder intent",
      metadata: predecessor.metadata,
      pr: null,
      baseSha: BASE,
      createdAt: "2026-08-17T05:00:01.000Z",
      predecessor,
    });
    const worker = createCanonicalWorkState({
      issue: 18,
      title: predecessor.title,
      state: "state:working",
      agentReady: true,
      requirements: canonicalRequirements(predecessor),
      metadata: metadata(true),
      pr: null,
      baseSha: BASE,
      createdAt: "2026-08-17T05:00:02.000Z",
      predecessor,
    });

    let releaseStale!: () => void;
    let markStaleReached!: () => void;
    const staleRelease = new Promise<void>((resolve) => { releaseStale = resolve; });
    const staleReached = new Promise<void>((resolve) => { markStaleReached = resolve; });
    github.__beforeRecoverySign = async (body) => {
      const cursor = recoveryCursorBody(body);
      if (cursor?.scope !== "work/18" || cursor.commit_witness !== true || typeof cursor.best_body_b64 !== "string") return;
      const proposed = parseCanonicalWorkState(Buffer.from(cursor.best_body_b64, "base64url").toString("utf8"));
      if (proposed?.title !== stale.title) return;
      markStaleReached();
      await staleRelease;
    };

    const stalePublish = publishCanonicalWorkState(github, stale);
    await staleReached;
    await expect(publishCanonicalWorkState(github, worker)).resolves.toBe(true);
    releaseStale();
    await expect(stalePublish).resolves.toBe(false);
    github.__beforeRecoverySign = undefined;

    const current = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(current?.title).toBe("Causal root");
    expect(current?.state).toBe("state:working");
    expect(current?.metadata.execution.worker_id).toBe("wkr-b0057a9e");
    expect(current?.authority_sequence).toBe(1);
    expect(canonicalRequirements(current!)).toBe("## Outcome\nroot intent");
    expect(recoveryOrders(github, "work/18").filter((order) => order.endsWith("00000000000000000001"))).toHaveLength(1);
  });

  it("removes or reverses a d3 witness when protected base advances inside final create/rename mutation windows", async () => {
    const createRace = makeGithub();
    const createVariables = new AdvanceBaseOnRecoveryLeafMap();
    createRace.__authorityVariables = createVariables;
    createVariables.onLeaf = () => { createRace.__baseSha = NEXT_BASE; };
    createVariables.armed = true;

    await expect(publishDurableProtocolRecord(createRace, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: "final-create-race",
      unsignedBody: "must-not-commit-after-create-race",
      publicationTimestamp: Date.parse("2026-08-17T05:10:00.000Z"),
      authorityOrder: "2026-08-17T05:10:00.000Z",
    })).rejects.toThrow(/stale protected revision/);
    expect(recoveryScopes(createRace).has("final-create-race")).toBe(false);

    const renameRace = makeGithub();
    const renameVariables = new AdvanceBaseOnRecoveryLeafMap();
    renameRace.__authorityVariables = renameVariables;
    for (let index = 0; index < 8; index += 1) {
      renameVariables.set(`FUGUE_D3R_${String(index).padStart(2, "0")}`, "reserved-for-fugue-recovery-compaction");
    }
    renameVariables.set("FUGUE_D3GI_00", "reserved-for-fugue-recovery-mutation-guard");
    fillAuthorityCapacity(renameRace, "UNRELATED_FINAL_RACE_");
    const unrelatedBefore = [...renameVariables.keys()].filter((name) => name.startsWith("UNRELATED_FINAL_RACE_")).length;
    renameVariables.onLeaf = () => { renameRace.__baseSha = NEXT_BASE; };
    renameVariables.armed = true;

    await expect(publishDurableProtocolRecord(renameRace, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: "final-rename-race",
      unsignedBody: "must-not-commit-after-rename-race",
      publicationTimestamp: Date.parse("2026-08-17T05:11:00.000Z"),
      authorityOrder: "2026-08-17T05:11:00.000Z",
    })).rejects.toThrow(/stale protected revision/);
    expect(recoveryScopes(renameRace).has("final-rename-race")).toBe(false);
    expect([...renameVariables.keys()].filter((name) => name.startsWith("FUGUE_D3R_"))).toHaveLength(8);
    expect([...renameVariables.keys()].filter((name) => name.startsWith("UNRELATED_FINAL_RACE_")).length).toBe(unrelatedBefore);
    expect(renameVariables.size).toBe(500);
  });

  it("quarantines a mixed-validity recovery pack instead of compacting away its unverifiable sibling", async () => {
    const github = makeGithub();
    const { bucket, first, second } = sameBucketScopes();
    const firstOrder = "2026-08-17T05:20:00.000Z";
    const secondOrder = "2026-08-17T05:21:00.000Z";

    await publishDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: first,
      unsignedBody: `first-body:${first}`,
      publicationTimestamp: Date.parse(firstOrder),
      authorityOrder: firstOrder,
    });
    await publishDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: second,
      unsignedBody: `second-body:${second}`,
      publicationTimestamp: Date.parse(secondOrder),
      authorityOrder: secondOrder,
    });
    await compactFugueRecoveryAuthorityVariables(github);

    const pack = [...github.__authorityVariables.entries()].find(([name, value]) =>
      name.startsWith(`FUGUE_D3P_${bucket}_`) && value.includes(first) && value.includes(second));
    expect(pack).toBeDefined();
    const [packName, packValue] = pack!;
    expect(recoveryScopes(github)).toEqual(expect.objectContaining(new Set([first, second])));

    let failedSecond = false;
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockImplementation(async (candidateGithub, body, expected) => {
      if (!failedSecond && body.includes("<!-- fugue-durable-recovery") && body.includes(second)) {
        failedSecond = true;
        return false;
      }
      return defaultPublicationVerifier(candidateGithub, body, expected);
    });
    await compactFugueRecoveryAuthorityVariables(github);
    expect(failedSecond).toBe(true);
    expect(github.__authorityVariables.get(packName)).toBe(packValue);

    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockImplementation(defaultPublicationVerifier);
    const recoveredFirst = await recoverDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: first,
      issueNumber: 18,
      parse: (body) => body,
      timestamp: () => Date.parse(firstOrder),
      order: () => firstOrder,
    });
    const recoveredSecond = await recoverDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: second,
      issueNumber: 18,
      parse: (body) => body,
      timestamp: () => Date.parse(secondOrder),
      order: () => secondOrder,
    });
    expect(recoveredFirst.record?.body).toContain(`first-body:${first}`);
    expect(recoveredSecond.record?.body).toContain(`second-body:${second}`);
  });

  it("replays newer Coordinator intent by immutable issue revision even after a slower older publication timestamp", async () => {
    const github = makeGithub();
    const root = createCanonicalWorkState({
      issue: 18, title: "Coordinator root", state: "state:ready", agentReady: true,
      requirements: "## Outcome\nroot", metadata: metadata(false), pr: null, baseSha: BASE,
      createdAt: "2026-08-17T08:00:00.000Z", logicalRoot: true,
      coordinator: { issueUpdatedAt: "2026-08-17T07:00:00.000Z", eventSequence: 10, eventId: "e1" },
    });
    await publishCanonicalWorkState(github, root);
    const current = (await loadCurrentCanonicalWorkState(github, 18, BASE))!;
    const slowOldPublication = createCanonicalWorkState({
      issue: 18, title: current.title, state: "state:working", agentReady: current.agent_ready,
      requirements: canonicalRequirements(current), metadata: current.metadata, pr: current.pr, baseSha: BASE,
      createdAt: "2026-08-17T09:00:00.000Z", predecessor: current,
    });
    await publishCanonicalWorkState(github, slowOldPublication);

    const policy = { identity: { baseSha: BASE } } as unknown as ActivePolicy;
    await expect(ingestCoordinatorIssueEvent(github, policy, {
      eventName: "issues", action: "unlabeled", actor: "human", issueNumber: 18,
      label: "agent:ready", issueTitle: "Coordinator root", issueBody: "", issueLabels: ["state:working"],
      issueUpdatedAt: "2026-08-17T07:30:00.000Z", eventSequence: 11, eventId: "e2",
    }, true)).resolves.toBe(true);
    const applied = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(applied?.agent_ready).toBe(false);
    expect(applied?.coordinator_event_id).toBe("e2");
  });

  it("keeps final Authority witness fenced while stale cleanup races compaction and reserve recreation", async () => {
    const github = makeGithub();
    let raced = false;
    github.__beforeRevisionCheck = async () => {
      if (raced || ![...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3GT_"))) return;
      const target = [...github.__authorityVariables.keys()].find((name) => /^FUGUE_D3_[0-9A-F]{16}_[0-9A-F]{16}$/i.test(name));
      if (!target) return;
      raced = true;
      github.__baseSha = NEXT_BASE;
      await compactFugueRecoveryAuthorityVariables(github);
    };
    await expect(publishDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "guarded-create-race",
      unsignedBody: "must-not-survive-guard-race", publicationTimestamp: Date.parse("2026-08-17T08:10:00.000Z"),
      authorityOrder: "2026-08-17T08:10:00.000Z",
    })).rejects.toThrow(/stale protected revision/);
    github.__beforeRevisionCheck = undefined;
    expect(recoveryScopes(github).has("guarded-create-race")).toBe(false);
    expect([...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3GT_"))).toBe(false);
    expect(github.__authorityVariables.get("FUGUE_D3GI_00")).toMatch(
      /^reserved-for-fugue-recovery-mutation-guard(?::[0-9a-f]{32})?$/,
    );
    expect(github.__authorityVariables.get("FUGUE_D3R_00")).toBe("reserved-for-fugue-recovery-compaction");
  });

  it("invalidates a reader that passed idle immediately before a provisional writer acquires the guard", async () => {
    const github = makeGithub();
    const firstOrder = "2026-08-17T08:15:00.000Z";
    await publishDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "guard-precheck-reader",
      unsignedBody: "committed-before-race", publicationTimestamp: Date.parse(firstOrder), authorityOrder: firstOrder,
    });

    let releaseReader!: () => void;
    let readerReached!: () => void;
    const readerGate = new Promise<void>((resolve) => { releaseReader = resolve; });
    const readerPaused = new Promise<void>((resolve) => { readerReached = resolve; });
    let pausedOnce = false;
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockImplementation(async (candidateGithub, body, expected) => {
      const cursor = recoveryCursorBody(body);
      if (!pausedOnce && cursor?.scope === "guard-precheck-reader" && cursor.commit_witness === true) {
        pausedOnce = true;
        readerReached();
        await readerGate;
      }
      return defaultPublicationVerifier(candidateGithub, body, expected);
    });

    const reader = recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "guard-precheck-reader", issueNumber: 18,
      parse: (body) => body, timestamp: () => Date.parse(firstOrder), order: () => firstOrder,
    });
    await readerPaused;

    let releaseWriter!: () => void;
    let writerReached!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writerPaused = new Promise<void>((resolve) => { writerReached = resolve; });
    let writerHeld = false;
    github.__beforeRevisionCheck = async () => {
      if (writerHeld || ![...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3GT_"))) return;
      const provisional = [...github.__authorityVariables.keys()].some((name) =>
        /^FUGUE_D3_[0-9A-F]{16}_[0-9A-F]{16}$/i.test(name) &&
        recoveryCursorBody(github.__authorityVariables.get(name) ?? "")?.scope === "guard-precheck-reader");
      if (!provisional) return;
      writerHeld = true;
      writerReached();
      await writerGate;
    };
    const secondOrder = "2026-08-17T08:16:00.000Z";
    const writer = publishDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "guard-precheck-reader",
      unsignedBody: "provisional-must-never-be-observed", publicationTimestamp: Date.parse(secondOrder), authorityOrder: secondOrder,
    });
    await writerPaused;
    github.__baseSha = NEXT_BASE;
    releaseReader();
    await expect(reader).rejects.toBeInstanceOf(DurableProtocolRecoveryPendingError);
    releaseWriter();
    await expect(writer).rejects.toThrow(/stale protected revision/);
    github.__beforeRevisionCheck = undefined;
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockImplementation(defaultPublicationVerifier);
    expect(recoveryCheckpointBodies(github).some((body) => body.includes("provisional-must-never-be-observed"))).toBe(false);
  });

  it("recovers accepted QA and Human evidence from d3 after every presentation comment is deleted", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 }, qa: { controlPlaneChanged: true } } as unknown as EvaluationSnapshot;
    const session = reviewStartSchema.parse({ version: 1, kind: "review_start", session_id: "rev-code-durable1", role: "code", identity, fugue_version: "test", created_at: "2026-08-17T08:20:00.000Z" });
    const qa = qaAttestationSchema.parse({ version: 1, kind: "qa", attestation_id: "att-code-durable1", session_id: session.session_id, role: "code", identity, fugue_version: "test", verdict: "approved", created_at: "2026-08-17T08:21:00.000Z" });
    const human = humanControlPlaneAttestationSchema.parse({ version: 1, kind: "human_control_plane", attestation_id: "att-human-durable1", identity, fugue_version: "test", actor: "human", verdict: "acknowledged", created_at: "2026-08-17T08:22:00.000Z" });
    for (const value of [session, qa, human]) {
      await github.octokit.rest.issues.createComment({ owner: "JohnnyZLi", repo: "Fugue", issue_number: 19, body: serializeAttestation(value) });
    }
    const before = await currentReviewActivities(github, snapshot);
    expect(before.get("code")?.completed?.attestation_id).toBe(qa.attestation_id);
    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(true);
    github.__comments.splice(0);
    const after = await currentReviewActivities(github, snapshot);
    expect(after.get("code")?.completed?.attestation_id).toBe(qa.attestation_id);
    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(true);
    await expect(verifyHumanControlPlanePrerequisite(github, snapshot)).resolves.toMatchObject({
      attestation_id: human.attestation_id, verdict: "acknowledged",
    });
  });

  it("recovers a pre-POST crash without treating a nonexistent attempt as permanently pending", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "1".repeat(16));
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", "2".repeat(64));
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z",
    }));

    // Model process death immediately before the workflow-dispatch POST: no run exists anywhere.
    const recovered = await ensureIntegrationDispatch(github, snapshot, Date.parse("2026-08-17T08:41:00.000Z"));
    expect(recovered.dispatch).toBe(true);
    expect(recovered.request?.request_id).not.toBe(request.request_id);
    expect((await getCurrentIntegrationRecord(github, identity))?.request.request_id).toBe(recovered.request?.request_id);
  });

  it("keeps legitimate run L authoritative when later replay run A completes first", () => {
    const L = {
      runId: 4242,
      createdAt: "2026-08-17T08:30:10.000Z",
      htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4242",
    };
    const A = {
      runId: 4243,
      createdAt: "2026-08-17T08:30:20.000Z",
      htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4243",
    };
    // The request-local protected witness has already claimed exact L. Later replay/history is data,
    // not election authority, so A cannot lower/replace the first exact binding.
    const recovered = protectedIntegrationRecoveryDecision({
      requestCreatedAt: "2026-08-17T08:30:00.000Z",
      fenceCreatedAt: "2026-08-17T08:30:01.000Z",
      witness: L,
      now: Date.parse("2026-08-17T08:31:00.000Z"),
    });
    expect(recovered).toEqual({ kind: "bind", ...L });
    expect(recovered.kind === "bind" ? recovered.runId : 0).not.toBe(A.runId);
  });

  it("preserves legitimate pre-run-start failure when replay A completes before L", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "5".repeat(16));
    const secret = "6".repeat(64);
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", secret);
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z",
    }));
    const token = integrationDispatchRunToken(request.request_id, secret);
    const title = `Fugue Integration PR #19 ${request.request_id} ${token}`;
    const L = { id: 5252, actor: BOT, event: "workflow_dispatch", head_sha: BASE, display_title: title,
      created_at: "2026-08-17T08:30:10.000Z", run_attempt: 1, status: "completed", conclusion: "failure",
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/5252" };
    const A = { id: 5253, actor: BOT, event: "workflow_dispatch", head_sha: BASE, display_title: title,
      created_at: "2026-08-17T08:30:20.000Z", run_attempt: 1, status: "completed", conclusion: "failure",
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/5253" };
    github.__workflowRuns.push(L, A);

    // Model the primary synchronous return-details path binding exact L before any prepare/run-start
    // step. Replay A may finish first, but the exact d3 binding rejects it.
    await bindDispatchedIntegrationRun(github, snapshot, request.request_id, L.id, L.html_url, L.created_at);
    await expect(sealIntegrationWorkflowRunEvent(github, {
      eventName: "workflow_run", workflowName: "Fugue Integration", runId: A.id, runAttempt: 1,
      conclusion: A.conclusion, status: A.status, headSha: BASE, displayTitle: title,
      createdAt: A.created_at, htmlUrl: A.html_url, actor: BOT.login,
    })).resolves.toBe(false);
    await expect(sealIntegrationWorkflowRunEvent(github, {
      eventName: "workflow_run", workflowName: "Fugue Integration", runId: L.id, runAttempt: 1,
      conclusion: L.conclusion, status: L.status, headSha: BASE, displayTitle: title,
      createdAt: L.created_at, htmlUrl: L.html_url, actor: BOT.login,
    })).resolves.toBe(true);
    const terminal = await getCurrentIntegrationRecord(github, identity);
    expect(terminal?.run?.id).toBe(L.id);
    expect(terminal?.terminal?.state).toBe("failure");
  });

  it("rejects attacker-edited privileged QA and Human comments instead of inheriting the original author", async () => {
    const github = makeGithub();
    vi.mocked(completeReview).mockClear();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = {
      identity,
      pr: { number: 19 },
      qa: { required: [{ role: "code" }], controlPlaneChanged: true, validationControlChanged: false },
    } as unknown as EvaluationSnapshot;
    const session = reviewStartSchema.parse({
      version: 1, kind: "review_start", session_id: "rev-code-editproof1", role: "code", identity,
      fugue_version: "test", created_at: "2026-08-17T08:20:00.000Z",
    });
    github.__comments.push({
      id: 8800, node_id: "IC_8800", issueNumber: 19, body: serializeAttestation(session), user: BOT,
      created_at: "2026-08-17T08:20:00.000Z", updated_at: "2026-08-17T08:20:00.000Z",
    });
    const qaBody = `<!-- fugue-review-submit\nversion: 1\nsession_id: ${session.session_id}\nrole: code\nverdict: approved\nagents_update: not-required\nvalidation_control: acceptable\n-->`;
    github.__comments.push({
      ...immutableUserComment(8801, qaBody, "human"),
      updated_at: "2026-08-17T08:21:10.000Z",
      editedBy: "attacker-app",
    });
    const humanBody = `<!-- fugue-human-submit\nversion: 1\nkind: control_plane_ack\nidentity:\n  prNumber: 19\n  headSha: ${identity.headSha}\n  baseBranch: main\n  baseSha: ${BASE}\n  policyDigest: sha256:policy\n  protocolVersion: 1\n  issueNumber: 18\n  workId: work-18\n  workSpecDigest: sha256:spec\n-->`;
    github.__comments.push({
      ...immutableUserComment(8802, humanBody, "human"),
      updated_at: "2026-08-17T08:22:10.000Z",
      editedBy: "attacker-app",
    });

    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 1 });
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 1 });
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 0 });
    expect(vi.mocked(completeReview)).not.toHaveBeenCalled();
    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(false);
  });

  it("keeps exact witnessed L irreversible after run deletion and never lets later replay A replace it", () => {
    const L = { runId: 6262, createdAt: "2026-08-17T08:30:10.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/6262" };
    const A = { runId: 6263, createdAt: "2026-08-17T08:30:20.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/6263" };
    const result = protectedIntegrationRecoveryDecision({
      requestCreatedAt: "2026-08-17T08:30:00.000Z",
      fenceCreatedAt: "2026-08-17T08:30:01.000Z",
      witness: L,
      now: Date.parse("2026-08-17T09:00:00.000Z"),
    });
    expect(result).toEqual({ kind: "bind", ...L });
    expect(result.kind === "bind" ? result.runId : 0).not.toBe(A.runId);
  });

  it("makes >100 concurrent-deletion pagination and forged deployment/status records irrelevant to exact-run authority", () => {
    const L = { runId: 7000, createdAt: "2026-08-17T08:30:01.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/7000" };
    const mutableHistory = Array.from({ length: 151 }, (_, index) => ({
      runId: 7000 + index,
      forgedDeploymentUrl: `https://github.com/JohnnyZLi/Fugue/actions/runs/${1 + index}?fugue_request=public`,
    }));
    // Delete/reorder enough records to model a page shift while authoritative F/B state is unchanged.
    mutableHistory.splice(20, 100);
    mutableHistory.reverse();
    const result = protectedIntegrationRecoveryDecision({
      requestCreatedAt: "2026-08-17T08:30:00.000Z",
      fenceCreatedAt: "2026-08-17T08:30:00.500Z",
      witness: L,
      now: Date.parse("2026-08-17T09:00:00.000Z"),
    });
    expect(result).toEqual({ kind: "bind", ...L });
    expect(mutableHistory.length).toBe(51);
  });

  it("dedupes semantic hostile rejection variants in fixed-size durable progress", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 }, qa: { required: [], controlPlaneChanged: false } } as unknown as EvaluationSnapshot;
    for (let index = 0; index < 80; index += 1) {
      const body = index % 2 === 0
        ? `presentation ${index}\n<!-- fugue-review-submit\nversion: 1\nsession_id: rev-code-dead${String(index).padStart(4, "0")}\nrole: code\nverdict: changes_requested\nsummary: hostile variant ${index}\n-->`
        : `<!-- fugue-review-submit\n\nversion: 1\nsession_id: rev-code-beef${String(index).padStart(4, "0")}\nrole: code\nverdict: approved\nsummary: another presentation ${index}\n-->`;
      github.__comments.push(immutableUserComment(9000 + index, body));
    }
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 1 });
    const scope = `submission-rejection/19/${createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex").slice(0, 20)}`;
    const beforeOrders = recoveryOrders(github, scope);
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 0 });
    expect(recoveryOrders(github, scope)).toEqual(beforeOrders);
    for (let index = 80; index < 100; index += 1) {
      github.__comments.push(immutableUserComment(9000 + index,
        `<!-- fugue-review-submit\nversion: 1\nsession_id: rev-code-cafe${String(index).padStart(4, "0")}\nrole: code\nverdict: error\nsummary: fresh text ${index}\n-->`));
    }
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 0 });
    expect(recoveryOrders(github, scope)).toEqual(beforeOrders);
    const progressBodies = vi.mocked(signProtocolBody).mock.calls
      .map(([, body]) => body)
      .filter((body) => body.includes("fugue-submission-rejection-progress"));
    expect(progressBodies.some((body) => body.includes("version: 2") && body.includes("bloom_b64:"))).toBe(true);
    expect(progressBodies.filter((body) => body.includes("version: 2")).every((body) => body.length < 6000)).toBe(true);
  });

  it("never lets a legacy ID-only rejection receipt suppress a distinct legitimate current submission", async () => {
    const github = makeGithub();
    vi.mocked(completeReview).mockClear();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = {
      identity, pr: { number: 19 },
      qa: { required: [{ role: "code" }], controlPlaneChanged: false, validationControlChanged: false },
    } as unknown as EvaluationSnapshot;
    const session = reviewStartSchema.parse({
      version: 1, kind: "review_start", session_id: "rev-code-legacyproof1", role: "code", identity,
      fugue_version: "test", created_at: "2026-08-17T08:20:00.000Z",
    });
    github.__comments.push({
      id: 9300, node_id: "IC_9300", issueNumber: 19, body: serializeAttestation(session), user: BOT,
      created_at: "2026-08-17T08:20:00.000Z", updated_at: "2026-08-17T08:20:00.000Z",
    });
    github.__comments.push({
      id: 9301, node_id: "IC_9301", issueNumber: 19,
      body: `FUGUE SUBMISSION — REJECTED\n\nlegacy presentation\n\n<!-- fugue-submission-rejection\nversion: 1\ncomment_ids:\n  - 9400\n-->`,
      user: BOT, created_at: "2026-08-17T08:21:00.000Z", updated_at: "2026-08-17T08:21:00.000Z",
    });
    github.__comments.push(immutableUserComment(9400,
      `<!-- fugue-review-submit\nversion: 1\nsession_id: ${session.session_id}\nrole: code\nverdict: approved\nagents_update: not-required\nvalidation_control: acceptable\n-->`, "human"));

    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 1 });
    expect(vi.mocked(completeReview)).toHaveBeenCalledWith(
      github, 19, "code", expect.objectContaining({ verdict: "approved" }),
    );
  });



  it("terminalizes lost returned run identity as durable identity_lost and rejects later replay", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 19, headSha: "d".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T10:00:00.000Z", "a".repeat(16));
      const secret = "b".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T10:00:00.000Z", secret);
      let record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
        dispatch: authorized.authorization, createdAt: "2026-08-17T10:00:00.000Z",
      }));
      github.__authorityVariables.delete(authorized.electionName);
      const protectedFence = installProtectedFence(github, record, secret, "2026-08-17T10:00:01.000Z");

      // Model POST creating L, loss of the synchronous response/process, suppression of every
      // protected exact-run consumer, and Actions deletion of L before run-start. Only F survives.
      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T10:05:00.000Z"),
      )).resolves.toBe(true);
      expect((await getCurrentIntegrationRecord(github, identity))?.terminal).toBeNull();

      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T10:11:00.000Z"),
      )).resolves.toBe(true);
      record = (await getCurrentIntegrationRecord(github, identity))!;
      expect(record.run).toBeNull();
      expect(record.terminal).toMatchObject({
        state: "identity_lost",
        attempt: 1,
        boundary_created_at: "2026-08-17T10:00:01.000Z",
        fence_digest: `sha256:${createHash("sha256").update(protectedFence.raw, "utf8").digest("hex")}`,
      });
      expect(record.request.request_id).toBe(request.request_id);
      expect(record.identity).toEqual(identity);
      await expect(ensureIntegrationDispatch(github, snapshot, Date.parse("2026-08-17T10:30:00.000Z")))
        .resolves.toEqual({ request: record.request, dispatch: false });
      expect(github.__authorityVariables.has(protectedFence.names.fence)).toBe(false);
      expect(github.__authorityVariables.has(protectedFence.names.binding)).toBe(false);

      // delayed d3 exact binding cannot reopen identity_lost after terminal cleanup.
      await expect(bindDispatchedIntegrationRun(
        github, snapshot, request.request_id, 99003,
        "https://github.com/JohnnyZLi/Fugue/actions/runs/99003", "2026-08-17T10:20:01.000Z",
      )).rejects.toThrow(/active authorized durable request/);
      expect([...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_INT_C_"))).toBe(false);
      expect((await getCurrentIntegrationRecord(github, identity))?.terminal?.state).toBe("identity_lost");

      github.__comments.splice(0);
      github.__statuses.splice(0);
      github.__workflowRuns.splice(0);
      expect((await getCurrentIntegrationRecord(github, identity))?.terminal?.state).toBe("identity_lost");

      const A = {
        id: 99002, actor: BOT, event: "workflow_dispatch", head_sha: BASE,
        display_title: `Fugue Integration PR #19 ${request.request_id} ${protectedFence.runToken}`,
        created_at: "2026-08-17T10:20:00.000Z", run_attempt: 1, status: "completed", conclusion: "success",
        html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/99002",
      };
      github.__workflowRuns.push(A);
      await expect(sealIntegrationWorkflowRunEvent(github, {
        eventName: "workflow_run", workflowName: "Fugue Integration", runId: A.id, runAttempt: 1,
        conclusion: A.conclusion, status: A.status, headSha: BASE, displayTitle: A.display_title,
        createdAt: A.created_at, htmlUrl: A.html_url, actor: BOT.login,
      })).resolves.toBe(false);
      const afterReplay = await getCurrentIntegrationRecord(github, identity);
      expect(afterReplay?.run).toBeNull();
      expect(afterReplay?.terminal?.state).toBe("identity_lost");
    });
  });

  it("binds surviving protected exact L before identity_lost terminalization", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 20, headSha: "e".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 20 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T11:00:00.000Z", "c".repeat(16));
      const secret = "d".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T11:00:00.000Z", secret);
      const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
        dispatch: authorized.authorization, createdAt: "2026-08-17T11:00:00.000Z",
      }));
      github.__authorityVariables.delete(authorized.electionName);
      const protectedFence = installProtectedFence(github, record, secret, "2026-08-17T11:00:01.000Z");
      const htmlUrl = installProtectedBinding(github, record, protectedFence.fence, 99101, "2026-08-17T11:00:02.000Z");

      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T11:30:00.000Z"),
      )).resolves.toBe(true);
      const bound = await getCurrentIntegrationRecord(github, identity);
      expect(bound?.run).toMatchObject({ id: 99101, attempt: 1, html_url: htmlUrl });
      expect(bound?.terminal).toBeNull();

      // W bound exact L into d3 first; a stale T proposal with run:null can never clear it.
      const staleTerminalAt = new Date(Date.parse(bound!.created_at) + 1).toISOString();
      await expect(publishIntegrationRecord(github, {
        ...(bound!),
        run: null,
        terminal: {
          state: "identity_lost", attempt: 1,
          boundary_created_at: protectedFence.fence.created_at as string,
          fence_digest: `sha256:${createHash("sha256").update(protectedFence.raw, "utf8").digest("hex")}`,
          detail: "stale terminalizer must not clear exact L", created_at: staleTerminalAt,
        },
        created_at: staleTerminalAt,
      } as IntegrationRecord)).rejects.toThrow(/cannot clear protected run/);
      expect((await getCurrentIntegrationRecord(github, identity))?.run?.id).toBe(99101);
      expect([...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_INT_C_"))).toBe(false);
      expect(github.__authorityVariables.has(protectedFence.names.fence)).toBe(false);
      expect(github.__authorityVariables.has(protectedFence.names.binding)).toBe(false);
    });
  });

  it("converges an F-only pre-POST ambiguity deterministically instead of remaining unresolved", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 21, headSha: "1".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 21 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T12:00:00.000Z", "e".repeat(16));
      const secret = "f".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T12:00:00.000Z", secret);
      const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
        dispatch: authorized.authorization, createdAt: "2026-08-17T12:00:00.000Z",
      }));
      github.__authorityVariables.delete(authorized.electionName);
      installProtectedFence(github, record, secret, "2026-08-17T12:00:01.000Z");

      for (let index = 0; index < 8; index += 1) {
        await expect(recoverExistingProtectedIntegration(
          github, snapshot, Date.parse("2026-08-17T12:05:00.000Z"),
        )).resolves.toBe(true);
        expect((await getCurrentIntegrationRecord(github, identity))?.terminal).toBeNull();
      }
      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T12:11:00.000Z"),
      )).resolves.toBe(true);
      const firstTerminal = (await getCurrentIntegrationRecord(github, identity))!;
      expect(firstTerminal.terminal?.state).toBe("identity_lost");
      for (let index = 0; index < 12; index += 1) {
        await expect(recoverExistingProtectedIntegration(
          github, snapshot, Date.parse("2026-08-17T12:30:00.000Z") + index,
        )).resolves.toBe(true);
        expect(await getCurrentIntegrationRecord(github, identity)).toEqual(firstTerminal);
      }
    });
  });

  it("reclaims Authority slots across more than 64 sequential identity_lost requests", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      for (let index = 0; index < 65; index += 1) {
        const identity = {
          prNumber: 100 + index,
          headSha: index.toString(16).padStart(40, "0"), baseBranch: "main", baseSha: BASE,
          policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 1000 + index,
          workId: `work-${1000 + index}`, workSpecDigest: "sha256:revised-spec",
        };
        const snapshot = { identity, pr: { number: identity.prNumber } } as unknown as EvaluationSnapshot;
        const nonce = index.toString(16).padStart(16, "0");
        const request = createIntegrationRequest(identity, "2026-08-17T13:00:00.000Z", nonce);
        const secret = (index + 1).toString(16).padStart(64, "0");
        const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T13:00:00.000Z", secret);
        const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
          dispatch: authorized.authorization, createdAt: "2026-08-17T13:00:00.000Z",
        }));
        github.__authorityVariables.delete(authorized.electionName);
        installProtectedFence(github, record, secret, "2026-08-17T13:00:01.000Z");
        await recoverExistingProtectedIntegration(github, snapshot, Date.parse("2026-08-17T13:11:00.000Z"));
        expect((await getCurrentIntegrationRecord(github, identity))?.terminal?.state).toBe("identity_lost");
        const transient = [...github.__authorityVariables.keys()].filter((name) =>
          /^FUGUE_INT_[ABCFS]_/.test(name));
        expect(transient).toEqual([]);
      }
    });
  }, 30000);

  it("resumes crash-interrupted identity_lost cleanup without changing terminal authority", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 22, headSha: "2".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 22 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T14:00:00.000Z", "1".repeat(16));
      const secret = "2".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T14:00:00.000Z", secret);
      let record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
        dispatch: authorized.authorization, createdAt: "2026-08-17T14:00:00.000Z",
      }));
      github.__authorityVariables.delete(authorized.electionName);
      const protectedFence = installProtectedFence(github, record, secret, "2026-08-17T14:00:01.000Z");

      // Simulate the exact crash boundary: request-local identity_lost serialization and d3
      // terminal authority have committed, but none of the transient F/A/B/S/C cleanup has run.
      const terminalAt = new Date(Date.parse(record.created_at) + 11 * 60 * 1000).toISOString();
      const fenceDigest = `sha256:${createHash("sha256").update(protectedFence.raw, "utf8").digest("hex")}`;
      const terminalRecord: IntegrationRecord = {
        ...record,
        dispatch_started_at: protectedFence.fence.created_at as string,
        run: null,
        terminal: {
          state: "identity_lost", attempt: 1,
          boundary_created_at: protectedFence.fence.created_at as string,
          fence_digest: fenceDigest,
          detail: "simulated post-commit cleanup crash", created_at: terminalAt,
        },
        created_at: terminalAt,
      };
      await claimIdentityLostIntegrationCommit(github, {
        requestId: record.request.request_id,
        prNumber: identity.prNumber,
        headSha: identity.headSha,
        baseSha: identity.baseSha,
        anchorName: authorized.authorization.anchor_name,
      }, {
        boundaryCreatedAt: protectedFence.fence.created_at as string,
        fenceDigest,
        createdAt: terminalAt,
      });
      await publishDurableProtocolRecord(github, {
        storageSha: identity.headSha,
        publisherSha: identity.baseSha,
        scope: `integration/${identity.prNumber}`,
        unsignedBody: `${serializeIntegrationRecord(terminalRecord)}\n\nINTEGRATION RECORD — CANONICAL`,
        publicationTimestamp: Date.parse(terminalAt),
        authorityOrder: terminalAt,
      });
      record = terminalRecord;
      expect(github.__authorityVariables.has(protectedFence.names.fence)).toBe(true);
      const durableBefore = await getCurrentIntegrationRecord(github, identity);

      // Model partial cleanup/late redundant B, then let reconciliation finish idempotently.
      installProtectedBinding(github, record, protectedFence.fence, 99222, "2026-08-17T14:00:02.000Z");
      github.__authorityVariables.delete(protectedFence.names.fence);
      await expect(cleanupTerminalProtectedIntegrationRecovery(github, snapshot)).resolves.toBe(true);
      expect(github.__authorityVariables.has(protectedFence.names.binding)).toBe(false);
      expect(await getCurrentIntegrationRecord(github, identity)).toEqual(durableBefore);
      await expect(cleanupTerminalProtectedIntegrationRecovery(github, snapshot)).resolves.toBe(true);
      expect(await getCurrentIntegrationRecord(github, identity)).toEqual(durableBefore);
    });
  });


  it("preserves hosted fresh-request recovery for a genuinely aborted no-fence transport", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 23, headSha: "3".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 23 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T15:00:00.000Z", "3".repeat(16));
      const aborted = await publishIntegrationRecord(github, createIntegrationRecord(request, {
        terminal: { state: "aborted", detail: "provably no protected attempt-1 run was created", created_at: "2026-08-17T15:11:00.000Z" },
        createdAt: "2026-08-17T15:11:00.000Z",
      }));

      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T15:12:00.000Z"),
      )).resolves.toBe(false);
      const next = await ensureIntegrationDispatch(github, snapshot, Date.parse("2026-08-17T15:12:00.000Z"));
      expect(next.dispatch).toBe(true);
      expect(next.request?.request_id).not.toBe(aborted.request.request_id);
      expect((await getCurrentIntegrationRecord(github, identity))?.request.request_id).toBe(next.request?.request_id);
    });
  });

});


describe("durable known-run cleanup restart completeness", () => {
  async function seedBound(
    github: TestGithub,
    prNumber: number,
    nonce: string,
    runId: number,
  ): Promise<{ snapshot: EvaluationSnapshot; record: IntegrationRecord; names: string[] }> {
    const identity = {
      prNumber,
      headSha: prNumber.toString(16).padStart(40, "0"),
      baseBranch: "main",
      baseSha: BASE,
      policyDigest: "sha256:policy",
      protocolVersion: 1 as const,
      issueNumber: 5000 + prNumber,
      workId: `work-${5000 + prNumber}`,
      workSpecDigest: "sha256:revised-spec",
    };
    const snapshot = { identity, pr: { number: prNumber } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-18T14:00:00.000Z", nonce);
    const secret = runId.toString(16).padStart(64, "0");
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-18T14:00:00.000Z", secret);
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization,
      createdAt: "2026-08-18T14:00:00.000Z",
    }));
    github.__authorityVariables.delete(authorized.electionName);
    const htmlUrl = `https://github.com/JohnnyZLi/Fugue/actions/runs/${runId}`;
    const record = await bindDispatchedIntegrationRun(
      github, snapshot, request.request_id, runId, htmlUrl, "2026-08-18T14:00:02.000Z",
    );
    const recovery = protectedRecoveryNames(request.request_id);
    return {
      snapshot,
      record,
      names: [
        recovery.fence,
        record.dispatch!.anchor_name,
        recovery.binding,
        integrationRunStartVariableName(record.request),
        integrationCommitVariableName(record.request.request_id),
      ],
    };
  }

  function recreateTransientCut(github: TestGithub, names: string[], deletedPrefix: number): void {
    names.forEach((name, index) => github.__authorityVariables.set(name, `stale-${index}`));
    for (let index = 0; index < deletedPrefix; index += 1) github.__authorityVariables.delete(names[index]!);
  }

  it("resumes every F/A/B/S-before-C crash cut for a durable exact L without changing L", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const seeded = await seedBound(github, 301, "0000000000000301", 99301);
      for (const deletedPrefix of [1, 2, 3, 4]) {
        recreateTransientCut(github, seeded.names, deletedPrefix);
        await expect(cleanupTerminalProtectedIntegrationRecovery(github, seeded.snapshot)).resolves.toBe(true);
        expect(seeded.names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
        const durable = await getCurrentIntegrationRecord(github, seeded.snapshot.identity);
        expect(durable?.run?.id).toBe(99301);
        expect(durable?.terminal).toBeNull();
      }
    });
  });

  it("resumes every cleanup cut for terminal known-L failure and cancelled-as-error without retry", async () => {
    await withHostedAuthority(async () => {
      for (const [offset, state, detail] of [
        [0, "failure", "Protected attempt 1 failed."],
        [1, "error", "Protected attempt 1 completed cancelled; a known attempt is never retryable transport."],
      ] as const) {
        const github = makeGithub();
        const seeded = await seedBound(github, 310 + offset, `000000000000031${offset}`, 99410 + offset);
        const terminalAt = "2026-08-18T14:10:00.000Z";
        const terminal = await publishIntegrationRecord(github, {
          ...seeded.record,
          terminal: { state, detail, created_at: terminalAt },
          created_at: terminalAt,
        });
        for (const deletedPrefix of [1, 2, 3, 4]) {
          recreateTransientCut(github, seeded.names, deletedPrefix);
          github.__workflowRuns.splice(0);
          github.__comments.splice(0);
          github.__statuses.splice(0);
          await expect(cleanupTerminalProtectedIntegrationRecovery(github, seeded.snapshot)).resolves.toBe(true);
          expect(seeded.names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
          const durable = await getCurrentIntegrationRecord(github, seeded.snapshot.identity);
          expect(durable?.run?.id).toBe(terminal.run?.id);
          expect(durable?.terminal).toEqual(terminal.terminal);
          await expect(ensureIntegrationDispatch(github, seeded.snapshot, Date.parse("2026-08-18T15:00:00.000Z")))
            .resolves.toEqual({ request: terminal.request, dispatch: false });
        }
      }
    });
  });

  it("reclaims delayed S and B producers from durable binding alone after earlier cleanup completed", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const seeded = await seedBound(github, 320, "0000000000000320", 99520);
      github.__authorityVariables.set(seeded.names[3]!, "late-run-start");
      github.__authorityVariables.set(seeded.names[2]!, "late-binding-witness");
      github.__workflowRuns.splice(0);
      github.__comments.splice(0);
      github.__statuses.splice(0);
      await expect(recoverExistingProtectedIntegration(github, seeded.snapshot, Date.parse("2026-08-18T14:30:00.000Z")))
        .resolves.toBe(true);
      expect(seeded.names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      expect((await getCurrentIntegrationRecord(github, seeded.snapshot.identity))?.run?.id).toBe(99520);
    });
  });

  it("does not exhaust Authority capacity across more than 64 interrupted known-run generations", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      for (let index = 0; index < 65; index += 1) {
        const prNumber = 400 + index;
        const seeded = await seedBound(github, prNumber, index.toString(16).padStart(16, "0"), 99600 + index);
        recreateTransientCut(github, seeded.names, 3);
        await expect(cleanupTerminalProtectedIntegrationRecovery(github, seeded.snapshot)).resolves.toBe(true);
        expect(seeded.names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      }
      const transient = [...github.__authorityVariables.keys()].filter((name) => /^FUGUE_INT_[ABCFS]_/.test(name));
      expect(transient).toEqual([]);
    });
  }, 30000);
});


describe("historical Integration transient cleanup across evaluation drift", () => {
  async function seedHistoricalBound(github: TestGithub, prNumber: number, headChar: string, nonce: string, runId: number) {
    const identity = {
      prNumber, headSha: headChar.length === 1 ? headChar.repeat(40) : headChar, baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 7000 + prNumber,
      workId: `work-${7000 + prNumber}`, workSpecDigest: `sha256:spec-${headChar}`,
    };
    const snapshot = { identity, pr: { number: prNumber } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-18T18:00:00.000Z", nonce);
    const secret = runId.toString(16).padStart(64, "0");
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-18T18:00:00.000Z", secret);
    const anchorBody = github.__authorityVariables.get(authorized.authorization.anchor_name)!;
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-18T18:00:00.000Z",
    }));
    github.__authorityVariables.delete(authorized.electionName);
    const htmlUrl = `https://github.com/JohnnyZLi/Fugue/actions/runs/${runId}`;
    const record = await bindDispatchedIntegrationRun(github, snapshot, request.request_id, runId, htmlUrl, "2026-08-18T18:00:02.000Z");
    return { identity, snapshot, request, secret, anchorBody, record, runId, htmlUrl };
  }

  async function installValidHistoricalTransients(github: TestGithub, seeded: Awaited<ReturnType<typeof seedHistoricalBound>>) {
    const { record, request, secret, runId, htmlUrl, anchorBody } = seeded;
    const suffix = createHash("sha256").update(request.request_id, "utf8").digest("hex").slice(0, 32).toUpperCase();
    const runToken = integrationDispatchRunToken(request.request_id, secret);
    const fenceName = `FUGUE_INT_F_${suffix}`;
    const bindingName = `FUGUE_INT_B_${suffix}`;
    const commitName = integrationCommitVariableName(request.request_id);
    const startName = integrationRunStartVariableName(request);
    const fence = {
      version: 1, kind: "integration_dispatch_fence", request_id: request.request_id,
      pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
      anchor_name: record.dispatch!.anchor_name, secret_digest: record.dispatch!.secret_digest,
      run_token: runToken, authority_actor_id: 123456, created_at: "2026-08-18T18:00:01.000Z",
    };
    const binding = {
      version: 1, kind: "integration_binding_witness", request_id: request.request_id,
      pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
      anchor_name: record.dispatch!.anchor_name, run_token: runToken, authority_actor_id: 123456,
      run_id: runId, run_attempt: 1, run_created_at: record.run!.created_at, html_url: htmlUrl,
    };
    const start = await signProtocolBody(github, serializeIntegrationRunStartEvidence({
      version: 1, kind: "integration_run_start", request_id: request.request_id,
      pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
      secret_digest: record.dispatch!.secret_digest, anchor_name: record.dispatch!.anchor_name,
      run_id: runId, run_attempt: 1, created_at: record.run!.created_at,
    }));
    const commit = {
      version: 1, kind: "integration_exact_run_commit", request_id: request.request_id,
      pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
      anchor_name: record.dispatch!.anchor_name, run_id: runId, run_attempt: 1,
      run_created_at: record.run!.created_at, html_url: htmlUrl,
    };
    github.__authorityVariables.set(fenceName, JSON.stringify(fence));
    github.__authorityVariables.set(record.dispatch!.anchor_name, anchorBody);
    github.__authorityVariables.set(bindingName, JSON.stringify(binding));
    github.__authorityVariables.set(startName, start);
    github.__authorityVariables.set(commitName, JSON.stringify(commit));
    return [fenceName, record.dispatch!.anchor_name, bindingName, startName, commitName];
  }

  function currentIdentityFor(seeded: Awaited<ReturnType<typeof seedHistoricalBound>>, headChar: string) {
    return { ...seeded.identity, headSha: headChar.length === 1 ? headChar.repeat(40) : headChar, workSpecDigest: `sha256:spec-${headChar}` };
  }

  it("reclaims every H1 F/A/B/S-before-C crash cut after H2 drift while preserving H1 exact L", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const seeded = await seedHistoricalBound(github, 501, "1", "0000000000000501", 120501);
      const h2 = currentIdentityFor(seeded, "2");
      const before = await getCurrentIntegrationRecord(github, seeded.identity);
      for (const deletedPrefix of [1, 2, 3, 4]) {
        const names = await installValidHistoricalTransients(github, seeded);
        for (let index = 0; index < deletedPrefix; index += 1) github.__authorityVariables.delete(names[index]!);
        github.__workflowRuns.splice(0);
        github.__comments.splice(0);
        await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [h2]);
        expect(names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
        expect(await getCurrentIntegrationRecord(github, seeded.identity)).toEqual(before);
      }
    });
  });

  it("reclaims historical known-L failure/error/cancelled-as-error and preserves terminal evidence", async () => {
    await withHostedAuthority(async () => {
      for (const [offset, state, detail] of [
        [0, "failure", "known attempt failed"],
        [1, "error", "known attempt errored"],
        [2, "error", "Protected attempt 1 completed cancelled; a known attempt is never retryable transport."],
      ] as const) {
        const github = makeGithub();
        const seeded = await seedHistoricalBound(github, 510 + offset, "3", `000000000000051${offset}`, 120510 + offset);
        const terminalAt = "2026-08-18T18:10:00.000Z";
        const terminal = await publishIntegrationRecord(github, {
          ...seeded.record, terminal: { state, detail, created_at: terminalAt }, created_at: terminalAt,
        });
        const names = await installValidHistoricalTransients(github, { ...seeded, record: terminal });
        github.__workflowRuns.splice(0);
        github.__comments.splice(0);
        github.__statuses.splice(0);
        await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [currentIdentityFor(seeded, "4")]);
        expect(names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
        const durable = await getCurrentIntegrationRecord(github, seeded.identity);
        expect(durable?.run?.id).toBe(seeded.runId);
        expect(durable?.terminal).toEqual(terminal.terminal);
      }
    });
  });

  it("reclaims historical identity_lost without creating retryable aborted", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 520, headSha: "5".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 7520,
        workId: "work-7520", workSpecDigest: "sha256:spec-5",
      };
      const snapshot = { identity, pr: { number: 520 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-18T18:00:00.000Z", "0000000000000520");
      const secret = "5".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-18T18:00:00.000Z", secret);
      const anchorBody = github.__authorityVariables.get(authorized.authorization.anchor_name)!;
      const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, { dispatch: authorized.authorization, createdAt: "2026-08-18T18:00:00.000Z" }));
      github.__authorityVariables.delete(authorized.electionName);
      const fence = installProtectedFence(github, record, secret, "2026-08-18T18:00:01.000Z");
      await recoverExistingProtectedIntegration(github, snapshot, Date.parse("2026-08-18T18:11:00.000Z"));
      const terminal = (await getCurrentIntegrationRecord(github, identity))!;
      expect(terminal.terminal?.state).toBe("identity_lost");
      github.__authorityVariables.set(fence.names.fence, fence.raw);
      github.__authorityVariables.set(authorized.authorization.anchor_name, anchorBody);
      github.__authorityVariables.set(integrationCommitVariableName(request.request_id), JSON.stringify({
        version: 1, kind: "integration_identity_lost_commit", request_id: request.request_id,
        pr_number: identity.prNumber, head_sha: identity.headSha, base_sha: identity.baseSha,
        anchor_name: authorized.authorization.anchor_name, attempt: 1,
        boundary_created_at: terminal.terminal!.state === "identity_lost" ? terminal.terminal.boundary_created_at : "",
        fence_digest: terminal.terminal!.state === "identity_lost" ? terminal.terminal.fence_digest : "",
        created_at: terminal.terminal!.created_at,
      }));
      // Protected B/S writers may have passed earlier checks before terminal cleanup and reappear later.
      installProtectedBinding(github, terminal, fence.fence, 120520, "2026-08-18T18:12:00.000Z");
      const lateStart = await signProtocolBody(github, serializeIntegrationRunStartEvidence({
        version: 1, kind: "integration_run_start", request_id: request.request_id,
        pr_number: identity.prNumber, head_sha: identity.headSha, base_sha: identity.baseSha,
        secret_digest: terminal.dispatch!.secret_digest, anchor_name: terminal.dispatch!.anchor_name,
        run_id: 120521, run_attempt: 1, created_at: "2026-08-18T18:12:01.000Z",
      }));
      github.__authorityVariables.set(integrationRunStartVariableName(request), lateStart);
      const names = [
        fence.names.fence,
        authorized.authorization.anchor_name,
        fence.names.binding,
        integrationRunStartVariableName(request),
        integrationCommitVariableName(request.request_id),
      ];
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [{ ...identity, headSha: "6".repeat(40), workSpecDigest: "sha256:spec-6" }]);
      expect(names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      expect((await getCurrentIntegrationRecord(github, identity))?.terminal?.state).toBe("identity_lost");
    });
  });

  it("reclaims late historical B/S on the next pass and never touches the current active request", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const h1 = await seedHistoricalBound(github, 530, "7", "0000000000000530", 120530);
      const h2Identity = currentIdentityFor(h1, "8");
      const h2Request = createIntegrationRequest(h2Identity, "2026-08-18T18:20:00.000Z", "1000000000000530");
      const h2Secret = "8".repeat(64);
      const h2Authorized = await authorizeIntegrationDispatch(github, h2Request, "2026-08-18T18:20:00.000Z", h2Secret);
      const h2Record = await publishIntegrationRecord(github, createIntegrationRecord(h2Authorized.request, { dispatch: h2Authorized.authorization, createdAt: "2026-08-18T18:20:00.000Z" }));
      github.__authorityVariables.delete(h2Authorized.electionName);
      const h2Anchor = h2Record.dispatch!.anchor_name;
      const h2AnchorValue = github.__authorityVariables.get(h2Anchor);

      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [h2Identity]);
      const h1Names = await installValidHistoricalTransients(github, h1);
      // Simulate cleanup already passed F/A and a delayed B/S producer appearing afterward.
      github.__authorityVariables.delete(h1Names[0]!);
      github.__authorityVariables.delete(h1Names[1]!);
      github.__authorityVariables.delete(h1Names[4]!);
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:31:00.000Z"), [h2Identity]);
      expect(github.__authorityVariables.has(h1Names[2]!)).toBe(false);
      expect(github.__authorityVariables.has(h1Names[3]!)).toBe(false);
      expect(github.__authorityVariables.get(h2Anchor)).toBe(h2AnchorValue);
      expect((await getCurrentIntegrationRecord(github, h2Identity))?.request.request_id).toBe(h2Request.request_id);
    });
  });

  it("does not exhaust transient capacity across more than 64 interrupted head-drift generations", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const currentIdentity = {
        prNumber: 540, headSha: "f".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 7540,
        workId: "work-7540", workSpecDigest: "sha256:spec-current",
      };
      for (let index = 0; index < 65; index += 1) {
        const headChar = index.toString(16).padStart(40, "0");
        const seeded = await seedHistoricalBound(github, 540, headChar, index.toString(16).padStart(16, "0"), 121000 + index);
        const names = await installValidHistoricalTransients(github, seeded);
        github.__authorityVariables.delete(names[0]!);
        github.__authorityVariables.delete(names[1]!);
        github.__authorityVariables.delete(names[2]!);
        await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T19:00:00.000Z") + index, [currentIdentity]);
        expect(names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      }
      expect([...github.__authorityVariables.keys()].filter((name) => /^FUGUE_INT_[ABCFS]_/.test(name))).toEqual([]);
    });
  }, 30000);

  it("never turns a historical may-have-dispatched ambiguity into retryable aborted during scavenging", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 550, headSha: "9".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 7550,
        workId: "work-7550", workSpecDigest: "sha256:spec-9",
      };
      const request = createIntegrationRequest(identity, "2026-08-18T18:00:00.000Z", "0000000000000550");
      const secret = "9".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-18T18:00:00.000Z", secret);
      const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, { dispatch: authorized.authorization, createdAt: "2026-08-18T18:00:00.000Z" }));
      github.__authorityVariables.delete(authorized.electionName);
      installProtectedFence(github, record, secret, "2026-08-18T18:00:01.000Z");
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [{ ...identity, headSha: "a".repeat(40), workSpecDigest: "sha256:spec-a" }]);
      const historical = await getCurrentIntegrationRecord(github, identity);
      expect(historical?.terminal?.state).toBe("identity_lost");
      expect(historical?.terminal?.state).not.toBe("aborted");
    });
  });
});
