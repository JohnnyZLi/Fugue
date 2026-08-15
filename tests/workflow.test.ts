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
      qa: [],
    }))).toEqual({ kind: "allocate_worker" });
  });

  it("waits for a claimed Worker to publish a PR", () => {
    expect(planWork(observation({ hasPr: false, prNumber: undefined, prDraft: false, qa: [] }))).toEqual({ kind: "wait_worker" });
  });

  it("starts all required QA that has no active evidence", () => {
    expect(planWork(observation({
      qa: [
        { role: "code", state: "none", supersededSessions: 0 },
        { role: "visual", state: "none", supersededSessions: 0 },
      ],
    }))).toEqual({ kind: "start_qa", roles: ["code", "visual"] });
  });

  it("waits when QA sessions are already active", () => {
    expect(planWork(observation({
      qa: [{ role: "code", state: "pending", supersededSessions: 0 }],
    }))).toEqual({ kind: "wait_qa", roles: ["code"] });
  });

  it("routes changes requested back to the existing Worker", () => {
    expect(planWork(observation({
      qa: [{ role: "code", state: "changes_requested", supersededSessions: 0 }],
    }))).toEqual({ kind: "resume_worker", roles: ["code"] });
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

  it("runs Integration after all current QA is approved and the PR is ready", () => {
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
  it("produces a self-contained Worker reconstruction prompt", () => {
    const instruction = new ManualChatExecutor().instruction({
      repository: "JohnnyZLi/Path",
      role: "worker",
      issueNumber: 7,
      workId: "work-7",
    });
    expect(instruction.prompt).toContain("JohnnyZLi/Path work-7");
    expect(instruction.prompt).toContain("Reconstruct your assignment from GitHub");
  });

  it("produces an independent QA reconstruction prompt", () => {
    const instruction = new ManualChatExecutor().instruction({
      repository: "JohnnyZLi/Path",
      role: "visual-qa",
      prNumber: 11,
    });
    expect(instruction.prompt).toContain("Visual QA");
    expect(instruction.prompt).toContain("exact committed evaluation identity");
    expect(instruction.prompt).toContain("Do not implement fixes");
  });
});
