import { describe, expect, it } from "vitest";
import { ManualChatExecutor } from "../src/core/executor.js";
import { planWork, type WorkflowObservation } from "../src/core/workflow.js";

function observation(overrides: Partial<WorkflowObservation> = {}): WorkflowObservation {
  return {
    issueNumber: 7,
    workId: "work-7",
    stateLabel: "state:working",
    workerClaimed: true,
    hasPr: true,
    prNumber: 11,
    prDraft: false,
    drift: [],
    ownership: "passed",
    ci: "success",
    baseCurrent: true,
    qa: [{ role: "code", state: "approved", supersededSessions: 0 }],
    controlPlaneChanged: false,
    humanControlPlaneAcknowledged: false,
    integration: "none",
    ...overrides,
  };
}

describe("workflow planner", () => {
  it("allocates ready unclaimed work", () => {
    expect(planWork(observation({
      stateLabel: "state:ready",
      workerClaimed: false,
      hasPr: false,
      prNumber: undefined,
      prDraft: false,
      ownership: "not_applicable",
      ci: "not_applicable",
      qa: [],
    }))).toEqual({ kind: "allocate_worker" });
  });

  it("waits for a claimed Worker to publish a PR", () => {
    expect(planWork(observation({
      hasPr: false,
      prNumber: undefined,
      prDraft: false,
      ownership: "not_applicable",
      ci: "not_applicable",
      qa: [],
    }))).toEqual({ kind: "wait_worker" });
  });

  it("updates a stale branch before CI or QA", () => {
    expect(planWork(observation({ baseCurrent: false }))).toEqual({ kind: "update_base" });
  });

  it("waits for exact-head required CI before QA", () => {
    expect(planWork(observation({ ci: "missing" }))).toEqual({ kind: "wait_ci", state: "missing" });
    expect(planWork(observation({ ci: "pending" }))).toEqual({ kind: "wait_ci", state: "pending" });
  });

  it("routes failed required CI back to the Worker", () => {
    expect(planWork(observation({ ci: "failure" }))).toEqual({
      kind: "resume_worker",
      roles: [],
      reason: "Required CI is failure.",
    });
  });

  it("starts Code QA before conditional later roles", () => {
    expect(planWork(observation({
      qa: [
        { role: "code", state: "none", supersededSessions: 0 },
        { role: "visual", state: "none", supersededSessions: 0 },
      ],
    }))).toEqual({ kind: "start_qa", roles: ["code"] });
  });

  it("starts remaining QA only after Code QA approves", () => {
    expect(planWork(observation({
      qa: [
        { role: "code", state: "approved", supersededSessions: 0 },
        { role: "security", state: "none", supersededSessions: 0 },
        { role: "visual", state: "none", supersededSessions: 0 },
      ],
    }))).toEqual({ kind: "start_qa", roles: ["security", "visual"] });
  });

  it("waits when Code QA is already active", () => {
    expect(planWork(observation({
      qa: [{ role: "code", state: "pending", supersededSessions: 0 }],
    }))).toEqual({ kind: "wait_qa", roles: ["code"] });
  });

  it("routes changes requested back to the existing Worker", () => {
    expect(planWork(observation({
      qa: [{ role: "code", state: "changes_requested", supersededSessions: 0 }],
    }))).toEqual({ kind: "resume_worker", roles: ["code"] });
  });

  it("blocks ownership violations before QA", () => {
    const result = planWork(observation({ ownership: "failed", ownershipDetail: "README.md (unassigned)" }));
    expect(result).toEqual({ kind: "blocked", reason: "Ownership violation: README.md (unassigned)" });
  });

  it("requires human acknowledgement for control-plane changes", () => {
    expect(planWork(observation({
      controlPlaneChanged: true,
      humanControlPlaneAcknowledged: false,
    }))).toEqual({ kind: "human_control_plane_ack" });
  });

  it("promotes a draft PR before Integration", () => {
    expect(planWork(observation({ prDraft: true }))).toEqual({ kind: "mark_pr_ready" });
  });

  it("dispatches Integration after all current QA is approved and the PR is ready", () => {
    expect(planWork(observation())).toEqual({ kind: "integrate" });
  });

  it("reports merge-ready only for current successful Integration", () => {
    expect(planWork(observation({ integration: "success" }))).toEqual({ kind: "ready_to_merge" });
  });

  it("reruns stale Integration evidence rather than treating it as merge-ready", () => {
    expect(planWork(observation({ integration: "stale" }))).toEqual({ kind: "integrate" });
  });

  it("blocks on repository drift before mutating workflow", () => {
    const result = planWork(observation({ drift: ["branch mismatch"] }));
    expect(result.kind).toBe("blocked");
  });
});

describe("manual-chat executor", () => {
  it("produces a self-contained Worker reconstruction prompt without terminal relay", () => {
    const instruction = new ManualChatExecutor().instruction({
      repository: "JohnnyZLi/Path",
      role: "worker",
      issueNumber: 7,
      workId: "work-7",
    });
    expect(instruction.prompt).toContain("JohnnyZLi/Path work-7");
    expect(instruction.prompt).toContain("Reconstruct the current assignment");
    expect(instruction.prompt).not.toContain("fugue handoff");
  });

  it("produces an independent QA reconstruction/submission prompt", () => {
    const instruction = new ManualChatExecutor().instruction({
      repository: "JohnnyZLi/Path",
      role: "visual-qa",
      prNumber: 11,
    });
    expect(instruction.prompt).toContain("Visual QA");
    expect(instruction.prompt).toContain("exact committed evaluation identity");
    expect(instruction.prompt).toContain("fugue-review-submit");
    expect(instruction.prompt).toContain("Do not implement fixes");
  });
});
