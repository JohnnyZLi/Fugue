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
import { allocateWorker, dispatchIntegration, ingestCoordinatorIssueEvent } from "../src/core/reconcile.js";
import { externalInstruction, renderStateComment, upsertStateComment } from "../src/core/state-comment.js";
import {
  createCanonicalWorkState,
  parseCanonicalWorkState,
  serializeCanonicalWorkState,
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
    isReusableProtocolComment: vi.fn(trusted),
    createProtocolComment: vi.fn(async (github: FugueGitHub, issueNumber: number, body: string) => {
      const response = await github.octokit.rest.issues.createComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        issue_number: issueNumber,
        body,
      });
      return { data: { html_url: response.data.html_url } };
    }),
    updateProtocolComment: vi.fn(async (github: FugueGitHub, commentId: number, body: string) => {
      const response = await github.octokit.rest.issues.updateComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        comment_id: commentId,
        body,
      });
      return { data: { html_url: response.data.html_url } };
    }),
  };
});

const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

function canonicalWork(draft = true) {
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
    issue: 18, title: item.title, state: "state:ready", agentReady: true,
    requirements: item.requirements, metadata, baseSha: BASE,
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
      prNumber: 21, headSha: HEAD, baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1, issueNumber: 18,
      workId: "work-18", workSpecDigest: "sha256:spec",
    },
    pr: { number: 21 },
  } as unknown as EvaluationSnapshot;
}

function observation(overrides: Partial<WorkflowObservation> = {}): WorkflowObservation {
  return {
    issueNumber: 18, workId: "work-18", stateLabel: "state:working", workerClaimed: true,
    hasPr: true, prNumber: 21, prDraft: true, drift: [], ownership: "passed", ci: "success",
    baseCurrent: true,
    qa: [
      { role: "code", state: "none", supersededSessions: 0 },
      { role: "security", state: "none", supersededSessions: 0 },
    ],
    controlPlaneChanged: false, humanControlPlaneAcknowledged: false, integration: "none", ...overrides,
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

describe("protected canonical work state", () => {
  it("refuses candidate Actions issue events as a durable-state authority", async () => {
    const createComment = vi.fn();
    const github = coordinatorGithub([], createComment);
    await expect(ingestCoordinatorIssueEvent(github, policy(), {
      eventName: "issues", action: "edited", actor: FUGUE_PROTOCOL_ACTOR, issueNumber: 18,
    })).resolves.toBe(false);
    expect(createComment).not.toHaveBeenCalled();
    expect(github.octokit.rest.issues.get).not.toHaveBeenCalled();
  });

  it("lets an authorized Coordinator update the spec but preserves protected Worker/link identity", async () => {
    const original = canonicalWork();
    const comments: ProtocolComment[] = [{ id: 1, body: serializeCanonicalWorkState(original), user: BOT }];
    const attackerMetadata = workMetadataSchema.parse({
      ...original.metadata,
      spec: { ...original.metadata.spec, dependencies: [99] },
      execution: { worker_id: "wkr-attacker", branch: "agent/18-attacker" },
    });
    const body = upsertWorkMetadata("## Outcome\nCoordinator-approved new spec", attackerMetadata);
    const github = coordinatorGithub(comments, vi.fn(async (args: { body: string }) => {
      comments.push({ id: comments.length + 1, body: args.body, user: BOT });
      return { data: { html_url: "https://example.test/comment" } };
    }), body);
    await expect(ingestCoordinatorIssueEvent(github, policy(), {
      eventName: "issues", action: "edited", actor: "JohnnyZLi", issueNumber: 18,
    })).resolves.toBe(true);
    const next = parseCanonicalWorkState(comments.at(-1)!.body)!;
    expect(next.metadata.spec.dependencies).toEqual([99]);
    expect(next.metadata.execution).toEqual(original.metadata.execution);
    expect(next.pr).toEqual(original.pr);
  });
});

describe("dependency trust boundary", () => {
  it("does not let closed issues or forged PR-body linkage satisfy a dependency", async () => {
    const metadata = workMetadataSchema.parse({
      version: 1, work_id: "work-99", spec: {},
      execution: { worker_id: "wkr-dependency", branch: "agent/99-dependency" },
    });
    const dependency = createCanonicalWorkState({
      issue: 99, title: "Dependency", state: "state:working", agentReady: true,
      requirements: "Dependency", metadata,
      pr: {
        number: 50, draft: false,
        metadata: { version: 1, work_id: "work-99", issue: 99, worker_id: "wkr-dependency", branch: "agent/99-dependency" },
      },
      baseSha: BASE,
    });
    const comments: ProtocolComment[] = [{ id: 1, body: serializeCanonicalWorkState(dependency), user: BOT }];
    const github = {
      repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
      octokit: {
        paginate: vi.fn(async () => comments),
        rest: {
          issues: { listComments: vi.fn(), get: vi.fn() },
          pulls: {
            list: vi.fn(),
            get: vi.fn(async () => ({ data: {
              merged: false, head: { ref: "agent/99-dependency" },
              body: "<!-- fugue-pr\nversion: 1\nwork_id: work-99\nissue: 99\nworker_id: forged\nbranch: forged\n-->",
            } })),
          },
        },
      },
    } as unknown as FugueGitHub;
    await expect(verifyDependenciesSatisfied(github, [99])).rejects.toThrow(/canonical PR #50 is not merged/);
    expect(github.octokit.rest.issues.get).not.toHaveBeenCalled();
    expect(github.octokit.rest.pulls.list).not.toHaveBeenCalled();
  });
});

describe("restart-safe Worker allocation", () => {
  it("can retry after branch creation succeeded but signed claim publication failed", async () => {
    const item = readyWork();
    let branchSha: string | null = null;
    const comments: ProtocolComment[] = [];
    const createComment = vi.fn()
      .mockRejectedValueOnce(new Error("simulated canonical publication crash"))
      .mockImplementation(async (args: { body: string }) => {
        comments.push({ id: 1, body: args.body, user: BOT });
        return { data: { html_url: "https://example.test/comment" } };
      });
    const github = {
      repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
      octokit: {
        paginate: vi.fn(async () => comments),
        rest: {
          issues: { listComments: vi.fn(), createComment },
          git: {
            getRef: vi.fn(async () => {
              if (!branchSha) throw Object.assign(new Error("Not Found"), { status: 404 });
              return { data: { object: { sha: branchSha } } };
            }),
            createRef: vi.fn(async (args: { sha: string }) => { branchSha = args.sha; return { data: {} }; }),
          },
        },
      },
    } as unknown as FugueGitHub;
    await expect(allocateWorker(github, policy(), item)).rejects.toThrow(/publication crash/);
    expect(branchSha).toBe(BASE);
    await expect(allocateWorker(github, policy(), item)).resolves.toBeUndefined();
    expect(github.octokit.rest.git.createRef).toHaveBeenCalledTimes(1);
    expect(parseCanonicalWorkState(comments[0]!.body)?.metadata.execution.worker_id).toMatch(/^wkr-/);
  });
});

describe("Integration request/run causality", () => {
  it("ignores an exact same-PR/request preplay run created before the signed durable request", async () => {
    const current = snapshot();
    const request = createIntegrationRequest(current.identity, "2026-08-16T20:00:10.000Z", "0123456789abcdef");
    const comments: ProtocolComment[] = [{ id: 1, body: serializeIntegrationRequest(request), user: BOT }];
    const runs = [{
      display_title: integrationRunTitle(request.request_id, 21),
      created_at: "2026-08-16T20:00:09.000Z",
      status: "completed", conclusion: "failure", html_url: "https://example.test/preplay",
    }];
    const github = integrationGithub(comments, runs, vi.fn());
    const state = await currentIntegrationState(github, current, Date.parse(request.created_at) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1);
    expect(state.state).toBe("none");
  });

  it("reuses the signed request across restart and dispatches its unpredictable ID", async () => {
    const current = snapshot();
    const request = createIntegrationRequest(current.identity, "2026-08-16T20:00:10.000Z", "0123456789abcdef");
    const comments: ProtocolComment[] = [{ id: 1, body: serializeIntegrationRequest(request), user: BOT }];
    const dispatch = vi.fn(async () => ({ data: {} }));
    const github = integrationGithub(comments, [], dispatch);
    await dispatchIntegration(github, policy(), work(), Date.parse(request.created_at) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ inputs: { pr: 21, request_id: request.request_id } }));
    expect(comments).toHaveLength(1);
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
      comments.find((comment) => comment.id === args.comment_id)!.body = args.body;
      return { data: { html_url: "https://example.test/state" } };
    });
    const deleteComment = vi.fn(async (args: { comment_id: number }) => {
      const index = comments.findIndex((comment) => comment.id === args.comment_id);
      if (index >= 0) comments.splice(index, 1);
      return { data: {} };
    });
    const createComment = vi.fn();
    const github = {
      repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
      octokit: { paginate: vi.fn(async () => comments), rest: { issues: { listComments: vi.fn(), updateComment, deleteComment, createComment } } },
    } as unknown as FugueGitHub;
    await upsertStateComment(github, item, { kind: "wait_qa", roles: ["code"] });
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 10 }));
    expect(deleteComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 11 }));
    expect(comments).toHaveLength(1);
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
}

function coordinatorGithub(
  comments: ProtocolComment[],
  createComment: ReturnType<typeof vi.fn>,
  body = upsertWorkMetadata("## Outcome\nTrusted", workMetadataSchema.parse({ version: 1, work_id: "work-18", spec: {}, execution: {} })),
): FugueGitHub {
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      paginate: vi.fn(async () => comments),
      rest: {
        issues: {
          listComments: vi.fn(), createComment,
          get: vi.fn(async () => ({ data: { number: 18, title: "Chat-first orchestration", body, labels: ["state:working", "agent:ready"] } })),
        },
        repos: { getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "admin" } })) },
      },
    },
  } as unknown as FugueGitHub;
}

function integrationGithub(comments: ProtocolComment[], runs: Array<Record<string, unknown>>, dispatch: ReturnType<typeof vi.fn>): FugueGitHub {
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      paginate: vi.fn(async () => comments),
      rest: {
        issues: {
          listComments: vi.fn(),
          createComment: vi.fn(async (args: { body: string }) => {
            comments.push({ id: comments.length + 1, body: args.body, user: BOT });
            return { data: { html_url: "https://example.test/comment" } };
          }),
        },
        actions: {
          listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: runs.map((run) => ({ actor: BOT, event: "workflow_dispatch", head_sha: BASE, ...run })) } })),
          createWorkflowDispatch: dispatch,
        },
      },
    },
  } as unknown as FugueGitHub;
}
