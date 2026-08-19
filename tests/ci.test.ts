import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  currentRequiredCiState,
  requiredCiRunTitle,
  verifyRequiredCi,
} from "../src/core/ci.js";
import type { FugueGitHub } from "../src/core/github.js";
import {
  HISTORICAL_INTEGRATION_H_ONLY_CLEANUP_BUDGET,
  historicalIntegrationWinnerClaimCanBeReclaimed,
  integrationExactRunCommitSchema,
  integrationIdentityLostCommitSchema,
} from "../src/core/integration-status.js";
import { createIntegrationRecord, createIntegrationRequest } from "../src/core/integration-plan.js";

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

const HISTORICAL_B1 = "1".repeat(40);
const HISTORICAL_B2 = "2".repeat(40);
const HISTORICAL_B3 = "3".repeat(40);
const HISTORICAL_FULL_NAME = "JohnnyZLi/Fugue";

function historicalHFixture(kind: "exact" | "lost", recoveryBaseSha = HISTORICAL_B2) {
  const identity = {
    prNumber: 811,
    headSha: "a".repeat(40),
    baseBranch: "main",
    baseSha: HISTORICAL_B1,
    policyDigest: "sha256:historical-policy",
    protocolVersion: 1 as const,
    issueNumber: 18,
    workId: "work-18",
    workSpecDigest: "sha256:historical-spec",
  };
  const request = createIntegrationRequest(identity, "2026-08-18T20:00:00.000Z", "1234567890abcdef");
  const requestToken = createHash("sha256").update(request.request_id, "utf8").digest("hex").slice(0, 16).toUpperCase();
  const anchorName = `FUGUE_INT_A_${String(identity.prNumber).padStart(10, "0")}_${requestToken}`;
  const record = createIntegrationRecord(request, {
    dispatch: { secret_digest: "f".repeat(64), authorized_at: "2026-08-18T20:00:00.000Z", anchor_name: anchorName },
    createdAt: "2026-08-18T20:00:00.000Z",
  });
  const historicalBody = "signed protected B1 normal-d3 body";
  const historicalRecordDigest = `sha256:${createHash("sha256").update(historicalBody, "utf8").digest("hex")}`;
  const commit = kind === "exact"
    ? integrationExactRunCommitSchema.parse({
        version: 1,
        kind: "integration_exact_run_commit",
        request_id: request.request_id,
        pr_number: identity.prNumber,
        head_sha: identity.headSha,
        base_sha: identity.baseSha,
        anchor_name: anchorName,
        run_id: 881001,
        run_attempt: 1,
        run_created_at: "2026-08-18T20:00:02.000Z",
        html_url: `https://github.com/${HISTORICAL_FULL_NAME}/actions/runs/881001`,
      })
    : integrationIdentityLostCommitSchema.parse({
        version: 1,
        kind: "integration_identity_lost_commit",
        request_id: request.request_id,
        pr_number: identity.prNumber,
        head_sha: identity.headSha,
        base_sha: identity.baseSha,
        anchor_name: anchorName,
        attempt: 1,
        boundary_created_at: "2026-08-18T20:00:01.000Z",
        fence_digest: `sha256:${"e".repeat(64)}`,
        created_at: "2026-08-18T20:11:00.000Z",
      });
  const claim = {
    version: 1,
    kind: "historical_integration_winner_claim",
    request_id: request.request_id,
    pr_number: identity.prNumber,
    head_sha: identity.headSha,
    base_sha: identity.baseSha,
    anchor_name: anchorName,
    historical_record_digest: historicalRecordDigest,
    recovery_base_sha: recoveryBaseSha,
    commit,
    created_at: "2026-08-18T20:12:00.000Z",
  };
  const suffix = createHash("sha256").update(request.request_id, "utf8").digest("hex").slice(0, 32).toUpperCase();
  const variableName = `FUGUE_INT_H_${suffix}_${recoveryBaseSha.toUpperCase()}`;
  return {
    record,
    historicalBody,
    commit,
    claim,
    variableName,
    rawClaim: JSON.stringify(claim),
  };
}

function hReclaimable(fixture: ReturnType<typeof historicalHFixture>, rawClaim = fixture.rawClaim, variableName = fixture.variableName, durableWinnerCommit = fixture.commit) {
  return historicalIntegrationWinnerClaimCanBeReclaimed({
    repositoryFullName: HISTORICAL_FULL_NAME,
    variableName,
    rawClaim,
    historicalRecord: fixture.record,
    historicalBody: fixture.historicalBody,
    durableWinnerCommit,
  });
}

describe("historical H-only restart cleanup", () => {
  it("reclaims exact-L and identity_lost H-only crash residue only after the same permanent winner is independently supplied", () => {
    expect(hReclaimable(historicalHFixture("exact"))).toBe(true);
    expect(hReclaimable(historicalHFixture("lost"))).toBe(true);

    const exact = historicalHFixture("exact");
    const lost = historicalHFixture("lost");
    expect(hReclaimable(exact, exact.rawClaim, exact.variableName, lost.commit)).toBe(false);
    expect(hReclaimable(lost, lost.rawClaim, lost.variableName, exact.commit)).toBe(false);
  });

  it("allows a stale B2 H to be garbage-collected after B3 without making the current base part of H authority", () => {
    const staleB2 = historicalHFixture("exact", HISTORICAL_B2);
    const currentProtectedBase = HISTORICAL_B3;
    expect(currentProtectedBase).not.toBe(staleB2.claim.recovery_base_sha);
    expect(hReclaimable(staleB2)).toBe(true);
  });

  it("fails closed for malformed, foreign, recovery-unqualified, body-digest-mismatched, and conflicting H", () => {
    const exact = historicalHFixture("exact");
    expect(hReclaimable(exact, "{" )).toBe(false);

    const foreign = { ...exact.claim, head_sha: "9".repeat(40) };
    expect(hReclaimable(exact, JSON.stringify(foreign))).toBe(false);

    const wrongAnchor = { ...exact.claim, anchor_name: exact.claim.anchor_name.replace(/.$/, "0") };
    expect(hReclaimable(exact, JSON.stringify(wrongAnchor))).toBe(false);

    const wrongDigest = { ...exact.claim, historical_record_digest: `sha256:${"0".repeat(64)}` };
    expect(hReclaimable(exact, JSON.stringify(wrongDigest))).toBe(false);

    const sameOldBase = historicalHFixture("exact", HISTORICAL_B1);
    expect(hReclaimable(sameOldBase)).toBe(false);

    const wrongName = exact.variableName.replace(HISTORICAL_B2.toUpperCase(), HISTORICAL_B3.toUpperCase());
    expect(hReclaimable(exact, exact.rawClaim, wrongName)).toBe(false);

    const lost = historicalHFixture("lost");
    const conflicting = { ...exact.claim, commit: lost.commit };
    expect(hReclaimable(exact, JSON.stringify(conflicting))).toBe(false);
  });

  it("is idempotent across an immediate crash before deletion and drains more than 64 independently qualified H-only residues in bounded passes", () => {
    const fixture = historicalHFixture("exact");
    const crashResidue = new Map([[fixture.variableName, fixture.rawClaim]]);
    expect(hReclaimable(fixture, crashResidue.get(fixture.variableName)!)).toBe(true);
    expect(crashResidue.size).toBe(1); // crash before DELETE
    if (hReclaimable(fixture, crashResidue.get(fixture.variableName)!)) crashResidue.delete(fixture.variableName);
    expect(crashResidue.size).toBe(0);

    const residues = new Map<string, ReturnType<typeof historicalHFixture>>();
    for (let index = 0; index < 65; index += 1) {
      const recoveryBase = (0x4000 + index).toString(16).padStart(40, "0");
      const candidate = historicalHFixture("exact", recoveryBase);
      residues.set(candidate.variableName, candidate);
    }
    let passes = 0;
    while (residues.size) {
      passes += 1;
      let budget = HISTORICAL_INTEGRATION_H_ONLY_CLEANUP_BUDGET;
      for (const [name, candidate] of [...residues]) {
        if (budget <= 0) break;
        budget -= 1;
        if (hReclaimable(candidate, candidate.rawClaim, name)) residues.delete(name);
      }
    }
    expect(passes).toBe(Math.ceil(65 / HISTORICAL_INTEGRATION_H_ONLY_CLEANUP_BUDGET));
    expect(residues.size).toBe(0);
  });

  it("keeps H non-authoritative and requires old normal d3 plus a durable historical winner before exact-value deletion", async () => {
    const source = await readFile("src/core/integration-status.ts", "utf8");
    const start = source.indexOf("async function reclaimHistoricalIntegrationWinnerClaimOrphans");
    const end = source.indexOf("async function reclaimHistoricalIntegrationAuthorityVariables", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const scavenger = source.slice(start, end);
    expect(scavenger).toContain("recoverHistoricalIntegrationRecord");
    expect(scavenger).toContain("recoverHistoricalIntegrationWinner");
    expect(scavenger).toContain("historicalIntegrationWinnerClaimCanBeReclaimed");
    expect(scavenger).toContain("getFugueAuthorityVariable(github, variable.name) !== variable.value");
    expect(scavenger).not.toContain("ensureHistoricalIntegrationWinner");
    expect(scavenger).not.toContain("publishDurableProtocolRecord");
    expect(scavenger).not.toContain("claimIntegrationCommit");

    const entry = source.indexOf("export async function reclaimOrphanIntegrationAuthorityVariables");
    const entryEnd = source.indexOf("function integrationRunBindingFromEvidence", entry);
    const cleanup = source.slice(entry, entryEnd);
    expect(cleanup.indexOf("reclaimHistoricalIntegrationAuthorityVariables")).toBeGreaterThanOrEqual(0);
    expect(cleanup.indexOf("reclaimHistoricalIntegrationWinnerClaimOrphans")).toBeGreaterThan(
      cleanup.indexOf("reclaimHistoricalIntegrationAuthorityVariables"),
    );
  });
});
