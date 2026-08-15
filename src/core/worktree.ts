import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repositoryRoot } from "./git.js";

export async function withCleanWorktree<T>(
  headSha: string,
  operation: (worktree: string) => Promise<T>,
): Promise<T> {
  const root = await repositoryRoot();
  await git(["fetch", "--no-tags", "origin", headSha], root);

  const directory = await mkdtemp(join(tmpdir(), "fugue-integration-"));
  let added = false;
  try {
    await git(["worktree", "add", "--detach", "--force", directory, headSha], root);
    added = true;
    const checkedOut = await git(["rev-parse", "HEAD"], directory);
    if (checkedOut !== headSha) {
      throw new Error(`Clean worktree resolved ${checkedOut}, expected ${headSha}.`);
    }
    const dirty = await git(["status", "--porcelain"], directory);
    if (dirty) throw new Error("Integration worktree is unexpectedly dirty before validation.");
    return await operation(directory);
  } finally {
    if (added) {
      try {
        await git(["worktree", "remove", "--force", directory], root);
      } catch {
        // Best-effort cleanup; the temp directory is removed below as a fallback.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
