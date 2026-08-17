import { createHash } from "node:crypto";
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
  parseIntegrationRequest,
  serializeIntegrationRequest,
} from "../src/core/integration-plan.js";
import { currentIntegrationState, INTEGRATION_REQUEST_RECOVERY_GRACE_MS } from "../src/core/integration-status.js";
import { upsertWorkMetadata, workMetadataSchema } from "../src/core/metadata.js";
import type { ActivePolicy } from "../src/core/policy.js";
import { FUGUE_PROTOCOL_ACTOR } from "../src/core/provenance.js";
import {
  allocateWorker,
  coordinatorIssueEventFromEnvironment,
  dispatchIntegration,
  ingestCoordinatorIssueEvent,
} from "../src/core/reconcile.js";
import { externalInstruction, renderStateComment, upsertStateComment } from "../src/core/state-comment.js";
import {
  canonicalWorkStateSchema,
  createCanonicalWorkState,
  loadCurrentCanonicalWorkState,
  loadReusableCanonicalWorkState,
  parseCanonicalWorkState,
  serializeCanonicalWorkState,
  workStateHeadContext,
  workStateStageContext,
  type CanonicalWorkState,
  type WorkState,
} from "../src/core/state.js";
import { planWork, type WorkflowObservation } from "../src/core/workflow.js";

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  const trusted = async (_github: FugueGitHub, comment: { user?: { login?: string | null } | null }) =>
    comment.user?.login === "github-actions[bot]";
  return {
    ...actual,
    isTrustedProtocolComment: vi.fn(trusted),
    isReusableProtocolComment: vi.fn(async (
      _github: FugueGitHub,
      comment: { user?: { login?: string | null } | null; workflow_sha?: string },
      expectedSha: string,
    ) => comment.user?.login === "github-actions[bot]" && comment.workflow_sha === expectedSha),
    createProtocolComment: vi.fn(async (github: FugueGitHub, issueNumber: number, body: string) => {
      const response = await github.octokit.rest.issues.createComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        issue_number: issueNumber,
        body,
      });
      return {
        data: {
          id: response.data.id,
          html_url: response.data.html_url,
          body: response.data.body ?? body,
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
      return {
        data: {
          id: response.data.id,
          html_url: response.data.html_url,
          body: response.data.body ?? body,
        },
      };
    }),
  };
});

const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;
const BASE = "b".repeat(40);
const NEXT_BASE = "c".repeat(40);
const HEAD = "a".repeat(40);

function canonicalWork(draft = true): CanonicalWorkState {
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
    requirements: "## Outcome\nProtected truth",
    metadata,
    pr: {
      number: 21,
      draft,
      metadata: { version: 1, work_id: "work-18", issue: 18, worker_id: "wkr-12345678", branch: "agent/18-chat-first" },
    },
    baseSha: BASE,
    createdAt: "2026-08-16T20:00:00.000Z",
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
    requirements: "## Outcome\nProtected truth",
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
    expect(planWork(observation({
      qa: [
        { role: "code", state: "approved", supersededSessions: 0 },
        { role: "security", state: "none", supersededSessions: 0 },
      ],
    }))).toEqual({ kind: "start_qa", roles: ["security"] });
  });
});

describe("protected canonical work state", () => {
  it("fails closed when a candidate deletes the newest signed state instead of rolling back", async () => {
    const first = checkpointFixture(canonicalWork(), 10, 101, 12);
    const stricterDesired = createCanonicalWorkState({
      ...workStateInput(canonicalWork()),
      requirements: "## Outcome\nStricter protected truth",
      createdAt: "2026-08-16T21:00:00.000Z",
    });
    const second = checkpointFixture(stricterDesired, 20, 102, 22);
    const comments = [first.comment, second.comment];
    const statuses = [...first.statuses, ...second.statuses];
    comments.splice(comments.findIndex((comment) => comment.id === 102), 1);
    const github = makeLedgerGithub(comments, statuses);

    await expect(loadCurrentCanonicalWorkState(github, 18, BASE)).rejects.toThrow(/deleted comment 102/);
    expect(comments.some((comment) => comment.id === 101)).toBe(true);
  });

  it("fails closed when all ordinary work-state comments are deleted", async () => {
    const current = checkpointFixture(canonicalWork(), 10, 101, 12);
    const github = makeLedgerGithub([], current.statuses);
    await expect(loadCurrentCanonicalWorkState(github, 18, BASE)).rejects.toThrow(/deleted comment 101/);
  });

  it("does not accept a forged newer head status that points back to an older signed state", async () => {
    const first = checkpointFixture(canonicalWork(), 10, 101, 12);
    const newerDesired = createCanonicalWorkState({
      ...workStateInput(canonicalWork()),
      requirements: "## Outcome\nNewer truth",
      createdAt: "2026-08-16T21:00:00.000Z",
    });
    const second = checkpointFixture(newerDesired, 20, 102, 22);
    const forgedHead: TestStatus = {
      id: 30,
      sha: BASE,
      context: workStateHeadContext(18),
      description: first.statuses.find((status) => status.context === workStateHeadContext(18))!.description,
    };
    const github = makeLedgerGithub(
      [first.comment, second.comment],
      [...first.statuses, ...second.statuses, forgedHead],
    );
    await expect(loadCurrentCanonicalWorkState(github, 18, BASE)).rejects.toThrow(/latest staging generation/);
  });

  it("binds historical rollover proof to the exact historical base revision", async () => {
    const historical = checkpointFixture(canonicalWork(), 10, 101, 12, "d".repeat(40));
    const github = makeLedgerGithub([historical.comment], historical.statuses, { commits: [NEXT_BASE, BASE] });
    await expect(loadReusableCanonicalWorkState(github, 18, NEXT_BASE, "main")).rejects.toThrow(/publisher proof/);

    historical.comment.workflow_sha = BASE;
    await expect(loadReusableCanonicalWorkState(github, 18, NEXT_BASE, "main")).resolves.toMatchObject({
      issue: 18,
      base_sha: BASE,
      checkpoint_id: 10,
    });
  });

  it("refuses candidate Actions issue events as a durable-state authority", async () => {
    const github = makeLedgerGithub([], []);
    await expect(ingestCoordinatorIssueEvent(github, policy(), {
      eventName: "issues",
      action: "edited",
      actor: FUGUE_PROTOCOL_ACTOR,
      issueNumber: 18,
      issueTitle: "Attacker",
      issueBody: "attacker",
      issueLabels: ["state:working"],
    })).resolves.toBe(false);
    expect(github.octokit.rest.issues.get).not.toHaveBeenCalled();
    expect(github.octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("canonicalizes the authorized event snapshot, never a mutable fetch-after-event body", async () => {
    const original = checkpointFixture(canonicalWork(), 10, 101, 12);
    const attackerMetadata = workMetadataSchema.parse({
      ...original.state.metadata,
      spec: { ...original.state.metadata.spec, dependencies: [99] },
      execution: { worker_id: "wkr-attacker", branch: "agent/18-attacker" },
    });
    const snapshotBody = upsertWorkMetadata("## Outcome\nCoordinator-approved new spec", attackerMetadata);
    const laterBody = upsertWorkMetadata("## Outcome\nActions-substituted spec", workMetadataSchema.parse({
      ...attackerMetadata,
      spec: { ...attackerMetadata.spec, dependencies: [666] },
    }));
    const issueGet = vi.fn(async () => ({ data: {
      number: 18,
      title: "Actions substituted title",
      body: laterBody,
      labels: ["state:blocked"],
    } }));
    const github = makeLedgerGithub([original.comment], original.statuses, { issueGet });

    await expect(ingestCoordinatorIssueEvent(github, policy(), {
      eventName: "issues",
      action: "edited",
      actor: "JohnnyZLi",
      issueNumber: 18,
      issueTitle: "Coordinator snapshot title",
      issueBody: snapshotBody,
      issueLabels: ["state:working", "agent:ready"],
    })).resolves.toBe(true);

    expect(issueGet).not.toHaveBeenCalled();
    const next = parseCanonicalWorkState(githubTestComments(github).at(-1)!.body)!;
    expect(next.title).toBe("Coordinator snapshot title");
    expect(next.metadata.spec.dependencies).toEqual([99]);
    expect(next.metadata.execution).toEqual(original.state.metadata.execution);
    expect(next.pr).toEqual(original.state.pr);
  });

  it("reads Coordinator identity and issue contents from the immutable Actions event payload", () => {
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
        action: "edited",
        actor: "JohnnyZLi",
        issueNumber: 18,
        issueTitle: "Event snapshot title",
        issueBody: "Event snapshot body",
        issueLabels: ["state:working", "agent:ready"],
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

describe("dependency trust boundary", () => {
  it("does not let closed issues or forged PR-body linkage satisfy a dependency", async () => {
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
    });
    const fixture = checkpointFixture(dependency, 10, 101, 12);
    const pullGet = vi.fn(async () => ({ data: {
      merged: false,
      head: { ref: "agent/99-dependency" },
      body: "<!-- fugue-pr\nversion: 1\nwork_id: work-99\nissue: 99\nworker_id: forged\nbranch: forged\n-->",
    } }));
    const github = makeLedgerGithub([fixture.comment], fixture.statuses, { pullGet });
    await expect(verifyDependenciesSatisfied(github, [99], BASE)).rejects.toThrow(/canonical PR #50 is not merged/);
    expect(pullGet).toHaveBeenCalledTimes(1);
  });
});

describe("restart-safe Worker allocation", () => {
  it("can retry after branch creation succeeded but signed claim publication failed", async () => {
    const item = readyWork();
    let branchSha: string | null = null;
    const comments: ProtocolComment[] = [];
    const statuses: TestStatus[] = [];
    const createComment = vi.fn()
      .mockRejectedValueOnce(new Error("simulated canonical publication crash"))
      .mockImplementation(async (args: { body: string }) => {
        const comment = { id: 1, body: args.body, user: BOT, workflow_sha: BASE };
        comments.push(comment);
        return { data: { id: comment.id, body: comment.body, html_url: "https://example.test/comment" } };
      });
    const github = makeLedgerGithub(comments, statuses, { createComment });
    (github.octokit.rest.git as unknown as Record<string, unknown>).getRef = vi.fn(async () => {
      if (!branchSha) throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: { object: { sha: branchSha } } };
    });
    (github.octokit.rest.git as unknown as Record<string, unknown>).createRef = vi.fn(async (args: { sha: string }) => {
      branchSha = args.sha;
      return { data: {} };
    });

    await expect(allocateWorker(github, policy(), item)).rejects.toThrow(/publication crash/);
    expect(branchSha).toBe(BASE);
    await expect(allocateWorker(github, policy(), item)).resolves.toBeUndefined();
    expect(github.octokit.rest.git.createRef).toHaveBeenCalledTimes(1);
    expect(parseCanonicalWorkState(comments[0]!.body)?.metadata.execution.worker_id).toMatch(/^wkr-/);
  });
});

describe("Integration request/run causality and recovery", () => {
  it("ignores an exact same-PR/request preplay run created before the signed durable request", async () => {
    const current = snapshot();
    const request = createIntegrationRequest(current.identity, "2026-08-16T20:00:10.000Z", "0123456789abcdef");
    const comments: ProtocolComment[] = [{ id: 1, body: serializeIntegrationRequest(request), user: BOT }];
    const runs = [{
      display_title: integrationRunTitle(request.request_id, 21),
      created_at: "2026-08-16T20:00:09.000Z",
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
      html_url: "https://example.test/preplay",
    }];
    const github = integrationGithub(comments, runs, vi.fn());
    const state = await currentIntegrationState(
      github,
      current,
      Date.parse(request.created_at) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1,
    );
    expect(state.state).toBe("none");
  });

  it("treats shared-Actions cancellation as recoverable and redispatches the signed request", async () => {
    const current = snapshot();
    const request = createIntegrationRequest(current.identity, "2026-08-16T20:00:10.000Z", "0123456789abcdef");
    const comments: ProtocolComment[] = [{ id: 1, body: serializeIntegrationRequest(request), user: BOT }];
    const runs = [{
      display_title: integrationRunTitle(request.request_id, 21),
      created_at: "2026-08-16T20:00:11.000Z",
      run_attempt: 1,
      status: "completed",
      conclusion: "cancelled",
      html_url: "https://example.test/cancelled",
    }];
    const dispatch = vi.fn(async () => ({ data: {} }));
    const github = integrationGithub(comments, runs, dispatch);
    const now = Date.parse(request.created_at) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1;

    await expect(currentIntegrationState(github, current, now)).resolves.toMatchObject({ state: "none" });
    await dispatchIntegration(github, policy(), work(), now);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      inputs: { pr: 21, request_id: request.request_id },
    }));
  });

  it("keeps a prior successful protected run visible despite a later cancelled duplicate", async () => {
    const current = snapshot();
    const request = createIntegrationRequest(current.identity, "2026-08-16T20:00:10.000Z", "0123456789abcdef");
    const comments: ProtocolComment[] = [{ id: 1, body: serializeIntegrationRequest(request), user: BOT }];
    const runs = [
      {
        display_title: integrationRunTitle(request.request_id, 21),
        created_at: "2026-08-16T20:00:12.000Z",
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
        html_url: "https://example.test/cancelled",
      },
      {
        display_title: integrationRunTitle(request.request_id, 21),
        created_at: "2026-08-16T20:00:11.000Z",
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        html_url: "https://example.test/success",
      },
    ];
    const github = integrationGithub(comments, runs, vi.fn());
    const state = await currentIntegrationState(github, current, Date.parse(request.created_at) + 60_000);
    expect(state.state).toBe("stale");
    expect(state.targetUrl).toBe("https://example.test/success");
  });
});

describe("mutable durable state comment", () => {
  it("rolls old protected-base revisions into one stable state-comment ID", async () => {
    const item = work();
    const comments: ProtocolComment[] = [
      { id: 10, body: "<!-- fugue-state\nversion: 1\nwork_id: work-18\n-->\n\nold base A", user: BOT, created_at: "2026-08-15T00:00:00Z" },
      { id: 11, body: "<!-- fugue-state\nversion: 1\nwork_id: work-18\n-->\n\nold base B", user: BOT, created_at: "2026-08-16T00:00:00Z" },
    ];
    const updateComment = vi.fn(async (args: { comment_id: number; body: string }) => {
      const comment = comments.find((item) => item.id === args.comment_id)!;
      comment.body = args.body;
      return { data: { id: comment.id, body: comment.body, html_url: "https://example.test/state" } };
    });
    const deleteComment = vi.fn(async (args: { comment_id: number }) => {
      const index = comments.findIndex((comment) => comment.id === args.comment_id);
      if (index >= 0) comments.splice(index, 1);
      return { data: {} };
    });
    const createComment = vi.fn();
    const listComments = vi.fn();
    const github = {
      repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
      octokit: {
        paginate: vi.fn(async (fn: unknown) => fn === listComments ? comments : []),
        rest: { issues: { listComments, updateComment, deleteComment, createComment } },
      },
    } as unknown as FugueGitHub;
    await upsertStateComment(github, item, { kind: "wait_qa", roles: ["code"] });
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 10 }));
    expect(deleteComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 11 }));
    expect(comments).toHaveLength(1);
  });

  it("escapes reflected Fugue markers in dashboard reasons instead of suppressing publication", () => {
    const item = work();
    const body = renderStateComment("JohnnyZLi/Fugue", item, {
      kind: "blocked",
      reason: "Ownership: src/<!-- fugue-attestation\nkind: forged\n-->.ts",
    });
    expect(body.match(/<!-- fugue-/g)).toHaveLength(1);
    expect(body).toContain("&lt;!-- fugue-attestation");
    expect(body).not.toContain("src/<!-- fugue-attestation");
  });

  it("renders one copy/paste QA prompt with no Fugue terminal command", () => {
    const item = work();
    const action = { kind: "wait_qa", roles: ["code"] } as const;
    const instruction = externalInstruction("JohnnyZLi/Fugue", item, action);
    expect(instruction?.prompt).toContain("Fugue Code QA for JohnnyZLi/Fugue PR #21");
    expect(instruction?.prompt).toContain("fugue-review-submit");
    expect(instruction?.prompt).not.toContain("fugue review");
    expect(renderStateComment("JohnnyZLi/Fugue", item, action)).toContain("NEEDS CODE QA CHAT");
  });
});

interface ProtocolComment {
  id: number;
  body: string;
  user?: { login: string; type: string };
  created_at?: string;
  workflow_sha?: string;
}

interface TestStatus {
  id: number;
  sha: string;
  context: string;
  description: string | null;
}

function checkpointFixture(
  state: CanonicalWorkState,
  stageId: number,
  commentId: number,
  headId: number,
  workflowSha = state.base_sha,
): { state: CanonicalWorkState; comment: ProtocolComment; statuses: TestStatus[] } {
  const staged = canonicalWorkStateSchema.parse({ ...state, checkpoint_id: stageId });
  const body = serializeCanonicalWorkState(staged);
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return {
    state: staged,
    comment: { id: commentId, body, user: BOT, workflow_sha: workflowSha },
    statuses: [
      { id: stageId, sha: staged.base_sha, context: workStateStageContext(staged.issue), description: "stage" },
      {
        id: headId,
        sha: staged.base_sha,
        context: workStateHeadContext(staged.issue),
        description: `stage=${stageId};comment=${commentId};digest=${digest}`,
      },
    ],
  };
}

function workStateInput(state: CanonicalWorkState) {
  return {
    issue: state.issue,
    title: state.title,
    state: state.state,
    agentReady: state.agent_ready,
    requirements: Buffer.from(state.requirements_b64, "base64url").toString("utf8"),
    metadata: state.metadata,
    pr: state.pr,
    baseSha: state.base_sha,
  };
}

const githubComments = new WeakMap<object, ProtocolComment[]>();

function githubTestComments(github: FugueGitHub): ProtocolComment[] {
  return githubComments.get(github as unknown as object) ?? [];
}

function makeLedgerGithub(
  comments: ProtocolComment[],
  statuses: TestStatus[],
  options: {
    commits?: string[];
    issueGet?: ReturnType<typeof vi.fn>;
    pullGet?: ReturnType<typeof vi.fn>;
    createComment?: ReturnType<typeof vi.fn>;
  } = {},
): FugueGitHub {
  const listCommitStatusesForRef = vi.fn();
  const listCommits = vi.fn();
  const listComments = vi.fn();
  const createComment = options.createComment ?? vi.fn(async (args: { body: string }) => {
    const id = Math.max(0, ...comments.map((comment) => comment.id)) + 1;
    const comment: ProtocolComment = { id, body: args.body, user: BOT, workflow_sha: BASE };
    comments.push(comment);
    return { data: { id, body: args.body, html_url: `https://example.test/comment/${id}` } };
  });
  let nextStatusId = Math.max(0, ...statuses.map((status) => status.id)) + 1;
  const createCommitStatus = vi.fn(async (args: { sha: string; context?: string; description?: string | null }) => {
    const id = nextStatusId++;
    statuses.push({ id, sha: args.sha, context: args.context ?? "default", description: args.description ?? null });
    return { data: { id } };
  });
  const getComment = vi.fn(async (args: { comment_id: number }) => {
    const comment = comments.find((item) => item.id === args.comment_id);
    if (!comment) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { data: comment };
  });
  const issueGet = options.issueGet ?? vi.fn();
  const pullGet = options.pullGet ?? vi.fn();
  const github = {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      paginate: vi.fn(async (fn: unknown, args: { ref?: string }) => {
        if (fn === listCommitStatusesForRef) return statuses.filter((status) => status.sha === args.ref);
        if (fn === listCommits) return (options.commits ?? [BASE]).map((sha) => ({ sha }));
        if (fn === listComments) return comments;
        return [];
      }),
      rest: {
        issues: { listComments, getComment, createComment, get: issueGet },
        repos: {
          listCommitStatusesForRef,
          listCommits,
          createCommitStatus,
          getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "admin" } })),
        },
        pulls: { get: pullGet },
        git: { getRef: vi.fn(), createRef: vi.fn() },
      },
    },
  } as unknown as FugueGitHub;
  githubComments.set(github as unknown as object, comments);
  return github;
}

function integrationGithub(
  comments: ProtocolComment[],
  runs: Array<Record<string, unknown>>,
  dispatch: ReturnType<typeof vi.fn>,
): FugueGitHub {
  const listComments = vi.fn();
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      paginate: vi.fn(async (fn: unknown) => fn === listComments ? comments : []),
      rest: {
        issues: {
          listComments,
          createComment: vi.fn(async (args: { body: string }) => {
            const id = comments.length + 1;
            comments.push({ id, body: args.body, user: BOT });
            return { data: { id, body: args.body, html_url: "https://example.test/comment" } };
          }),
        },
        actions: {
          listWorkflowRuns: vi.fn(async () => ({
            data: {
              workflow_runs: runs.map((run) => ({
                actor: BOT,
                event: "workflow_dispatch",
                head_sha: BASE,
                run_attempt: 1,
                ...run,
              })),
            },
          })),
          createWorkflowDispatch: dispatch,
        },
      },
    },
  } as unknown as FugueGitHub;
}
