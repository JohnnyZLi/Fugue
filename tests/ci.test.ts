import { describe, expect, it, vi } from "vitest";
import { currentRequiredCiState, verifyRequiredCi } from "../src/core/ci.js";
import type { FugueGitHub } from "../src/core/github.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

 describe("required CI provenance", () => {
  it("accepts the named job only from a workflow definition identical to protected base", async () => {
    const github = ciGithub("workflow-blob", "workflow-blob");
    await expect(currentRequiredCiState(github, HEAD, ["test"], ".github/workflows/ci.yml"))
      .resolves.toBe("success");
    await expect(verifyRequiredCi(github, HEAD, ["test"], ".github/workflows/ci.yml"))
      .resolves.toEqual({ passed: true, checks: ["test"] });
  });

  it("rejects a successful lookalike CI job when the candidate changed the workflow file", async () => {
    const github = ciGithub("candidate-workflow", "protected-workflow");
    await expect(currentRequiredCiState(github, HEAD, ["test"], ".github/workflows/ci.yml"))
      .resolves.toBe("error");
    await expect(verifyRequiredCi(github, HEAD, ["test"], ".github/workflows/ci.yml"))
      .rejects.toThrow(/differs from protected base/);
  });
});

function ciGithub(headWorkflowSha: string, baseWorkflowSha: string): FugueGitHub {
  const getContent = vi.fn(async (args: { ref?: string }) => ({
    data: {
      type: "file",
      sha: args.ref === HEAD ? headWorkflowSha : baseWorkflowSha,
    },
  }));
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      rest: {
        actions: {
          listWorkflowRuns: vi.fn(async () => ({
            data: {
              workflow_runs: [{
                id: 1,
                event: "pull_request",
                head_sha: HEAD,
                status: "completed",
                conclusion: "success",
              }],
            },
          })),
          listJobsForWorkflowRun: vi.fn(async () => ({
            data: {
              jobs: [{
                id: 10,
                name: "test",
                status: "completed",
                conclusion: "success",
              }],
            },
          })),
        },
        repos: {
          listPullRequestsAssociatedWithCommit: vi.fn(async () => ({
            data: [{ state: "open", head: { sha: HEAD }, base: { sha: BASE } }],
          })),
          getContent,
        },
      },
    },
  } as unknown as FugueGitHub;
}
