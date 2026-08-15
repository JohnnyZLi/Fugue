import { describe, expect, it } from "vitest";
import { parseInterval } from "../src/commands/run.js";

describe("local recovery watcher", () => {
  it("uses a safe default polling interval", () => {
    expect(parseInterval()).toBe(30);
  });

  it("rejects aggressive polling below the supported minimum", () => {
    expect(() => parseInterval("9")).toThrow(/at least 10 seconds/);
  });

  it("accepts an explicit recovery polling interval", () => {
    expect(parseInterval("60")).toBe(60);
  });
});
