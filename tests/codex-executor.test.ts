import { describe, expect, it } from "vitest";
import {
  CodexCliExecutor,
  assertWorkerChangesWithinOwnership,
  buildCodexExecArgs,
  parseCodexQaResult,
} from "../src/core/codex-executor.js";
import { parseExecutorMode } from "../src/commands/run.js";

describe("Codex executor selection", () => {
  it("preserves manual-chat as the default", () => {
    expect(parseExecutorMode()).toBe("manual-chat");
  });

  it("accepts codex explicitly and rejects unknown executors", () => {
    expect(parseExecutorMode("codex")).toBe("codex");
    expect(() => parseExecutorMode("mystery")).toThrow(/manual-chat or codex/);
  });

  it("keeps Visual QA outside the Codex CLI executor for now", () => {
    const executor = new CodexCliExecutor();
    expect(executor.supports("worker")).toBe(true);
    expect(executor.supports("code-qa")).toBe(true);
    expect(executor.supports("security-qa")).toBe(true);
    expect(executor.supports("visual-qa")).toBe(false);
  });
});

describe("Codex exec command construction", () => {
  it("builds a workspace-write Worker invocation", () => {
    expect(buildCodexExecArgs({
      sandbox: "workspace-write",
      prompt: "implement work-4",
      lastMessagePath: "/tmp/last.txt",
    })).toEqual([
      "exec",
      "--sandbox", "workspace-write",
      "--output-last-message", "/tmp/last.txt",
      "implement work-4",
    ]);
  });

  it("adds model and output schema for structured QA", () => {
    expect(buildCodexExecArgs({
      sandbox: "read-only",
      prompt: "review PR 7",
      lastMessagePath: "/tmp/last.txt",
      outputSchemaPath: "/tmp/schema.json",
      model: "gpt-5.3-codex",
    })).toEqual([
      "exec",
      "--sandbox", "read-only",
      "--output-last-message", "/tmp/last.txt",
      "--model", "gpt-5.3-codex",
      "--output-schema", "/tmp/schema.json",
      "review PR 7",
    ]);
  });
});

describe("Codex QA output", () => {
  it("parses a structured Code QA approval", () => {
    const result = parseCodexQaResult("code", JSON.stringify({
      verdict: "approved",
      agents_update: "not-required",
      summary: "Exact-head review passed.",
      findings: [],
    }));
    expect(result.verdict).toBe("approved");
  });

  it("rejects free-form or malformed QA output", () => {
    expect(() => parseCodexQaResult("code", "APPROVE")).toThrow(/valid JSON/);
    expect(() => parseCodexQaResult("code", JSON.stringify({ verdict: "approved" }))).toThrow();
  });
});

describe("Codex Worker ownership enforcement", () => {
  const ownership = {
    owned: ["src/algorithms/sorting/**", "tests/merge-sort.test.ts"],
    coordinate: ["src/algorithms/index.ts"],
    forbidden: ["src/ui/**", ".fugue/**"],
  };

  it("accepts changes contained within owned or coordinated paths", () => {
    expect(() => assertWorkerChangesWithinOwnership([
      "src/algorithms/sorting/merge.ts",
      "tests/merge-sort.test.ts",
      "src/algorithms/index.ts",
    ], ownership)).not.toThrow();
  });

  it("rejects forbidden paths", () => {
    expect(() => assertWorkerChangesWithinOwnership([
      "src/ui/App.tsx",
    ], ownership)).toThrow(/forbidden paths/);
  });

  it("rejects unassigned paths even when they are not explicitly forbidden", () => {
    expect(() => assertWorkerChangesWithinOwnership([
      "README.md",
    ], ownership)).toThrow(/outside assigned ownership/);
  });
});
