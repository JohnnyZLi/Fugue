import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FugueGitHub } from "../src/core/github.js";
import { createIntegrationRecord, createIntegrationRequest } from "../src/core/integration-plan.js";
import {
  findEarliestProtectedIntegrationRunWitness,
  serializeIntegrationRunWitness,
  type IntegrationRunWitness,
} from "../src/core/integration-run-witness.js";

vi.mock("../src/core/provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/provenance.js")>();
  return {
    ...actual,
    verifyProtocolPublicationBodyAtRevision: vi.fn(async (
      _github: FugueGitHub,
      body: string,
      expectedSha: string,
      _timestamp: number,
      expectedBranch?: string,
    ) => {
      if (expectedSha !== BASE || expectedBranch !== "main") return false;
      const marker = "\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: ";
      const start = body.lastIndexOf(marker);
      if (start < 0 || !body.endsWith("\n-->")) return false;
      const canonical = body.slice(0, start);
      const token = body.slice(start + marker.length, -4);
      return token === createHash("sha256").update(canonical, "utf8").digest("hex");
    }),
  };
});

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const REQUEST_ID = "int-1111111111111111-2222222222222222";
const SECRET_DIGEST = "3".repeat(64);
const ANCHOR = "FUGUE_INT_A_0000000019_4444444444444444";

function signedWitness(value: IntegrationRunWitness): string {
  const canonical = serializeIntegrationRunWitness(value);
  const token = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${canonical}\n\n<!-- fugue-publisher-proof\nversion: 1\ntoken: ${token}\n-->`;
}

function record() {
  const identity = {
    prNumber: 19,
    headSha: HEAD,
    baseBranch: "main",
    baseSha: BASE,
    policyDigest: "sha256:policy",
    protocolVersion: 1 as const,
    issueNumber: 18,
    workId: "work-18",
    workSpecDigest: "sha256:spec",
  };
  const request = createIntegrationRequest(identity, "2026-08-18T07:30:00.000Z", "2222222222222222");
  const canonicalRequest = { ...request, request_id: REQUEST_ID };
  return createIntegrationRecord(canonicalRequest, {
    dispatch: {
      secret_digest: SECRET_DIGEST,
      authorized_at: "2026-08-18T07:30:00.000Z",
      anchor_name: ANCHOR,
    },
    createdAt: "2026-08-18T07:30:00.000Z",
  });
}

function witness(runId: number, createdAt = "2026-08-18T07:30:10.000Z"): IntegrationRunWitness {
  return {
    version: 1,
    kind: "integration_run_witness",
    request_id: REQUEST_ID,
    pr_number: 19,
    base_sha: BASE,
    secret_digest: SECRET_DIGEST,
    anchor_name: ANCHOR,
    run_id: runId,
    run_attempt: 1,
    created_at: createdAt,
  };
}

function githubWithComments(comments: Array<{ id: number; body: string; commit_id?: string }>) {
  const routes: string[] = [];
  const github = {
    repository: { owner: "JohnnyZLi", repo: "Fugue", fullName: "JohnnyZLi/Fugue" },
    octokit: {
      request: vi.fn(async (route: string, args: { page?: number; per_page?: number; commit_sha?: string }) => {
        routes.push(route);
        if (route.includes("/deployments")) throw new Error("Deployment transport must never be queried for run authority.");
        if (route !== "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments") {
          throw new Error(`unexpected route ${route}`);
        }
        const page = args.page ?? 1;
        const perPage = args.per_page ?? 100;
        const filtered = comments
          .filter((comment) => !comment.commit_id || comment.commit_id === args.commit_sha)
          .map((comment) => ({ ...comment, created_at: "2026-08-18T07:30:11.000Z" }));
        return { data: filtered.slice((page - 1) * perPage, page * perPage) };
      }),
    },
  } as unknown as FugueGitHub;
  return { github, routes };
}

describe("Integration lost-bind authority root", () => {
  it("ignores forged, mutated, reordered, and deleted Deployment/Deployment Status transport", async () => {
    const legitimate = witness(4200);
    const forgedLower = witness(1, "2026-08-18T07:30:12.000Z");
    const forgedBody = signedWitness(forgedLower);
    const mutatedBody = forgedBody.replace("INTEGRATION RUN — STARTED", "INTEGRATION RUN — STARTED\nmutated-transport");
    const copiedLegitimate = signedWitness(legitimate);
    const { github, routes } = githubWithComments([
      { id: 99, body: mutatedBody, commit_id: BASE },
      { id: 12, body: copiedLegitimate, commit_id: BASE },
      { id: 7, body: copiedLegitimate, commit_id: BASE },
    ]);

    // Attacker-controlled Deployments/Statuses may be forged with a lower ID, mutated, reordered,
    // or deleted entirely. None are supplied to the verifier because they are not authority inputs.
    const selected = await findEarliestProtectedIntegrationRunWitness(github, record());
    expect(selected?.id).toBe(4200);
    expect(routes).toEqual(["GET /repos/{owner}/{repo}/commits/{commit_sha}/comments"]);
    expect(routes.some((route) => route.includes("/deployments"))).toBe(false);
  });

  it("rejects a copied protected proof after the run identity is mutated", async () => {
    const legitimate = signedWitness(witness(4200));
    const payload = witness(2);
    const canonicalMutated = serializeIntegrationRunWitness(payload);
    const copiedProof = legitimate.slice(legitimate.lastIndexOf("\n\n<!-- fugue-publisher-proof"));
    const { github } = githubWithComments([{ id: 1, body: `${canonicalMutated}${copiedProof}`, commit_id: BASE }]);

    await expect(findEarliestProtectedIntegrationRunWitness(github, record())).resolves.toBeUndefined();
  });

  it("uses the globally lowest valid protected witness when replay A is observed before L", async () => {
    const A = signedWitness(witness(4201, "2026-08-18T07:30:20.000Z"));
    const L = signedWitness(witness(4200, "2026-08-18T07:30:10.000Z"));
    const { github } = githubWithComments([
      { id: 1, body: A, commit_id: BASE },
      { id: 2, body: L, commit_id: BASE },
    ]);

    await expect(findEarliestProtectedIntegrationRunWitness(github, record())).resolves.toMatchObject({ id: 4200, attempt: 1 });
  });
});
