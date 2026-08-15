import { discoverRepository } from "../core/git.js";
import { requireWritableGitHub } from "../core/github.js";
import { reconcileRepository } from "../core/reconcile.js";
import { reconstructState, type WorkState } from "../core/state.js";
import { actionLabel, observeWork, planWork } from "../core/workflow.js";

export interface AdvanceOptions {
  issue?: string;
  pr?: string;
  dryRun?: boolean;
}

export async function runAdvance(options: AdvanceOptions): Promise<void> {
  if (options.issue && options.pr) throw new Error("Choose at most one of --issue or --pr.");
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const filters = {
    ...(options.issue ? { issue: parsePositiveInteger(options.issue, "issue") } : {}),
    ...(options.pr ? { pr: parsePositiveInteger(options.pr, "PR") } : {}),
  };

  if (!options.dryRun) {
    const result = await reconcileRepository(github, filters);
    console.log(`FUGUE ADVANCE — ${repository.fullName}`);
    console.log(result.processed.length
      ? `Reconciled    ${result.processed.map((issue) => `#${issue}`).join(", ")}`
      : "Reconciled    no matching open work");
    return;
  }

  const state = await reconstructState(github);
  const works = selectWorks(state.works, options);
  if (!works.length) {
    console.log("FUGUE ADVANCE — no matching open work items.");
    return;
  }

  for (const work of works) {
    const observation = await observeWork(github, work);
    const action = planWork(observation);
    console.log(`FUGUE ADVANCE — #${work.issueNumber} ${work.title}`);
    console.log(`Current      ${work.stateLabel.replace("state:", "")}${work.pr ? ` / PR #${work.pr.number}` : ""}`);
    console.log(`Next         ${actionLabel(action)}`);
    console.log("Mode         dry-run; no mutation performed");
    console.log("");
  }
}

function selectWorks(works: WorkState[], options: AdvanceOptions): WorkState[] {
  if (options.issue) {
    const issue = parsePositiveInteger(options.issue, "issue");
    return works.filter((work) => work.issueNumber === issue);
  }
  if (options.pr) {
    const pr = parsePositiveInteger(options.pr, "PR");
    return works.filter((work) => work.pr?.number === pr);
  }
  return works;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}
