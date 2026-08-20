import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FugueGitHub } from "../src/core/github.js";
import {
  createFugueAuthorityVariable,
  deleteFugueAuthorityVariable,
  withFugueAuthorityNamespaceMutation,
} from "../src/core/authority-namespace.js";
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
  it("recaptures a constant-count cross-page Integration shift instead of accepting a hybrid without W", async () => {
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
    const oldIntegrationName = "FUGUE_INT_A_0000000001_0000000000000001";
    const newIntegrationName = "FUGUE_INT_Z_9999999999_FFFFFFFFFFFFFFFF";

    const variables = Array.from({ length: 500 }, (_, index) => ({
      name: `UNRELATED_${String(index).padStart(4, "0")}`,
      value: "unrelated",
    }));
    variables[0] = { name: IDLE, value: `${IDLE_PREFIX}:${"1".repeat(32)}` };
    variables[50] = { name: oldIntegrationName, value: "old" };
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
            await deleteFugueAuthorityVariable(writer, oldIntegrationName);
            await createFugueAuthorityVariable(writer, newIntegrationName, "new");
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

  it("reuses a self-rotated certified epoch so bounded cleanup loops do not multiply full namespace scans", async () => {
    process.env.FUGUE_AUTHORITY_TOKEN = "authority-test-token";
    const variables = Array.from({ length: 500 }, (_, index) => ({
      name: `UNRELATED_${String(index).padStart(4, "0")}`,
      value: "unrelated",
    }));
    variables[0] = { name: IDLE, value: `${IDLE_PREFIX}:${"8".repeat(32)}` };
    const oldNames = Array.from({ length: 5 }, (_, index) => `FUGUE_INT_F_${String(index + 1).padStart(32, "A")}`);
    oldNames.forEach((name, index) => { variables[index + 1] = { name, value: `stale-${index}` }; });
    const writer = github("writer-cleanup");
    const fetchMock = installMutableAuthorityApi(variables);

    for (const name of oldNames) await deleteFugueAuthorityVariable(writer, name);

    const listRequests = fetchMock.mock.calls.filter(([input, init]) => {
      const { url, method } = requestParts(input, init);
      return method === "GET" && url.pathname === "/repos/writer-cleanup/repo/actions/variables" && url.searchParams.has("page");
    });
    expect(listRequests).toHaveLength(5);
    for (const name of oldNames) expect(variables.some((entry) => entry.name === name)).toBe(false);
  });

  it("routes the protected workflow writer through the shared boundary and classifies the real state paths", () => {
    const workflow = readFileSync(".github/workflows/fugue-control-plane.yml", "utf8");
    const start = workflow.indexOf("- name: Persist protected Integration binding witness");
    const end = workflow.indexOf("- name: Reconcile durable Fugue state", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const persist = workflow.slice(start, end);
    expect(persist).toContain("withFugueAuthorityNamespaceMutation");
    expect(persist).toContain("createFugueAuthorityVariable");
    expect(persist).toContain("deleteFugueAuthorityVariable");
    expect(persist).toContain("./dist/core/authority-namespace.js");
    expect(persist).not.toContain("method: 'POST'");
    expect(persist).not.toContain("method: 'DELETE'");

    const config = readFileSync(".fugue/config.yml", "utf8");
    expect(config.match(/"src\/core\/state-raw\.ts"/g)).toHaveLength(2);
    expect(config.match(/"src\/core\/authority-namespace\.ts"/g)).toHaveLength(2);

    const agents = readFileSync("AGENTS.md", "utf8");
    expect(agents).toContain("src/core/state.ts              public d3/Authority state facade");
    expect(agents).toContain("src/core/state-raw.ts          bounded d3 durable-record + Variables-permission recovery/work/Coordinator authority");
    expect(agents).toContain("src/core/authority-namespace.ts shared Authority namespace-mutation coherence boundary for Integration writers");
  });
});
