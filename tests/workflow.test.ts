import { readFile } from "node:fs/promises";
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

describe("cleanup-aware Integration run-start", () => {
  it("delegates cleanup fallback authority to the canonical d3 reader and propagates every fail-closed state", async () => {
    const workflow = await readFile(".github/workflows/fugue-integration.yml", "utf8");
    const beginMarker = "          // FUGUE_CLEANUP_D3_CANONICAL_BEGIN\n";
    const endMarker = "          // FUGUE_CLEANUP_D3_CANONICAL_END";
    const begin = workflow.indexOf(beginMarker);
    const end = workflow.indexOf(endMarker, begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const helperSource = workflow.slice(begin + beginMarker.length, end)
      .split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
    const execute = new AsyncFunction("deps", `${helperSource}\nreturn requireCanonicalCleanupBinding(deps);`) as
      (deps: Record<string, unknown>) => Promise<void>;

    const requestId = "int-0123456789abcdef-1234567890abcdef";
    const prNumber = 21;
    const baseSha = "b".repeat(40);
    const storageSha = "a".repeat(40);
    const anchorName = "FUGUE_INT_A_0000000021_0123456789ABCDEF";
    const runId = 7001;
    const runAttempt = 1;
    const record = {
      request: { request_id: requestId, identity: { prNumber, baseSha } },
      identity: { prNumber, baseSha },
      dispatch: { anchor_name: anchorName },
      run: { id: runId, attempt: 1 },
      created_at: "2026-08-18T18:00:01.000Z",
    };
    const cursor = {
      version: 1,
      kind: "durable_recovery",
      storage_sha: storageSha,
      publisher_sha: baseSha,
      scope: `integration/${prNumber}`,
    };
    const leaf = `<!-- fugue-durable-recovery\nversion: 1\npayload: ${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}\n-->`;
    const pack = JSON.stringify({ version: 1, kind: "durable_recovery_pack", entries: [leaf] });
    const variables = [{ name: "FUGUE_D3_AA_HINT", value: leaf }, { name: "FUGUE_D3P_AA_HINT", value: pack }];
    const baseDeps = {
      github: {},
      prNumber,
      baseSha,
      requestId,
      anchorName,
      runId,
      runAttempt,
      variables,
      parseIntegrationRecord: (body: string) => JSON.parse(body),
      sameEvaluationIdentity: () => true,
      matchesCleanupAwareDurableRunStartBinding: (value: any, context: any) =>
        value.request?.request_id === context.requestId && value.identity?.prNumber === context.prNumber &&
        value.identity?.baseSha === context.baseSha && value.dispatch?.anchor_name === context.anchorName &&
        value.run?.id === context.runId && value.run?.attempt === context.runAttempt,
    };
    await expect(execute({
      ...baseDeps,
      recoverDurableProtocolRecord: async () => ({ record: { value: record, body: JSON.stringify(record) } }),
    })).resolves.toBeUndefined();

    for (const reason of [
      "invalid outer publisher proof",
      "body digest mismatch",
      "manifest key/nonce mismatch",
      "invalid exact chunk-ID proof",
      "stale protected revision",
      "active recovery mutation guard",
      "provisional recovery cursor",
    ]) {
      await expect(execute({
        ...baseDeps,
        recoverDurableProtocolRecord: async () => { throw new Error(reason); },
      })).rejects.toThrow(reason);
    }

    await expect(execute({
      ...baseDeps,
      recoverDurableProtocolRecord: async () => ({ record: { value: { ...record, run: { id: runId + 1, attempt: 1 } }, body: "wrong" } }),
    })).rejects.toThrow(/Canonical durable Integration authority disagrees/);
    await expect(execute({
      ...baseDeps,
      variables: [{ name: "FUGUE_D3_AA_BAD", value: "not-a-cursor" }],
      recoverDurableProtocolRecord: async () => { throw new Error("must not be reached"); },
    })).rejects.toThrow(/canonical durable d3 exact-run authority/);
  });

  it("keeps normal A/F run-start local and uses d3 only in the deferred cleanup proof step", async () => {
    const workflow = await readFile(".github/workflows/fugue-integration.yml", "utf8");
    const runStart = workflow.slice(workflow.indexOf("Commit protected Integration run-start evidence"), workflow.indexOf("- uses: actions/checkout@v4"));
    const cleanup = workflow.slice(workflow.indexOf("Verify cleanup-aware run-start against canonical d3 authority"), workflow.indexOf("- uses: actions/checkout@v4", workflow.indexOf("Verify cleanup-aware run-start against canonical d3 authority")));
    expect(runStart).not.toContain("recoverDurableProtocolRecord");
    expect(runStart).not.toContain("FUGUE_D3_");
    expect(runStart).toContain("cleanup_proof_required=true");
    expect(cleanup).toContain("recoverDurableProtocolRecord");
    expect(cleanup).toContain("matchesCleanupAwareDurableRunStartBinding");
    expect(cleanup).toContain("listFugueAuthorityVariables");
    expect(cleanup).not.toContain("deployments");
    expect(cleanup).not.toContain("workflow-runs");
    expect(cleanup).not.toContain("issues/comments");
    expect(workflow.indexOf("npm run build")).toBeLessThan(workflow.indexOf("Verify cleanup-aware run-start against canonical d3 authority"));
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
