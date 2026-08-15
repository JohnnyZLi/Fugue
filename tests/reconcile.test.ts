import { describe, expect, it } from "vitest";
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
