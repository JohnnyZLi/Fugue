import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { findDependencyCycle } from "../src/core/dependencies.js";
import { digestCanonical } from "../src/core/hash.js";
import type { FugueGitHub } from "../src/core/github.js";
import {
  assertWorkMetadataForIssue,
  createWorkId,
  parseWorkMetadata,
  upsertWorkMetadata,
  workMetadataSchema,
  workSpecDigest,
  workSpecDigestFromRequirements,
} from "../src/core/metadata.js";
import { parseGitHubRepository } from "../src/core/git.js";
import {
  canonicalRequirements,
  compactFugueRecoveryAuthorityVariables,
  createCanonicalWorkState,
  createFugueAuthorityVariable,
  deleteFugueAuthorityVariable,
  listFugueAuthorityVariables,
  loadReusableCanonicalWorkState,
  parseCanonicalWorkState,
  recoverDurableProtocolRecord,
  serializeCanonicalWorkState,
} from "../src/core/state.js";
import { claimWorker, slugify } from "../src/core/worker.js";

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  return {
    ...actual,
    verifyProtocolPublicationBodyAtRevision: vi.fn(async () => true),
    verifyDurableManifestProof: vi.fn(async () => true),
  };
});

const ORIGINAL_AUTHORITY_TOKEN = process.env.FUGUE_AUTHORITY_TOKEN;
const RECOVERY_IDLE = "FUGUE_D3GI_00";
const RECOVERY_IDLE_PREFIX = "reserved-for-fugue-recovery-mutation-guard";
const RECOVERY_BASE = "b".repeat(40);

afterEach(() => {
  if (ORIGINAL_AUTHORITY_TOKEN === undefined) delete process.env.FUGUE_AUTHORITY_TOKEN;
  else process.env.FUGUE_AUTHORITY_TOKEN = ORIGINAL_AUTHORITY_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function recoveryGithub(authorityVariables?: Map<string, string>): FugueGitHub {
  return {
    repository: { owner: "owner", repo: "repo", fullName: "owner/repo" },
    ...(authorityVariables ? { __authorityVariables: authorityVariables } : {}),
  } as unknown as FugueGitHub;
}

function emptyRecoveryOptions(scope: string) {
  return {
    storageSha: RECOVERY_BASE,
    publisherSha: RECOVERY_BASE,
    scope,
    issueNumber: 1,
    parse: () => null,
    timestamp: () => 0,
    order: () => "",
  };
}

class CountingAuthorityMap extends Map<string, string> {
  snapshots = 0;

  override entries(): MapIterator<[string, string]> {
    this.snapshots += 1;
    return super.entries();
  }
}

class RotateEpochOnSnapshotMap extends CountingAuthorityMap {
  rotated = false;

  override entries(): MapIterator<[string, string]> {
    if (!this.rotated) {
      this.rotated = true;
      super.set(RECOVERY_IDLE, `${RECOVERY_IDLE_PREFIX}:${"2".repeat(32)}`);
    }
    return super.entries();
  }
}

function seedHistoricalWorkRecovery(
  variables: Map<string, string>,
  issueNumber: number,
  historicalSha: string,
) {
  const metadata = workMetadataSchema.parse({
    version: 1,
    work_id: `work-${issueNumber}`,
    spec: {},
    execution: {},
  });
  const state = createCanonicalWorkState({
    issue: issueNumber,
    title: "Historical work",
    state: "state:ready",
    agentReady: true,
    requirements: "## Outcome\nRecover the historical root.",
    metadata,
    baseSha: historicalSha,
    createdAt: "2026-08-18T00:00:00.000Z",
    logicalRoot: true,
  });
  const key = "1".repeat(32);
  const nonce = "2".repeat(32);
  const signedBody = `${serializeCanonicalWorkState(state)}\n\nFUGUE WORK STATE — CANONICAL\n\nFugue-Authority-Key: ${key}\nFugue-Authority-Commit: ${nonce}`;
  const authorityOrder = `work-v2:${String(0).padStart(20, "0")}`;
  const manifestId = 101;
  const cursor = {
    version: 1,
    kind: "durable_recovery",
    scope: `work/${issueNumber}`,
    storage_sha: historicalSha,
    publisher_sha: historicalSha,
    checkpoint_at: "2026-08-18T00:00:01.000Z",
    complete_top_id: manifestId,
    scan_top_id: manifestId,
    scan_floor_id: manifestId,
    before_id: manifestId + 1,
    page: 1,
    phase: "discover",
    commit_witness: true,
    best_body_b64: Buffer.from(signedBody, "utf8").toString("base64url"),
    best_manifest: {
      id: manifestId,
      key,
      nonce,
      body_digest: createHash("sha256").update(signedBody, "utf8").digest("hex"),
      authority_order_b64: Buffer.from(authorityOrder, "utf8").toString("base64url"),
      first_status_id: 100,
      last_status_id: 100,
      chunk_count: 1,
      status_ids: [100],
      proof: "manifest-proof",
      created_at: "2026-08-18T00:00:00.500Z",
    },
  };
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const cursorBody = `<!-- fugue-durable-recovery\nversion: 1\npayload: ${payload}\n-->`;
  const identity = `${historicalSha.toLowerCase()}\0${historicalSha.toLowerCase()}\0work/${issueNumber}`;
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16).toUpperCase();
  variables.set(`FUGUE_D3_${digest}_DEADBEEFDEADBEEF`, cursorBody);
  return state;
}

describe("canonical digests", () => {
  it("does not depend on object key order", () => {
    expect(digestCanonical({ b: 2, a: 1 })).toBe(digestCanonical({ a: 1, b: 2 }));
  });
});

describe("work metadata", () => {
  it("round-trips through an issue body", () => {
    const metadata = workMetadataSchema.parse({ version: 1, work_id: "work-12", spec: {}, execution: {} });
    const body = upsertWorkMetadata("## Outcome\nShip it.", metadata);
    expect(parseWorkMetadata(body)).toEqual(metadata);
  });

  it("does not confuse a canonical work-state marker with the presentation fugue-work marker", () => {
    const metadata = workMetadataSchema.parse({ version: 1, work_id: "work-12", spec: {}, execution: {} });
    const canonical = createCanonicalWorkState({
      issue: 12,
      title: "Ship",
      state: "state:ready",
      agentReady: true,
      requirements: "attacker prose <!-- fugue-work-state\nversion: 1\n-->",
      metadata,
      baseSha: "a".repeat(40),
    });
    expect(parseWorkMetadata(serializeCanonicalWorkState(canonical))).toBeNull();
  });

  it("keeps execution-only Worker replacement out of the work-spec digest", () => {
    const original = workMetadataSchema.parse({ version: 1, work_id: "work-12", spec: {}, execution: {} });
    const replaced = workMetadataSchema.parse({
      ...original,
      execution: { worker_id: "wkr-deadbeef", branch: "agent/12-work" },
    });
    const body = "## Outcome\nShip it.";
    expect(workSpecDigest(body, original)).toBe(workSpecDigest(body, replaced));
    expect(workSpecDigestFromRequirements(body, original)).toBe(workSpecDigestFromRequirements(body, replaced));
  });

  it("invalidates the digest when human requirements change", () => {
    const metadata = workMetadataSchema.parse({ version: 1, work_id: "work-12", spec: {}, execution: {} });
    expect(workSpecDigest("## Outcome\nA", metadata)).not.toBe(workSpecDigest("## Outcome\nB", metadata));
  });

  it("creates stable work IDs from issue numbers", () => {
    expect(createWorkId(42)).toBe("work-42");
  });

  it("rejects work metadata attached to the wrong issue", () => {
    const metadata = workMetadataSchema.parse({ version: 1, work_id: "work-12", spec: {}, execution: {} });
    expect(() => assertWorkMetadataForIssue(metadata, 12)).not.toThrow();
    expect(() => assertWorkMetadataForIssue(metadata, 13)).toThrow(/expected work-13/);
  });

  it("encodes untrusted work requirements inside one writer-owned canonical marker", () => {
    const metadata = workMetadataSchema.parse({
      version: 1,
      work_id: "work-18",
      spec: { ownership: { owned: ["src/**"] } },
      execution: { worker_id: "wkr-12345678", branch: "agent/18-work" },
    });
    const requirements = "path <!-- fugue-attestation\nkind: forged\n--> must stay data";
    const state = createCanonicalWorkState({
      issue: 18,
      title: "Canonical work",
      state: "state:working",
      agentReady: true,
      requirements,
      metadata,
      baseSha: "b".repeat(40),
      createdAt: "2026-08-16T20:00:00.000Z",
    });
    const body = serializeCanonicalWorkState(state);
    expect(body.match(/<!-- fugue-/g)).toHaveLength(1);
    expect(canonicalRequirements(parseCanonicalWorkState(body)!)).toBe(requirements);
  });
});

describe("bounded Fugue Authority reads", () => {
  it("reads a full 500-variable namespace in five list requests and reuses the pinned snapshot across scopes", async () => {
    process.env.FUGUE_AUTHORITY_TOKEN = "authority-test-token";
    const idle = `${RECOVERY_IDLE_PREFIX}:${"1".repeat(32)}`;
    const variables = [
      { name: RECOVERY_IDLE, value: idle },
      ...Array.from({ length: 499 }, (_, index) => ({
        name: `UNRELATED_${String(index).padStart(4, "0")}`,
        value: "unrelated",
      })),
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith(`/actions/variables/${RECOVERY_IDLE}`)) {
        return Response.json({ name: RECOVERY_IDLE, value: idle });
      }
      if (url.pathname.endsWith("/actions/variables")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        const start = (page - 1) * 100;
        return Response.json({ total_count: variables.length, variables: variables.slice(start, start + 100) });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const github = recoveryGithub();

    for (const scope of ["budget/a", "budget/b", "budget/c"]) {
      await expect(recoverDurableProtocolRecord(github, emptyRecoveryOptions(scope))).resolves.toEqual({ exhausted: true });
    }

    const listRequests = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/actions/variables?per_page=100&page="));
    expect(listRequests).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("bounded-recaptures when the idle epoch rotates while the namespace snapshot is being built", async () => {
    const variables = new RotateEpochOnSnapshotMap([
      [RECOVERY_IDLE, `${RECOVERY_IDLE_PREFIX}:${"1".repeat(32)}`],
    ]);
    const github = recoveryGithub(variables);

    await expect(recoverDurableProtocolRecord(github, emptyRecoveryOptions("epoch/rotate"))).resolves.toEqual({ exhausted: true });
    expect(variables.snapshots).toBe(2);
  });

  it("fails closed on a structurally corrupt simultaneous idle epoch and active guard", async () => {
    const variables = new Map<string, string>([
      [RECOVERY_IDLE, `${RECOVERY_IDLE_PREFIX}:${"1".repeat(32)}`],
      ["FUGUE_D3GT_CORRUPT", JSON.stringify({
        version: 1,
        publisher_sha: RECOVERY_BASE,
        target_name: "FUGUE_D3_DEADBEEF_DEADBEEF",
        target_value: "candidate",
        created_at: new Date().toISOString(),
        maintenance: true,
      })],
    ]);
    const github = recoveryGithub(variables);

    await expect(recoverDurableProtocolRecord(github, emptyRecoveryOptions("epoch/corrupt")))
      .rejects.toThrow(/simultaneously exposes an idle epoch and an active mutation guard/i);
  });

  it("fails closed before a writer can acquire a second guard from simultaneous idle+active state", async () => {
    const idle = `${RECOVERY_IDLE_PREFIX}:${"4".repeat(32)}`;
    const guardName = "FUGUE_D3GT_CORRUPT_WRITER";
    const variables = new Map<string, string>([
      [RECOVERY_IDLE, idle],
      [guardName, JSON.stringify({
        version: 1,
        publisher_sha: RECOVERY_BASE,
        target_name: "__fugue_recovery_maintenance__",
        target_value: "maintenance",
        created_at: new Date().toISOString(),
        maintenance: true,
      })],
    ]);
    const before = [...variables.entries()];
    const github = recoveryGithub(variables);

    await expect(compactFugueRecoveryAuthorityVariables(github))
      .rejects.toThrow(/simultaneously exposes an idle epoch and an active mutation guard/i);
    expect([...variables.entries()]).toEqual(before);
    expect([...variables.keys()].filter((name) => name.startsWith("FUGUE_D3GT_"))).toEqual([guardName]);
    expect(variables.get(RECOVERY_IDLE)).toBe(idle);
  });

  it("fences a recent legacy active guard when the idle slot is missing instead of scanning past it", async () => {
    const variables = new Map<string, string>([[
      "FUGUE_D3GT_LEGACY",
      JSON.stringify({
        version: 1,
        publisher_sha: RECOVERY_BASE,
        target_name: "__fugue_recovery_maintenance__",
        target_value: "maintenance",
        created_at: new Date().toISOString(),
        maintenance: true,
      }),
    ]]);
    const github = recoveryGithub(variables);

    await expect(recoverDurableProtocolRecord(github, emptyRecoveryOptions("epoch/legacy")))
      .rejects.toThrow(/still provisional|remains fenced/i);
  });

  it("invalidates the shared snapshot after create, delete, guarded rename, and compaction mutations", async () => {
    const variables = new CountingAuthorityMap([
      [RECOVERY_IDLE, `${RECOVERY_IDLE_PREFIX}:${"1".repeat(32)}`],
    ]);
    const github = recoveryGithub(variables);

    await recoverDurableProtocolRecord(github, emptyRecoveryOptions("cache/a"));
    await recoverDurableProtocolRecord(github, emptyRecoveryOptions("cache/b"));
    expect(variables.snapshots).toBe(1);

    await createFugueAuthorityVariable(github, "UNRELATED_CACHE_TEST", "value");
    await recoverDurableProtocolRecord(github, emptyRecoveryOptions("cache/c"));
    expect(variables.snapshots).toBe(2);

    await deleteFugueAuthorityVariable(github, "UNRELATED_CACHE_TEST");
    await recoverDurableProtocolRecord(github, emptyRecoveryOptions("cache/d"));
    expect(variables.snapshots).toBe(3);

    await compactFugueRecoveryAuthorityVariables(github);
    const afterCompaction = variables.snapshots;
    await recoverDurableProtocolRecord(github, emptyRecoveryOptions("cache/e"));
    expect(variables.snapshots).toBe(afterCompaction + 1);
  });

  it("distinguishes GitHub rate exhaustion from Authority-variable permission denial", async () => {
    process.env.FUGUE_AUTHORITY_TOKEN = "authority-test-token";
    const github = recoveryGithub();

    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { message: "API rate limit exceeded for installation" },
      { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } },
    )));
    await expect(listFugueAuthorityVariables(github, "FUGUE_D3"))
      .rejects.toThrow(/rate limit.*remaining=0/i);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { message: "Resource not accessible by integration" },
      { status: 403, headers: { "x-ratelimit-remaining": "4999" } },
    )));
    await expect(listFugueAuthorityVariables(recoveryGithub(), "FUGUE_D3"))
      .rejects.toThrow(/permissions \(403: Resource not accessible by integration\)/i);
  });
});

describe("bounded historical work rollover", () => {
  it("examines one exact protected-base commit page per reusable-state lookup and can resume on the next page", async () => {
    const historicalSha = "a".repeat(40);
    const currentSha = "b".repeat(40);
    const variables = new Map<string, string>([
      [RECOVERY_IDLE, `${RECOVERY_IDLE_PREFIX}:${"3".repeat(32)}`],
    ]);
    const expected = seedHistoricalWorkRecovery(variables, 24, historicalSha);
    const listCommits = vi.fn(async ({ page }: { page: number; per_page: number; sha: string }) => ({
      data: page === 1
        ? Array.from({ length: 100 }, (_, index) => ({ sha: index.toString(16).padStart(40, "0") }))
        : [{ sha: historicalSha }],
    }));
    const github = {
      repository: { owner: "owner", repo: "repo", fullName: "owner/repo" },
      __authorityVariables: variables,
      octokit: { rest: { repos: { listCommits } } },
    } as unknown as FugueGitHub;

    await expect(loadReusableCanonicalWorkState(github, 24, currentSha, "main", 1)).resolves.toBeUndefined();
    expect(listCommits).toHaveBeenCalledTimes(1);
    expect(listCommits).toHaveBeenLastCalledWith(expect.objectContaining({ sha: currentSha, per_page: 100, page: 1 }));

    await expect(loadReusableCanonicalWorkState(github, 24, currentSha, "main", 2)).resolves.toEqual(expected);
    expect(listCommits).toHaveBeenCalledTimes(2);
    expect(listCommits).toHaveBeenLastCalledWith(expect.objectContaining({ sha: currentSha, per_page: 100, page: 2 }));
  });

  it("keeps repository-wide maintenance outside the deterministic per-work transition loop", () => {
    const source = readFileSync("src/core/reconcile.ts", "utf8");
    const publicStart = source.indexOf("export async function reconcileWork(");
    const transitionStart = source.indexOf("async function reconcileWorkTransitions(", publicStart);
    const transitionEnd = source.indexOf("export function assertProtectedWorkflowRuntimeCurrent", transitionStart);
    expect(publicStart).toBeGreaterThanOrEqual(0);
    expect(transitionStart).toBeGreaterThan(publicStart);
    expect(transitionEnd).toBeGreaterThan(transitionStart);

    const publicWrapper = source.slice(publicStart, transitionStart);
    const transitionLoop = source.slice(transitionStart, transitionEnd);
    expect(publicWrapper.match(/rollCanonicalWorkStatesToCurrentBase\(/g)).toHaveLength(1);
    expect(publicWrapper.match(/reclaimOrphanIntegrationAuthorityVariables\(/g)).toHaveLength(1);
    expect(transitionLoop).not.toContain("rollCanonicalWorkStatesToCurrentBase(");
    expect(transitionLoop).not.toContain("repairCanonicalWorkStateComments(");
    expect(transitionLoop).not.toContain("reclaimOrphanIntegrationAuthorityVariables(");
  });

  it("keeps a full 500-variable Integration maintenance budget additive across many 12-transition works", async () => {
    const savedEnv = {
      GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
      FUGUE_AUTHORITY_ACTOR_ID: process.env.FUGUE_AUTHORITY_ACTOR_ID,
      FUGUE_WORKFLOW_SHA: process.env.FUGUE_WORKFLOW_SHA,
    };
    process.env.FUGUE_AUTHORITY_TOKEN = "authority-test-token";
    process.env.GITHUB_EVENT_NAME = "";
    delete process.env.FUGUE_AUTHORITY_ACTOR_ID;
    process.env.FUGUE_WORKFLOW_SHA = RECOVERY_BASE;

    const variables = Array.from({ length: 500 }, (_, index) => ({
      name: `UNRELATED_BUDGET_${String(index).padStart(4, "0")}`,
      value: "unrelated",
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!url.pathname.endsWith("/actions/variables")) {
        return Response.json({ message: "unexpected request" }, { status: 500 });
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * 100;
      return Response.json({ total_count: variables.length, variables: variables.slice(start, start + 100) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const policy = {
      identity: {
        baseBranch: "main",
        baseSha: RECOVERY_BASE,
        policyDigest: `sha256:${"1".repeat(64)}`,
        protocolVersion: 1,
      },
      config: { branches: { worker_pattern: "agent/{issue}-{slug}" } },
    };
    const works = Array.from({ length: 6 }, (_, index) => {
      const issueNumber = 100 + index;
      const workerId = `wkr-${(index + 1).toString(16).padStart(8, "0")}`;
      const branch = `agent/${issueNumber}-budget`;
      const metadata = workMetadataSchema.parse({
        version: 1,
        work_id: `work-${issueNumber}`,
        spec: {
          dependencies: [],
          ownership: { owned: ["src/**"], coordinate: [], forbidden: [] },
          qa: { force: ["code"] },
          authorized_changes: { agents_invariants: [] },
        },
        execution: { worker_id: workerId, branch },
      });
      const requirements = `## Outcome\nBudget work ${issueNumber}.`;
      const prMetadata = {
        version: 1 as const,
        work_id: metadata.work_id,
        issue: issueNumber,
        worker_id: workerId,
        branch,
      };
      const canonical = createCanonicalWorkState({
        issue: issueNumber,
        title: `Budget work ${issueNumber}`,
        state: "state:working",
        agentReady: true,
        requirements,
        metadata,
        pr: { number: 200 + index, metadata: prMetadata, draft: false },
        baseSha: RECOVERY_BASE,
        createdAt: "2026-08-19T00:00:00.000Z",
        logicalRoot: true,
      });
      return {
        issueNumber,
        title: canonical.title,
        url: `https://github.com/owner/repo/issues/${issueNumber}`,
        stateLabel: canonical.state,
        agentReady: canonical.agent_ready,
        metadata,
        requirements,
        workSpecDigest: workSpecDigestFromRequirements(requirements, metadata),
        pr: {
          number: 200 + index,
          url: `https://github.com/owner/repo/pull/${200 + index}`,
          headSha: (index + 1).toString(16).padStart(40, "0"),
          headBranch: branch,
          draft: false,
          metadata: prMetadata,
        },
        drift: [],
        presentationDrift: [],
        canonical,
      };
    });
    const repositoryState = { policy, works, drift: [] };

    vi.resetModules();
    const actualState = await vi.importActual<typeof import("../src/core/state.js")>("../src/core/state.js");
    const actualPolicy = await vi.importActual<typeof import("../src/core/policy.js")>("../src/core/policy.js");
    const actualIntegration = await vi.importActual<typeof import("../src/core/integration-status.js")>("../src/core/integration-status.js");
    const actualEvaluation = await vi.importActual<typeof import("../src/core/evaluation.js")>("../src/core/evaluation.js");
    const actualSubmissions = await vi.importActual<typeof import("../src/core/submissions.js")>("../src/core/submissions.js");
    const actualStateComment = await vi.importActual<typeof import("../src/core/state-comment.js")>("../src/core/state-comment.js");
    const reclaim = vi.fn(async (github: FugueGitHub) => {
      await actualState.listFugueAuthorityVariables(github, "FUGUE_INT_");
    });

    vi.doMock("../src/core/state.js", () => ({
      ...actualState,
      rollCanonicalWorkStatesToCurrentBase: vi.fn(async () => []),
      repairCanonicalWorkStateComments: vi.fn(async () => []),
      recoverCoordinatorSnapshots: vi.fn(async () => []),
      reconstructState: vi.fn(async () => repositoryState),
    }));
    vi.doMock("../src/core/policy.js", () => ({
      ...actualPolicy,
      resolveActivePolicy: vi.fn(async () => policy),
    }));
    vi.doMock("../src/core/integration-status.js", () => ({
      ...actualIntegration,
      getCurrentIntegrationRecord: vi.fn(async () => undefined),
      reclaimOrphanIntegrationAuthorityVariables: reclaim,
      sealIntegrationWorkflowRunEvent: vi.fn(async () => false),
    }));
    vi.doMock("../src/core/evaluation.js", () => ({
      ...actualEvaluation,
      captureEvaluation: vi.fn(async (_github: FugueGitHub, prNumber: number) => {
        const work = works.find((candidate) => candidate.pr.number === prNumber)!;
        return {
          identity: {
            prNumber,
            headSha: work.pr.headSha,
            baseBranch: policy.identity.baseBranch,
            baseSha: policy.identity.baseSha,
            policyDigest: policy.identity.policyDigest,
            protocolVersion: policy.identity.protocolVersion,
            issueNumber: work.issueNumber,
            workId: work.metadata.work_id,
            workSpecDigest: work.workSpecDigest,
          },
          pr: { number: prNumber },
        };
      }),
    }));
    vi.doMock("../src/core/submissions.js", () => ({
      ...actualSubmissions,
      processCurrentSubmissions: vi.fn(async () => ({ accepted: 1, rejected: 0 })),
    }));
    vi.doMock("../src/core/state-comment.js", () => ({
      ...actualStateComment,
      upsertStateComment: vi.fn(async () => undefined),
    }));

    const pulls = works.map((work) => ({
      number: work.pr.number,
      node_id: `PR_${work.pr.number}`,
      state: "open",
      merged: false,
      draft: false,
      body: "",
      html_url: work.pr.url,
      base: { ref: "main" },
      head: { ref: work.pr.headBranch, sha: work.pr.headSha },
    }));
    const listPulls = vi.fn(async () => ({ data: pulls }));
    const github = {
      repository: { owner: "owner", repo: "repo", fullName: "owner/repo" },
      octokit: {
        graphql: vi.fn(async () => ({})),
        paginate: vi.fn(async (method: unknown) => {
          if (method === listPulls) return pulls;
          throw new Error("Unexpected pagination in bounded reconciliation budget test.");
        }),
        rest: {
          issues: {
            get: vi.fn(async ({ issue_number }: { issue_number: number }) => {
              const work = works.find((candidate) => candidate.issueNumber === issue_number)!;
              return {
                data: {
                  number: issue_number,
                  state: "open",
                  title: work.title,
                  body: upsertWorkMetadata(work.requirements, work.metadata),
                  labels: ["state:working", "agent:ready"],
                  comments: 0,
                },
              };
            }),
            update: vi.fn(async () => ({ data: {} })),
          },
          pulls: {
            list: listPulls,
            get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({
              data: pulls.find((pull) => pull.number === pull_number)!,
            })),
            update: vi.fn(async () => ({ data: {} })),
            updateBranch: vi.fn(async () => ({ data: {} })),
          },
        },
      },
    } as unknown as FugueGitHub;

    try {
      const { reconcileRepository } = await import("../src/core/reconcile.js");
      await expect(reconcileRepository(github)).resolves.toEqual({
        processed: works.map((work) => work.issueNumber),
      });
      const listRequests = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/actions/variables?per_page=100&page="));
      expect(reclaim).toHaveBeenCalledTimes(2);
      expect(listRequests).toHaveLength(10);
      expect(listRequests.length).toBeLessThan(5 * 12 * works.length);
    } finally {
      vi.doUnmock("../src/core/state.js");
      vi.doUnmock("../src/core/policy.js");
      vi.doUnmock("../src/core/integration-status.js");
      vi.doUnmock("../src/core/evaluation.js");
      vi.doUnmock("../src/core/submissions.js");
      vi.doUnmock("../src/core/state-comment.js");
      vi.resetModules();
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("Worker claims", () => {
  it("creates a new Worker claim and can resume it", () => {
    const metadata = workMetadataSchema.parse({ version: 1, work_id: "work-9", spec: {}, execution: {} });
    const claimed = claimWorker(metadata, 9, "Build the visual timeline", "agent/{issue}-{slug}", false);
    expect(claimed.workerId).toMatch(/^wkr-[0-9a-f]{8}$/);
    expect(claimed.branch).toBe("agent/9-build-the-visual-timeline");
    const resumed = claimWorker(claimed.metadata, 9, "ignored", "agent/{issue}-{slug}", true);
    expect(resumed.workerId).toBe(claimed.workerId);
    expect(resumed.branch).toBe(claimed.branch);
    expect(resumed.resumed).toBe(true);
  });

  it("refuses a second new claim", () => {
    const metadata = workMetadataSchema.parse({
      version: 1,
      work_id: "work-9",
      spec: {},
      execution: { worker_id: "wkr-12345678", branch: "agent/9-existing" },
    });
    expect(() => claimWorker(metadata, 9, "New", "agent/{issue}-{slug}", false)).toThrow(/already claimed/);
  });

  it("slugifies branch names deterministically", () => {
    expect(slugify("  Crazy UI / Timeline!!! ")).toBe("crazy-ui-timeline");
  });
});

describe("dependency graph", () => {
  it("detects transitive cycles", () => {
    const result = findDependencyCycle([
      { issueNumber: 1, dependencies: [2] },
      { issueNumber: 2, dependencies: [3] },
      { issueNumber: 3, dependencies: [1] },
    ]);
    expect(result?.cycle).toEqual([1, 2, 3, 1]);
  });

  it("accepts an acyclic graph", () => {
    expect(findDependencyCycle([
      { issueNumber: 1, dependencies: [] },
      { issueNumber: 2, dependencies: [1] },
    ])).toBeNull();
  });
});

describe("GitHub repository discovery", () => {
  it("parses SSH and HTTPS origins", () => {
    expect(parseGitHubRepository("git@github.com:JohnnyZLi/Path.git").fullName).toBe("JohnnyZLi/Path");
    expect(parseGitHubRepository("https://github.com/JohnnyZLi/Fugue.git").fullName).toBe("JohnnyZLi/Fugue");
  });
});

describe("config", () => {
  it("parses the protocol-one configuration shape", () => {
    const config = parseConfig(`
version: 1
protocol: { version: 1 }
repository: { default_branch: main, agents_file: AGENTS.md }
control_plane: { paths: [AGENTS.md, .fugue/**] }
validation:
  install: [npm ci]
  checks: [npm test]
  required_ci: [test]
  control_paths: [package.json]
reviews:
  code: { required: always }
  security: { required: conditional, paths: [.github/workflows/**] }
  visual: { required: conditional, paths: [src/ui/**] }
branches: { worker_pattern: 'agent/{issue}-{slug}', require_up_to_date: true }
allocation:
  coordinator_only: true
  require_assignment: true
  require_worker_id: true
  one_active_pr_per_issue: true
dependencies: { require_satisfied_before_integration: true }
enforcement: { prefer_hard_merge_gate: true }
github: { source_of_truth: true }
`);
    expect(config.protocol.version).toBe(1);
    expect(config.reviews.code.required).toBe("always");
  });
});
