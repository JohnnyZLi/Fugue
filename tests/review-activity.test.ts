import { describe, expect, it } from "vitest";
import { qaAttestationSchema, reviewStartSchema } from "../src/core/attestations.js";
import { resolveReviewActivity } from "../src/core/review-activity.js";

const identity = {
  prNumber: 3,
  headSha: "85847cb3950b30698889ec5ce0b1a33c7b0fb832",
  baseBranch: "main",
  baseSha: "d7cbe7745d893f79dc91e1fd6716fbe684a9dd12",
  policyDigest: "sha256:policy",
  protocolVersion: 1 as const,
  issueNumber: 2,
  workId: "work-2",
  workSpecDigest: "sha256:spec",
};

function session(id: string) {
  return reviewStartSchema.parse({
    version: 1,
    kind: "review_start",
    session_id: id,
    role: "code",
    identity,
    fugue_version: "0.1.0-alpha.0",
    created_at: "2026-08-15T00:00:00.000Z",
  });
}

function approval(sessionId: string) {
  return qaAttestationSchema.parse({
    version: 1,
    kind: "qa",
    attestation_id: "att-code-12345678",
    session_id: sessionId,
    role: "code",
    identity,
    fugue_version: "0.1.0-alpha.0",
    verdict: "approved",
    agents_md: {
      reviewed: true,
      update_required: false,
      update_present: false,
    },
    validation_control: {
      reviewed: true,
      materially_changed: false,
      acceptable: true,
    },
    created_at: "2026-08-15T00:01:00.000Z",
  });
}

describe("review activity reconciliation", () => {
  it("selects the latest uncompleted session and supersedes older duplicates", () => {
    const first = session("rev-code-first");
    const second = session("rev-code-second");
    const activity = resolveReviewActivity([first, second], []);

    expect(activity.active?.session_id).toBe("rev-code-second");
    expect(activity.superseded.map((item) => item.session_id)).toEqual(["rev-code-first"]);
    expect(activity.completed).toBeNull();
  });

  it("removes completed sessions from the active set", () => {
    const first = session("rev-code-first");
    const second = session("rev-code-second");
    const completed = approval("rev-code-second");
    const activity = resolveReviewActivity([first, second], [completed]);

    expect(activity.active?.session_id).toBe("rev-code-first");
    expect(activity.completed?.session_id).toBe("rev-code-second");
  });

  it("reports no active session when the only handoff is completed", () => {
    const only = session("rev-code-only");
    const completed = approval("rev-code-only");
    const activity = resolveReviewActivity([only], [completed]);

    expect(activity.active).toBeNull();
    expect(activity.superseded).toEqual([]);
    expect(activity.completed?.verdict).toBe("approved");
  });
});
