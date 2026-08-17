import { describe, expect, it, vi } from "vitest";
import { integrationAttestationSchema } from "../src/core/attestations.js";
import type { EvaluationSnapshot } from "../src/core/evaluation.js";
import type { FugueGitHub } from "../src/core/github.js";
import {
  createIntegrationRecord,
  createIntegrationRequest,
  integrationRunTitle,
  type IntegrationRecord,
} from "../src/core/integration-plan.js";
import {
  bindIntegrationRun,
  currentIntegrationState,
  ensureIntegrationDispatch,
  findIntegrationWorkflowRun,
  getCurrentIntegrationRecord,
  publishIntegrationRecord,
} from "../src/core/integration-status.js";
import { upsertWorkMetadata, workMetadataSchema } from "../src/core/metadata.js";
import type { ActivePolicy } from "../src/core/policy.js";
import {
  assertRepositoryDefaultBranchRevision,
  FUGUE_PROTOCOL_ACTOR,
  signProtocolBody,
  verifyProtocolPublicationBodyAtRevision,
} from "../src/core/provenance.js";
import { ingestCoordinatorSnapshot, preserveCoordinatorIssueEvent } from "../src/core/reconcile.js";
import {
  canonicalRequirements,
  createCanonicalWorkState,
  durableManifestContext,
  loadCurrentCanonicalWorkState,
  parseCanonicalWorkState,
  publishCanonicalWorkState,
  recoverCoordinatorSnapshots,
  recoverDurableProtocolRecord,
  type CanonicalWorkState,
} from "../src/core/state.js";

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  return {
    ...actual,
    assertRepositoryDefaultBranchRevision: vi.fn(async (github: FugueGitHub, expected: string) => {
      const actualSha = (github as TestGithub).__baseSha ?? expected;
      if (actualSha !== expected) throw new Error(`stale protected revision ${actualSha.slice(0, 8)}`);
    }),
    signProtocolBody: vi.fn(async (_github: FugueGitHub, body: string) =>
      `${body}\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: test-proof\n-->`),
    verifyProtocolPublicationBodyAtRevision: vi.fn(async (
      github: FugueGitHub,
      body: string,
      expected: string,
    ) => {
      if (((github as TestGithub).__publisherSha ?? expected) !== expected) return false;
      const key = body.match(/Fugue-Authority-Key: ([0-9a-f]{32})/i)?.[1];
      const commit = body.match(/Fugue-Authority-Commit: ([0-9a-f]{32})/i)?.[1];
      return Boolean(key && commit && !/^0+$/.test(key) && !/^0+$/.test(commit));
    }),
    isTrustedProtocolComment: vi.fn(async (_github: FugueGitHub, comment: TestComment) =>
      comment.user?.login === "github-actions[bot]"),
    createProtocolComment: vi.fn(async (github: FugueGitHub, issueNumber: number, body: string) =>
      github.octokit.rest.issues.createComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        issue_number: issueNumber,
        body,
      })),
    updateProtocolComment: vi.fn(async (github: FugueGitHub, commentId: number, body: string) =>
      github.octokit.rest.issues.updateComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        comment_id: commentId,
        body,
      })),
  };
});

const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

function workMetadata(execution = true) {
  return workMetadataSchema.parse({
    version: 1,
    work_id: "work-18",
    spec: {
      dependencies: [],
      ownership: { owned: ["src/**"], coordinate: [], forbidden: [] },
      qa: { force: ["code"] },
      authorized_changes: { agents_invariants: [] },
    },
    execution: execution ? { worker_id: "wkr-12345678", branch: "agent/18-chat-first" } : {},
  });
}

function canonicalWork(requirements = "## Outcome\nProtected truth", createdAt = "2026-08-17T03:00:00.000Z"): CanonicalWorkState {
  return createCanonicalWorkState({
    issue: 18,
    title: "Chat-first orchestration",
    state: "state:working",
    agentReady: true,
    requirements,
    metadata: workMetadata(),
    pr: {
      number: 21,
      draft: false,
      metadata: { version: 1, work_id: "work-18", issue: 18, worker_id: "wkr-12345678", branch: "agent/18-chat-first" },
    },
    baseSha: BASE,
    createdAt,
  });
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

function policy(): ActivePolicy {
  return {
    identity: { baseBranch: "main", baseSha: BASE, policyDigest: "sha256:policy", protocolVersion: 1 },
    config: { branches: { worker_pattern: "agent/{issue}-{slug}" } },
  } as unknown as ActivePolicy;
}

describe("d3 protected durable authority", () => {
  it("does not expose an authority commit capability before the protected manifest write", async () => {
    const github = makeGithub({ failManifestAlways: true });
    await expect(publishCanonicalWorkState(github, canonicalWork())).rejects.toThrow(/Unable to commit/);
    expect(github.__comments).toHaveLength(0);
    expect(github.__statuses.some((status) => status.context.includes("/m/"))).toBe(false);

    for (const [, signedInput] of vi.mocked(signProtocolBody).mock.calls) {
      const key = signedInput.match(/Fugue-Authority-Key: ([0-9a-f]{32})/)?.[1];
      const commit = signedInput.match(/Fugue-Authority-Commit: ([0-9a-f]{32})/)?.[1];
      if (!key || !commit) continue;
      expect(github.__statuses.some((status) => status.context.includes(key))).toBe(false);
      expect(github.__statuses.some((status) => status.description.includes(commit))).toBe(false);
    }

    github.__statuses.push({
      id: ++github.__nextStatusId,
      sha: BASE,
      context: durableManifestContext("work/18", "f".repeat(32)),
      description: `n=1;d=${"1".repeat(64)};c=${"e".repeat(32)}`,
    });
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: "work/18",
      issueNumber: 18,
      parse: parseCanonicalWorkState,
      timestamp: (value) => Date.parse(value.created_at),
    });
    expect(recovered.record).toBeUndefined();
    expect(recovered.exhausted).toBe(true);
  });

  it("requires exact publisher/base proof before any manifest becomes discoverable", async () => {
    const github = makeGithub();
    github.__publisherSha = "c".repeat(40);
    await expect(publishCanonicalWorkState(github, canonicalWork())).rejects.toThrow(/publisher proof/);
    expect(github.__statuses).toHaveLength(0);
    vi.mocked(assertRepositoryDefaultBranchRevision).mockClear();
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockClear();
  });

  it("abandons an exhausted transaction and retries under fresh unrevealed secrets", async () => {
    const github = makeGithub({ failFirstManifest: true });
    await expect(publishCanonicalWorkState(github, canonicalWork())).resolves.toBe(true);
    expect(github.__statuses.filter((status) => status.context.includes("/m/"))).toHaveLength(1);
    const dataContexts = github.__statuses.filter((status) => status.context.includes("/d/")).map((status) => status.context);
    expect(new Set(dataContexts).size).toBeGreaterThan(1);
  });

  it("bounds fake-manifest and chunk reconstruction work per scheduled recovery slice", async () => {
    const github = makeGithub();
    for (let index = 0; index < 100; index += 1) {
      const key = index.toString(16).padStart(32, "0");
      github.__statuses.push({
        id: ++github.__nextStatusId,
        sha: BASE,
        context: durableManifestContext("work/18", key),
        description: `n=48;d=${"a".repeat(64)};c=${"b".repeat(32)}`,
      });
    }
    github.__listStatus.mockClear();
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockClear();
    const first = await recoverDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: "work/18",
      issueNumber: 18,
      parse: parseCanonicalWorkState,
      timestamp: (value) => Date.parse(value.created_at),
    });
    expect(first.exhausted).toBe(false);
    expect(github.__listStatus).toHaveBeenCalledTimes(2);
    expect(vi.mocked(verifyProtocolPublicationBodyAtRevision)).not.toHaveBeenCalled();
    expect(github.__comments.some((comment) => comment.body.includes("fugue-durable-recovery"))).toBe(true);
  });

  it("recovers the newest committed state after all ordinary state comments are destroyed", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("older"));
    await publishCanonicalWorkState(github, canonicalWork("newer", "2026-08-17T03:01:00.000Z"));
    github.__comments.splice(0);
    const recovered = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(canonicalRequirements(recovered!)).toBe("newer");
    expect(github.__comments.some((comment) => comment.body.includes("work-d3"))).toBe(true);
  });
});

describe("Coordinator event durability", () => {
  it("recovers an authorized immutable Human snapshot after its ordinary snapshot comment is deleted", async () => {
    const github = makeGithub();
    const body = upsertWorkMetadata("## Outcome\nHuman-approved snapshot", workMetadata(false));
    await expect(preserveCoordinatorIssueEvent(github, policy(), {
      eventName: "issues",
      action: "edited",
      actor: "JohnnyZLi",
      eventId: "event-1",
      issueNumber: 18,
      issueTitle: "Approved title",
      issueBody: body,
      issueLabels: ["state:working", "agent:ready"],
      issueUpdatedAt: "2026-08-17T03:05:00.000Z",
      issueIsPullRequest: false,
    })).resolves.toBe(true);
    github.__comments.splice(0);

    const snapshots = await recoverCoordinatorSnapshots(github, policy());
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ event_id: "event-1", title: "Approved title", body });
    await ingestCoordinatorSnapshot(github, policy(), snapshots[0]!);
    const current = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(current?.title).toBe("Approved title");
    expect(canonicalRequirements(current!)).toContain("Human-approved snapshot");
  });
});

describe("durable Integration one-request/one-run/result authority", () => {
  it("binds a request to the earliest causally valid attempt-1 run and rejects later replacements", async () => {
    const github = makeGithub();
    const request = createIntegrationRequest(snapshot().identity, "2026-08-17T03:20:00.000Z", "0123456789abcdef");
    await publishIntegrationRecord(github, createIntegrationRecord(request));
    github.__runs.push(run(request, 101, "2026-08-17T03:20:01.000Z", "in_progress", null));
    github.__runs.push(run(request, 102, "2026-08-17T03:20:02.000Z", "queued", null));
    await expect(findIntegrationWorkflowRun(github, request)).resolves.toMatchObject({ id: 101, attempt: 1 });
    const bound = await bindIntegrationRun(github, snapshot(), request.request_id, 101);
    expect(bound.run?.id).toBe(101);
    await expect(bindIntegrationRun(github, snapshot(), request.request_id, 102)).rejects.toThrow(/already bound/);
  });

  it("preserves terminal PASS after request/result comments and the bound workflow run are deleted", async () => {
    const github = makeGithub();
    const record = await publishBoundRecord(github, 201);
    const attestation = integrationAttestation(record);
    await publishIntegrationRecord(github, {
      ...record,
      terminal: { state: "success", attestation, created_at: "2026-08-17T03:30:05.000Z" },
      created_at: "2026-08-17T03:30:05.000Z",
    });
    github.__comments.splice(0);
    github.__runs.splice(0);
    github.__attempts.clear();
    const state = await settleIntegrationState(github);
    expect(state.state).toBe("success");
    expect(state.attestation?.integration).toEqual({ request_id: record.request.request_id, run_id: 201, run_attempt: 1 });
  });

  it("preserves terminal failure and never silently converts it into retry", async () => {
    const github = makeGithub();
    const record = await publishBoundRecord(github, 301);
    await publishIntegrationRecord(github, {
      ...record,
      terminal: { state: "failure", detail: "protected gate failed", created_at: "2026-08-17T03:40:05.000Z" },
      created_at: "2026-08-17T03:40:05.000Z",
    });
    github.__comments.splice(0);
    github.__runs.push(run(record.request, 999, "2026-08-17T03:41:00.000Z", "completed", "success"));
    github.__attempts.clear();
    expect((await settleIntegrationState(github)).state).toBe("failure");
    const dispatch = await ensureIntegrationDispatch(github, snapshot(), Date.parse("2026-08-17T04:00:00Z"));
    expect(dispatch.dispatch).toBe(false);
    expect(dispatch.request?.request_id).toBe(record.request.request_id);
  });

  it("aborts a deleted bound run and creates a fresh request instead of substituting a later same-request run", async () => {
    const github = makeGithub();
    const bound = await publishBoundRecord(github, 401);
    github.__runs.push(run(bound.request, 999, "2026-08-17T03:50:10.000Z", "queued", null));
    github.__attempts.clear();
    const next = await ensureIntegrationDispatch(github, snapshot(), Date.parse("2026-08-17T04:10:00Z"));
    expect(next.dispatch).toBe(true);
    expect(next.request?.request_id).not.toBe(bound.request.request_id);
    const current = await getCurrentIntegrationRecord(github, snapshot().identity);
    expect(current?.request.request_id).toBe(next.request?.request_id);
    expect(current?.run).toBeNull();
  });
});

interface TestComment {
  id: number;
  issueNumber: number;
  body: string;
  user?: { login: string; type: string };
  created_at?: string;
  updated_at?: string;
}
interface TestStatus { id: number; sha: string; context: string; description: string; }
interface TestRun {
  id: number;
  actor: typeof BOT;
  event: string;
  head_sha: string;
  display_title: string;
  created_at: string;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}
interface TestGithub extends FugueGitHub {
  __baseSha: string;
  __publisherSha?: string;
  __comments: TestComment[];
  __statuses: TestStatus[];
  __runs: TestRun[];
  __attempts: Map<number, TestRun>;
  __nextStatusId: number;
  __listStatus: ReturnType<typeof vi.fn>;
}

function makeGithub(options: { failManifestAlways?: boolean; failFirstManifest?: boolean } = {}): TestGithub {
  const comments: TestComment[] = [];
  const statuses: TestStatus[] = [];
  const runs: TestRun[] = [];
  const attempts = new Map<number, TestRun>();
  let nextCommentId = 0;
  let nextStatusId = 0;
  let failedManifest = false;
  const listForRepo = vi.fn();
  const listCommits = vi.fn();
  const listCommitStatusesForRef = vi.fn(async (args: { ref: string; page?: number; per_page?: number }) => {
    const perPage = args.per_page ?? 100;
    const page = args.page ?? 1;
    const filtered = statuses.filter((status) => status.sha === args.ref).sort((a, b) => b.id - a.id);
    return { data: filtered.slice((page - 1) * perPage, page * perPage) };
  });
  const listComments = vi.fn(async (args: { issue_number: number; page?: number; per_page?: number }) => {
    const perPage = args.per_page ?? 100;
    const page = args.page ?? 1;
    const filtered = comments.filter((comment) => comment.issueNumber === args.issue_number).sort((a, b) => a.id - b.id);
    return { data: filtered.slice((page - 1) * perPage, page * perPage) };
  });

  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    __baseSha: BASE,
    __comments: comments,
    __statuses: statuses,
    __runs: runs,
    __attempts: attempts,
    get __nextStatusId() { return nextStatusId; },
    set __nextStatusId(value: number) { nextStatusId = value; },
    __listStatus: listCommitStatusesForRef,
    octokit: {
      paginate: vi.fn(async (fn: unknown) => {
        if (fn === listForRepo) return [{ number: 18, pull_request: undefined, state: "open", labels: [], body: "", title: "Issue", html_url: "https://example.test/issues/18" }];
        if (fn === listCommits) return [{ sha: BASE }];
        return [];
      }),
      rest: {
        issues: {
          get: vi.fn(async (args: { issue_number: number }) => ({ data: { comments: comments.filter((comment) => comment.issueNumber === args.issue_number).length } })),
          listComments,
          createComment: vi.fn(async (args: { issue_number: number; body: string }) => {
            const comment: TestComment = { id: ++nextCommentId, issueNumber: args.issue_number, body: args.body, user: BOT, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            comments.push(comment);
            return { data: { id: comment.id, body: comment.body, html_url: `https://example.test/comment/${comment.id}`, created_at: comment.created_at } };
          }),
          updateComment: vi.fn(async (args: { comment_id: number; body: string }) => {
            const comment = comments.find((item) => item.id === args.comment_id);
            if (!comment) throw Object.assign(new Error("Not Found"), { status: 404 });
            comment.body = args.body;
            comment.updated_at = new Date().toISOString();
            return { data: { id: comment.id, body: comment.body, html_url: `https://example.test/comment/${comment.id}`, created_at: comment.created_at } };
          }),
          deleteComment: vi.fn(async (args: { comment_id: number }) => {
            const index = comments.findIndex((item) => item.id === args.comment_id);
            if (index >= 0) comments.splice(index, 1);
            return { data: {} };
          }),
          listForRepo,
          update: vi.fn(async () => ({ data: {} })),
        },
        repos: {
          createCommitStatus: vi.fn(async (args: { sha: string; context: string; description?: string }) => {
            if (args.context.includes("/m/") && (options.failManifestAlways || (options.failFirstManifest && !failedManifest))) {
              failedManifest = true;
              throw Object.assign(new Error("status context exhausted"), { status: 422 });
            }
            const status = { id: ++nextStatusId, sha: args.sha, context: args.context, description: args.description ?? "" };
            statuses.push(status);
            return { data: status };
          }),
          listCommitStatusesForRef,
          getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "admin" } })),
          listCommits,
        },
        actions: {
          listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: runs } })),
          getWorkflowRunAttempt: vi.fn(async (args: { run_id: number; attempt_number: number }) => {
            const item = attempts.get(args.run_id);
            if (!item || args.attempt_number !== 1) throw Object.assign(new Error("Not Found"), { status: 404 });
            return { data: item };
          }),
          createWorkflowDispatch: vi.fn(async () => ({ data: {} })),
        },
        git: { getRef: vi.fn(async () => ({ data: { object: { sha: BASE } } })), createRef: vi.fn(async () => ({ data: {} })) },
        pulls: { get: vi.fn() },
      },
    },
  } as unknown as TestGithub;
}

function run(request: ReturnType<typeof createIntegrationRequest>, id: number, createdAt: string, status: string, conclusion: string | null): TestRun {
  return {
    id, actor: BOT, event: "workflow_dispatch", head_sha: request.identity.baseSha,
    display_title: integrationRunTitle(request.request_id, request.identity.prNumber),
    created_at: createdAt, run_attempt: 1, status, conclusion, html_url: `https://example.test/runs/${id}`,
  };
}

async function publishBoundRecord(github: TestGithub, runId: number): Promise<IntegrationRecord> {
  const request = createIntegrationRequest(snapshot().identity, "2026-08-17T03:30:00.000Z", runId.toString(16).padStart(16, "0"));
  await publishIntegrationRecord(github, createIntegrationRecord(request));
  const first = run(request, runId, "2026-08-17T03:30:01.000Z", "in_progress", null);
  github.__runs.push(first);
  github.__attempts.set(runId, first);
  return bindIntegrationRun(github, snapshot(), request.request_id, runId);
}

function integrationAttestation(record: IntegrationRecord) {
  return integrationAttestationSchema.parse({
    version: 1,
    kind: "integration",
    attestation_id: "att-integration-test",
    identity: record.identity,
    integration: { request_id: record.request.request_id, run_id: record.run!.id, run_attempt: 1 },
    fugue_version: "0.1.0-alpha.0",
    qa: { code: "passed", security: "passed", visual: "not_required" },
    dependencies: { passed: true },
    agents_md: { impact_reviewed: true, update_required: false, update_present: false },
    control_plane: { changed: false, human_acknowledgement: "not_required" },
    validation_control: { changed: false, reviewed: true, acceptable: true },
    validation: { clean_worktree: true, passed: true, commands: ["npm test"] },
    ci: { passed: true, checks: ["test"] },
    base_current: { passed: true }, conflicts: { none: true }, verdict: "approved",
    created_at: "2026-08-17T03:30:05.000Z",
  });
}

async function settleIntegrationState(github: TestGithub) {
  let state = await currentIntegrationState(github, snapshot(), Date.parse("2026-08-17T04:00:00Z"));
  for (let attempt = 0; attempt < 8 && state.state === "pending"; attempt += 1) {
    state = await currentIntegrationState(github, snapshot(), Date.parse("2026-08-17T04:00:00Z"));
  }
  return state;
}
