import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FugueGitHub } from "../src/core/github.js";
import { workMetadataSchema } from "../src/core/metadata.js";
import {
  assertRepositoryDefaultBranchRevision,
  createDurableManifestProof,
  FUGUE_PROTOCOL_ACTOR,
  signProtocolBody,
  verifyDurableManifestProof,
  verifyProtocolPublicationBodyAtRevision,
} from "../src/core/provenance.js";
import {
  canonicalRequirements,
  compactFugueRecoveryAuthorityVariables,
  createCanonicalWorkState,
  loadCurrentCanonicalWorkState,
  parseCanonicalWorkState,
  publishCanonicalWorkState,
  publishDurableProtocolRecord,
  recoverDurableProtocolRecord,
} from "../src/core/state.js";

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  return {
    ...actual,
    assertRepositoryDefaultBranchRevision: vi.fn(async (github: FugueGitHub, expected: string) => {
      const actualSha = (github as TestGithub).__baseSha;
      if (actualSha.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`stale protected revision ${actualSha.slice(0, 8)}`);
      }
    }),
    signProtocolBody: vi.fn(async (github: FugueGitHub, body: string) => {
      if (body.includes("<!-- fugue-durable-recovery")) {
        await (github as TestGithub).__beforeRecoverySign?.(body);
      }
      return `${body}\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: test-proof\n-->`;
    }),
    createDurableManifestProof: vi.fn(async () => "manifest-proof"),
    verifyDurableManifestProof: vi.fn(async (_github: FugueGitHub, proof: string) => proof === "manifest-proof"),
    verifyProtocolPublicationBodyAtRevision: vi.fn(defaultPublicationVerifier),
    isTrustedProtocolComment: vi.fn(async (_github: FugueGitHub, comment: TestComment) =>
      comment.user?.login === FUGUE_PROTOCOL_ACTOR),
    createProtocolComment: vi.fn(async (github: FugueGitHub, issueNumber: number, body: string) =>
      github.octokit.rest.issues.createComment({
        owner: github.repository.owner,
        repo: github.repository.repo,
        issue_number: issueNumber,
        body,
      })),
  };
});

const BASE = "b".repeat(40);
const NEXT_BASE = "c".repeat(40);
const BOT = { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } as const;

async function defaultPublicationVerifier(
  github: FugueGitHub,
  body: string,
  expected: string,
): Promise<boolean> {
  const publisherSha = (github as TestGithub).__publisherSha ?? expected;
  if (publisherSha.toLowerCase() !== expected.toLowerCase()) return false;
  if (body.includes("<!-- fugue-durable-recovery")) return body.includes("token: test-proof");
  const key = body.match(/Fugue-Authority-Key: ([0-9a-f]{32})/i)?.[1];
  const commit = body.match(/Fugue-Authority-Commit: ([0-9a-f]{32})/i)?.[1];
  return Boolean(key && commit && !/^0+$/.test(key) && !/^0+$/.test(commit));
}

function metadata(execution = false) {
  return workMetadataSchema.parse({
    version: 1,
    work_id: "work-18",
    spec: {
      dependencies: [],
      ownership: { owned: ["src/**"], coordinate: [], forbidden: [] },
      qa: { force: ["code", "security"] },
      authorized_changes: { agents_invariants: [] },
    },
    execution: execution
      ? { worker_id: "wkr-b0057a9e", branch: "agent/18-migrate-fugue-to-chat-first-github-hosted-orchestration" }
      : {},
  });
}

interface TestComment {
  id: number;
  issueNumber: number;
  body: string;
  user?: { login: string; type: string };
  created_at?: string;
  updated_at?: string;
}

interface TestStatus {
  id: number;
  sha: string;
  context: string;
  description: string;
  target_url?: string;
  created_at: string;
}

interface TestGithub extends FugueGitHub {
  __baseSha: string;
  __publisherSha?: string;
  __authorityVariables: Map<string, string>;
  __comments: TestComment[];
  __statuses: TestStatus[];
  __beforeRecoverySign?: (body: string) => Promise<void> | void;
}

function makeGithub(): TestGithub {
  const authorityVariables = new Map<string, string>();
  const comments: TestComment[] = [];
  const statuses: TestStatus[] = [];
  let nextCommentId = 0;
  let nextStatusId = 0;

  return {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    __baseSha: BASE,
    __authorityVariables: authorityVariables,
    __comments: comments,
    __statuses: statuses,
    octokit: {
      rest: {
        issues: {
          get: vi.fn(async (args: { issue_number: number }) => ({
            data: { comments: comments.filter((comment) => comment.issueNumber === args.issue_number).length },
          })),
          listComments: vi.fn(async (args: { issue_number: number; page?: number; per_page?: number }) => {
            const perPage = args.per_page ?? 100;
            const page = args.page ?? 1;
            const filtered = comments
              .filter((comment) => comment.issueNumber === args.issue_number)
              .sort((left, right) => left.id - right.id);
            return { data: filtered.slice((page - 1) * perPage, page * perPage) };
          }),
          createComment: vi.fn(async (args: { issue_number: number; body: string }) => {
            const created = new Date().toISOString();
            const comment: TestComment = {
              id: ++nextCommentId,
              issueNumber: args.issue_number,
              body: args.body,
              user: BOT,
              created_at: created,
              updated_at: created,
            };
            comments.push(comment);
            return { data: { id: comment.id, body: comment.body, created_at: created } };
          }),
          deleteComment: vi.fn(async (args: { comment_id: number }) => {
            const index = comments.findIndex((comment) => comment.id === args.comment_id);
            if (index >= 0) comments.splice(index, 1);
            return { data: {} };
          }),
        },
        repos: {
          createCommitStatus: vi.fn(async (args: {
            sha: string;
            context: string;
            description?: string;
            target_url?: string;
          }) => {
            const status: TestStatus = {
              id: ++nextStatusId,
              sha: args.sha,
              context: args.context,
              description: args.description ?? "",
              target_url: args.target_url,
              created_at: new Date().toISOString(),
            };
            statuses.push(status);
            return { data: status };
          }),
        },
      },
    },
  } as unknown as TestGithub;
}

function recoveryCursorBody(body: string): Record<string, unknown> | undefined {
  const payload = body.match(/<!-- fugue-durable-recovery\nversion: 1\npayload: ([A-Za-z0-9_-]+)/)?.[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function recoveryCheckpointBodies(github: TestGithub): string[] {
  const result: string[] = [];
  for (const [name, value] of github.__authorityVariables) {
    if (name.startsWith("FUGUE_D3_")) {
      result.push(value);
      continue;
    }
    if (!name.startsWith("FUGUE_D3P_")) continue;
    try {
      const pack = JSON.parse(value) as { kind?: string; entries?: unknown[] };
      if (pack.kind !== "durable_recovery_pack" || !Array.isArray(pack.entries)) continue;
      for (const entry of pack.entries) if (typeof entry === "string") result.push(entry);
    } catch {
      // Unreadable packs intentionally remain opaque to readers and compactors.
    }
  }
  return result;
}

function recoveryScopes(github: TestGithub): Set<string> {
  return new Set(recoveryCheckpointBodies(github)
    .map((body) => recoveryCursorBody(body)?.scope)
    .filter((scope): scope is string => typeof scope === "string"));
}

function recoveryOrders(github: TestGithub, scope: string): string[] {
  return recoveryCheckpointBodies(github).flatMap((body) => {
    const cursor = recoveryCursorBody(body);
    if (cursor?.scope !== scope || cursor.commit_witness !== true) return [];
    const manifest = cursor.best_manifest as { authority_order_b64?: unknown } | undefined;
    if (typeof manifest?.authority_order_b64 !== "string") return [];
    return [Buffer.from(manifest.authority_order_b64, "base64url").toString("utf8")];
  });
}

function recoveryBucket(scope: string): string {
  return createHash("sha256")
    .update(`${BASE.toLowerCase()}\0${BASE.toLowerCase()}\0${scope}`, "utf8")
    .digest("hex")
    .slice(0, 2)
    .toUpperCase();
}

function sameBucketScopes(): { bucket: string; first: string; second: string } {
  const firstByBucket = new Map<string, string>();
  for (let index = 0; index < 10_000; index += 1) {
    const scope = `mixed-validity/${index}`;
    const bucket = recoveryBucket(scope);
    const first = firstByBucket.get(bucket);
    if (first) return { bucket, first, second: scope };
    firstByBucket.set(bucket, scope);
  }
  throw new Error("unable to find two recovery scopes in one bucket");
}

class AdvanceBaseOnRecoveryLeafMap extends Map<string, string> {
  armed = false;
  onLeaf?: () => void;

  override set(key: string, value: string): this {
    super.set(key, value);
    if (this.armed && /^FUGUE_D3_[0-9A-F]{16}_[0-9A-F]{16}$/i.test(key)) {
      this.armed = false;
      this.onLeaf?.();
    }
    return this;
  }
}

function fillAuthorityCapacity(github: TestGithub, prefix: string): void {
  let index = 0;
  while (github.__authorityVariables.size < 500) {
    github.__authorityVariables.set(`${prefix}${String(index++).padStart(4, "0")}`, "unrelated");
  }
}

describe("absorbed Code QA / Security QA authority blockers", () => {
  it("keeps a later Worker successor authoritative when an older overlapping publisher finishes last", async () => {
    const github = makeGithub();
    const root = createCanonicalWorkState({
      issue: 18,
      title: "Causal root",
      state: "state:ready",
      agentReady: true,
      requirements: "## Outcome\nroot intent",
      metadata: metadata(false),
      pr: null,
      baseSha: BASE,
      createdAt: "2026-08-17T05:00:00.000Z",
      logicalRoot: true,
    });
    await expect(publishCanonicalWorkState(github, root)).resolves.toBe(true);
    const predecessor = (await loadCurrentCanonicalWorkState(github, 18, BASE))!;

    const stale = createCanonicalWorkState({
      issue: 18,
      title: "Older Human edit",
      state: "state:ready",
      agentReady: true,
      requirements: "## Outcome\nolder intent",
      metadata: predecessor.metadata,
      pr: null,
      baseSha: BASE,
      createdAt: "2026-08-17T05:00:01.000Z",
      predecessor,
    });
    const worker = createCanonicalWorkState({
      issue: 18,
      title: predecessor.title,
      state: "state:working",
      agentReady: true,
      requirements: canonicalRequirements(predecessor),
      metadata: metadata(true),
      pr: null,
      baseSha: BASE,
      createdAt: "2026-08-17T05:00:02.000Z",
      predecessor,
    });

    let releaseStale!: () => void;
    let markStaleReached!: () => void;
    const staleRelease = new Promise<void>((resolve) => { releaseStale = resolve; });
    const staleReached = new Promise<void>((resolve) => { markStaleReached = resolve; });
    github.__beforeRecoverySign = async (body) => {
      const cursor = recoveryCursorBody(body);
      if (cursor?.scope !== "work/18" || cursor.commit_witness !== true || typeof cursor.best_body_b64 !== "string") return;
      const proposed = parseCanonicalWorkState(Buffer.from(cursor.best_body_b64, "base64url").toString("utf8"));
      if (proposed?.title !== stale.title) return;
      markStaleReached();
      await staleRelease;
    };

    const stalePublish = publishCanonicalWorkState(github, stale);
    await staleReached;
    await expect(publishCanonicalWorkState(github, worker)).resolves.toBe(true);
    releaseStale();
    await expect(stalePublish).resolves.toBe(false);
    github.__beforeRecoverySign = undefined;

    const current = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(current?.title).toBe("Causal root");
    expect(current?.state).toBe("state:working");
    expect(current?.metadata.execution.worker_id).toBe("wkr-b0057a9e");
    expect(current?.authority_sequence).toBe(1);
    expect(canonicalRequirements(current!)).toBe("## Outcome\nroot intent");
    expect(recoveryOrders(github, "work/18").filter((order) => order.endsWith("00000000000000000001"))).toHaveLength(1);
  });

  it("removes or reverses a d3 witness when protected base advances inside final create/rename mutation windows", async () => {
    const createRace = makeGithub();
    const createVariables = new AdvanceBaseOnRecoveryLeafMap();
    createRace.__authorityVariables = createVariables;
    createVariables.onLeaf = () => { createRace.__baseSha = NEXT_BASE; };
    createVariables.armed = true;

    await expect(publishDurableProtocolRecord(createRace, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: "final-create-race",
      unsignedBody: "must-not-commit-after-create-race",
      publicationTimestamp: Date.parse("2026-08-17T05:10:00.000Z"),
      authorityOrder: "2026-08-17T05:10:00.000Z",
    })).rejects.toThrow(/stale protected revision/);
    expect(recoveryScopes(createRace).has("final-create-race")).toBe(false);

    const renameRace = makeGithub();
    const renameVariables = new AdvanceBaseOnRecoveryLeafMap();
    renameRace.__authorityVariables = renameVariables;
    for (let index = 0; index < 8; index += 1) {
      renameVariables.set(`FUGUE_D3R_${String(index).padStart(2, "0")}`, "reserved-for-fugue-recovery-compaction");
    }
    fillAuthorityCapacity(renameRace, "UNRELATED_FINAL_RACE_");
    const unrelatedBefore = [...renameVariables.keys()].filter((name) => name.startsWith("UNRELATED_FINAL_RACE_")).length;
    renameVariables.onLeaf = () => { renameRace.__baseSha = NEXT_BASE; };
    renameVariables.armed = true;

    await expect(publishDurableProtocolRecord(renameRace, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: "final-rename-race",
      unsignedBody: "must-not-commit-after-rename-race",
      publicationTimestamp: Date.parse("2026-08-17T05:11:00.000Z"),
      authorityOrder: "2026-08-17T05:11:00.000Z",
    })).rejects.toThrow(/stale protected revision/);
    expect(recoveryScopes(renameRace).has("final-rename-race")).toBe(false);
    expect([...renameVariables.keys()].filter((name) => name.startsWith("FUGUE_D3R_"))).toHaveLength(8);
    expect([...renameVariables.keys()].filter((name) => name.startsWith("UNRELATED_FINAL_RACE_")).length).toBe(unrelatedBefore);
    expect(renameVariables.size).toBe(500);
  });

  it("quarantines a mixed-validity recovery pack instead of compacting away its unverifiable sibling", async () => {
    const github = makeGithub();
    const { bucket, first, second } = sameBucketScopes();
    const firstOrder = "2026-08-17T05:20:00.000Z";
    const secondOrder = "2026-08-17T05:21:00.000Z";

    await publishDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: first,
      unsignedBody: `first-body:${first}`,
      publicationTimestamp: Date.parse(firstOrder),
      authorityOrder: firstOrder,
    });
    await publishDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: second,
      unsignedBody: `second-body:${second}`,
      publicationTimestamp: Date.parse(secondOrder),
      authorityOrder: secondOrder,
    });
    await compactFugueRecoveryAuthorityVariables(github);

    const pack = [...github.__authorityVariables.entries()].find(([name, value]) =>
      name.startsWith(`FUGUE_D3P_${bucket}_`) && value.includes(first) && value.includes(second));
    expect(pack).toBeDefined();
    const [packName, packValue] = pack!;
    expect(recoveryScopes(github)).toEqual(expect.objectContaining(new Set([first, second])));

    let failedSecond = false;
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockImplementation(async (candidateGithub, body, expected) => {
      if (!failedSecond && body.includes("<!-- fugue-durable-recovery") && body.includes(second)) {
        failedSecond = true;
        return false;
      }
      return defaultPublicationVerifier(candidateGithub, body, expected);
    });
    await compactFugueRecoveryAuthorityVariables(github);
    expect(failedSecond).toBe(true);
    expect(github.__authorityVariables.get(packName)).toBe(packValue);

    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockImplementation(defaultPublicationVerifier);
    const recoveredFirst = await recoverDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: first,
      issueNumber: 18,
      parse: (body) => body,
      timestamp: () => Date.parse(firstOrder),
      order: () => firstOrder,
    });
    const recoveredSecond = await recoverDurableProtocolRecord(github, {
      storageSha: BASE,
      publisherSha: BASE,
      scope: second,
      issueNumber: 18,
      parse: (body) => body,
      timestamp: () => Date.parse(secondOrder),
      order: () => secondOrder,
    });
    expect(recoveredFirst.record?.body).toContain(`first-body:${first}`);
    expect(recoveredSecond.record?.body).toContain(`second-body:${second}`);
  });
});
