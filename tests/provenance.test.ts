import { describe, expect, it } from "vitest";
import {
  FUGUE_PROTOCOL_ACTOR,
  isTrustedProtocolActor,
  isTrustedProtocolComment,
  isTrustedProtocolWorkflowRun,
} from "../src/core/provenance.js";

describe("Fugue protocol provenance", () => {
  it("trusts only the protected GitHub Actions publisher", () => {
    expect(isTrustedProtocolActor({ login: FUGUE_PROTOCOL_ACTOR, type: "Bot" })).toBe(true);
    expect(isTrustedProtocolActor({ login: "JohnnyZLi", type: "User" })).toBe(false);
    expect(isTrustedProtocolActor({ login: FUGUE_PROTOCOL_ACTOR, type: "User" })).toBe(false);
    expect(isTrustedProtocolActor(null)).toBe(false);
  });

  it("does not treat user-authored protocol-looking comments as canonical state", () => {
    expect(isTrustedProtocolComment({ user: { login: "JohnnyZLi", type: "User" } })).toBe(false);
    expect(isTrustedProtocolComment({ user: { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } })).toBe(true);
  });

  it("does not treat manually triggered lookalike workflow runs as trusted dispatch evidence", () => {
    expect(isTrustedProtocolWorkflowRun({ actor: { login: "JohnnyZLi", type: "User" } })).toBe(false);
    expect(isTrustedProtocolWorkflowRun({ actor: { login: FUGUE_PROTOCOL_ACTOR, type: "Bot" } })).toBe(true);
  });
});
