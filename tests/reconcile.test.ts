import { describe, expect, it, vi } from "vitest";
import type { EvaluationSnapshot } from "../src/core/evaluation.js";
import type { FugueGitHub } from "../src/core/github.js";
import {
  createIntegrationRequest,
  integrationRunTitle,
  parseIntegrationRequest,
  serializeIntegrationRequest,
} from "../src/core/integration-plan.js";
import {
  currentIntegrationState,
  INTEGRATION_REQUEST_RECOVERY_GRACE_MS,
} from "../src/core/integration-status.js";
import { parseWorkMetadata, upsertWorkMetadata } from "../src/core/metadata.js";
import { canonicalizePrMetadata, parsePrMetadata } from "../src/core/pr-metadata.js";
import type { ActivePolicy } from "../src/core/policy.js";
import { allocateWorker, dispatchIntegration } from "../src/core/reconcile.js";
import { externalInstruction, renderStateComment } from "../src/core/state-comment.js";
import type { WorkState } from "../src/core/state.js";
import { planWork, type WorkflowObservation } from "../src/core/workflow.js";

function work(): WorkState {
  return {
    issueNumber: 18,
    title: "Chat-first orchestration",
    url: "https://github.com/JohnnyZLi/Fugue/issues/18",
    stateLabel: "state:working",
    metadata: {
      version: 1,
      work_id: "work-18",
      spec: {
        dependencies: [],
        ownership: { owned: ["src/**"], coordinate: [], forbidden: [] },
        qa: { force: ["code"] },
        authorized_changes: { agents_invariants: [] },
      },
      execution: {
        worker_id: "wkr-12345678",
        branch: "agent/18-chat-first",
      },
    },
    workSpecDigest: "sha256:spec",
    pr: {
      number: 21,
      url: "https://github.com/JohnnyZLi/Fugue/pull/21",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headBranch: "agent/18-chat-first",
      draft: true,
      metadata: {
        version: 1,
        work_id: "work-18",
        issue: 18,
        worker_id: "wkr-12345678",
        branch: "agent/18-chat-first",
      },
    },
    drift: [],
  };
}

function readyWork(): WorkState {
  const item = work();
  return {
    ...item,
    stateLabel: "state:ready",
    metadata: {
      ...item.metadata,
      execution: {},
    },
    pr: undefined,
  };
}

function policy(baseSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"): ActivePolicy {
  return {
    identity: {
      baseBranch: "main",
      baseSha,
      policyDigest: "sha256:policy",
      protocolVersion: 1,
    },
    config: {
      branches: {
        worker_pattern: "agent/{issue}-{slug}",
      },
    },
  } as unknown as ActivePolicy;
}

function snapshot(): EvaluationSnapshot {
  return {
    identity: {
      prNumber: 21,
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseBranch: "main",
      baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
  it("waits for CI before asking the Human to open QA", () => {
    expect(planWork(observation({ ci: "pending" }))).toEqual({ kind: "wait_ci", state: "pending" });
  });

  it("sequences Code QA before later expensive QA roles", () => {
    expect(planWork(observation())).toEqual({ kind: "start_qa", roles: ["code"] });
    expect(planWork(observation({
      qa: [
        { role: "code", state: "approved", supersededSessions: 0 },
        { role: "security", state: "none", supersededSessions: 0 },
      ],
    }))).toEqual({ kind: "start_qa", roles: ["security"] });
  });

  it("routes failed CI back to the existing Worker", () => {
    const action = planWork(observation({ ci: "failure" }));
    expect(action.kind).toBe("resume_worker");
  });

  it("blocks before QA on ownership violations", () => {
    const action = planWork(observation({ ownership: "failed", ownershipDetail: "package.json (unassigned)" }));
    expect(action).toEqual({ kind: "blocked", reason: "Ownership violation: package.json (unassigned)" });
  });
});

describe("restart-safe Worker allocation", () => {
  it("recovers when branch creation succeeded before Worker claim persistence failed", async () => {
    const item = readyWork();
    const activePolicy = policy();
    const issueBody = upsertWorkMetadata("Bootstrap work", item.metadata);
    let branchSha: string | null = null;
    let updateAttempts = 0;
    let persistedBody = "";

    const getRef = vi.fn(async () => {
      if (!branchSha) throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: { object: { sha: branchSha } } };
    });
    const createRef = vi.fn(async (args: { sha: string }) => {
      branchSha = args.sha;
      return { data: {} };
    });
    const updateIssue = vi.fn(async (args: { body?: string }) => {
      updateAttempts += 1;
      if (updateAttempts === 1) throw new Error("simulated issue persistence crash");
      persistedBody = args.body ?? "";
      return { data: {} };
    });

    const github = {
      repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
      octokit: {
        rest: {
          issues: {
            get: vi.fn(async () => ({
              data: {
                title: item.title,
                body: issueBody,
                labels: ["state:ready", "agent:ready"],
              },
            })),
            update: updateIssue,
          },
          git: { getRef, createRef },
        },
      },
    } as unknown as FugueGitHub;

    await expect(allocateWorker(github, activePolicy, item)).rejects.toThrow(/simulated issue persistence crash/);
    expect(branchSha).toBe(activePolicy.identity.baseSha);

    await expect(allocateWorker(github, activePolicy, item)).resolves.toBeUndefined();
    expect(createRef).toHaveBeenCalledTimes(1);
    expect(updateIssue).toHaveBeenCalledTimes(2);

    const persisted = parseWorkMetadata(persistedBody);
    expect(persisted?.execution.worker_id).toMatch(/^wkr-/);
    expect(persisted?.execution.branch).toMatch(/^agent\/18-/);
  });

  it("refuses to reuse a deterministic Worker branch that already diverged from protected base", async () => {
    const item = readyWork();
    const activePolicy = policy();
    const issueBody = upsertWorkMetadata("Bootstrap work", item.metadata);
    const github = {
      repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
      octokit: {
        rest: {
          issues: {
            get: vi.fn(async () => ({
              data: {
                title: item.title,
                body: issueBody,
                labels: ["state:ready", "agent:ready"],
              },
            })),
            update: vi.fn(),
          },
          git: {
            getRef: vi.fn(async () => ({
              data: { object: { sha: "cccccccccccccccccccccccccccccccccccccccc" } },
            })),
            createRef: vi.fn(),
          },
        },
      },
    } as unknown as FugueGitHub;

    await expect(allocateWorker(github, activePolicy, item)).rejects.toThrow(/already exists/);
    expect(github.octokit.rest.git.createRef).not.toHaveBeenCalled();
    expect(github.octokit.rest.issues.update).not.toHaveBeenCalled();
  });
});

describe("restart-safe Integration dispatch", () => {
  it("persists a request before dispatch and suppresses immediate replay when the run is not visible yet", async () => {
    const comments: Array<{ body: string }> = [];
    const dispatch = vi.fn(async () => ({ data: {} }));
    const github = integrationGithub(comments, [], dispatch);
    const activePolicy = policy();

    await dispatchIntegration(github, activePolicy, work());
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(comments).toHaveLength(1);

    const request = parseIntegrationRequest(comments[0]?.body ?? "");
    expect(request).not.toBeNull();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      inputs: { pr: "21", request_id: request?.request_id },
    }));

    const createdAt = Date.parse(request!.created_at);
    await dispatchIntegration(github, activePolicy, work(), createdAt + 1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not replay after the grace period when the request-bound Actions run exists", async () => {
    const comments: Array<{ body: string }> = [];
    const runs: Array<Record<string, unknown>> = [];
    const dispatch = vi.fn(async () => ({ data: {} }));
    const github = integrationGithub(comments, runs, dispatch);
    const activePolicy = policy();

    await dispatchIntegration(github, activePolicy, work());
    const request = parseIntegrationRequest(comments[0]?.body ?? "")!;
    runs.push({
      display_title: integrationRunTitle(request.request_id),
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/123",
    });

    await dispatchIntegration(
      github,
      activePolicy,
      work(),
      Date.parse(request.created_at) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("retries a persisted request after the grace period when dispatch never produced a run", async () => {
    const comments: Array<{ body: string }> = [];
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error("simulated dispatch failure"))
      .mockResolvedValue({ data: {} });
    const github = integrationGithub(comments, [], dispatch);
    const activePolicy = policy();

    await expect(dispatchIntegration(github, activePolicy, work())).rejects.toThrow(/simulated dispatch failure/);
    const request = parseIntegrationRequest(comments[0]?.body ?? "")!;

    await dispatchIntegration(github, activePolicy, work(), Date.parse(request.created_at) + 1);
    expect(dispatch).toHaveBeenCalledTimes(1);

    await dispatchIntegration(
      github,
      activePolicy,
      work(),
      Date.parse(request.created_at) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("treats a request-bound run as pending even when no commit-status marker exists", async () => {
    const current = snapshot();
    const createdAt = "2026-08-16T08:00:00.000Z";
    const request = createIntegrationRequest(current.identity, createdAt);
    const comments = [{ body: serializeIntegrationRequest(request) }];
    const runs = [{
      display_title: integrationRunTitle(request.request_id),
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/456",
    }];
    const github = integrationGithub(comments, runs, vi.fn());

    const state = await currentIntegrationState(
      github,
      current,
      Date.parse(createdAt) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1,
    );
    expect(state.state).toBe("pending");
    expect(state.request?.request_id).toBe(request.request_id);
  });

  it("makes an old durable request eligible for retry when no matching Actions run exists", async () => {
    const current = snapshot();
    const createdAt = "2026-08-16T08:00:00.000Z";
    const request = createIntegrationRequest(current.identity, createdAt);
    const github = integrationGithub([{ body: serializeIntegrationRequest(request) }], [], vi.fn());

    const state = await currentIntegrationState(
      github,
      current,
      Date.parse(createdAt) + INTEGRATION_REQUEST_RECOVERY_GRACE_MS + 1,
    );
    expect(state.state).toBe("none");
    expect(state.request?.request_id).toBe(request.request_id);
  });
});

describe("assigned PR adoption metadata", () => {
  const expected = {
    version: 1 as const,
    work_id: "work-18",
    issue: 18,
    worker_id: "wkr-12345678",
    branch: "agent/18-chat-first",
  };

  it("repairs malformed assigned-branch metadata and becomes idempotent", () => {
    const malformed = "Summary\n\n<!-- fugue-pr\nversion: nope\n";
    const repaired = canonicalizePrMetadata(malformed, expected);
    expect(parsePrMetadata(repaired)).toEqual(expected);
    expect(canonicalizePrMetadata(repaired, expected)).toBe(repaired);
  });

  it("replaces mismatched metadata with the durable Worker claim", () => {
    const mismatched = canonicalizePrMetadata("Summary", { ...expected, worker_id: "wkr-wrong" });
    const repaired = canonicalizePrMetadata(mismatched, expected);
    expect(parsePrMetadata(repaired)).toEqual(expected);
  });
});

describe("durable state comment", () => {
  it("gives the Human one copy/paste QA prompt with no Fugue terminal command", () => {
    const item = work();
    const action = { kind: "wait_qa", roles: ["code"] } as const;
    const instruction = externalInstruction("JohnnyZLi/Fugue", item, action);
    expect(instruction?.prompt).toContain("Fugue Code QA for JohnnyZLi/Fugue PR #21");
    expect(instruction?.prompt).toContain("fugue-review-submit");
    expect(instruction?.prompt).not.toContain("fugue review");
    expect(renderStateComment("JohnnyZLi/Fugue", item, action)).toContain("NEEDS CODE QA CHAT");
  });
});

function integrationGithub(
  comments: Array<{ body: string }>,
  runs: Array<Record<string, unknown>>,
  dispatch: ReturnType<typeof vi.fn>,
): FugueGitHub {
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      paginate: vi.fn(async () => comments),
      rest: {
        issues: {
          listComments: vi.fn(),
          createComment: vi.fn(async (args: { body: string }) => {
            comments.push({ body: args.body });
            return { data: { html_url: "https://github.com/JohnnyZLi/Fugue/pull/21#issuecomment-1" } };
          }),
        },
        actions: {
          listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: runs } })),
          createWorkflowDispatch: dispatch,
        },
        repos: {
          listCommitStatusesForRef: vi.fn(async () => ({ data: [] })),
        },
      },
    },
  } as unknown as FugueGitHub;
}
