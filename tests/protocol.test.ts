import { describe, expect, it } from "vitest";
import {
  FUGUE_PROTOCOL_VERSION,
  assertCompatibleCliVersion,
  assertSupportedProtocol,
} from "../src/core/protocol.js";

describe("Fugue protocol", () => {
  it("exposes protocol version 1", () => {
    expect(FUGUE_PROTOCOL_VERSION).toBe(1);
  });

  it("accepts the supported protocol", () => {
    expect(() => assertSupportedProtocol(1)).not.toThrow();
  });

  it("rejects incompatible protocols", () => {
    expect(() => assertSupportedProtocol(2)).toThrow(/Unsupported Fugue protocol/);
  });

  it("accepts a CLI inside the repository compatibility line", () => {
    expect(() => assertCompatibleCliVersion("0.1.0-alpha.0", "0.x", "0.1.0-alpha.0")).not.toThrow();
    expect(() => assertCompatibleCliVersion("0.1.0", "0.x", "0.9.4")).not.toThrow();
  });

  it("rejects a CLI older than the repository minimum", () => {
    expect(() => assertCompatibleCliVersion("0.2.0", "0.x", "0.1.9")).toThrow(/older than repository minimum/);
    expect(() => assertCompatibleCliVersion("0.1.0", "0.x", "0.1.0-alpha.2")).toThrow(/older than repository minimum/);
  });

  it("rejects a CLI outside the declared maximum compatibility line", () => {
    expect(() => assertCompatibleCliVersion("0.1.0", "0.x", "1.0.0")).toThrow(/outside repository compatibility line/);
    expect(() => assertCompatibleCliVersion("0.1.0", "0.1.x", "0.2.0")).toThrow(/outside repository compatibility line/);
  });
});
