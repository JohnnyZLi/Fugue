import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  currentRequiredCiState,
  requiredCiRunTitle,
  verifyRequiredCi,
} from "../src/core/ci.js";
import type { FugueGitHub } from "../src/core/github.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PR = 21;

describe("required CI provenance", () => {
  it("accepts the named job only from the protected-base target run bound to the exact PR head", async () => {
    const { github, listWorkflowRuns } = ciGithub([trustedRun()]);
    await expect(currentRequiredCiState(github, HEAD, ["test"], ".github/workflows/ci.yml"))
      .resolves.toBe("success");
    await expect(verifyRequiredCi(github, HEAD, ["test"], ".github/workflows/ci.yml"))
      .resolves.toEqual({ passed: true, checks: ["test"] });
    expect(listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({
      event: "pull_request_target",
      head_sha: BASE,
    }));
  });

  it("ignores a successful candidate pull_request workflow lookalike", async () => {
    const { github } = ciGithub([{
      ...trustedRun(),
      event: "pull_request",
      head_sha: HEAD,
    }]);
    await expect(currentRequiredCiState(github, HEAD, ["test"], ".github/workflows/ci.yml"))
      .resolves.toBe("missing");
    await expect(verifyRequiredCi(github, HEAD, ["test"], ".github/workflows/ci.yml"))
      .rejects.toThrow(/protected pull_request_target run/);
  });

  it("rejects a protected run whose durable title is bound to a different PR", async () => {
    const { github } = ciGithub([{
      ...trustedRun(),
      display_title: requiredCiRunTitle(PR + 1, HEAD),
    }]);
    await expect(currentRequiredCiState(github, HEAD, ["test"], ".github/workflows/ci.yml"))
      .resolves.toBe("missing");
  });

  it("executes candidate CI from protected pull_request_target code without write credentials", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toMatch(/^\s*pull_request:\s*$/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain('GITHUB_TOKEN: ""');
    expect(workflow).toContain('GH_TOKEN: ""');
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name");
  });
});

function trustedRun() {
  return {
    id: 1,
    event: "pull_request_target",
    head_sha: BASE,
    display_title: requiredCiRunTitle(PR, HEAD),
    status: "completed",
    conclusion: "success",
  };
}

function ciGithub(runs: Array<Record<string, unknown>>): {
  github: FugueGitHub;
  listWorkflowRuns: ReturnType<typeof vi.fn>;
} {
  const listWorkflowRuns = vi.fn(async () => ({ data: { workflow_runs: runs } }));
  const github = {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      rest: {
        actions: {
          listWorkflowRuns,
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
            data: [{
              number: PR,
              state: "open",
              head: { sha: HEAD },
              base: { sha: BASE },
            }],
          })),
        },
      },
    },
  } as unknown as FugueGitHub;
  return { github, listWorkflowRuns };
}
