import { describe, expect, it, vi } from "vitest";
import type { EvaluationSnapshot } from "../src/core/evaluation.js";
import type { FugueGitHub } from "../src/core/github.js";
import { currentIntegrationState } from "../src/core/integration-status.js";
import {
  FUGUE_PROTOCOL_ACTOR,
  isTrustedProtocolActor,
  isTrustedProtocolComment,
  isTrustedProtocolCommitStatus,
  isTrustedProtocolWorkflowRun,
} from "../src/core/provenance.js";

const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;
const USER = { login: "JohnnyZLi", type: "User" } as const;

const SNAPSHOT = {
  identity: {
    prNumber: 19,
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseBranch: "main",
    baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    policyDigest: "sha256:policy",
    protocolVersion: 1,
    issueNumber: 18,
    workId: "work-18",
    workSpecDigest: "sha256:spec",
  },
  pr: { number: 19 },
} as unknown as EvaluationSnapshot;

describe("Fugue protocol provenance", () => {
  it("trusts only the protected GitHub Actions publisher", () => {
    expect(isTrustedProtocolActor(BOT)).toBe(true);
    expect(isTrustedProtocolActor(USER)).toBe(false);
    expect(isTrustedProtocolActor({ login: FUGUE_PROTOCOL_ACTOR, type: "User" })).toBe(false);
    expect(isTrustedProtocolActor(null)).toBe(false);
  });

  it("does not treat user-authored protocol-looking comments as canonical state", () => {
    expect(isTrustedProtocolComment({ user: USER })).toBe(false);
    expect(isTrustedProtocolComment({ user: BOT })).toBe(true);
  });

  it("does not treat manually triggered lookalike workflow runs as trusted dispatch evidence", () => {
    expect(isTrustedProtocolWorkflowRun({ actor: USER })).toBe(false);
    expect(isTrustedProtocolWorkflowRun({ actor: BOT })).toBe(true);
  });

  it("does not treat lookalike commit statuses as trusted Integration state", () => {
    expect(isTrustedProtocolCommitStatus({ creator: USER })).toBe(false);
    expect(isTrustedProtocolCommitStatus({ creator: BOT })).toBe(true);
    expect(isTrustedProtocolCommitStatus({ creator: null })).toBe(false);
  });

  it.each(["pending", "failure"] as const)(
    "ignores an untrusted fugue/integration %s status so real Integration remains dispatchable",
    async (state) => {
      const github = integrationGithub([{ context: "fugue/integration", state, creator: USER }]);
      const current = await currentIntegrationState(github, SNAPSHOT);
      expect(current.state).toBe("none");
    },
  );

  it("still honors a trusted Actions-authored Integration pending status", async () => {
    const github = integrationGithub([{ context: "fugue/integration", state: "pending", creator: BOT }]);
    const current = await currentIntegrationState(github, SNAPSHOT);
    expect(current.state).toBe("pending");
  });
});

function integrationGithub(statuses: Array<Record<string, unknown>>): FugueGitHub {
  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      paginate: vi.fn(async () => []),
      rest: {
        issues: { listComments: vi.fn() },
        repos: {
          listCommitStatusesForRef: vi.fn(async () => ({ data: statuses })),
        },
        actions: {
          listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [] } })),
        },
      },
    },
  } as unknown as FugueGitHub;
}
