import { describe, expect, it, vi } from "vitest";
import type { FugueGitHub } from "../src/core/github.js";

const { legacyEnsure } = vi.hoisted(() => ({
  legacyEnsure: vi.fn(async (github: FugueGitHub) => {
    const deployments = await github.octokit.request("GET /repos/{owner}/{repo}/deployments", {
      owner: "JohnnyZLi",
      repo: "Fugue",
    });
    const statuses = await github.octokit.request("GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses", {
      owner: "JohnnyZLi",
      repo: "Fugue",
      deployment_id: 1,
    });
    return { dispatch: false, observed: [deployments.data, statuses.data] };
  }),
}));

vi.mock("../src/core/integration-status-legacy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/integration-status-legacy.js")>();
  return {
    ...actual,
    getCurrentIntegrationRecord: vi.fn(async () => undefined),
    ensureIntegrationDispatch: legacyEnsure,
  };
});

vi.mock("../src/core/integration-run-witness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/integration-run-witness.js")>();
  return { ...actual, findEarliestProtectedIntegrationRunWitness: vi.fn(async () => undefined) };
});

import { ensureIntegrationDispatch } from "../src/core/integration-status.js";

describe("Integration deployment authority firewall", () => {
  it("makes forged, mutated, reordered, and deleted Deployment/Status histories invisible to run election", async () => {
    const publicUrl = "https://github.com/JohnnyZLi/Fugue/actions/runs/1?fugue_request=int-public&fugue_run_token=public";
    const forged = [{ id: 9, sha: "b".repeat(40), ref: "main", environment: "fugue-authority", statuses: [{ id: 90, environment_url: publicUrl }] }];
    const mutated = [{ ...forged[0], statuses: [{ id: 90, environment_url: publicUrl.replace("/runs/1", "/runs/2") }] }];
    const reordered = [{ id: 10, statuses: [{ id: 100, environment_url: publicUrl.replace("/runs/1", "/runs/3") }] }, ...mutated].reverse();
    const deleted: unknown[] = [];
    const attackerSnapshots = [forged, mutated, reordered, deleted];
    const underlyingRequest = vi.fn(async () => ({ data: attackerSnapshots.shift() ?? [] }));
    const github = {
      repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
      octokit: { request: underlyingRequest },
    } as unknown as FugueGitHub;
    const snapshot = {
      identity: {
        prNumber: 19,
        headSha: "a".repeat(40),
        baseBranch: "main",
        baseSha: "b".repeat(40),
        policyDigest: "sha256:policy",
        protocolVersion: 1,
        issueNumber: 18,
        workId: "work-18",
        workSpecDigest: "sha256:spec",
      },
    } as any;

    await expect(ensureIntegrationDispatch(github, snapshot)).resolves.toMatchObject({ dispatch: false, observed: [[], []] });
    expect(legacyEnsure).toHaveBeenCalledTimes(1);
    expect(underlyingRequest).not.toHaveBeenCalled();
    expect(attackerSnapshots).toHaveLength(4);
  });
});
