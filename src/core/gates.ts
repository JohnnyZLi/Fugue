import type { FugueGitHub } from "./github.js";
import { resolveActivePolicy } from "./policy.js";
import { loadCurrentCanonicalWorkState } from "./state.js";

export class IntegrationGateFailure extends Error {
  readonly gate: string;

  constructor(gate: string, message: string) {
    super(message);
    this.name = "IntegrationGateFailure";
    this.gate = gate;
  }
}

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
    throw new IntegrationGateFailure(
      "base-current",
      `PR head is not current with base ${baseSha.slice(0, 8)} (compare status: ${response.data.status}).`,
    );
  }
}

/**
 * Dependency completion is derived from protected canonical work/PR linkage plus GitHub's merged
 * state for that exact PR. Issue lifecycle labels, issue closed state, and fugue-pr body mirrors
 * are presentation only and cannot satisfy this gate.
 */
export async function verifyDependenciesSatisfied(
  github: FugueGitHub,
  dependencies: readonly number[],
  baseSha?: string,
): Promise<void> {
  if (!dependencies.length) return;
  const protectedBaseSha = baseSha ?? (await resolveActivePolicy(github)).identity.baseSha;
  const { owner, repo } = github.repository;

  for (const dependency of dependencies) {
    const canonical = await loadCurrentCanonicalWorkState(github, dependency, protectedBaseSha);
    if (!canonical) {
      throw new IntegrationGateFailure(
        "dependencies",
        `Dependency #${dependency} has no current protected canonical Fugue work state.`,
      );
    }
    if (!canonical.pr) {
      throw new IntegrationGateFailure(
        "dependencies",
        `Dependency #${dependency} has no protected canonical PR linkage.`,
      );
    }

    const pull = await github.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: canonical.pr.number,
    });
    if (pull.data.head.ref !== canonical.pr.metadata.branch) {
      throw new IntegrationGateFailure(
        "dependencies",
        `Dependency #${dependency} canonical PR #${canonical.pr.number} no longer matches its protected branch identity.`,
      );
    }
    if (!pull.data.merged) {
      throw new IntegrationGateFailure(
        "dependencies",
        `Dependency #${dependency} canonical PR #${canonical.pr.number} is not merged.`,
      );
    }
  }
}

export async function verifyMergeability(github: FugueGitHub, prNumber: number): Promise<void> {
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (response.data.mergeable === false) {
    throw new IntegrationGateFailure("conflicts", `PR #${prNumber} is not mergeable.`);
  }
  if (response.data.mergeable === null) {
    throw new Error(`GitHub has not resolved mergeability for PR #${prNumber}; retry Integration.`);
  }
}
