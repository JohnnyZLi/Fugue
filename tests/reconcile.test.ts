import { describe, expect, it, vi } from "vitest";
import { integrationAttestationSchema } from "../src/core/attestations.js";
import type { EvaluationSnapshot } from "../src/core/evaluation.js";
import type { FugueGitHub } from "../src/core/github.js";
import {
  createIntegrationRecord,
  createIntegrationRequest,
  integrationRunTitle,
  type IntegrationRecord,
} from "../src/core/integration-plan.js";
import {
  authorizeIntegrationDispatch,
  bindIntegrationRun,
  currentIntegrationState,
  ensureIntegrationDispatch,
  getCurrentIntegrationRecord,
  getIntegrationRunStartEvidence,
  integrationEvidenceRefName,
  integrationRunStartSchema,
  publishIntegrationRecord,
  sealIntegrationWorkflowRunEvent,
  serializeIntegrationRunStartEvidence,
} from "../src/core/integration-status.js";
import { upsertWorkMetadata, workMetadataSchema } from "../src/core/metadata.js";
import type { ActivePolicy } from "../src/core/policy.js";
import {
  assertRepositoryDefaultBranchRevision,
  FUGUE_PROTOCOL_ACTOR,
  signProtocolBody,
  verifyDurableManifestProof,
  verifyProtocolPublicationBodyAtRevision,
} from "../src/core/provenance.js";
import { ingestCoordinatorSnapshot, preserveCoordinatorIssueEvent } from "../src/core/reconcile.js";
import {
  canonicalRequirements,
  coordinatorSnapshotSchema,
  createCanonicalWorkState,
  durableManifestContext,
  loadCurrentCanonicalWorkState,
  parseCanonicalWorkState,
  publishCanonicalWorkState,
  publishCoordinatorSnapshot,
  recoverCoordinatorSnapshots,
  recoverDurableProtocolRecord,
  type CanonicalWorkState,
} from "../src/core/state.js";

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  return {
    ...actual,
    assertRepositoryDefaultBranchRevision: vi.fn(async (github: FugueGitHub, expected: string) => {
      const actualSha = (github as TestGithub).__baseSha ?? expected;
      if (actualSha !== expected) throw new Error(`stale protected revision ${actualSha.slice(0, 8)}`);
    }),
    signProtocolBody: vi.fn(async (_github: FugueGitHub, body: string) =>
      `${body}\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: test-proof\n-->`),
    createDurableManifestProof: vi.fn(async () => "manifest-proof"),
    verifyDurableManifestProof: vi.fn(async (_github: FugueGitHub, proof: string) => proof === "manifest-proof"),
    verifyProtocolPublicationBodyAtRevision: vi.fn(async (
      github: FugueGitHub,
      body: string,
      expected: string,
    ) => {
      if (((github as TestGithub).__publisherSha ?? expected) !== expected) return false;
      if (body.includes("<!-- fugue-durable-recovery") ||
          body.includes("<!-- fugue-integration-dispatch-anchor") ||
          body.includes("<!-- fugue-integration-run-start")) return body.includes("token: test-proof");
      const key = body.match(/Fugue-Authority-Key: ([0-9a-f]{32})/i)?.[1];
      const commit = body.match(/Fugue-Authority-Commit: ([0-9a-f]{32})/i)?.[1];
      return Boolean(key && commit && !/^0+$/.test(key) && !/^0+$/.test(commit));
    }),
    isTrustedProtocolComment: vi.fn(async (_github: FugueGitHub, comment: TestComment) =>
      comment.user?.login === "github-actions[bot]"),
    createProtocolComment: vi.fn(async (github: FugueGitHub, issueNumber: number, body: string) =>
      github.octokit.rest.issues.createComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        issue_number: issueNumber,
        body,
      })),
    updateProtocolComment: vi.fn(async (github: FugueGitHub, commentId: number, body: string) =>
      github.octokit.rest.issues.updateComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        comment_id: commentId,
        body,
      })),
  };
});

const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const CURRENT_WORK_SPEC_DIGEST = "sha256:a808b8ae2dbf920771f978dfb3c747d7372b24bf516e3d4d92b0d26afa55a15a";

function workMetadata(execution = true) {
  return workMetadataSchema.parse({
    version: 1,
    work_id: "work-18",
    spec: {
      dependencies: [],
      ownership: { owned: ["src/**"], coordinate: [], forbidden: [] },
      qa: { force: ["code"] },
      authorized_changes: { agents_invariants: [] },
    },
    execution: execution ? { worker_id: "wkr-12345678", branch: "agent/18-chat-first" } : {},
  });
}

function canonicalWork(requirements = "## Outcome\nProtected truth", createdAt = "2026-08-17T03:00:00.000Z"): CanonicalWorkState {
  return createCanonicalWorkState({
    issue: 18,
    title: "Chat-first orchestration",
    state: "state:working",
    agentReady: true,
    requirements,
    metadata: workMetadata(),
    pr: {
      number: 21,
      draft: false,
      metadata: { version: 1, work_id: "work-18", issue: 18, worker_id: "wkr-12345678", branch: "agent/18-chat-first" },
    },
    baseSha: BASE,
    createdAt,
  });
}

function snapshot(): EvaluationSnapshot {
  return {
    identity: {
      prNumber: 21,
      headSha: HEAD,
      baseBranch: "main",
      baseSha: BASE,
      policyDigest: "sha256:policy",
      protocolVersion: 1,
      issueNumber: 18,
      workId: "work-18",
      workSpecDigest: CURRENT_WORK_SPEC_DIGEST,
    },
    pr: { number: 21 },
  } as unknown as EvaluationSnapshot;
}

function policy(): ActivePolicy {
  return {
    identity: { baseBranch: "main", baseSha: BASE, policyDigest: "sha256:policy", protocolVersion: 1 },
    config: { branches: { worker_pattern: "agent/{issue}-{slug}" } },
  } as unknown as ActivePolicy;
}

describe("d3 protected durable authority", () => {
  it("does not expose an authority commit capability before the protected manifest write", async () => {
    const github = makeGithub({ failManifestAlways: true });
    await expect(publishCanonicalWorkState(github, canonicalWork())).rejects.toThrow(/Unable to commit/);
    expect(github.__comments).toHaveLength(0);
    expect(github.__statuses.some((status) => status.context.includes("/m/"))).toBe(false);

    for (const [, signedInput] of vi.mocked(signProtocolBody).mock.calls) {
      const key = signedInput.match(/Fugue-Authority-Key: ([0-9a-f]{32})/)?.[1];
      const commit = signedInput.match(/Fugue-Authority-Commit: ([0-9a-f]{32})/)?.[1];
      if (!key || !commit) continue;
      expect(github.__statuses.some((status) => status.context.includes(key))).toBe(false);
      expect(github.__statuses.some((status) => status.description.includes(commit))).toBe(false);
    }

    github.__statuses.push({
      id: ++github.__nextStatusId,
      sha: BASE,
      context: durableManifestContext("work/18", "f".repeat(32)),
      description: `n=1;d=${"1".repeat(64)};c=${"e".repeat(32)}`,
    });
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: "work/18",
      issueNumber: 18,
      parse: parseCanonicalWorkState,
      timestamp: (value) => Date.parse(value.created_at),
    });
    expect(recovered.record).toBeUndefined();
    expect(recovered.exhausted).toBe(true);
  });

  it("requires exact publisher/base proof before any manifest becomes discoverable", async () => {
    const github = makeGithub();
    github.__publisherSha = "c".repeat(40);
    await expect(publishCanonicalWorkState(github, canonicalWork())).rejects.toThrow(/publisher proof/);
    expect(github.__statuses).toHaveLength(0);
    vi.mocked(assertRepositoryDefaultBranchRevision).mockClear();
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockClear();
  });

  it("abandons an exhausted transaction and retries under fresh unrevealed secrets", async () => {
    const github = makeGithub({ failFirstManifest: true });
    await expect(publishCanonicalWorkState(github, canonicalWork())).resolves.toBe(true);
    expect(github.__statuses.filter((status) => status.context.includes("/m/"))).toHaveLength(1);
    const dataContexts = github.__statuses.filter((status) => status.context.includes("/d/")).map((status) => status.context);
    expect(new Set(dataContexts).size).toBeGreaterThan(1);
  });

  it("bounds fake-manifest and chunk reconstruction work per scheduled recovery slice", async () => {
    const github = makeGithub();
    github.__nextStatusId = 1000;
    const order = Buffer.from("2026-08-17T03:00:00.000Z", "utf8").toString("base64url");
    for (let index = 0; index < 100; index += 1) {
      const key = index.toString(16).padStart(32, "0");
      github.__statuses.push({
        id: ++github.__nextStatusId,
        sha: BASE,
        context: durableManifestContext("work/18", key),
        description: `n=48;c=${"b".repeat(32)};b=${"a".repeat(64)};a=1;z=48`,
        target_url: `https://token.actions.githubusercontent.com/fugue/d3?o=${order}&p=forged`,
        created_at: "2026-08-17T03:00:01.000Z",
      });
    }
    github.__listStatus.mockClear();
    vi.mocked(verifyDurableManifestProof).mockClear();
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockClear();
    const first = await recoverDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: "work/18",
      issueNumber: 18,
      parse: parseCanonicalWorkState,
      timestamp: (value) => Date.parse(value.created_at),
      order: (value) => value.created_at,
    });
    expect(first.exhausted).toBe(false);
    expect(github.__listStatus).toHaveBeenCalledTimes(2);
    expect(vi.mocked(verifyDurableManifestProof)).toHaveBeenCalledTimes(8);
    expect(vi.mocked(verifyProtocolPublicationBodyAtRevision)).toHaveBeenCalledTimes(1);
    expect([...github.__refs.keys()].some((ref) => ref.startsWith("fugue/recovery/"))).toBe(true);
    expect(github.__comments.some((comment) => comment.body.includes("fugue-durable-recovery"))).toBe(false);
  });

  it("recovers the newest committed state after all ordinary state comments are destroyed", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("older"));
    await publishCanonicalWorkState(github, canonicalWork("newer", "2026-08-17T03:01:00.000Z"));
    github.__comments.splice(0);
    const recovered = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(canonicalRequirements(recovered!)).toBe("newer");
    expect(github.__comments.some((comment) => comment.body.includes("work-d3"))).toBe(true);
  });


  it("reconstructs a committed record despite hostile statuses inserted after proof and before manifest commit", async () => {
    const github = makeGithub({ interleaveBeforeManifest: 250 });
    await publishCanonicalWorkState(github, canonicalWork("interleaving-safe"));
    github.__comments.splice(0);
    const recovered = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(canonicalRequirements(recovered!)).toBe("interleaving-safe");
  });

  it("makes monotonic recovery progress while newer hostile statuses keep arriving", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("older-valid-authority"));
    github.__comments.splice(0);
    for (let index = 0; index < 3400; index += 1) {
      github.__statuses.push({ id: ++github.__nextStatusId, sha: BASE, context: `hostile/${index}`, description: "noise" });
    }
    let recovered;
    for (let attempt = 0; attempt < 8 && !recovered?.record; attempt += 1) {
      recovered = await recoverDurableProtocolRecord(github, {
        storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
        parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
      });
      if (!recovered.record) {
        github.__comments.splice(0);
        for (let index = 0; index < 300; index += 1) {
          github.__statuses.push({ id: ++github.__nextStatusId, sha: BASE, context: `continuous/${attempt}/${index}`, description: "new-noise" });
        }
      }
    }
    expect(recovered?.record).toBeDefined();
    expect(canonicalRequirements(recovered!.record!.value)).toBe("older-valid-authority");
    expect([...github.__refs.keys()].some((ref) => ref.startsWith("fugue/recovery/"))).toBe(true);
  });

  it("treats replayed work locator comments as hints and repairs them from newer d3 authority", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("old-locator", "2026-08-17T03:00:00.000Z"));
    const stale = github.__comments.find((comment) => comment.body.includes("work-d3"))!.body;
    await publishCanonicalWorkState(github, canonicalWork("new-d3", "2026-08-17T03:02:00.000Z"));
    github.__comments.splice(0);
    await github.octokit.rest.issues.createComment({ owner: "JohnnyZLi", repo: "Fugue", issue_number: 18, body: stale });
    const current = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(canonicalRequirements(current!)).toBe("new-d3");
    const repaired = github.__comments.find((comment) => comment.body.includes("work-d3"));
    expect(canonicalRequirements(parseCanonicalWorkState(repaired!.body)!)).toBe("new-d3");
  });
});

describe("Coordinator event durability", () => {
  it("recovers an authorized immutable Human snapshot after its ordinary snapshot comment is deleted", async () => {
    const github = makeGithub();
    const body = upsertWorkMetadata("## Outcome\nHuman-approved snapshot", workMetadata(false));
    await expect(preserveCoordinatorIssueEvent(github, policy(), {
      eventName: "issues",
      action: "edited",
      actor: "JohnnyZLi",
      eventId: "event-1",
      issueNumber: 18,
      issueTitle: "Approved title",
      issueBody: body,
      issueLabels: ["state:working", "agent:ready"],
      issueUpdatedAt: "2026-08-17T03:05:00.000Z",
      issueIsPullRequest: false,
    })).resolves.toBe(true);
    github.__comments.splice(0);

    const snapshots = await recoverCoordinatorSnapshots(github, policy());
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ event_id: "event-1", title: "Approved title", body });
    await ingestCoordinatorSnapshot(github, policy(), snapshots[0]!);
    const current = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(current?.title).toBe("Approved title");
    expect(canonicalRequirements(current!)).toContain("Human-approved snapshot");
  });

  it("keeps the newest immutable issue revision authoritative across stale locator replay and a slower older run", async () => {
    const github = makeGithub();
    const bodyOld = upsertWorkMetadata("## Outcome\nold Human edit", workMetadata(false));
    const bodyNew = upsertWorkMetadata("## Outcome\nnew Human edit", workMetadata(false));
    const older = coordinatorSnapshotSchema.parse({
      version: 1, kind: "coordinator_snapshot", event_id: "event-100", event_name: "issues", action: "edited",
      actor: "JohnnyZLi", issue: 18, title: "Old title", body: bodyOld, labels: ["state:working", "agent:ready"],
      issue_updated_at: "2026-08-17T03:05:00.000Z", captured_at: "2026-08-17T03:05:01.000Z",
    });
    const newer = coordinatorSnapshotSchema.parse({
      ...older, event_id: "event-200", title: "New title", body: bodyNew,
      issue_updated_at: "2026-08-17T03:06:00.000Z", captured_at: "2026-08-17T03:06:01.000Z",
    });
    await publishCoordinatorSnapshot(github, BASE, older);
    const stale = github.__comments.find((comment) => comment.body.includes("coordinator-d3"))!.body;
    await publishCoordinatorSnapshot(github, BASE, newer);
    await publishCoordinatorSnapshot(github, BASE, older);
    github.__comments.splice(0);
    await github.octokit.rest.issues.createComment({ owner: "JohnnyZLi", repo: "Fugue", issue_number: 18, body: stale });
    const recovered = await recoverCoordinatorSnapshots(github, policy());
    expect(recovered[0]).toMatchObject({ event_id: "event-200", title: "New title" });
    await ingestCoordinatorSnapshot(github, policy(), newer);
    await expect(ingestCoordinatorSnapshot(github, policy(), older)).resolves.toBe(false);
    const work = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(work?.title).toBe("New title");
    expect(canonicalRequirements(work!)).toContain("new Human edit");
  });


  it("totally orders distinct authorized edits that share issue.updated_at and action", async () => {
    const github = makeGithub();
    const oldBody = upsertWorkMetadata("## Outcome\nsame-second older", workMetadata(false));
    const newBody = upsertWorkMetadata("## Outcome\nsame-second newer", workMetadata(false));
    const updatedAt = "2026-08-17T03:07:00.000Z";
    await preserveCoordinatorIssueEvent(github, policy(), {
      eventName: "issues", action: "edited", actor: "JohnnyZLi", eventId: "run-701:new", eventSequence: 701,
      issueNumber: 18, issueTitle: "Newer same-second title", issueBody: newBody,
      issueLabels: ["state:working", "agent:ready"], issueUpdatedAt: updatedAt, issueIsPullRequest: false,
    });
    await preserveCoordinatorIssueEvent(github, policy(), {
      eventName: "issues", action: "edited", actor: "JohnnyZLi", eventId: "run-700:old", eventSequence: 700,
      issueNumber: 18, issueTitle: "Older same-second title", issueBody: oldBody,
      issueLabels: ["state:working", "agent:ready"], issueUpdatedAt: updatedAt, issueIsPullRequest: false,
    });
    const recovered = await recoverCoordinatorSnapshots(github, policy());
    expect(recovered[0]).toMatchObject({ event_sequence: 701, event_id: "run-701:new", title: "Newer same-second title" });
    await ingestCoordinatorSnapshot(github, policy(), recovered[0]!);
    const work = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(work?.title).toBe("Newer same-second title");
    expect(canonicalRequirements(work!)).toContain("same-second newer");
  });
});

describe("durable Integration one-request/one-run/result authority", () => {
  it("binds only the run that consumes the one-use protected dispatch capability", async () => {
    const github = makeGithub();
    const record = await publishAuthorizedRecord(github, 101);
    await installRunStartEvidence(github, record, 101, "2026-08-17T03:20:01.000Z");
    const bound = await bindIntegrationRun(github, snapshot(), record.request.request_id, 101);
    expect(bound.run?.id).toBe(101);
    await expect(bindIntegrationRun(github, snapshot(), record.request.request_id, 102)).rejects.toThrow(/already bound/);
    expect(github.__listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("preserves terminal PASS after comments and the exact Actions run are deleted", async () => {
    const github = makeGithub();
    const record = await publishBoundRecord(github, 201);
    const attestation = integrationAttestation(record);
    await publishIntegrationRecord(github, {
      ...record,
      terminal: { state: "success", attestation, created_at: "2026-08-17T03:30:05.000Z" },
      created_at: "2026-08-17T03:30:05.000Z",
    });
    github.__comments.splice(0);
    github.__runs.splice(0);
    github.__attempts.clear();
    const state = await settleIntegrationState(github);
    expect(state.state).toBe("success");
    expect(state.attestation?.integration).toEqual({ request_id: record.request.request_id, run_id: 201, run_attempt: 1 });
  });

  it("preserves durable terminal failure and never silently converts it into retry", async () => {
    const github = makeGithub();
    const record = await publishBoundRecord(github, 301);
    await publishIntegrationRecord(github, {
      ...record,
      terminal: { state: "failure", detail: "protected gate failed", created_at: "2026-08-17T03:40:05.000Z" },
      created_at: "2026-08-17T03:40:05.000Z",
    });
    github.__comments.splice(0); github.__runs.splice(0); github.__attempts.clear();
    expect((await settleIntegrationState(github)).state).toBe("failure");
    expect((await ensureIntegrationDispatch(github, snapshot(), Date.parse("2026-08-17T04:00:00Z"))).dispatch).toBe(false);
  });

  it("seals failure from durable run-start evidence after the Actions run is deleted and no workflow_run consumer runs", async () => {
    const github = makeGithub();
    const bound = await publishBoundRecord(github, 401);
    github.__runs.splice(0); github.__attempts.clear(); github.__comments.splice(0);
    const next = await ensureIntegrationDispatch(github, snapshot(), Date.parse("2026-08-17T04:10:00Z"));
    expect(next.dispatch).toBe(false);
    const current = await getCurrentIntegrationRecord(github, snapshot().identity);
    expect(current?.terminal?.state).toBe("failure");
    expect(current?.run?.id).toBe(401);
    expect((await currentIntegrationState(github, snapshot(), Date.parse("2026-08-17T04:10:00Z"))).state).toBe("failure");
  });

  it("recovers a genuine failure before integration-runtime prepare from pre-checkout run-start evidence", async () => {
    const github = makeGithub();
    const record = await publishAuthorizedRecord(github, 550, "2026-08-17T03:25:00.000Z");
    await installRunStartEvidence(github, record, 550, "2026-08-17T03:25:01.000Z");
    // No bindIntegrationRun call and no workflow_run sealing event: model checkout/setup/build failure plus run deletion.
    github.__runs.splice(0); github.__attempts.clear(); github.__comments.splice(0);
    const next = await ensureIntegrationDispatch(github, snapshot(), Date.parse("2026-08-17T04:00:00Z"));
    expect(next.dispatch).toBe(false);
    const current = await getCurrentIntegrationRecord(github, snapshot().identity);
    expect(current?.run?.id).toBe(550);
    expect(current?.terminal?.state).toBe("failure");
  });

  it("does not consult capped workflow-run search even with more than 1000 same-request flood records", async () => {
    const github = makeGithub();
    const record = await publishAuthorizedRecord(github, 500);
    await installRunStartEvidence(github, record, 500, "2026-08-17T03:20:01.000Z");
    for (let index = 0; index < 1200; index += 1) {
      github.__runs.push(run(record.request, 1000 + index, `2026-08-17T03:21:${String(index % 60).padStart(2, "0")}.000Z`, "queued", null));
    }
    const bound = await bindIntegrationRun(github, snapshot(), record.request.request_id, 500);
    expect(bound.run?.id).toBe(500);
    expect(github.__listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("seals an observed protected failure only for the run-start evidence run ID", async () => {
    const github = makeGithub();
    const record = await publishAuthorizedRecord(github, 600, "2026-08-17T03:35:00.000Z");
    await installRunStartEvidence(github, record, 600, "2026-08-17T03:35:01.000Z");
    await expect(sealIntegrationWorkflowRunEvent(github, completionEvent(record.request, 900, "failure", "2026-08-17T03:35:09.000Z"))).resolves.toBe(false);
    await expect(sealIntegrationWorkflowRunEvent(github, completionEvent(record.request, 600, "failure", "2026-08-17T03:35:06.000Z"))).resolves.toBe(true);
    const current = await getCurrentIntegrationRecord(github, snapshot().identity);
    expect(current?.run?.id).toBe(600);
    expect(current?.terminal?.state).toBe("failure");
  });

  it("keeps an observed cancellation retryable but never guesses cancellation after evidence/run deletion", async () => {
    const github = makeGithub();
    const record = await publishAuthorizedRecord(github, 700, "2026-08-17T03:36:00.000Z");
    await installRunStartEvidence(github, record, 700, "2026-08-17T03:36:01.000Z");
    await expect(sealIntegrationWorkflowRunEvent(github, completionEvent(record.request, 700, "cancelled", "2026-08-17T03:36:05.000Z"))).resolves.toBe(true);
    const current = await getCurrentIntegrationRecord(github, snapshot().identity);
    expect(current?.terminal?.state).toBe("aborted");
  });

  it("treats replayed Integration receipt comments as hints and keeps newer terminal d3 authority", async () => {
    const github = makeGithub();
    const record = await publishAuthorizedRecord(github, 800, "2026-08-17T03:45:00.000Z");
    const stale = github.__comments.find((comment) => comment.body.includes("integration-d3"))!.body;
    await publishIntegrationRecord(github, {
      ...record,
      terminal: { state: "failure", detail: "terminal", created_at: "2026-08-17T03:45:05.000Z" },
      created_at: "2026-08-17T03:45:05.000Z",
    });
    github.__comments.splice(0);
    await github.octokit.rest.issues.createComment({ owner: "JohnnyZLi", repo: "Fugue", issue_number: 21, body: stale });
    const current = await getCurrentIntegrationRecord(github, snapshot().identity);
    expect(current?.terminal?.state).toBe("failure");
  });
});

interface TestComment {
  id: number;
  issueNumber: number;
  body: string;
  user?: { login: string; type: string };
  created_at?: string;
  updated_at?: string;
}
interface TestStatus { id: number; sha: string; context: string; description: string; target_url?: string; created_at?: string; }
interface TestRun {
  id: number;
  actor: typeof BOT;
  event: string;
  head_sha: string;
  display_title: string;
  created_at: string;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}
interface TestGitCommit { sha: string; message: string; tree: { sha: string }; parents: Array<{ sha: string }>; }
interface TestGithub extends FugueGitHub {
  __baseSha: string;
  __publisherSha?: string;
  __comments: TestComment[];
  __statuses: TestStatus[];
  __runs: TestRun[];
  __attempts: Map<number, TestRun>;
  __refs: Map<string, string>;
  __gitCommits: Map<string, TestGitCommit>;
  __nextStatusId: number;
  __listStatus: ReturnType<typeof vi.fn>;
  __listWorkflowRuns: ReturnType<typeof vi.fn>;
}

function makeGithub(options: { failManifestAlways?: boolean; failFirstManifest?: boolean; interleaveBeforeManifest?: number } = {}): TestGithub {
  const comments: TestComment[] = [];
  const statuses: TestStatus[] = [];
  const runs: TestRun[] = [];
  const attempts = new Map<number, TestRun>();
  const refs = new Map<string, string>();
  const gitCommits = new Map<string, TestGitCommit>();
  gitCommits.set(BASE, { sha: BASE, message: "protected base", tree: { sha: "1".repeat(40) }, parents: [] });
  gitCommits.set(HEAD, { sha: HEAD, message: "candidate", tree: { sha: "2".repeat(40) }, parents: [{ sha: BASE }] });
  let nextGitCommit = 0;
  let nextCommentId = 0;
  let nextStatusId = 0;
  let failedManifest = false;
  let interleavedManifest = false;
  const listForRepo = vi.fn();
  const listCommits = vi.fn();
  const listWorkflowRuns = vi.fn(async () => ({ data: { workflow_runs: runs } }));
  const listCommitStatusesForRef = vi.fn(async (args: { ref: string; page?: number; per_page?: number }) => {
    const perPage = args.per_page ?? 100;
    const page = args.page ?? 1;
    const filtered = statuses.filter((status) => status.sha === args.ref).sort((a, b) => b.id - a.id);
    return { data: filtered.slice((page - 1) * perPage, page * perPage) };
  });
  const listComments = vi.fn(async (args: { issue_number: number; page?: number; per_page?: number }) => {
    const perPage = args.per_page ?? 100;
    const page = args.page ?? 1;
    const filtered = comments.filter((comment) => comment.issueNumber === args.issue_number).sort((a, b) => a.id - b.id);
    return { data: filtered.slice((page - 1) * perPage, page * perPage) };
  });
  const getRef = vi.fn(async (args: { ref: string }) => {
    const sha = refs.get(args.ref);
    if (!sha) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { data: { object: { sha } } };
  });
  const getCommit = vi.fn(async (args: { commit_sha: string }) => {
    const commit = gitCommits.get(args.commit_sha);
    if (!commit) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { data: commit };
  });
  const createCommit = vi.fn(async (args: { message: string; tree: string; parents: string[] }) => {
    const sha = (++nextGitCommit).toString(16).padStart(40, "0");
    const commit: TestGitCommit = { sha, message: args.message, tree: { sha: args.tree }, parents: args.parents.map((parent) => ({ sha: parent })) };
    gitCommits.set(sha, commit);
    return { data: commit };
  });
  const createRef = vi.fn(async (args: { ref: string; sha: string }) => {
    const ref = args.ref.replace(/^refs\//, "");
    if (refs.has(ref)) throw Object.assign(new Error("Reference exists"), { status: 422 });
    refs.set(ref, args.sha);
    return { data: { ref: args.ref, object: { sha: args.sha } } };
  });
  const updateRef = vi.fn(async (args: { ref: string; sha: string; force?: boolean }) => {
    const current = refs.get(args.ref);
    const next = gitCommits.get(args.sha);
    if (!current || !next) throw Object.assign(new Error("Not Found"), { status: 404 });
    if (!args.force && next.parents[0]?.sha !== current) throw Object.assign(new Error("Not fast forward"), { status: 422 });
    refs.set(args.ref, args.sha);
    return { data: { ref: args.ref, object: { sha: args.sha } } };
  });

  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    __baseSha: BASE,
    __comments: comments,
    __statuses: statuses,
    __runs: runs,
    __attempts: attempts,
    __refs: refs,
    __gitCommits: gitCommits,
    get __nextStatusId() { return nextStatusId; },
    set __nextStatusId(value: number) { nextStatusId = value; },
    __listStatus: listCommitStatusesForRef,
    __listWorkflowRuns: listWorkflowRuns,
    octokit: {
      paginate: vi.fn(async (fn: unknown) => {
        if (fn === listForRepo) return [{ number: 18, pull_request: undefined, state: "open", labels: [], body: "", title: "Issue", html_url: "https://example.test/issues/18" }];
        if (fn === listCommits) return [{ sha: BASE }];
        if (fn === listWorkflowRuns) return runs;
        return [];
      }),
      rest: {
        issues: {
          get: vi.fn(async (args: { issue_number: number }) => ({ data: { comments: comments.filter((comment) => comment.issueNumber === args.issue_number).length } })),
          listComments,
          createComment: vi.fn(async (args: { issue_number: number; body: string }) => {
            const comment: TestComment = { id: ++nextCommentId, issueNumber: args.issue_number, body: args.body, user: BOT, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            comments.push(comment);
            return { data: { id: comment.id, body: comment.body, html_url: `https://example.test/comment/${comment.id}`, created_at: comment.created_at } };
          }),
          updateComment: vi.fn(async (args: { comment_id: number; body: string }) => {
            const comment = comments.find((item) => item.id === args.comment_id);
            if (!comment) throw Object.assign(new Error("Not Found"), { status: 404 });
            comment.body = args.body; comment.updated_at = new Date().toISOString();
            return { data: { id: comment.id, body: comment.body, html_url: `https://example.test/comment/${comment.id}`, created_at: comment.created_at } };
          }),
          deleteComment: vi.fn(async (args: { comment_id: number }) => {
            const index = comments.findIndex((item) => item.id === args.comment_id);
            if (index >= 0) comments.splice(index, 1);
            return { data: {} };
          }),
          listForRepo,
          update: vi.fn(async () => ({ data: {} })),
        },
        repos: {
          createCommitStatus: vi.fn(async (args: { sha: string; context: string; description?: string; target_url?: string }) => {
            if (args.context.includes("/m/") && (options.failManifestAlways || (options.failFirstManifest && !failedManifest))) {
              failedManifest = true; throw Object.assign(new Error("status context exhausted"), { status: 422 });
            }
            if (args.context.includes("/m/") && options.interleaveBeforeManifest && !interleavedManifest) {
              interleavedManifest = true;
              for (let index = 0; index < options.interleaveBeforeManifest; index += 1) {
                statuses.push({ id: ++nextStatusId, sha: args.sha, context: `hostile/pre-manifest/${index}`, description: "interleaved" });
              }
            }
            const status = { id: ++nextStatusId, sha: args.sha, context: args.context, description: args.description ?? "", target_url: args.target_url, created_at: new Date().toISOString() };
            statuses.push(status); return { data: status };
          }),
          listCommitStatusesForRef,
          getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "admin" } })),
          listCommits,
        },
        actions: {
          listWorkflowRuns,
          getWorkflowRunAttempt: vi.fn(async (args: { run_id: number; attempt_number: number }) => {
            const item = attempts.get(args.run_id);
            if (!item || args.attempt_number !== 1) throw Object.assign(new Error("Not Found"), { status: 404 });
            return { data: item };
          }),
          createWorkflowDispatch: vi.fn(async () => ({ data: {} })),
        },
        git: { getRef, getCommit, createCommit, createRef, updateRef },
        pulls: { get: vi.fn(async () => ({ data: { head: { sha: HEAD }, base: { ref: "main" } } })) },
      },
    },
  } as unknown as TestGithub;
}

function completionEvent(request: ReturnType<typeof createIntegrationRequest>, runId: number, conclusion: string | null, createdAt: string) {
  return {
    eventName: "workflow_run" as const, workflowName: "Fugue Integration", runId, runAttempt: 1,
    conclusion, status: "completed", headSha: request.identity.baseSha,
    displayTitle: integrationRunTitle(request.request_id, request.identity.prNumber),
    createdAt, htmlUrl: `https://example.test/runs/${runId}`, actor: BOT.login,
  };
}

function run(request: ReturnType<typeof createIntegrationRequest>, id: number, createdAt: string, status: string, conclusion: string | null): TestRun {
  return {
    id, actor: BOT, event: "workflow_dispatch", head_sha: request.identity.baseSha,
    display_title: integrationRunTitle(request.request_id, request.identity.prNumber),
    created_at: createdAt, run_attempt: 1, status, conclusion, html_url: `https://example.test/runs/${id}`,
  };
}

async function publishAuthorizedRecord(
  github: TestGithub,
  runId: number,
  createdAt = "2026-08-17T03:30:00.000Z",
): Promise<IntegrationRecord> {
  const request = createIntegrationRequest(snapshot().identity, createdAt, runId.toString(16).padStart(16, "0"));
  const authorized = await authorizeIntegrationDispatch(
    github,
    request,
    createdAt,
    runId.toString(16).padStart(64, "0"),
  );
  return publishIntegrationRecord(github, createIntegrationRecord(request, {
    dispatch: authorized.authorization,
    createdAt,
  }));
}

async function installRunStartEvidence(
  github: TestGithub,
  record: IntegrationRecord,
  runId: number,
  createdAt: string,
): Promise<void> {
  if (!record.dispatch) throw new Error("test Integration record lacks dispatch authorization");
  const ref = integrationEvidenceRefName(record.dispatch.secret_digest);
  const refData = await github.octokit.rest.git.getRef({ owner: "JohnnyZLi", repo: "Fugue", ref });
  const anchorSha = refData.data.object.sha;
  const anchor = await github.octokit.rest.git.getCommit({ owner: "JohnnyZLi", repo: "Fugue", commit_sha: anchorSha });
  const evidence = integrationRunStartSchema.parse({
    version: 1, kind: "integration_run_start", request_id: record.request.request_id,
    pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
    secret_digest: record.dispatch.secret_digest, run_id: runId, run_attempt: 1, created_at: createdAt,
  });
  const signed = await signProtocolBody(github, serializeIntegrationRunStartEvidence(evidence));
  const commit = await github.octokit.rest.git.createCommit({
    owner: "JohnnyZLi", repo: "Fugue", message: signed, tree: anchor.data.tree.sha, parents: [anchorSha],
  });
  await github.octokit.rest.git.updateRef({ owner: "JohnnyZLi", repo: "Fugue", ref, sha: commit.data.sha, force: false });
  expect((await getIntegrationRunStartEvidence(github, record))?.run_id).toBe(runId);
}

async function publishBoundRecord(github: TestGithub, runId: number): Promise<IntegrationRecord> {
  const record = await publishAuthorizedRecord(github, runId);
  await installRunStartEvidence(github, record, runId, "2026-08-17T03:30:01.000Z");
  const first = run(record.request, runId, "2026-08-17T03:30:01.000Z", "in_progress", null);
  github.__runs.push(first); github.__attempts.set(runId, first);
  return bindIntegrationRun(github, snapshot(), record.request.request_id, runId);
}

function integrationAttestation(record: IntegrationRecord) {
  return integrationAttestationSchema.parse({
    version: 1,
    kind: "integration",
    attestation_id: "att-integration-test",
    identity: record.identity,
    integration: { request_id: record.request.request_id, run_id: record.run!.id, run_attempt: 1 },
    fugue_version: "0.1.0-alpha.0",
    qa: { code: "passed", security: "passed", visual: "not_required" },
    dependencies: { passed: true },
    agents_md: { impact_reviewed: true, update_required: false, update_present: false },
    control_plane: { changed: false, human_acknowledgement: "not_required" },
    validation_control: { changed: false, reviewed: true, acceptable: true },
    validation: { clean_worktree: true, passed: true, commands: ["npm test"] },
    ci: { passed: true, checks: ["test"] },
    base_current: { passed: true }, conflicts: { none: true }, verdict: "approved",
    created_at: "2026-08-17T03:30:05.000Z",
  });
}

async function settleIntegrationState(github: TestGithub) {
  let state = await currentIntegrationState(github, snapshot(), Date.parse("2026-08-17T04:00:00Z"));
  for (let attempt = 0; attempt < 8 && state.state === "pending"; attempt += 1) {
    state = await currentIntegrationState(github, snapshot(), Date.parse("2026-08-17T04:00:00Z"));
  }
  return state;
}
