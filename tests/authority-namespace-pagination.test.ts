import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FugueGitHub } from "../src/core/github.js";
import {
  createFugueAuthorityVariable,
  deleteFugueAuthorityVariable,
  withFugueAuthorityNamespaceMutation,
} from "../src/core/authority-namespace.js";
import { createIntegrationRecord, createIntegrationRequest } from "../src/core/integration-plan.js";
import {
  integrationAnchorVariableName,
  integrationCommitVariableName,
  integrationRunStartVariableName,
  reclaimOrphanIntegrationAuthorityVariables,
  releaseIntegrationAuthorityVariable,
} from "../src/core/integration-status.js";
import { recoverDurableProtocolRecord } from "../src/core/state.js";

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  return {
    ...actual,
    verifyProtocolPublicationBodyAtRevision: vi.fn(async () => true),
    verifyDurableManifestProof: vi.fn(async () => true),
  };
});

const ORIGINAL_AUTHORITY_TOKEN = process.env.FUGUE_AUTHORITY_TOKEN;
const BASE = "b".repeat(40);
const IDLE = "FUGUE_D3GI_00";
const IDLE_PREFIX = "reserved-for-fugue-recovery-mutation-guard";

afterEach(() => {
  if (ORIGINAL_AUTHORITY_TOKEN === undefined) delete process.env.FUGUE_AUTHORITY_TOKEN;
  else process.env.FUGUE_AUTHORITY_TOKEN = ORIGINAL_AUTHORITY_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function github(owner: string): FugueGitHub {
  return { repository: { owner, repo: "repo", fullName: `${owner}/repo` } } as FugueGitHub;
}

function requestParts(input: string | URL | Request, init?: RequestInit): { url: URL; method: string } {
  const request = input instanceof Request ? input : undefined;
  return {
    url: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url),
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
  };
}

function installMutableAuthorityApi(variables: Array<{ name: string; value: string }>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const { url, method } = requestParts(input, init);
    const variablePath = url.pathname.match(/\/actions\/variables\/(.+)$/)?.[1];
    if (variablePath) {
      const name = decodeURIComponent(variablePath);
      const index = variables.findIndex((entry) => entry.name === name);
      if (method === "GET") {
        return index < 0 ? Response.json({ message: "Not Found" }, { status: 404 }) :
          Response.json({ name, value: variables[index]!.value });
      }
      if (method === "PATCH") {
        if (index < 0) return Response.json({ message: "Not Found" }, { status: 404 });
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; value?: string };
        if (!body.name || typeof body.value !== "string") return Response.json({ message: "bad patch" }, { status: 422 });
        if (body.name !== name && variables.some((entry) => entry.name === body.name)) {
          return Response.json({ message: "exists" }, { status: 409 });
        }
        variables[index] = { name: body.name, value: body.value };
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        if (index < 0) return new Response(null, { status: 404 });
        variables.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname.endsWith("/actions/variables") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; value?: string };
      if (!body.name || typeof body.value !== "string") return Response.json({ message: "bad create" }, { status: 422 });
      if (variables.length >= 500 || variables.some((entry) => entry.name === body.name)) {
        return Response.json({ message: "capacity" }, { status: 422 });
      }
      variables.push({ name: body.name, value: body.value });
      return new Response(null, { status: 201 });
    }
    if (url.pathname.endsWith("/actions/variables") && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * 100;
      return Response.json({ total_count: variables.length, variables: variables.slice(start, start + 100) });
    }
    return Response.json({ message: "unexpected request" }, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Authority namespace pagination coherence", () => {
  it("recaptures the production run-start C/S constant-count page shift instead of accepting a hybrid without W", async () => {
    process.env.FUGUE_AUTHORITY_TOKEN = "authority-test-token";
    const scope = "pagination/coherence";
    const key = "1".repeat(32);
    const nonce = "2".repeat(32);
    const authorityOrder = "witness-order";
    const signedBody = `witness-body\n\nFugue-Authority-Key: ${key}\nFugue-Authority-Commit: ${nonce}`;
    const manifestId = 101;
    const cursor = {
      version: 1,
      kind: "durable_recovery",
      scope,
      storage_sha: BASE,
      publisher_sha: BASE,
      checkpoint_at: "2026-08-20T00:00:01.000Z",
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
        created_at: "2026-08-20T00:00:00.500Z",
      },
    };
    const cursorPayload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
    const witnessValue = `<!-- fugue-durable-recovery\nversion: 1\npayload: ${cursorPayload}\n-->`;
    const identity = `${BASE.toLowerCase()}\0${BASE.toLowerCase()}\0${scope}`;
    const witnessName = `FUGUE_D3_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16).toUpperCase()}_AAAAAAAAAAAAAAAA`;
    const oldCommitName = `FUGUE_INT_C_${"A".repeat(32)}`;
    const newStartName = `FUGUE_INT_S_0000000001_${"F".repeat(16)}`;

    const variables = Array.from({ length: 500 }, (_, index) => ({
      name: `UNRELATED_${String(index).padStart(4, "0")}`,
      value: "unrelated",
    }));
    variables[0] = { name: IDLE, value: `${IDLE_PREFIX}:${"1".repeat(32)}` };
    variables[50] = { name: oldCommitName, value: "old-run-start-commit" };
    variables[100] = { name: witnessName, value: witnessValue };

    const reader = github("reader");
    const writer = github("writer");
    let stalePageOne: Array<{ name: string; value: string }> = [];
    let shifted = false;
    let hybridHasExactCount = false;
    let hybridHasUniqueNames = false;
    let hybridOmitsWitness = false;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const { url, method } = requestParts(input, init);
      const repository = url.pathname.match(/^\/repos\/([^/]+)\/repo/)?.[1];
      const variablePath = url.pathname.match(/\/actions\/variables\/(.+)$/)?.[1];

      if (variablePath) {
        const name = decodeURIComponent(variablePath);
        const index = variables.findIndex((entry) => entry.name === name);
        if (method === "GET") {
          return index < 0 ? Response.json({ message: "Not Found" }, { status: 404 }) :
            Response.json({ name, value: variables[index]!.value });
        }
        if (method === "PATCH") {
          if (index < 0) return Response.json({ message: "Not Found" }, { status: 404 });
          const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; value?: string };
          if (!body.name || typeof body.value !== "string") return Response.json({ message: "bad patch" }, { status: 422 });
          if (body.name !== name && variables.some((entry) => entry.name === body.name)) {
            return Response.json({ message: "exists" }, { status: 409 });
          }
          variables[index] = { name: body.name, value: body.value };
          return new Response(null, { status: 204 });
        }
        if (method === "DELETE") {
          if (index < 0) return new Response(null, { status: 404 });
          variables.splice(index, 1);
          return new Response(null, { status: 204 });
        }
      }

      if (url.pathname.endsWith("/actions/variables") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; value?: string };
        if (!body.name || typeof body.value !== "string") return Response.json({ message: "bad create" }, { status: 422 });
        if (variables.length >= 500 || variables.some((entry) => entry.name === body.name)) {
          return Response.json({ message: "capacity" }, { status: 422 });
        }
        variables.push({ name: body.name, value: body.value });
        return new Response(null, { status: 201 });
      }

      if (url.pathname.endsWith("/actions/variables") && method === "GET") {
        const page = Number(url.searchParams.get("page") ?? "1");
        if (repository === "reader" && page === 1 && !shifted) stalePageOne = variables.slice(0, 100);
        if (repository === "reader" && page === 2 && !shifted) {
          await withFugueAuthorityNamespaceMutation(writer, async () => {
            await deleteFugueAuthorityVariable(writer, oldCommitName);
            await createFugueAuthorityVariable(writer, newStartName, "new-run-start");
          });
          shifted = true;
          const hybrid = [...stalePageOne, ...variables.slice(100)];
          hybridHasExactCount = hybrid.length === 500;
          hybridHasUniqueNames = new Set(hybrid.map((entry) => entry.name)).size === 500;
          hybridOmitsWitness = !hybrid.some((entry) => entry.name === witnessName);
        }
        const start = (page - 1) * 100;
        return Response.json({ total_count: variables.length, variables: variables.slice(start, start + 100) });
      }

      return Response.json({ message: "unexpected request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const recovered = await recoverDurableProtocolRecord(reader, {
      storageSha: BASE,
      publisherSha: BASE,
      scope,
      issueNumber: 1,
      parse: (body) => body === signedBody ? { createdAt: "2026-08-20T00:00:00.000Z" } : null,
      timestamp: (value) => Date.parse(value.createdAt),
      order: () => authorityOrder,
    });

    expect(hybridHasExactCount).toBe(true);
    expect(hybridHasUniqueNames).toBe(true);
    expect(hybridOmitsWitness).toBe(true);
    expect(recovered.record?.body).toBe(signedBody);
    const readerListRequests = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "GET" && url.pathname === "/repos/reader/repo/actions/variables" && url.searchParams.has("page");
    });
    const writerListRequests = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "GET" && url.pathname === "/repos/writer/repo/actions/variables" && url.searchParams.has("page");
    });
    const writerGuardPatches = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "PATCH" && url.pathname.startsWith("/repos/writer/repo/actions/variables/FUGUE_D3G");
    });
    expect(readerListRequests).toHaveLength(10);
    expect(writerListRequests).toHaveLength(5);
    expect(writerGuardPatches).toHaveLength(2);
  });

  it("keeps multi-variable writer cost bounded to one namespace preflight and one guard session", async () => {
    process.env.FUGUE_AUTHORITY_TOKEN = "authority-test-token";
    const variables = Array.from({ length: 500 }, (_, index) => ({
      name: `UNRELATED_${String(index).padStart(4, "0")}`,
      value: "unrelated",
    }));
    variables[0] = { name: IDLE, value: `${IDLE_PREFIX}:${"7".repeat(32)}` };
    const oldNames = Array.from({ length: 8 }, (_, index) => `FUGUE_INT_A_${String(index + 1).padStart(10, "0")}_AAAAAAAAAAAAAAAA`);
    oldNames.forEach((name, index) => { variables[index + 1] = { name, value: `old-${index}` }; });
    const writer = github("writer-budget");
    const fetchMock = installMutableAuthorityApi(variables);

    await withFugueAuthorityNamespaceMutation(writer, async () => {
      for (const name of oldNames) await deleteFugueAuthorityVariable(writer, name);
      for (let index = 0; index < oldNames.length; index += 1) {
        await createFugueAuthorityVariable(
          writer,
          `FUGUE_INT_B_${String(index + 1).padStart(32, "0")}`,
          `new-${index}`,
        );
      }
    });

    const listRequests = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "GET" && url.pathname === "/repos/writer-budget/repo/actions/variables" && url.searchParams.has("page");
    });
    const guardPatches = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "PATCH" && url.pathname.startsWith("/repos/writer-budget/repo/actions/variables/FUGUE_D3G");
    });
    const creates = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "POST" && url.pathname === "/repos/writer-budget/repo/actions/variables";
    });
    const deletes = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "DELETE" && url.pathname.includes("/repos/writer-budget/repo/actions/variables/FUGUE_INT_A_");
    });
    expect(listRequests).toHaveLength(5);
    expect(guardPatches).toHaveLength(2);
    expect(creates).toHaveLength(8);
    expect(deletes).toHaveLength(8);
    expect(variables).toHaveLength(500);
  });

  it("keeps production terminal F/A/B/S/C cleanup to one namespace preflight with C last", async () => {
    process.env.FUGUE_AUTHORITY_TOKEN = "authority-test-token";
    const createdAt = "2026-08-22T00:00:00.000Z";
    const request = createIntegrationRequest({
      prNumber: 24,
      headSha: "a".repeat(40),
      baseBranch: "main",
      baseSha: BASE,
      policyDigest: "policy-test",
      protocolVersion: 1,
      issueNumber: 24,
      workId: "work-24",
      workSpecDigest: "work-spec-test",
    }, createdAt, "3".repeat(16));
    const anchorName = integrationAnchorVariableName(request);
    const record = createIntegrationRecord(request, {
      dispatch: {
        secret_digest: "4".repeat(64),
        authorized_at: createdAt,
        anchor_name: anchorName,
      },
      terminal: {
        state: "failure",
        detail: "terminal writer budget regression",
        created_at: createdAt,
      },
      createdAt,
    });
    const suffix = createHash("sha256").update(request.request_id, "utf8").digest("hex").slice(0, 32).toUpperCase();
    const terminalNames = [
      `FUGUE_INT_F_${suffix}`,
      anchorName,
      `FUGUE_INT_B_${suffix}`,
      integrationRunStartVariableName(request),
      integrationCommitVariableName(request.request_id),
    ];
    const variables = Array.from({ length: 500 }, (_, index) => ({
      name: `UNRELATED_${String(index).padStart(4, "0")}`,
      value: "unrelated",
    }));
    variables[0] = { name: IDLE, value: `${IDLE_PREFIX}:${"8".repeat(32)}` };
    terminalNames.forEach((name, index) => { variables[index + 1] = { name, value: `terminal-${index}` }; });
    const writer = github("writer-cleanup");
    const fetchMock = installMutableAuthorityApi(variables);

    await releaseIntegrationAuthorityVariable(writer, record);

    const listRequests = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "GET" && url.pathname === "/repos/writer-cleanup/repo/actions/variables" && url.searchParams.has("page");
    });
    const guardPatches = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "PATCH" && url.pathname.startsWith("/repos/writer-cleanup/repo/actions/variables/FUGUE_D3G");
    });
    const deletes = fetchMock.mock.calls.flatMap(([input, init]) => {
      const { url, method } = requestParts(input, init);
      const encodedName = url.pathname.match(/\/actions\/variables\/(.+)$/)?.[1];
      return method === "DELETE" && encodedName ? [decodeURIComponent(encodedName)] : [];
    }).filter((name) => name.startsWith("FUGUE_INT_"));
    expect(listRequests).toHaveLength(5);
    expect(guardPatches).toHaveLength(2);
    expect(deletes).toEqual(terminalNames);
    for (const name of terminalNames) expect(variables.some((entry) => entry.name === name)).toBe(false);
  });

  it("keeps production orphan reclamation to one discovery scan plus one mutation preflight", async () => {
    process.env.FUGUE_AUTHORITY_TOKEN = "authority-test-token";
    const variables = Array.from({ length: 500 }, (_, index) => ({
      name: `UNRELATED_${String(index).padStart(4, "0")}`,
      value: "unrelated",
    }));
    variables[0] = { name: IDLE, value: `${IDLE_PREFIX}:${"6".repeat(32)}` };
    const invalidElection = `FUGUE_INT_E_${String(24).padStart(10, "0")}_${"A".repeat(16)}_${"B".repeat(8)}`;
    const invalidAnchor = `FUGUE_INT_A_${String(24).padStart(10, "0")}_${"C".repeat(16)}`;
    variables[1] = { name: invalidElection, value: "malformed-election" };
    variables[2] = { name: invalidAnchor, value: "malformed-anchor" };
    const writer = github("writer-orphan-cleanup");
    const fetchMock = installMutableAuthorityApi(variables);

    await reclaimOrphanIntegrationAuthorityVariables(writer, Date.parse("2026-08-22T00:30:00.000Z"));

    const listRequests = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "GET" && url.pathname === "/repos/writer-orphan-cleanup/repo/actions/variables" && url.searchParams.has("page");
    });
    const guardPatches = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "PATCH" && url.pathname.startsWith("/repos/writer-orphan-cleanup/repo/actions/variables/FUGUE_D3G");
    });
    const deletes = fetchMock.mock.calls.flatMap(([input, init]) => {
      const { url, method } = requestParts(input, init);
      const encodedName = url.pathname.match(/\/actions\/variables\/(.+)$/)?.[1];
      return method === "DELETE" && encodedName ? [decodeURIComponent(encodedName)] : [];
    }).filter((name) => name.startsWith("FUGUE_INT_"));
    expect(listRequests).toHaveLength(10);
    expect(guardPatches).toHaveLength(2);
    expect(deletes).toEqual([invalidElection, invalidAnchor]);
    expect(variables.some((entry) => entry.name === invalidElection)).toBe(false);
    expect(variables.some((entry) => entry.name === invalidAnchor)).toBe(false);
  });

  it("fails closed on idle plus active corruption after a previously successful self-rotated epoch", async () => {
    process.env.FUGUE_AUTHORITY_TOKEN = "authority-test-token";
    const variables = Array.from({ length: 500 }, (_, index) => ({
      name: `UNRELATED_${String(index).padStart(4, "0")}`,
      value: "unrelated",
    }));
    variables[0] = { name: IDLE, value: `${IDLE_PREFIX}:${"9".repeat(32)}` };
    const staleName = `FUGUE_INT_F_${"B".repeat(32)}`;
    variables[1] = { name: staleName, value: "stale" };
    const writer = github("writer-corruption-after-success");
    const fetchMock = installMutableAuthorityApi(variables);

    // Complete one successful mutation so this writer itself rotates the idle slot to epoch E.
    await deleteFugueAuthorityVariable(writer, staleName);
    const certifiedIdle = variables.find((entry) => entry.name === IDLE)?.value;
    expect(certifiedIdle).toMatch(new RegExp(`^${IDLE_PREFIX}:[0-9a-f]{32}$`, "i"));

    // Inject the exact corrupt state that the old cached-E shortcut skipped: the same idle E plus
    // an already-active guard G. The second transaction must detect it before any Authority mutation.
    const existingGuard = `FUGUE_D3GT_${"C".repeat(24)}`;
    variables.push({ name: existingGuard, value: "existing-active-guard" });
    expect(variables).toHaveLength(500);
    const beforeSecond = fetchMock.mock.calls.length;
    const secondCommit = `FUGUE_INT_C_${"D".repeat(32)}`;

    await expect(createFugueAuthorityVariable(writer, secondCommit, "must-not-commit"))
      .rejects.toThrow(/simultaneously exposes an idle epoch and an active mutation guard/);

    const secondCalls = fetchMock.mock.calls.slice(beforeSecond);
    const secondListRequests = secondCalls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "GET" &&
        url.pathname === "/repos/writer-corruption-after-success/repo/actions/variables" &&
        url.searchParams.has("page");
    });
    const secondAuthorityMutations = secondCalls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return ["PATCH", "POST", "DELETE"].includes(method) && url.pathname.includes("/actions/variables");
    });
    expect(secondListRequests).toHaveLength(5);
    expect(secondAuthorityMutations).toHaveLength(0);
    expect(variables.find((entry) => entry.name === IDLE)?.value).toBe(certifiedIdle);
    expect(variables.filter((entry) => entry.name.startsWith("FUGUE_D3GT_")).map((entry) => entry.name)).toEqual([existingGuard]);
    expect(variables.some((entry) => entry.name === secondCommit)).toBe(false);
  });

  it("routes both protected workflow writers through the shared boundary and classifies the real state paths", () => {
    const controlWorkflow = readFileSync(".github/workflows/fugue-control-plane.yml", "utf8");
    const persistStart = controlWorkflow.indexOf("- name: Persist protected Integration binding witness");
    const persistEnd = controlWorkflow.indexOf("- name: Reconcile durable Fugue state", persistStart);
    expect(persistStart).toBeGreaterThanOrEqual(0);
    expect(persistEnd).toBeGreaterThan(persistStart);
    const persist = controlWorkflow.slice(persistStart, persistEnd);
    expect(persist).toContain("withFugueAuthorityNamespaceMutation");
    expect(persist).toContain("createFugueAuthorityVariable");
    expect(persist).toContain("deleteFugueAuthorityVariable");
    expect(persist).toContain("./dist/core/authority-namespace.js");
    expect(persist).not.toContain("method: 'POST'");
    expect(persist).not.toContain("method: 'DELETE'");

    const integrationWorkflow = readFileSync(".github/workflows/fugue-integration.yml", "utf8");
    const buildProtected = integrationWorkflow.indexOf("- name: Build protected namespace-writer runtime");
    const runStartStart = integrationWorkflow.indexOf("- name: Commit protected Integration run-start evidence");
    const runStartEnd = integrationWorkflow.indexOf("- uses: actions/checkout@v4", runStartStart);
    expect(buildProtected).toBeGreaterThanOrEqual(0);
    expect(runStartStart).toBeGreaterThan(buildProtected);
    expect(runStartEnd).toBeGreaterThan(runStartStart);
    const runStart = integrationWorkflow.slice(runStartStart, runStartEnd);
    expect(integrationWorkflow.slice(buildProtected, runStartStart)).toContain("tarball/$FUGUE_RUNTIME_SHA");
    expect(runStart).toContain("./dist/core/authority-namespace.js");
    const guard = runStart.indexOf("const runStartOutcome = await withFugueAuthorityNamespaceMutation");
    const commitCreate = runStart.indexOf("await createVariable(commitName, JSON.stringify(exactCommit))", guard);
    const staleCommitDelete = runStart.indexOf("await deleteVariable(commitName)", commitCreate);
    const startCreate = runStart.indexOf("await createVariable(startName, signed)", staleCommitDelete);
    const guardEnd = runStart.indexOf("          });", startCreate);
    const identityLostExit = runStart.indexOf("if (runStartOutcome === 'integration_identity_lost_commit') process.exit(0);", guardEnd);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(commitCreate).toBeGreaterThan(guard);
    expect(staleCommitDelete).toBeGreaterThan(commitCreate);
    expect(startCreate).toBeGreaterThan(staleCommitDelete);
    expect(guardEnd).toBeGreaterThan(startCreate);
    expect(identityLostExit).toBeGreaterThan(guardEnd);

    const config = readFileSync(".fugue/config.yml", "utf8");
    expect(config.match(/"src\/core\/state-raw\.ts"/g)).toHaveLength(2);
    expect(config.match(/"src\/core\/authority-namespace\.ts"/g)).toHaveLength(2);

    const agents = readFileSync("AGENTS.md", "utf8");
    expect(agents).toContain("src/core/state.ts              public d3/Authority state facade");
    expect(agents).toContain("src/core/state-raw.ts          bounded d3 durable-record + Variables-permission recovery/work/Coordinator authority");
    expect(agents).toContain("src/core/authority-namespace.ts shared Authority namespace-mutation coherence boundary for Integration writers");
  });
});
