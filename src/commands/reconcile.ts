import { discoverRepository } from "../core/git.js";
import { requireWritableGitHub } from "../core/github.js";
import { reconcileRepository } from "../core/reconcile.js";

export interface ReconcileCommandOptions {
  issue?: string;
  pr?: string;
}

export async function runReconcile(options: ReconcileCommandOptions): Promise<void> {
  if (options.issue && options.pr) throw new Error("Choose at most one of --issue or --pr.");
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const result = await reconcileRepository(github, {
    ...(options.issue ? { issue: parsePositiveInteger(options.issue, "issue") } : {}),
    ...(options.pr ? { pr: parsePositiveInteger(options.pr, "PR") } : {}),
  });

  console.log(`FUGUE RECONCILE — ${repository.fullName}`);
  console.log(result.processed.length
    ? `Processed     ${result.processed.map((issue) => `#${issue}`).join(", ")}`
    : "Processed     no matching open work");
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}
