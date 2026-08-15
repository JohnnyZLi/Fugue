import { discoverRepository } from "../core/git.js";
import { requireWritableGitHub } from "../core/github.js";
import { parseWorkMetadata } from "../core/metadata.js";
import { upsertPrMetadata } from "../core/pr-metadata.js";

export interface LinkPrOptions {
  issue: string;
}

export async function runLinkPr(prValue: string, options: LinkPrOptions): Promise<void> {
  const prNumber = parsePositiveInteger(prValue, "PR");
  const issueNumber = parsePositiveInteger(options.issue, "issue");
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const { owner, repo } = repository;

  const [prResponse, issueResponse] = await Promise.all([
    github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
    github.octokit.rest.issues.get({ owner, repo, issue_number: issueNumber }),
  ]);

  const work = parseWorkMetadata(issueResponse.data.body ?? "");
  if (!work) throw new Error(`Issue #${issueNumber} is missing fugue-work metadata.`);
  const workerId = work.execution.worker_id;
  const branch = work.execution.branch;
  if (!workerId || !branch) throw new Error(`Issue #${issueNumber} does not have an active Worker claim.`);

  if (prResponse.data.head.ref !== branch) {
    throw new Error(
      `PR #${prNumber} head ${prResponse.data.head.ref} does not match assigned Worker branch ${branch}.`,
    );
  }

  const nextBody = upsertPrMetadata(prResponse.data.body ?? "", {
    version: 1,
    work_id: work.work_id,
    issue: issueNumber,
    worker_id: workerId,
    branch,
  });

  await github.octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    body: nextBody,
  });

  console.log("FUGUE PR LINKED");
  console.log(`PR         #${prNumber}`);
  console.log(`Issue      #${issueNumber}`);
  console.log(`Work ID    ${work.work_id}`);
  console.log(`Worker ID  ${workerId}`);
  console.log(`Branch     ${branch}`);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}
