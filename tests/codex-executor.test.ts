import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexCliExecutor,
  assertWorkerChangesWithinOwnership,
  buildCodexExecArgs,
  committedWorkerPaths,
  parseCodexQaResult,
} from "../src/core/codex-executor.js";
import {
  codexQaAttemptFingerprint,
  codexWorkerAttemptFingerprint,
  parseExecutorMode,
} from "../src/commands/run.js";
import { git } from "../src/core/git.js";
import type { WorkState } from "../src/core/state.js";

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
      validation_control: "acceptable",
      summary: "Exact-head review passed.",
      findings: [],
    }));
    expect(result.verdict).toBe("approved");
  });

  it("requires an explicit validation-control assessment", () => {
    expect(() => parseCodexQaResult("code", JSON.stringify({
      verdict: "approved",
      agents_update: "not-required",
      summary: "Missing validation control.",
      findings: [],
    }))).toThrow();
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

describe("Worker publication recovery", () => {
  async function createRepository(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "fugue-recovery-test-"));
    await git(["init"], directory);
    await git(["config", "user.name", "Fugue Test"], directory);
    await git(["config", "user.email", "fugue-test@example.invalid"], directory);
    await writeFile(join(directory, "base.txt"), "base\n", "utf8");
    await git(["add", "base.txt"], directory);
    await git(["commit", "-m", "base"], directory);
    return directory;
  }

  it("does not mistake a merely-behind Worker branch for completed work", async () => {
    const directory = await createRepository();
    try {
      await git(["branch", "worker"], directory);
      await writeFile(join(directory, "main.txt"), "main advance\n", "utf8");
      await git(["add", "main.txt"], directory);
      await git(["commit", "-m", "advance base"], directory);
      const currentBase = await git(["rev-parse", "HEAD"], directory);
      await git(["checkout", "worker"], directory);

      expect(await committedWorkerPaths(directory, currentBase)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers unique Worker changes even when the base advanced independently", async () => {
    const directory = await createRepository();
    try {
      await git(["branch", "worker"], directory);
      await writeFile(join(directory, "main.txt"), "main advance\n", "utf8");
      await git(["add", "main.txt"], directory);
      await git(["commit", "-m", "advance base"], directory);
      const currentBase = await git(["rev-parse", "HEAD"], directory);

      await git(["checkout", "worker"], directory);
      await mkdir(join(directory, "src"), { recursive: true });
      await writeFile(join(directory, "src", "worker.ts"), "export const recovered = true;\n", "utf8");
      await git(["add", "src/worker.ts"], directory);
      await git(["commit", "-m", "worker result"], directory);

      expect(await committedWorkerPaths(directory, currentBase)).toEqual(["src/worker.ts"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Codex execution attempt identity", () => {
  function work(headSha: string | null, workSpecDigest = "sha256:spec-a"): WorkState {
    return {
      issueNumber: 4,
      title: "Add Merge Sort",
      url: "https://github.com/JohnnyZLi/Path/issues/4",
      stateLabel: "state:working",
      metadata: {
        version: 1,
        work_id: "work-4",
        spec: {
          dependencies: [],
          ownership: { owned: [], coordinate: [], forbidden: [] },
          qa: { force: ["code"] },
          authorized_changes: { agents_invariants: [] },
        },
        execution: {
          worker_id: "wkr-12345678",
          branch: "agent/4-merge-sort",
        },
      },
      workSpecDigest,
      pr: headSha ? {
        number: 10,
        url: "https://github.com/JohnnyZLi/Path/pull/10",
        headSha,
        headBranch: "agent/4-merge-sort",
        draft: true,
        metadata: {
          version: 1,
          work_id: "work-4",
          issue: 4,
          worker_id: "wkr-12345678",
          branch: "agent/4-merge-sort",
        },
      } : null,
      drift: [],
    };
  }

  it("keeps the same Worker attempt stable for an unchanged evaluation identity", () => {
    expect(codexWorkerAttemptFingerprint(work(null))).toBe(codexWorkerAttemptFingerprint(work(null)));
  });

  it("changes the Worker retry identity when the PR head changes", () => {
    expect(codexWorkerAttemptFingerprint(work("aaa"))).not.toBe(codexWorkerAttemptFingerprint(work("bbb")));
  });

  it("binds QA attempts to both role and exact PR head", () => {
    expect(codexQaAttemptFingerprint(work("aaa"), "code")).not.toBe(
      codexQaAttemptFingerprint(work("aaa"), "security"),
    );
    expect(codexQaAttemptFingerprint(work("aaa"), "code")).not.toBe(
      codexQaAttemptFingerprint(work("bbb"), "code"),
    );
  });
});
