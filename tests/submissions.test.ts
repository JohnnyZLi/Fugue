import { describe, expect, it } from "vitest";
import {
  parseHumanSubmission,
  parseQaSubmission,
  qaSubmissionToReviewOptions,
} from "../src/core/submissions.js";

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

  it("parses Human control-plane acknowledgement requests", () => {
    expect(parseHumanSubmission(`<!-- fugue-human-submit\nversion: 1\nkind: control_plane_ack\npr: 21\n-->`)).toEqual({
      version: 1,
      kind: "control_plane_ack",
      pr: 21,
    });
  });

  it("rejects malformed marked submissions rather than silently ignoring them", () => {
    expect(() => parseQaSubmission(`<!-- fugue-review-submit\nversion: 1\nrole: code\n-->`)).toThrow();
  });
});
