import { describe, expect, it } from "vitest";
import {
  parseHumanSubmission,
  parseQaSubmission,
  qaSubmissionToReviewOptions,
} from "../src/core/submissions.js";

const identity = {
  prNumber: 21,
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  baseBranch: "main",
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  policyDigest: "sha256:policy",
  protocolVersion: 1,
  issueNumber: 18,
  workId: "work-18",
  workSpecDigest: "sha256:spec",
};

describe("GitHub-native Fugue submissions", () => {
  it("parses a Code QA submission without trusting caller-supplied identity fields", () => {
    const submission = parseQaSubmission(`CODE QA SUBMISSION — APPROVED\n\n<!-- fugue-review-submit\nversion: 1\nsession_id: rev-code-1234\nrole: code\nverdict: approved\nagents_update: not-required\nvalidation_control: acceptable\nsummary: Exact-head review passed.\n-->`);

    expect(submission).toEqual({
      version: 1,
      session_id: "rev-code-1234",
      role: "code",
      verdict: "approved",
      agents_update: "not-required",
      validation_control: "acceptable",
      summary: "Exact-head review passed.",
    });
    expect(qaSubmissionToReviewOptions(submission!)).toEqual({
      verdict: "approved",
      agentsUpdate: "not-required",
      validationControl: "acceptable",
      summary: "Exact-head review passed.",
    });
  });

  it("parses exact-head Visual QA runtime evidence", () => {
    const submission = parseQaSubmission(`<!-- fugue-review-submit\nversion: 1\nsession_id: rev-visual-1234\nrole: visual\nverdict: approved\nruntime_tested: true\nviewports:\n  - 1440x900\n  - 390x844\n-->`);
    expect(submission?.runtime_tested).toBe(true);
    expect(submission?.viewports).toEqual(["1440x900", "390x844"]);
  });

  it("binds Human control-plane acknowledgement requests to the exact evaluation identity", () => {
    const submission = parseHumanSubmission(`<!-- fugue-human-submit\nversion: 1\nkind: control_plane_ack\nidentity:\n  prNumber: 21\n  headSha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n  baseBranch: main\n  baseSha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n  policyDigest: sha256:policy\n  protocolVersion: 1\n  issueNumber: 18\n  workId: work-18\n  workSpecDigest: sha256:spec\n-->`);
    expect(submission).toEqual({
      version: 1,
      kind: "control_plane_ack",
      identity,
    });
  });

  it("rejects a Human acknowledgement request that omits exact identity", () => {
    expect(() => parseHumanSubmission(`<!-- fugue-human-submit\nversion: 1\nkind: control_plane_ack\npr: 21\n-->`)).toThrow();
  });

  it("rejects malformed marked submissions rather than silently ignoring them", () => {
    expect(() => parseQaSubmission(`<!-- fugue-review-submit\nversion: 1\nrole: code\n-->`)).toThrow();
  });
});
