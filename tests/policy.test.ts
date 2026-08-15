import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseVersionFile } from "../src/core/policy.js";

describe("Fugue protected-base VERSION", () => {
  it("parses the checked-in VERSION trust root", async () => {
    const raw = await readFile(".fugue/VERSION", "utf8");

    expect(parseVersionFile(raw)).toEqual({
      protocol: 1,
      fugue_min_version: "0.1.0-alpha.0",
      fugue_max_compatible_version: "0.x",
    });
  });

  it("rejects the scalar bootstrap shape", () => {
    expect(() => parseVersionFile("1\n")).toThrow();
  });
});
