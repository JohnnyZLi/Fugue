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

  return withTemporaryWorktree(root, headSha, "fugue-integration-", operation, true);
}

export async function withBranchWorktree<T>(
  branch: string,
  operation: (worktree: string) => Promise<T>,
): Promise<T> {
  const root = await repositoryRoot();
  await git(["fetch", "--no-tags", "origin", branch], root);
  const remoteRef = `origin/${branch}`;

  return withTemporaryWorktree(root, remoteRef, "fugue-worker-", operation, false);
}

async function withTemporaryWorktree<T>(
  root: string,
  ref: string,
  prefix: string,
  operation: (worktree: string) => Promise<T>,
  requireExactRef: boolean,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  let added = false;
  try {
    await git(["worktree", "add", "--detach", "--force", directory, ref], root);
    added = true;

    if (requireExactRef) {
      const checkedOut = await git(["rev-parse", "HEAD"], directory);
      if (checkedOut !== ref) {
        throw new Error(`Clean worktree resolved ${checkedOut}, expected ${ref}.`);
      }
    }

    const dirty = await git(["status", "--porcelain"], directory);
    if (dirty) throw new Error("Temporary Fugue worktree is unexpectedly dirty before execution.");
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
