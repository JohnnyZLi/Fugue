import { describe, expect, it, vi } from "vitest";
import { parseWorkMetadata, upsertWorkMetadata } from "../src/core/metadata.js";
import { canonicalizePrMetadata, parsePrMetadata } from "../src/core/pr-metadata.js";
import { allocateWorker, dispatchIntegration } from "../src/core/reconcile.js";
import { externalInstruction, renderStateComment } from "../src/core/state-comment.js";
import type { FugueGitHub } from "../src/core/github.js";
import type { ActivePolicy } from "../src/core/policy.js";
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
    },
    config: {
      branches: {
        worker_pattern: "agent/{issue}-{slug}",
      },
    },
  } as unknown as ActivePolicy;
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
  it("does not publish a pending Integration marker before a dispatch succeeds", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("simulated dispatch failure");
    });
    const createCommitStatus = vi.fn();
    const github = {
      repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
      octokit: {
        rest: {
          actions: { createWorkflowDispatch: dispatch },
          repos: { createCommitStatus },
        },
      },
    } as unknown as FugueGitHub;

    await expect(dispatchIntegration(github, "main", work())).rejects.toThrow(/simulated dispatch failure/);
    expect(createCommitStatus).not.toHaveBeenCalled();
  });

  it("dispatches first and only then publishes the queued Integration marker", async () => {
    const dispatch = vi.fn(async () => ({ data: {} }));
    const createCommitStatus = vi.fn(async () => ({ data: {} }));
    const github = {
      repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
      octokit: {
        rest: {
          actions: { createWorkflowDispatch: dispatch },
          repos: { createCommitStatus },
        },
      },
    } as unknown as FugueGitHub;

    await dispatchIntegration(github, "main", work());

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(createCommitStatus).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(createCommitStatus.mock.invocationCallOrder[0] ?? 0);
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
