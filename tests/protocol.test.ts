import { describe, expect, it } from "vitest";
import {
  FUGUE_PROTOCOL_VERSION,
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
});
