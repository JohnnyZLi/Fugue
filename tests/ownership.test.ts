import { describe, expect, it } from "vitest";
import { assertOwnership, resolveOwnership } from "../src/core/ownership.js";

const ownership = {
  owned: ["src/core/**", "tests/example.test.ts"],
  coordinate: ["README.md"],
  forbidden: ["src/core/secrets/**", ".fugue/**"],
};

describe("central ownership gate", () => {
  it("allows owned and coordinated paths", () => {
    expect(resolveOwnership([
      "src/core/example.ts",
      "tests/example.test.ts",
      "README.md",
    ], ownership)).toEqual({ passed: true, violations: [] });
  });

  it("gives forbidden paths precedence over broad ownership", () => {
    expect(resolveOwnership(["src/core/secrets/token.ts"], ownership)).toEqual({
      passed: false,
      violations: [{ path: "src/core/secrets/token.ts", kind: "forbidden" }],
    });
  });

  it("rejects unassigned changed paths", () => {
    expect(resolveOwnership(["package.json"], ownership)).toEqual({
      passed: false,
      violations: [{ path: "package.json", kind: "unassigned" }],
    });
  });

  it("raises the Integration ownership gate with actionable detail", () => {
    expect(() => assertOwnership(["package.json"], ownership)).toThrow(/package\.json \(unassigned\)/);
  });
});
