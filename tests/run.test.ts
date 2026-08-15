import { describe, expect, it } from "vitest";
import {
  notificationFingerprint,
  qaExecutionFingerprint,
  workerExecutionFingerprint,
} from "../src/commands/run.js";
import type { WorkState } from "../src/core/state.js";
import type { WorkflowObservation } from "../src/core/workflow.js";

function work(headSha: string | null = null): WorkState {
  return {
    issueNumber: 7,
    title: "Example work",
    url: "https://github.com/JohnnyZLi/Path/issues/7",
    stateLabel: "state:working",
    metadata: {
      version: 1,
      work_id: "work-7",
      spec: {
        dependencies: [],
        ownership: { owned: [], coordinate: [], forbidden: [] },
        qa: { force: [] },
        authorized_changes: { agents_invariants: [] },
      },
      execution: { worker_id: "wkr-12345678", branch: "agent/7-example" },
    },
    workSpecDigest: "sha256:spec",
    pr: headSha ? {
      number: 11,
      url: "https://github.com/JohnnyZLi/Path/pull/11",
      headSha,
      headBranch: "agent/7-example",
      draft: true,
      metadata: {
        version: 1,
        work_id: "work-7",
        issue: 7,
        worker_id: "wkr-12345678",
        branch: "agent/7-example",
      },
    } : null,
    drift: [],
  };
}

function observation(): WorkflowObservation {
  return {
    issueNumber: 7,
    workId: "work-7",
    stateLabel: "state:working",
    workerClaimed: true,
    hasPr: true,
    prNumber: 11,
    prDraft: true,
    drift: [],
    qa: [{ role: "code", state: "pending", supersededSessions: 0 }],
    controlPlaneChanged: false,
    humanControlPlaneAcknowledged: false,
    integration: "none",
  };
}

describe("autonomous run notification fingerprints", () => {
  it("uses one Worker execution key before a PR exists", () => {
    const item = work();
    expect(workerExecutionFingerprint(item)).toBe("worker|work-7|sha256:spec|no-pr");
  });

  it("normalizes QA role ordering so equivalent prompts are not repeated", () => {
    const item = work("abcdef1234567890");
    expect(qaExecutionFingerprint(item, ["visual", "code"]))
      .toBe(qaExecutionFingerprint(item, ["code", "visual"]));
  });

  it("changes the workflow notification when the exact PR head changes", () => {
    const before = notificationFingerprint(
      work("abcdef1234567890"),
      observation(),
      { kind: "wait_qa", roles: ["code"] },
    );
    const after = notificationFingerprint(
      work("fedcba0987654321"),
      observation(),
      { kind: "wait_qa", roles: ["code"] },
    );
    expect(before).not.toBe(after);
  });
});
