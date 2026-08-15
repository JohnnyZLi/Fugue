import { discoverRepository } from "../core/git.js";
import { requireWritableGitHub } from "../core/github.js";
import { reconcileRepository } from "../core/reconcile.js";

export interface RunOptions {
  issue?: string;
  pr?: string;
  interval?: string;
}

const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_INTERVAL_SECONDS = 10;

export async function runOrchestrator(options: RunOptions): Promise<void> {
  if (options.issue && options.pr) throw new Error("Choose at most one of --issue or --pr.");
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const intervalSeconds = parseInterval(options.interval);
  const filters = {
    ...(options.issue ? { issue: parsePositiveInteger(options.issue, "issue") } : {}),
    ...(options.pr ? { pr: parsePositiveInteger(options.pr, "PR") } : {}),
  };

  console.log(`FUGUE RUN — ${repository.fullName}`);
  console.log(`Local recovery watcher. Polling every ${intervalSeconds}s; normal coordination runs in GitHub Actions.`);
  console.log("Ctrl-C is safe; durable state remains in GitHub.");
  console.log("");

  while (true) {
    try {
      await reconcileRepository(github, filters);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`FUGUE RUN ERROR — ${detail}`);
    }
    await sleep(intervalSeconds * 1000);
  }
}

export function parseInterval(value?: string): number {
  if (value === undefined) return DEFAULT_INTERVAL_SECONDS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_SECONDS) {
    throw new Error(`--interval must be at least ${MIN_INTERVAL_SECONDS} seconds.`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
