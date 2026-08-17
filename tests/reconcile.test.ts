import { createHash } from "node:crypto";
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
  INTEGRATION_AUTHORITY_SLOT_LIMIT,
  integrationAnchorVariableName,
  integrationElectionVariableName,
  integrationRunStartVariableName,
  integrationRunStartSchema,
  publishIntegrationRecord,
  releaseIntegrationAuthorityVariable,
  sealIntegrationWorkflowRunEvent,
  serializeIntegrationRunStartEvidence,
} from "../src/core/integration-status.js";
import { upsertWorkMetadata, workMetadataSchema } from "../src/core/metadata.js";
import type { ActivePolicy } from "../src/core/policy.js";
import {
  assertRepositoryDefaultBranchRevision,
  FUGUE_PROTOCOL_ACTOR,
  signProtocolBody,
  createDurableManifestProof,
  verifyDurableManifestProof,
  verifyProtocolPublicationBodyAtRevision,
} from "../src/core/provenance.js";
import { ingestCoordinatorSnapshot, preserveCoordinatorIssueEvent } from "../src/core/reconcile.js";
import {
  canonicalRequirements,
  compactFugueRecoveryAuthorityVariables,
  coordinatorSnapshotSchema,
  createCanonicalWorkState,
  durableManifestContext,
  loadCurrentCanonicalWorkState,
  parseCanonicalWorkState,
  publishCanonicalWorkState,
  publishCoordinatorSnapshot,
  publishDurableProtocolRecord,
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


function recoveryCursorBody(body: string): Record<string, unknown> | undefined {
  const payload = body.match(/<!-- fugue-durable-recovery\nversion: 1\npayload: ([A-Za-z0-9_-]+)/)?.[1];
  if (!payload) return undefined;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>; }
  catch { return undefined; }
}

function recoveryCheckpointBodies(github: TestGithub): string[] {
  const bodies: string[] = [];
  for (const [name, value] of github.__authorityVariables) {
    if (name.startsWith("FUGUE_D3_")) {
      bodies.push(value);
      continue;
    }
    if (!name.startsWith("FUGUE_D3P_")) continue;
    try {
      const parsed = JSON.parse(value) as { kind?: string; entries?: unknown[] };
      if (parsed.kind === "durable_recovery_pack" && Array.isArray(parsed.entries)) {
        for (const body of parsed.entries) if (typeof body === "string") bodies.push(body);
      }
    } catch { /* malformed packs are intentionally ignored by readers */ }
  }
  return bodies;
}

function recoveryScopes(github: TestGithub): Set<string> {
  return new Set(recoveryCheckpointBodies(github)
    .map((body) => recoveryCursorBody(body)?.scope)
    .filter((scope): scope is string => typeof scope === "string"));
}

function explodeRecoveryPacksToLeaves(github: TestGithub): void {
  const packs = [...github.__authorityVariables.entries()].filter(([name]) => name.startsWith("FUGUE_D3P_"));
  for (const [packName, value] of packs) {
    const parsed = JSON.parse(value) as { kind?: string; entries?: unknown[] };
    if (parsed.kind !== "durable_recovery_pack" || !Array.isArray(parsed.entries)) continue;
    github.__authorityVariables.delete(packName);
    for (const [index, raw] of parsed.entries.entries()) {
      if (typeof raw !== "string") continue;
      const cursor = recoveryCursorBody(raw);
      if (!cursor || typeof cursor.storage_sha !== "string" || typeof cursor.publisher_sha !== "string" || typeof cursor.scope !== "string") continue;
      const identity = `${cursor.storage_sha.toLowerCase()}\0${cursor.publisher_sha.toLowerCase()}\0${cursor.scope}`;
      const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16).toUpperCase();
      const suffix = createHash("sha256").update(`${raw}\0${index}\0${packName}`, "utf8").digest("hex").slice(0, 16).toUpperCase();
      github.__authorityVariables.set(`FUGUE_D3_${digest}_${suffix}`, raw);
    }
  }
}

function recoveryBucketForScope(scope: string): string {
  return createHash("sha256")
    .update(`${BASE.toLowerCase()}\0${BASE.toLowerCase()}\0${scope}`, "utf8")
    .digest("hex")
    .slice(0, 2)
    .toUpperCase();
}

function distinctRecoveryScopes(count: number, excludedBuckets: ReadonlySet<string>): string[] {
  const scopes: string[] = [];
  const buckets = new Set(excludedBuckets);
  for (let index = 0; scopes.length < count; index += 1) {
    const scope = `crash-bucket/${index}`;
    const bucket = recoveryBucketForScope(scope);
    if (buckets.has(bucket)) continue;
    buckets.add(bucket);
    scopes.push(scope);
  }
  return scopes;
}

function recoveryScopesForBucket(bucket: string, count: number, prefix = "same-bucket"): string[] {
  const scopes: string[] = [];
  for (let index = 0; scopes.length < count; index += 1) {
    const scope = `${prefix}/${index}`;
    if (recoveryBucketForScope(scope) === bucket) scopes.push(scope);
  }
  return scopes;
}

function seedRecoveryWitness(github: TestGithub, scope: string, ordinal: number): void {
  const key = (ordinal + 1).toString(16).padStart(32, "0").slice(-32);
  const nonce = (ordinal + 10001).toString(16).padStart(32, "0").slice(-32);
  const authorityOrder = `2026-08-17T03:${String(ordinal % 60).padStart(2, "0")}:00.000Z-${ordinal}`;
  const signedBody = [
    `seeded-body-${scope}`,
    `Fugue-Authority-Key: ${key}`,
    `Fugue-Authority-Commit: ${nonce}`,
    "<!-- fugue-publisher-proof",
    "version: 1",
    "token: test-proof",
    "-->",
  ].join("\n");
  const chunkId = 100000 + ordinal * 2;
  const manifestId = chunkId + 1;
  const cursor = {
    version: 1, kind: "durable_recovery", scope, storage_sha: BASE, publisher_sha: BASE,
    checkpoint_at: "2026-08-17T03:59:00.000Z",
    complete_top_id: manifestId, scan_top_id: manifestId, scan_floor_id: manifestId,
    before_id: manifestId + 1, page: 1, phase: "discover", commit_witness: true,
    best_body_b64: Buffer.from(signedBody, "utf8").toString("base64url"),
    best_manifest: {
      id: manifestId, key, nonce,
      body_digest: createHash("sha256").update(signedBody, "utf8").digest("hex"),
      authority_order_b64: Buffer.from(authorityOrder, "utf8").toString("base64url"),
      first_status_id: chunkId, last_status_id: chunkId, chunk_count: 1, status_ids: [chunkId],
      proof: "manifest-proof", created_at: "2026-08-17T03:58:59.000Z",
    },
  };
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const signedCursor = [
    "<!-- fugue-durable-recovery", "version: 1", `payload: ${payload}`, "-->", "",
    `Durable Fugue recovery checkpoint: ${scope}`, "", "<!-- fugue-publisher-proof",
    "version: 1", "token: test-proof", "-->",
  ].join("\n");
  const identity = `${BASE.toLowerCase()}\0${BASE.toLowerCase()}\0${scope}`;
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16).toUpperCase();
  const suffix = createHash("sha256").update(signedCursor, "utf8").digest("hex").slice(0, 16).toUpperCase();
  github.__authorityVariables.set(`FUGUE_D3_${digest}_${suffix}`, signedCursor);
}

function fillAuthorityCapacity(github: TestGithub, prefix: string): number {
  let index = 0;
  while (github.__authorityVariables.size < 500) {
    github.__authorityVariables.set(`${prefix}${String(index++).padStart(4, "0")}`, "unrelated");
  }
  return index;
}

class CrashAfterRecoveryLeafMap extends Map<string, string> {
  crashNextLeaf = false;

  override set(key: string, value: string): this {
    super.set(key, value);
    if (this.crashNextLeaf && /^FUGUE_D3_[0-9A-F]{16}_[0-9A-F]{16}$/i.test(key)) {
      this.crashNextLeaf = false;
      throw new Error("simulated crash after recovery checkpoint leaf creation");
    }
    return this;
  }
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

  it("does not treat hostile status-only manifests as committed authority without a protected witness", async () => {
    const github = makeGithub();
    github.__nextStatusId = 1000;
    const order = Buffer.from("2026-08-17T03:00:00.000Z", "utf8").toString("base64url");
    for (let index = 0; index < 100; index += 1) {
      const key = index.toString(16).padStart(32, "0");
      github.__statuses.push({
        id: ++github.__nextStatusId, sha: BASE, context: durableManifestContext("work/18", key),
        description: `n=48;c=${"b".repeat(32)};b=${"a".repeat(64)};a=1;z=48`,
        target_url: `https://token.actions.githubusercontent.com/fugue/d3?o=${order}&i=${Array.from({ length: 48 }, () => "1").join(".")}&p=forged`,
        created_at: "2026-08-17T03:00:01.000Z",
      });
    }
    github.__listStatus.mockClear();
    vi.mocked(verifyDurableManifestProof).mockClear();
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
      parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
    });
    expect(recovered.record).toBeUndefined();
    expect(recovered.exhausted).toBe(true);
    expect(github.__listStatus).not.toHaveBeenCalled();
    expect(vi.mocked(verifyDurableManifestProof)).not.toHaveBeenCalled();
  });

  it("preserves a sole commit witness and fails closed when proof verification is transiently unavailable", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("verification-pending"));
    github.__comments.splice(0);
    const before = new Map(github.__authorityVariables);
    vi.mocked(verifyDurableManifestProof).mockResolvedValueOnce(false);
    await expect(recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
      parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
    })).rejects.toThrow(/exists but is not currently verifiable/);
    expect(github.__authorityVariables).toEqual(before);
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
      parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
    });
    expect(canonicalRequirements(recovered.record!.value)).toBe("verification-pending");
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


  it("binds every exact protected chunk status ID despite hostile same-context interleaving", async () => {
    const github = makeGithub({ interleaveSameContext: true });
    vi.mocked(createDurableManifestProof).mockClear();
    await publishCanonicalWorkState(github, canonicalWork("exact-id-safe"));
    const binding = vi.mocked(createDurableManifestProof).mock.calls.at(-1)?.[1];
    expect(binding?.statusIds).toHaveLength(binding?.chunkCount ?? 0);
    const hostileId = github.__statuses.find((status) => status.description === "hostile-same-context")?.id;
    expect(hostileId).toBeDefined();
    expect(binding?.statusIds).not.toContain(hostileId);
    github.__comments.splice(0);
    const recovered = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(canonicalRequirements(recovered!)).toBe("exact-id-safe");
  });

  it("reconstructs a committed record despite hostile statuses inserted after proof and before manifest commit", async () => {
    const github = makeGithub({ interleaveBeforeManifest: 250 });
    await publishCanonicalWorkState(github, canonicalWork("interleaving-safe"));
    github.__comments.splice(0);
    const recovered = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(canonicalRequirements(recovered!)).toBe("interleaving-safe");
  });

  it("is append-stable when hostile statuses would move every former seek probe by a full page", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("older-valid-authority"));
    github.__comments.splice(0);
    const before = recoveryCheckpointBodies(github).map(recoveryCursorBody)
      .filter((cursor) => cursor?.scope === "work/18").map((cursor) => Number(cursor?.before_id)).filter(Number.isFinite);
    expect(before.length).toBeGreaterThan(0);
    github.__statusReadAppends.push(...Array.from({ length: 160 }, (_, index) => 100 + (index % 4) * 37));
    github.__listStatus.mockClear();
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
      parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
    });
    expect(canonicalRequirements(recovered.record!.value)).toBe("older-valid-authority");
    expect(recovered.exhausted).toBe(true);
    expect(github.__listStatus).not.toHaveBeenCalled();
    const after = recoveryCheckpointBodies(github).map(recoveryCursorBody)
      .filter((cursor) => cursor?.scope === "work/18").map((cursor) => Number(cursor?.before_id)).filter(Number.isFinite);
    expect(Math.min(...after)).toBeLessThanOrEqual(Math.min(...before));
    expect(github.__statusReadAppends).toHaveLength(160);
  });

  it("is append-stable when hostile statuses would move every former post-seek scan read", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("post-seek-stable"));
    github.__comments.splice(0);
    github.__statusReadAppends.push(...Array.from({ length: 96 }, () => 137));
    github.__listStatus.mockClear();
    for (let slice = 0; slice < 12; slice += 1) {
      const recovered = await recoverDurableProtocolRecord(github, {
        storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
        parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
      });
      expect(canonicalRequirements(recovered.record!.value)).toBe("post-seek-stable");
      expect(recovered.exhausted).toBe(true);
    }
    expect(github.__listStatus).not.toHaveBeenCalled();
    expect(github.__statusReadAppends).toHaveLength(96);
  });

  it("self-compacts a full recovery-variable namespace without free-slot headroom", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("capacity-safe"));
    github.__comments.splice(0);
    const checkpoint = [...github.__authorityVariables.entries()].find(([name]) => name.startsWith("FUGUE_D3_"));
    expect(checkpoint).toBeDefined();
    const [name, value] = checkpoint!;
    const prefix = name.slice(0, -16);
    for (let index = 0; github.__authorityVariables.size < 500; index += 1) {
      github.__authorityVariables.set(`${prefix}${index.toString(16).padStart(16, "0")}`, value);
    }
    expect(github.__authorityVariables.size).toBe(500);
    await compactFugueRecoveryAuthorityVariables(github);
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
      parse: parseCanonicalWorkState, timestamp: (entry) => Date.parse(entry.created_at), order: (entry) => entry.created_at,
    });
    expect(recovered.record).toBeDefined();
    expect(canonicalRequirements(recovered.record!.value)).toBe("capacity-safe");
    expect(recoveryScopes(github).has("work/18")).toBe(true);
  });

  it("uses one deterministic survivor when equal-progress recovery cleanup runs concurrently", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("equal-progress"));
    github.__comments.splice(0);
    for (let index = 0; index < 3400; index += 1) {
      github.__statuses.push({ id: ++github.__nextStatusId, sha: BASE, context: `equal-noise/${index}`, description: "noise" });
    }
    await recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
      parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
    });
    const checkpoint = [...github.__authorityVariables.entries()].find(([name]) => name.startsWith("FUGUE_D3_"))!;
    const prefix = checkpoint[0].slice(0, -16);
    github.__authorityVariables.set(`${prefix}${"e".repeat(16)}`, checkpoint[1]);
    github.__authorityVariables.set(`${prefix}${"f".repeat(16)}`, checkpoint[1]);
    await Promise.all([
      compactFugueRecoveryAuthorityVariables(github),
      compactFugueRecoveryAuthorityVariables(github),
    ]);
    const surviving = [...github.__authorityVariables.keys()].filter((name) => name.startsWith(prefix));
    expect(surviving).toHaveLength(1);
  });

  it("preserves monotonic witnesses for more than 24 scopes under concurrent compaction", async () => {
    const github = makeGithub();
    for (let scope = 0; scope < 30; scope += 1) seedRecoveryWitness(github, `many/${scope}`, scope);
    expect(recoveryScopes(github)).toEqual(new Set(Array.from({ length: 30 }, (_, index) => `many/${index}`)));
    await Promise.all([
      compactFugueRecoveryAuthorityVariables(github), compactFugueRecoveryAuthorityVariables(github),
      compactFugueRecoveryAuthorityVariables(github),
    ]);
    expect(recoveryScopes(github)).toEqual(new Set(Array.from({ length: 30 }, (_, index) => `many/${index}`)));
  });

  it("keeps a caught-up committed scope through hard-cap packing and concurrent compactors", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("packed-resume-authority"));
    for (let scope = 0; scope < 180; scope += 1) seedRecoveryWitness(github, `capacity/${scope}`, 1000 + scope);
    explodeRecoveryPacksToLeaves(github);
    fillAuthorityCapacity(github, "UNRELATED_");
    await Promise.all([
      compactFugueRecoveryAuthorityVariables(github), compactFugueRecoveryAuthorityVariables(github),
      compactFugueRecoveryAuthorityVariables(github),
    ]);
    expect(recoveryScopes(github).has("work/18")).toBe(true);
    const recovered = await recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
      parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
    });
    expect(canonicalRequirements(recovered.record!.value)).toBe("packed-resume-authority");
  });

  it("self-heals a >8-pack hard-cap bucket with intact/drained reserves and concurrent writers", async () => {
    const bucket = recoveryBucketForScope("work/18");
    const scopes = recoveryScopesForBucket(bucket, 145, "pack-pressure");
    expect(scopes).toHaveLength(145);

    const setup = (drainReserves: boolean): TestGithub => {
      const github = makeGithub();
      for (const [index, scope] of scopes.entries()) seedRecoveryWitness(github, scope, 3000 + index);
      for (let index = 0; index < 8; index += 1) {
        github.__authorityVariables.set(`FUGUE_D3R_${String(index).padStart(2, "0")}`, "reserved-for-fugue-recovery-compaction");
      }
      if (drainReserves) {
        const source = [...github.__authorityVariables.entries()].find(([name]) => name.startsWith("FUGUE_D3_"))!;
        for (let index = 0; index < 8; index += 1) {
          github.__authorityVariables.delete(`FUGUE_D3R_${String(index).padStart(2, "0")}`);
          github.__authorityVariables.set(`${source[0].slice(0, -16)}${(9000 + index).toString(16).padStart(16, "0")}`, source[1]);
        }
      }
      fillAuthorityCapacity(github, drainReserves ? "UNRELATED_DRAINED_" : "UNRELATED_INTACT_");
      expect(github.__authorityVariables.size).toBe(500);
      return github;
    };

    const intact = setup(false);
    const unrelatedIntact = [...intact.__authorityVariables.keys()].filter((name) => name.startsWith("UNRELATED_INTACT_")).length;
    await compactFugueRecoveryAuthorityVariables(intact);
    const intactPacks = [...intact.__authorityVariables.keys()].filter((name) => name.startsWith(`FUGUE_D3P_${bucket}_`));
    expect(intactPacks.length).toBeGreaterThan(8);
    expect([...intact.__authorityVariables.keys()].filter((name) => name.startsWith("FUGUE_D3R_"))).toHaveLength(8);
    expect([...intact.__authorityVariables.keys()].filter((name) => name.startsWith("UNRELATED_INTACT_"))).toHaveLength(unrelatedIntact);
    for (const scope of scopes) expect(recoveryScopes(intact).has(scope)).toBe(true);

    const drained = setup(true);
    expect([...drained.__authorityVariables.keys()].filter((name) => name.startsWith("FUGUE_D3R_"))).toHaveLength(0);
    const unrelatedDrained = [...drained.__authorityVariables.keys()].filter((name) => name.startsWith("UNRELATED_DRAINED_")).length;
    await publishDurableProtocolRecord(drained, {
      storageSha: BASE, publisherSha: BASE, scope: "ninth/required", unsignedBody: "required-checkpoint",
      publicationTimestamp: Date.parse("2026-08-17T04:10:00.000Z"), authorityOrder: "2026-08-17T04:10:00.000Z",
    });
    expect(recoveryScopes(drained).has("ninth/required")).toBe(true);
    expect([...drained.__authorityVariables.keys()].filter((name) => name.startsWith("UNRELATED_DRAINED_"))).toHaveLength(unrelatedDrained);
    for (const scope of scopes) expect(recoveryScopes(drained).has(scope)).toBe(true);

    const racing = setup(true);
    const unrelatedRacing = [...racing.__authorityVariables.keys()].filter((name) => name.startsWith("UNRELATED_DRAINED_")).length;
    await Promise.all([
      compactFugueRecoveryAuthorityVariables(racing), compactFugueRecoveryAuthorityVariables(racing),
      publishDurableProtocolRecord(racing, {
        storageSha: BASE, publisherSha: BASE, scope: "race/required", unsignedBody: "racing-required-checkpoint",
        publicationTimestamp: Date.parse("2026-08-17T04:11:00.000Z"), authorityOrder: "2026-08-17T04:11:00.000Z",
      }),
    ]);
    expect(recoveryScopes(racing).has("race/required")).toBe(true);
    expect([...racing.__authorityVariables.keys()].filter((name) => name.startsWith("UNRELATED_DRAINED_"))).toHaveLength(unrelatedRacing);
    for (const scope of scopes) expect(recoveryScopes(racing).has(scope)).toBe(true);
    expect(racing.__authorityVariables.size).toBeLessThanOrEqual(500);
  });

  it("ignores pre-created, deleted, rewound, fast-forwarded, and replayed custom recovery refs after presentation loss", async () => {
    const github = makeGithub();
    await publishCanonicalWorkState(github, canonicalWork("ref-independent-authority"));
    github.__comments.splice(0);
    for (let index = 0; index < 3400; index += 1) {
      github.__statuses.push({ id: ++github.__nextStatusId, sha: BASE, context: `ref-hostile/${index}`, description: "noise" });
    }
    const first = await recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
      parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
    });
    expect(first.record).toBeDefined();
    expect(first.exhausted).toBe(true);
    expect([...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3_") || name.startsWith("FUGUE_D3P_"))).toBe(true);

    // Candidate contents:write may create/delete/move arbitrary refs, including replaying an old valid signed commit.
    const replayBody = await signProtocolBody(github, "old-valid-signed-but-not-authority");
    const replayCommit = await github.octokit.rest.git.createCommit({ owner: "JohnnyZLi", repo: "Fugue", message: replayBody, tree: "1".repeat(40), parents: [BASE] });
    github.__refs.set("fugue/recovery/precreated", HEAD);
    github.__refs.set("fugue/recovery/fast-forward", replayCommit.data.sha);
    github.__refs.set("fugue/recovery/rewound", BASE);
    github.__refs.delete("fugue/recovery/precreated");
    github.__comments.splice(0);

    let recovered = first;
    for (let attempt = 0; attempt < 8 && !recovered.record; attempt += 1) {
      recovered = await recoverDurableProtocolRecord(github, {
        storageSha: BASE, publisherSha: BASE, scope: "work/18", issueNumber: 18,
        parse: parseCanonicalWorkState, timestamp: (value) => Date.parse(value.created_at), order: (value) => value.created_at,
      });
    }
    expect(recovered.record).toBeDefined();
    expect(canonicalRequirements(recovered.record!.value)).toBe("ref-independent-authority");
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

  it("keeps Integration binding independent of hostile custom-ref replacement and old signed-commit replay", async () => {
    const github = makeGithub();
    const record = await publishAuthorizedRecord(github, 151);
    await installRunStartEvidence(github, record, 151, "2026-08-17T03:20:01.000Z");

    const stale = integrationRunStartSchema.parse({
      version: 1, kind: "integration_run_start", request_id: record.request.request_id,
      pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
      secret_digest: record.dispatch!.secret_digest, anchor_name: record.dispatch!.anchor_name, run_id: 999, run_attempt: 1, created_at: "2026-08-17T03:19:59.000Z",
    });
    const staleSigned = await signProtocolBody(github, serializeIntegrationRunStartEvidence(stale));
    const staleCommit = await github.octokit.rest.git.createCommit({ owner: "JohnnyZLi", repo: "Fugue", message: staleSigned, tree: "1".repeat(40), parents: [BASE] });
    const hostileRef = `fugue/integration/${record.dispatch!.secret_digest}`;
    github.__refs.set(hostileRef, HEAD);                  // pre-create / arbitrary replacement
    github.__refs.set(hostileRef, staleCommit.data.sha); // old-valid replay / fast-forward-like update
    github.__refs.set(hostileRef, BASE);                 // rewind
    github.__refs.delete(hostileRef);                    // pointer deletion
    github.__comments.splice(0);                         // presentation evidence gone too

    const evidence = await getIntegrationRunStartEvidence(github, record);
    expect(evidence?.run_id).toBe(151);
    const bound = await bindIntegrationRun(github, snapshot(), record.request.request_id, 151);
    expect(bound.run?.id).toBe(151);
    expect(github.__refs.has(hostileRef)).toBe(false);
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

  it("reclaims an orphan dispatch anchor after a crash before d3 request publication", async () => {
    const github = makeGithub();
    const orphan = createIntegrationRequest(snapshot().identity, "2026-08-17T03:48:00.000Z");
    await authorizeIntegrationDispatch(github, orphan, "2026-08-17T03:48:00.000Z", "a".repeat(64));
    expect([...github.__authorityVariables.keys()].filter((name) => name.startsWith("FUGUE_INT_A_"))).toHaveLength(1);

    const next = await ensureIntegrationDispatch(github, snapshot(), Date.parse("2026-08-17T04:00:00.000Z"));
    expect(next.dispatch).toBe(true);
    expect(next.request?.request_id).not.toBe(orphan.request_id);
    const current = await getCurrentIntegrationRecord(github, snapshot().identity);
    expect(current?.request.request_id).toBe(next.request?.request_id);
    expect(current?.dispatch).toBeDefined();
  });

  it("linearizes concurrent protected request writers through one create-only election", async () => {
    const github = makeGithub();
    const now = Date.parse("2026-08-17T03:48:00.000Z");
    const [left, right] = await Promise.all([
      ensureIntegrationDispatch(github, snapshot(), now),
      ensureIntegrationDispatch(github, snapshot(), now),
    ]);
    expect(left.dispatch).toBe(true);
    expect(right.dispatch).toBe(true);
    expect(left.request?.request_id).toBe(right.request?.request_id);
    expect(left.dispatchSecret).toBe(right.dispatchSecret);
    const durable = await getCurrentIntegrationRecord(github, snapshot().identity);
    expect(durable?.request.request_id).toBe(left.request?.request_id);
    expect(durable?.dispatch?.anchor_name).toBe(left.authorityAnchor);
    expect([...github.__authorityVariables.keys()].filter((name) => name.startsWith("FUGUE_INT_A_"))).toHaveLength(1);
    expect([...github.__authorityVariables.keys()].filter((name) => name.startsWith("FUGUE_INT_E_"))).toHaveLength(0);
  });

  it("never lets stale cleanup delete a newer request-specific run-start", async () => {
    const github = makeGithub();
    const first = await publishAuthorizedRecord(github, 811, "2026-08-17T03:48:00.000Z");
    await publishIntegrationRecord(github, {
      ...first,
      terminal: { state: "aborted", detail: "retry", created_at: "2026-08-17T03:48:05.000Z" },
      created_at: "2026-08-17T03:48:05.000Z",
    });
    const next = await ensureIntegrationDispatch(github, snapshot(), Date.parse("2026-08-17T03:48:10.000Z"));
    expect(next.dispatch).toBe(true);
    const second = await getCurrentIntegrationRecord(github, snapshot().identity);
    expect(second?.request.request_id).not.toBe(first.request.request_id);
    await installRunStartEvidence(github, second!, 812, "2026-08-17T03:48:11.000Z");
    await releaseIntegrationAuthorityVariable(github, first);
    expect((await getIntegrationRunStartEvidence(github, second!))?.run_id).toBe(812);
  });

  it("reclaims repository-wide pre-d3 orphan anchors before the active-slot cap wedges new Integration", async () => {
    const github = makeGithub();
    const old = "2026-08-17T03:00:00.000Z";
    for (let index = 0; index < INTEGRATION_AUTHORITY_SLOT_LIMIT; index += 1) {
      const otherIdentity = { ...snapshot().identity, prNumber: 1000 + index };
      const request = createIntegrationRequest(otherIdentity, old, index.toString(16).padStart(16, "0"));
      await authorizeIntegrationDispatch(github, request, old, (index + 1).toString(16).padStart(64, "0"));
    }
    expect([...github.__authorityVariables.keys()].filter((name) => name.startsWith("FUGUE_INT_A_"))).toHaveLength(INTEGRATION_AUTHORITY_SLOT_LIMIT);
    const next = await ensureIntegrationDispatch(github, snapshot(), Date.parse("2026-08-17T03:30:00.000Z"));
    expect(next.dispatch).toBe(true);
    expect([...github.__authorityVariables.keys()].filter((name) => name.startsWith("FUGUE_INT_A_"))).toHaveLength(1);
  });

  it("reclaims the bounded per-PR Integration authority slot across repeated cancellations", async () => {
    const github = makeGithub();
    let now = Date.parse("2026-08-17T03:50:00.000Z");
    for (let index = 0; index < 12; index += 1) {
      const next = await ensureIntegrationDispatch(github, snapshot(), now);
      expect(next.dispatch).toBe(true);
      const record = await getCurrentIntegrationRecord(github, snapshot().identity);
      expect(record?.dispatch).toBeDefined();
      const runId = 9000 + index;
      await installRunStartEvidence(github, record!, runId, new Date(now + 1000).toISOString());
      await expect(sealIntegrationWorkflowRunEvent(
        github, completionEvent(record!.request, runId, "cancelled", new Date(now + 2000).toISOString()),
      )).resolves.toBe(true);
      expect([...github.__authorityVariables.keys()].filter((name) => name.startsWith("FUGUE_INT_A_") || name.startsWith("FUGUE_INT_S_"))).toHaveLength(0);
      now += 10_000;
    }
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
  __authorityVariables: Map<string, string>;
  __nextStatusId: number;
  __statusReadAppends: number[];
  __listStatus: ReturnType<typeof vi.fn>;
  __listWorkflowRuns: ReturnType<typeof vi.fn>;
}

function makeGithub(options: { failManifestAlways?: boolean; failFirstManifest?: boolean; interleaveBeforeManifest?: number; interleaveSameContext?: boolean } = {}): TestGithub {
  const comments: TestComment[] = [];
  const statuses: TestStatus[] = [];
  const runs: TestRun[] = [];
  const attempts = new Map<number, TestRun>();
  const refs = new Map<string, string>();
  const authorityVariables = new Map<string, string>();
  const gitCommits = new Map<string, TestGitCommit>();
  gitCommits.set(BASE, { sha: BASE, message: "protected base", tree: { sha: "1".repeat(40) }, parents: [] });
  gitCommits.set(HEAD, { sha: HEAD, message: "candidate", tree: { sha: "2".repeat(40) }, parents: [{ sha: BASE }] });
  let nextGitCommit = 0;
  let nextCommentId = 0;
  let nextStatusId = 0;
  let failedManifest = false;
  let interleavedManifest = false;
  let interleavedSameContext = false;
  const statusReadAppends: number[] = [];
  let statusReadOrdinal = 0;
  const listForRepo = vi.fn();
  const listCommits = vi.fn();
  const listWorkflowRuns = vi.fn(async () => ({ data: { workflow_runs: runs } }));
  const listCommitStatusesForRef = vi.fn(async (args: { ref: string; page?: number; per_page?: number }) => {
    const append = statusReadAppends.shift() ?? 0;
    for (let index = 0; index < append; index += 1) {
      statuses.push({ id: ++nextStatusId, sha: args.ref, context: `hostile/status-read/${statusReadOrdinal}/${index}`,
        description: "moving-page-noise", created_at: new Date().toISOString() });
    }
    statusReadOrdinal += 1;
    const perPage = args.per_page ?? 100;
    const page = args.page ?? 1;
    const filtered = statuses.filter((status) => status.sha === args.ref).sort((a, b) => b.id - a.id);
    const lastPage = Math.max(1, Math.ceil(filtered.length / perPage));
    const link = lastPage > 1 ? `<https://example.test/statuses?per_page=${perPage}&page=${lastPage}>; rel="last"` : undefined;
    return { data: filtered.slice((page - 1) * perPage, page * perPage), headers: { link } };
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
    __authorityVariables: authorityVariables,
    get __nextStatusId() { return nextStatusId; },
    set __nextStatusId(value: number) { nextStatusId = value; },
    __statusReadAppends: statusReadAppends,
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
            statuses.push(status);
            if (options.interleaveSameContext && args.context.includes("/d/") && !interleavedSameContext) {
              interleavedSameContext = true;
              statuses.push({ id: ++nextStatusId, sha: args.sha, context: args.context, description: "hostile-same-context", created_at: new Date().toISOString() });
            }
            return { data: status };
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
        pulls: { get: vi.fn(async () => ({ data: { state: "open", head: { sha: HEAD }, base: { ref: "main", sha: BASE } } })) },
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
  const evidence = integrationRunStartSchema.parse({
    version: 1, kind: "integration_run_start", request_id: record.request.request_id,
    pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
    secret_digest: record.dispatch.secret_digest, anchor_name: record.dispatch.anchor_name, run_id: runId, run_attempt: 1, created_at: createdAt,
  });
  const signed = await signProtocolBody(github, serializeIntegrationRunStartEvidence(evidence));
  github.__authorityVariables.set(integrationRunStartVariableName(record.request), signed);
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
