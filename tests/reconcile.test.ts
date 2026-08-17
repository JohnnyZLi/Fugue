import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EvaluationSnapshot } from "../src/core/evaluation.js";
import type { FugueGitHub } from "../src/core/github.js";
import { verifyDependenciesSatisfied } from "../src/core/gates.js";
import {
  createIntegrationRequest,
  integrationRunTitle,
  serializeIntegrationRequest,
} from "../src/core/integration-plan.js";
import {
  currentIntegrationState,
  findIntegrationWorkflowRun,
  INTEGRATION_REQUEST_RECOVERY_GRACE_MS,
} from "../src/core/integration-status.js";
import { upsertWorkMetadata, workMetadataSchema } from "../src/core/metadata.js";
import type { ActivePolicy } from "../src/core/policy.js";
import { FUGUE_PROTOCOL_ACTOR } from "../src/core/provenance.js";
import {
  allocateWorker,
  assertProtectedWorkflowRuntimeCurrent,
  coordinatorIssueEventFromEnvironment,
  dispatchIntegration,
  ingestCoordinatorIssueEvent,
} from "../src/core/reconcile.js";
import { renderStateComment, upsertStateComment } from "../src/core/state-comment.js";
import {
  canonicalRequirements,
  createCanonicalWorkState,
  encodeWorkStateBundle,
  loadCurrentCanonicalWorkState,
  loadReusableCanonicalWorkState,
  parseCanonicalWorkState,
  publishCanonicalWorkState,
  repairCanonicalWorkStateComments,
  serializeCanonicalWorkState,
  type CanonicalWorkState,
  type WorkState,
} from "../src/core/state.js";
import { planWork, type WorkflowObservation } from "../src/core/workflow.js";

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  return {
    ...actual,
    isTrustedProtocolComment: vi.fn(async (_github: FugueGitHub, comment: { user?: { login?: string | null } | null }) =>
      comment.user?.login === "github-actions[bot]"),
    verifyProtocolPublicationBodyAtRevision: vi.fn(async (
      _github: FugueGitHub,
      body: string,
      expectedSha: string,
    ) => body.includes(`proof-sha:${expectedSha}`)),
    readRepositoryDefaultBranchIdentity: vi.fn(async (github: FugueGitHub) => ({
      branch: "main",
      sha: (github as unknown as TestGitHub).__defaultSha ?? BASE,
    })),
    assertRepositoryDefaultBranchRevision: vi.fn(async (github: FugueGitHub, expectedSha: string) => {
      const actualSha = (github as unknown as TestGitHub).__defaultSha ?? expectedSha;
      if (actualSha !== expectedSha) throw new Error(`stale base ${actualSha}`);
    }),
    createProtocolComment: vi.fn(async (github: FugueGitHub, issueNumber: number, body: string) => {
      const publisherSha = (github as unknown as TestGitHub).__publisherSha ?? BASE;
      const signed = `${body}\n\nproof-sha:${publisherSha}`;
      const response = await github.octokit.rest.issues.createComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
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
    }),
    updateProtocolComment: vi.fn(async (github: FugueGitHub, commentId: number, body: string) => {
      const response = await github.octokit.rest.issues.updateComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        comment_id: commentId,
        body,
      });
      return { data: { id: response.data.id, html_url: response.data.html_url, body: response.data.body ?? body } };
    }),
  };
});

const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;
const BASE = "b".repeat(40);
const NEXT_BASE = "c".repeat(40);
const OLD_BASE = "d".repeat(40);
const HEAD = "a".repeat(40);

function canonicalWork(createdAt = "2026-08-16T20:00:00.000Z", requirements = "## Outcome\nProtected truth"): CanonicalWorkState {
  const metadata = workMetadataSchema.parse({
    version: 1,
    work_id: "work-18",
    spec: {
      dependencies: [],
      ownership: { owned: ["src/**"], coordinate: [], forbidden: [] },
      qa: { force: ["code"] },
      authorized_changes: { agents_invariants: [] },
    },
    execution: { worker_id: "wkr-12345678", branch: "agent/18-chat-first" },
  });
  return createCanonicalWorkState({
    issue: 18,
    title: "Chat-first orchestration",
    state: "state:working",
    agentReady: true,
    requirements,
    metadata,
    pr: {
      number: 21,
      draft: true,
      metadata: { version: 1, work_id: "work-18", issue: 18, worker_id: "wkr-12345678", branch: "agent/18-chat-first" },
    },
    baseSha: BASE,
    createdAt,
  });
}

function work(): WorkState {
  const canonical = canonicalWork();
  return {
    issueNumber: 18,
    title: canonical.title,
    url: "https://github.com/JohnnyZLi/Fugue/issues/18",
    stateLabel: canonical.state,
    agentReady: canonical.agent_ready,
    metadata: canonical.metadata,
    requirements: canonicalRequirements(canonical),
    workSpecDigest: "sha256:spec",
    pr: {
      number: 21,
      url: "https://github.com/JohnnyZLi/Fugue/pull/21",
      headSha: HEAD,
      headBranch: "agent/18-chat-first",
      draft: true,
      metadata: canonical.pr!.metadata,
    },
    drift: [],
    presentationDrift: [],
    canonical,
  };
}

function readyWork(): WorkState {
  const item = work();
  const metadata = { ...item.metadata, execution: {} };
  const canonical = createCanonicalWorkState({
    issue: 18,
    title: item.title,
    state: "state:ready",
    agentReady: true,
    requirements: item.requirements,
    metadata,
    baseSha: BASE,
  });
  return { ...item, stateLabel: "state:ready", metadata, pr: null, canonical };
}

function policy(baseSha = BASE): ActivePolicy {
  return {
    identity: { baseBranch: "main", baseSha, policyDigest: "sha256:policy", protocolVersion: 1 },
    config: { branches: { worker_pattern: "agent/{issue}-{slug}" } },
  } as unknown as ActivePolicy;
}

function snapshot(): EvaluationSnapshot {
  return {
    identity: {
      prNumber: 21,
      headSha: HEAD,
      baseBranch: "main",
      baseSha: BASE,
      policyDigest: "sha256:policy",
      protocolVersion: 1,
      issueNumber: 18,
      workId: "work-18",
      workSpecDigest: "sha256:spec",
    },
    pr: { number: 21 },
  } as unknown as EvaluationSnapshot;
}

function observation(overrides: Partial<WorkflowObservation> = {}): WorkflowObservation {
  return {
    issueNumber: 18,
    workId: "work-18",
    stateLabel: "state:working",
    workerClaimed: true,
    hasPr: true,
    prNumber: 21,
    prDraft: true,
    drift: [],
    ownership: "passed",
    ci: "success",
    baseCurrent: true,
    qa: [
      { role: "code", state: "none", supersededSessions: 0 },
      { role: "security", state: "none", supersededSessions: 0 },
    ],
    controlPlaneChanged: false,
    humanControlPlaneAcknowledged: false,
    integration: "none",
    ...overrides,
  };
}

describe("chat-first reconciliation planning", () => {
  it("waits for CI and sequences Code QA before Security QA", () => {
    expect(planWork(observation({ ci: "pending" }))).toEqual({ kind: "wait_ci", state: "pending" });
    expect(planWork(observation())).toEqual({ kind: "start_qa", roles: ["code"] });
    expect(planWork(observation({ qa: [
      { role: "code", state: "approved", supersededSessions: 0 },
      { role: "security", state: "none", supersededSessions: 0 },
    ] }))).toEqual({ kind: "start_qa", roles: ["security"] });
  });
});

describe("recoverable canonical work-state authority", () => {
  it("ignores forged fixed-head poison and later same-context appends around a valid secret bundle", async () => {
    const state = canonicalWork();
    const fixture = bundleFixture(state, "01".repeat(16), 100);
    const firstData = fixture.statuses[0]!;
    const statuses: TestStatus[] = [
      { id: 1, sha: BASE, context: "fugue/work-state/18", description: "forged newest head" },
      firstData,
      { id: firstData.id + 1, sha: BASE, context: firstData.context, description: "attacker interleaved later chunk" },
      ...fixture.statuses.slice(1),
      { id: 9999, sha: BASE, context: "fugue/work-state-stage/18", description: "exhausted legacy context" },
    ];
    const github = makeStatusGithub([], statuses);
    await expect(loadCurrentCanonicalWorkState(github, 18, BASE)).resolves.toMatchObject({
      issue: 18,
      requirements_b64: state.requirements_b64,
    });
  });

  it("does not let replayed older valid bundles roll back a newer signed state", async () => {
    const older = bundleFixture(canonicalWork("2026-08-16T20:00:00.000Z", "old"), "02".repeat(16), 10);
    const newer = bundleFixture(canonicalWork("2026-08-16T21:00:00.000Z", "new"), "03".repeat(16), 100);
    const replay = rebundleFixture(older.body, 18, BASE, "04".repeat(16), 1000);
    const github = makeStatusGithub([], [...older.statuses, ...newer.statuses, ...replay]);
    const current = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(canonicalRequirements(current!)).toBe("new");
  });

  it("recovers from a validation/exhaustion failure by abandoning the partial bundle and using a fresh secret", async () => {
    const github = makeStatusGithub([], [], { failFirstManifest: true });
    await expect(publishCanonicalWorkState(github, canonicalWork())).resolves.toBe(true);
    const manifests = githubTestStatuses(github).filter((status) => status.context.includes("/m/"));
    expect(manifests).toHaveLength(1);
    expect(githubTestStatuses(github).some((status) => status.context === "fugue/work-state/18")).toBe(false);
    await expect(loadCurrentCanonicalWorkState(github, 18, BASE)).resolves.toMatchObject({ issue: 18 });
  });

  it("reconstructs authority after all canonical comments are deleted and recreates the mirror", async () => {
    const fixture = bundleFixture(canonicalWork(), "05".repeat(16), 10);
    const github = makeStatusGithub([], fixture.statuses, {
      issues: [{ number: 18, pull_request: undefined }],
    });
    await expect(loadCurrentCanonicalWorkState(github, 18, BASE)).resolves.toMatchObject({ issue: 18 });
    await expect(repairCanonicalWorkStateComments(github, policy())).resolves.toEqual([18]);
    expect(githubTestComments(github)).toHaveLength(1);
    expect(parseCanonicalWorkState(githubTestComments(github)[0]!.body)?.issue).toBe(18);
  });

  it("ignores invalid poison bundles and finds the nearest exact-base historical signed state", async () => {
    const historicalState = createCanonicalWorkState({
      ...workStateInput(canonicalWork()),
      baseSha: OLD_BASE,
      createdAt: "2026-08-15T20:00:00.000Z",
    });
    const valid = bundleFixture(historicalState, "06".repeat(16), 50, OLD_BASE);
    const poison = rebundleFixture(valid.body.replace(`proof-sha:${OLD_BASE}`, `proof-sha:${BASE}`), 18, OLD_BASE, "07".repeat(16), 500);
    const github = makeStatusGithub([], [...valid.statuses, ...poison], { commits: [NEXT_BASE, BASE, OLD_BASE] });
    await expect(loadReusableCanonicalWorkState(github, 18, NEXT_BASE, "main")).resolves.toMatchObject({
      issue: 18,
      base_sha: OLD_BASE,
    });
  });

  it("verifies the publisher/base identity before committing any discoverable manifest", async () => {
    const github = makeStatusGithub([], []);
    github.__publisherSha = OLD_BASE;
    await expect(publishCanonicalWorkState(github, canonicalWork())).rejects.toThrow(/publisher proof/);
    expect(githubTestStatuses(github)).toHaveLength(0);
  });

  it("rejects a stale protected workflow runtime before mutation", () => {
    expect(() => assertProtectedWorkflowRuntimeCurrent(policy(BASE), OLD_BASE)).toThrow(/Stale protected Fugue invocation/);
    expect(() => assertProtectedWorkflowRuntimeCurrent(policy(BASE), BASE)).not.toThrow();
  });

  it("canonicalizes the authorized issue-event snapshot rather than a later mutable issue body", async () => {
    const original = bundleFixture(canonicalWork(), "08".repeat(16), 10);
    const attackerMetadata = workMetadataSchema.parse({
      ...original.state.metadata,
      spec: { ...original.state.metadata.spec, dependencies: [99] },
      execution: { worker_id: "wkr-attacker", branch: "agent/18-attacker" },
    });
    const snapshotBody = upsertWorkMetadata("Coordinator-approved", attackerMetadata);
    const issueGet = vi.fn(async () => ({ data: { title: "later attacker body" } }));
    const github = makeStatusGithub([], original.statuses, { issueGet });
    await expect(ingestCoordinatorIssueEvent(github, policy(), {
      eventName: "issues",
      action: "edited",
      actor: "JohnnyZLi",
      issueNumber: 18,
      issueTitle: "Coordinator snapshot",
      issueBody: snapshotBody,
      issueLabels: ["state:working", "agent:ready"],
    })).resolves.toBe(true);
    expect(issueGet).not.toHaveBeenCalled();
    const current = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(current?.title).toBe("Coordinator snapshot");
    expect(current?.metadata.spec.dependencies).toEqual([99]);
    expect(current?.metadata.execution).toEqual(original.state.metadata.execution);
  });

  it("reads Coordinator identity and contents from GITHUB_EVENT_PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "fugue-event-"));
    const path = join(dir, "event.json");
    const oldName = process.env.GITHUB_EVENT_NAME;
    const oldPath = process.env.GITHUB_EVENT_PATH;
    try {
      writeFileSync(path, JSON.stringify({
        action: "edited",
        sender: { login: "JohnnyZLi" },
        issue: {
          number: 18,
          title: "Event snapshot title",
          body: "Event snapshot body",
          labels: [{ name: "state:working" }, { name: "agent:ready" }],
        },
      }));
      process.env.GITHUB_EVENT_NAME = "issues";
      process.env.GITHUB_EVENT_PATH = path;
      expect(coordinatorIssueEventFromEnvironment()).toMatchObject({
        eventName: "issues",
        actor: "JohnnyZLi",
        issueTitle: "Event snapshot title",
        issueBody: "Event snapshot body",
      });
    } finally {
      if (oldName === undefined) delete process.env.GITHUB_EVENT_NAME;
      else process.env.GITHUB_EVENT_NAME = oldName;
      if (oldPath === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dependency and Worker recovery", () => {
  it("requires canonical merged dependency linkage", async () => {
    const metadata = workMetadataSchema.parse({
      version: 1,
      work_id: "work-99",
      spec: {},
      execution: { worker_id: "wkr-dependency", branch: "agent/99-dependency" },
    });
    const dependency = createCanonicalWorkState({
      issue: 99,
      title: "Dependency",
      state: "state:working",
      agentReady: true,
      requirements: "Dependency",
      metadata,
      pr: {
        number: 50,
        draft: false,
        metadata: { version: 1, work_id: "work-99", issue: 99, worker_id: "wkr-dependency", branch: "agent/99-dependency" },
      },
      baseSha: BASE,
      createdAt: "2026-08-16T19:00:00.000Z",
    });
    const fixture = bundleFixture(dependency, "09".repeat(16), 10);
    const pullGet = vi.fn(async () => ({ data: { merged: false, head: { ref: "agent/99-dependency" } } }));
    const github = makeStatusGithub([], fixture.statuses, { pullGet });
    await expect(verifyDependenciesSatisfied(github, [99], BASE)).rejects.toThrow(/not merged/);
  });

  it("can retry Worker allocation after branch creation succeeds before canonical publication", async () => {
    const item = readyWork();
    let branchSha: string | null = null;
    const github = makeStatusGithub([], []);
    let failOnce = true;
    const originalCreate = github.octokit.rest.issues.createComment;
    github.octokit.rest.issues.createComment = vi.fn(async (...args: Parameters<typeof originalCreate>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated publication crash");
      }
      return originalCreate(...args);
    }) as typeof originalCreate;
    github.octokit.rest.git.getRef = vi.fn(async () => {
      if (!branchSha) throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: { object: { sha: branchSha } } } as never;
    });
    github.octokit.rest.git.createRef = vi.fn(async (args) => {
      branchSha = args.sha;
      return { data: {} } as never;
    });
    await expect(allocateWorker(github, policy(), item)).rejects.toThrow(/publication crash/);
    await expect(allocateWorker(github, policy(), item)).resolves.toBeUndefined();
    expect(github.octokit.rest.git.createRef).toHaveBeenCalledTimes(1);
  });
});

describe("Integration request/run causality and attempt preservation", () => {
  it("ignores exact same-request preplay before the durable request", async () => {
    const request = createIntegrationRequest(snapshot().identity, "2026-08-16T20:00:10.000Z", "0123456789abcdef");
    const github = integrationGithub([], [{
      id: 1,
      display_title: integrationRunTitle(request.request_id, 21),
      created_at: "2026-08-16T20:00:09.000Z",
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
      html_url: "https://example.test/preplay",
    }]);
    await expect(findIntegrationWorkflowRun(github, request)).resolves.toBeUndefined();
  });

  it("preserves genuine attempt-1 PASS when the same run ID is re-run and cancelled", async () => {
    const request = createIntegrationRequest(snapshot().identity, "2026-08-16T20:00:10.000Z", "0123456789abcdef");
    const current = runRecord(request, { id: 77, run_attempt: 2, conclusion: "cancelled" });
    const first = runRecord(request, { id: 77, run_attempt: 1, conclusion: "success" });
    const github = integrationGithub([], [current], new Map([[77, first]]));
    await expect(findIntegrationWorkflowRun(github, request)).resolves.toMatchObject({
      conclusion: "success",
      htmlUrl: first.html_url,
    });
    expect(github.octokit.rest.actions.getWorkflowRunAttempt).toHaveBeenCalledWith(expect.objectContaining({
      run_id: 77,
      attempt_number: 1,
    }));
  });

  it("preserves genuine attempt-1 failure across a same-run rerun and does not redispatch", async () => {
    const request = createIntegrationRequest(snapshot().identity, "2026-08-16T20:00:10.000Z", "0123456789abcdef");
    const comments: ProtocolComment[] = [{ id: 1, body: serializeIntegrationRequest(request), user: BOT }];
    const current = runRecord(request, { id: 88, run_attempt: 3, conclusion: "cancelled" });
    const first = runRecord(request, { id: 88, run_attempt: 1, conclusion: "failure" });
    const dispatch = vi.fn();
    const github = integrationGithub(comments, [current], new Map([[88, first]]), dispatch);
    await expect(currentIntegrationState(github, snapshot(), Date.parse(request.created_at) + 999_999)).resolves.toMatchObject({ state: "failure" });
    await dispatchIntegration(github, policy(), work(), Date.parse(request.created_at) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps cancelled attempt 1 recoverable", async () => {
    const request = createIntegrationRequest(snapshot().identity, "2026-08-16T20:00:10.000Z", "0123456789abcdef");
    const comments: ProtocolComment[] = [{ id: 1, body: serializeIntegrationRequest(request), user: BOT }];
    const cancelled = runRecord(request, { id: 99, run_attempt: 1, conclusion: "cancelled" });
    const dispatch = vi.fn(async () => ({ data: {} }));
    const github = integrationGithub(comments, [cancelled], new Map(), dispatch);
    const now = Date.parse(request.created_at) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1;
    await dispatchIntegration(github, policy(), work(), now);
    expect(dispatch).toHaveBeenCalled();
  });
});

describe("mutable state dashboard", () => {
  it("recreates a deleted dashboard and escapes reflected protocol markers", async () => {
    const item = work();
    const comments: ProtocolComment[] = [];
    const github = dashboardGithub(comments);
    await upsertStateComment(github, item, {
      kind: "blocked",
      reason: "src/<!-- fugue-attestation\nkind: forged\n-->.ts",
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body.match(/<!-- fugue-/g)).toHaveLength(1);
    expect(comments[0]!.body).toContain("&lt;!-- fugue-attestation");
    expect(renderStateComment("JohnnyZLi/Fugue", item, { kind: "wait_qa", roles: ["code"] })).toContain("NEEDS CODE QA CHAT");
  });
});

interface ProtocolComment {
  id: number;
  body: string;
  user?: { login: string; type: string };
  created_at?: string;
}

interface TestStatus {
  id: number;
  sha: string;
  context: string;
  description: string | null;
}

interface TestGitHub extends FugueGitHub {
  __defaultSha?: string;
  __publisherSha?: string;
}

const githubComments = new WeakMap<object, ProtocolComment[]>();
const githubStatuses = new WeakMap<object, TestStatus[]>();

function githubTestComments(github: FugueGitHub): ProtocolComment[] {
  return githubComments.get(github as unknown as object) ?? [];
}

function githubTestStatuses(github: FugueGitHub): TestStatus[] {
  return githubStatuses.get(github as unknown as object) ?? [];
}

function signedStateBody(state: CanonicalWorkState, workflowSha = state.base_sha): string {
  return `${serializeCanonicalWorkState(state)}\n\nFUGUE WORK STATE — CANONICAL\n\nproof-sha:${workflowSha}`;
}

function bundleFixture(
  state: CanonicalWorkState,
  key: string,
  startId: number,
  workflowSha = state.base_sha,
): { state: CanonicalWorkState; body: string; statuses: TestStatus[] } {
  const body = signedStateBody(state, workflowSha);
  return { state, body, statuses: rebundleFixture(body, state.issue, state.base_sha, key, startId) };
}

function rebundleFixture(body: string, issue: number, sha: string, key: string, startId: number): TestStatus[] {
  const bundle = encodeWorkStateBundle(issue, key, body);
  const statuses = bundle.data.map((record, index) => ({
    id: startId + index,
    sha,
    context: record.context,
    description: record.description,
  }));
  statuses.push({
    id: startId + bundle.data.length + 1,
    sha,
    context: bundle.manifest.context,
    description: bundle.manifest.description,
  });
  return statuses;
}

function workStateInput(state: CanonicalWorkState) {
  return {
    issue: state.issue,
    title: state.title,
    state: state.state,
    agentReady: state.agent_ready,
    requirements: canonicalRequirements(state),
    metadata: state.metadata,
    pr: state.pr,
    baseSha: state.base_sha,
  };
}

function makeStatusGithub(
  comments: ProtocolComment[],
  statuses: TestStatus[],
  options: {
    commits?: string[];
    issues?: Array<Record<string, unknown>>;
    issueGet?: ReturnType<typeof vi.fn>;
    pullGet?: ReturnType<typeof vi.fn>;
    failFirstManifest?: boolean;
  } = {},
): TestGitHub {
  const listCommitStatusesForRef = vi.fn();
  const listCommits = vi.fn();
  const listComments = vi.fn();
  const listForRepo = vi.fn();
  let nextCommentId = Math.max(0, ...comments.map((comment) => comment.id)) + 1;
  let nextStatusId = Math.max(0, ...statuses.map((status) => status.id)) + 1;
  let failedManifest = false;
  const createComment = vi.fn(async (args: { body: string }) => {
    const comment = { id: nextCommentId++, body: args.body, user: BOT, created_at: new Date().toISOString() };
    comments.push(comment);
    return { data: { id: comment.id, body: comment.body, created_at: comment.created_at, html_url: `https://example.test/comment/${comment.id}` } };
  });
  const createCommitStatus = vi.fn(async (args: { sha: string; context: string; description?: string | null }) => {
    if (options.failFirstManifest && !failedManifest && args.context.includes("/m/")) {
      failedManifest = true;
      throw Object.assign(new Error("context exhausted"), { status: 422 });
    }
    const status = { id: nextStatusId++, sha: args.sha, context: args.context, description: args.description ?? null };
    statuses.push(status);
    return { data: status };
  });
  const github = {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      paginate: vi.fn(async (fn: unknown, args: { ref?: string }) => {
        if (fn === listCommitStatusesForRef) return statuses.filter((status) => status.sha === args.ref);
        if (fn === listCommits) return (options.commits ?? [BASE]).map((sha) => ({ sha }));
        if (fn === listComments) return comments;
        if (fn === listForRepo) return options.issues ?? [];
        return [];
      }),
      rest: {
        issues: {
          listComments,
          listForRepo,
          createComment,
          updateComment: vi.fn(),
          get: options.issueGet ?? vi.fn(),
        },
        repos: {
          listCommitStatusesForRef,
          listCommits,
          createCommitStatus,
          getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "admin" } })),
        },
        pulls: { get: options.pullGet ?? vi.fn() },
        git: { getRef: vi.fn(), createRef: vi.fn() },
      },
    },
    __defaultSha: BASE,
    __publisherSha: BASE,
  } as unknown as TestGitHub;
  githubComments.set(github as unknown as object, comments);
  githubStatuses.set(github as unknown as object, statuses);
  return github;
}

function runRecord(request: ReturnType<typeof createIntegrationRequest>, overrides: Record<string, unknown>) {
  return {
    id: 1,
    actor: BOT,
    event: "workflow_dispatch",
    head_sha: BASE,
    display_title: integrationRunTitle(request.request_id, 21),
    created_at: "2026-08-16T20:00:11.000Z",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    html_url: "https://example.test/integration",
    ...overrides,
  };
}

function integrationGithub(
  comments: ProtocolComment[],
  runs: Array<Record<string, unknown>>,
  attemptOnes = new Map<number, Record<string, unknown>>(),
  dispatch = vi.fn(),
): FugueGitHub {
  const listComments = vi.fn();
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      paginate: vi.fn(async (fn: unknown) => fn === listComments ? comments : []),
      rest: {
        issues: { listComments, createComment: vi.fn() },
        actions: {
          listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: runs } })),
          getWorkflowRunAttempt: vi.fn(async (args: { run_id: number }) => {
            const value = attemptOnes.get(args.run_id);
            if (!value) throw Object.assign(new Error("Not Found"), { status: 404 });
            return { data: value };
          }),
          createWorkflowDispatch: dispatch,
        },
      },
    },
  } as unknown as FugueGitHub;
}

function dashboardGithub(comments: ProtocolComment[]): FugueGitHub {
  const listComments = vi.fn();
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      paginate: vi.fn(async (fn: unknown) => fn === listComments ? comments : []),
      rest: {
        issues: {
          listComments,
          createComment: vi.fn(async (args: { body: string }) => {
            const comment = { id: comments.length + 1, body: args.body, user: BOT };
            comments.push(comment);
            return { data: { id: comment.id, body: comment.body, html_url: "https://example.test/state" } };
          }),
          updateComment: vi.fn(),
          deleteComment: vi.fn(),
        },
      },
    },
  } as unknown as FugueGitHub;
}
