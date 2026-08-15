import type { FugueGitHub } from "./github.js";
import { parsePrMetadata } from "./pr-metadata.js";

export async function verifyBaseCurrent(
  github: FugueGitHub,
  baseSha: string,
  headSha: string,
): Promise<void> {
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${baseSha}...${headSha}`,
  });

  if (response.data.status !== "ahead" && response.data.status !== "identical") {
    throw new Error(
      `PR head is not current with base ${baseSha.slice(0, 8)} (compare status: ${response.data.status}).`,
    );
  }
}

export async function verifyDependenciesSatisfied(
  github: FugueGitHub,
  dependencies: readonly number[],
): Promise<void> {
  if (!dependencies.length) return;
  const { owner, repo } = github.repository;

  const pulls = await github.octokit.paginate(github.octokit.rest.pulls.list, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  });

  const linkedByIssue = new Map<number, typeof pulls>();
  for (const pull of pulls) {
    let metadata;
    try {
      metadata = parsePrMetadata(pull.body);
    } catch {
      continue;
    }
    if (!metadata) continue;
    const list = linkedByIssue.get(metadata.issue) ?? [];
    list.push(pull);
    linkedByIssue.set(metadata.issue, list);
  }

  for (const dependency of dependencies) {
    const issue = await github.octokit.rest.issues.get({ owner, repo, issue_number: dependency });
    if (issue.data.state !== "closed") {
      throw new Error(`Dependency #${dependency} is not satisfied; the issue is still open.`);
    }

    const linked = linkedByIssue.get(dependency) ?? [];
    if (linked.length && !linked.some((pull) => pull.merged_at !== null)) {
      throw new Error(`Dependency #${dependency} has Fugue-linked PRs but none are merged.`);
    }
  }
}

export async function verifyMergeability(github: FugueGitHub, prNumber: number): Promise<void> {
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (response.data.mergeable === false) {
    throw new Error(`PR #${prNumber} is not mergeable.`);
  }
  if (response.data.mergeable === null) {
    throw new Error(`GitHub has not resolved mergeability for PR #${prNumber}; retry Integration.`);
  }
}
