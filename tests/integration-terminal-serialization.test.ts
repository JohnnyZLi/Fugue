import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  claimIntegrationCommitWithStore,
  integrationExactRunCommitSchema,
  integrationIdentityLostCommitSchema,
  type IntegrationCommitStore,
  type IntegrationCommitContext,
} from "../src/core/integration-commit.js";

const context: IntegrationCommitContext = {
  requestId: "int-1111111111111111-2222222222222222",
  prNumber: 19,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  anchorName: "FUGUE_INT_A_0000000019_0123456789ABCDEF",
};

const exact = integrationExactRunCommitSchema.parse({
  version: 1,
  kind: "integration_exact_run_commit",
  request_id: context.requestId,
  pr_number: context.prNumber,
  head_sha: context.headSha,
  base_sha: context.baseSha,
  anchor_name: context.anchorName,
  run_id: 99101,
  run_attempt: 1,
  run_created_at: "2026-08-18T12:00:02.000Z",
  html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/99101",
});

const lost = integrationIdentityLostCommitSchema.parse({
  version: 1,
  kind: "integration_identity_lost_commit",
  request_id: context.requestId,
  pr_number: context.prNumber,
  head_sha: context.headSha,
  base_sha: context.baseSha,
  anchor_name: context.anchorName,
  attempt: 1,
  boundary_created_at: "2026-08-18T12:00:01.000Z",
  fence_digest: `sha256:${"c".repeat(64)}`,
  created_at: "2026-08-18T12:11:00.000Z",
});

function createOnlyStore(): IntegrationCommitStore & { value(): string | undefined } {
  let value: string | undefined;
  return {
    async create(candidate) {
      if (value !== undefined) return false;
      value = candidate;
      return true;
    },
    async read() { return value; },
    value() { return value; },
  };
}

describe("request-local Integration terminal serialization", () => {
  it("lets exact L win when B/S commits after terminal final-read but before terminal commit", async () => {
    const store = createOnlyStore();
    // T has already performed its final B/S reads and observed no witness. W then reaches the
    // shared create-only commit point first. T's later identity_lost claim must observe W's L.
    expect((await claimIntegrationCommitWithStore(store, context, exact)).kind).toBe("integration_exact_run_commit");
    const terminalWinner = await claimIntegrationCommitWithStore(store, context, lost);
    expect(terminalWinner).toMatchObject({ kind: "integration_exact_run_commit", run_id: exact.run_id });
  });

  it("makes delayed B/S permanently inert when identity_lost commits first", async () => {
    const store = createOnlyStore();
    expect((await claimIntegrationCommitWithStore(store, context, lost)).kind).toBe("integration_identity_lost_commit");
    const lateExact = await claimIntegrationCommitWithStore(store, context, exact);
    expect(lateExact).toMatchObject({
      kind: "integration_identity_lost_commit",
      boundary_created_at: lost.boundary_created_at,
      fence_digest: lost.fence_digest,
    });
  });

  it("converges concurrent identity_lost terminalizers on one idempotent value", async () => {
    const store = createOnlyStore();
    const [left, right] = await Promise.all([
      claimIntegrationCommitWithStore(store, context, lost),
      claimIntegrationCommitWithStore(store, context, lost),
    ]);
    expect(left).toEqual(lost);
    expect(right).toEqual(lost);
  });

  it("rejects stale run-null publication and keeps known cancellation terminal", () => {
    const status = readFileSync(new URL("../src/core/integration-status.ts", import.meta.url), "utf8");
    expect(status).toContain("if (current?.run && !record.run)");
    expect(status).toContain("cannot clear protected run");
    expect(status).not.toContain("isRecoverableAbortedRun");
    expect(status).not.toContain('state: "aborted", detail: "Protected attempt 1 completed cancelled.');
    expect(status).toContain("known attempt is never retryable transport");
    expect(status).toContain("known attempt 1 cannot become retryable transport");
  });

  it("serializes both protected B and protected S through C and preserves only no-attempt aborted transport", () => {
    const control = readFileSync(new URL("../.github/workflows/fugue-control-plane.yml", import.meta.url), "utf8");
    const integration = readFileSync(new URL("../.github/workflows/fugue-integration.yml", import.meta.url), "utf8");
    const status = readFileSync(new URL("../src/core/integration-status.ts", import.meta.url), "utf8");

    expect(control).toContain("FUGUE_INT_C_${suffix}");
    expect(control.indexOf("serializedCommit")).toBeLessThan(control.indexOf("const witness ="));
    expect(control).toContain("integration_identity_lost_commit') process.exit(0)");

    expect(integration).toContain("FUGUE_INT_C_${suffix}");
    expect(integration.indexOf("const exactCommit =")).toBeLessThan(integration.indexOf("const startEvidence ="));
    expect(integration).toContain("integration_identity_lost_commit') process.exit(0)");

    // Retryable aborted remains solely on the no-exact-evidence path; known-run completions above it
    // return a terminal failure/error instead of setting predecessorRequestId for a replacement.
    expect(status).toContain("protected evidence proves no attempt was created");
    expect(status).toContain('terminal: {\n          state: "aborted"');
  });

  it("keeps post-durable cleanup request-local and idempotent", () => {
    const status = readFileSync(new URL("../src/core/integration-status.ts", import.meta.url), "utf8");
    expect(status).toContain("await releaseIntegrationCommit(github, record.request.request_id)");
    expect(status).toContain("if (normalized.terminal) await releaseIntegrationAuthorityVariable(github, normalized)");
  });
});
