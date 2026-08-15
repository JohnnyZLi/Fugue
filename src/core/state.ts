import type { FugueGitHub } from "./github.js";
import { assertAcyclicDependencies } from "./dependencies.js";
import { parseWorkMetadata, workSpecDigest, type WorkMetadata } from "./metadata.js";
import { parsePrMetadata, type PrMetadata } from "./pr-metadata.js";
import { resolveActivePolicy, type ActivePolicy } from "./policy.js";

export interface WorkPrState {
  number: number;
  url: string;
  headSha: string;
  headBranch: string;
  draft: boolean;
  metadata: PrMetadata;
}

export interface WorkState {
  issueNumber: number;
  title: string;
  url: string;
  stateLabel: "state:ready" | "state:working" | "state:blocked";
  metadata: WorkMetadata;
  workSpecDigest: string;
  pr: WorkPrState | null;
  drift: string[];
}

export interface RepositoryState {
  policy: ActivePolicy;
  works: WorkState[];
  drift: string[];
}

export async function reconstructState(github: FugueGitHub): Promise<RepositoryState> {
  const policy = await resolveActivePolicy(github);
  const { owner, repo } = github.repository;

  const [issues, pulls] = await Promise.all([
    github.octokit.paginate(github.octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    }),
    github.octokit.paginate(github.octokit.rest.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    }),
  ]);

  const prByWork = new Map<string, WorkPrState[]>();
  const repositoryDrift: string[] = [];

  for (const pull of pulls) {
    let metadata: PrMetadata | null;
    try {
      metadata = parsePrMetadata(pull.body);
    } catch (error) {
      repositoryDrift.push(`PR #${pull.number}: invalid fugue-pr metadata (${message(error)})`);
      continue;
    }
    if (!metadata) continue;

    const item: WorkPrState = {
      number: pull.number,
      url: pull.html_url,
      headSha: pull.head.sha,
      headBranch: pull.head.ref,
      draft: pull.draft ?? false,
      metadata,
    };
    const list = prByWork.get(metadata.work_id) ?? [];
    list.push(item);
    prByWork.set(metadata.work_id, list);
  }

  const works: WorkState[] = [];

  for (const issue of issues) {
    if (issue.pull_request) continue;
    const body = issue.body ?? "";
    let metadata: WorkMetadata | null;
    try {
      metadata = parseWorkMetadata(body);
    } catch (error) {
      repositoryDrift.push(`Issue #${issue.number}: invalid fugue-work metadata (${message(error)})`);
      continue;
    }
    if (!metadata) continue;

    const drift: string[] = [];
    const stateLabels = issue.labels
      .map(labelName)
      .filter((name): name is WorkState["stateLabel"] =>
        name === "state:ready" || name === "state:working" || name === "state:blocked",
      );

    if (stateLabels.length !== 1) {
      drift.push(`expected exactly one state label, found ${stateLabels.length}`);
    }

    const matchingPrs = prByWork.get(metadata.work_id) ?? [];
    if (matchingPrs.length > 1) {
      drift.push(`multiple open PRs claim ${metadata.work_id}: ${matchingPrs.map((pr) => `#${pr.number}`).join(", ")}`);
    }

    const pr = matchingPrs[0] ?? null;
    if (pr && metadata.execution.worker_id && pr.metadata.worker_id !== metadata.execution.worker_id) {
      drift.push(`PR #${pr.number} Worker ID does not match issue claim`);
    }
    if (pr && metadata.execution.branch && pr.headBranch !== metadata.execution.branch) {
      drift.push(`PR #${pr.number} head ${pr.headBranch} does not match assigned branch ${metadata.execution.branch}`);
    }

    works.push({
      issueNumber: issue.number,
      title: issue.title,
      url: issue.html_url,
      stateLabel: stateLabels[0] ?? "state:blocked",
      metadata,
      workSpecDigest: workSpecDigest(body, metadata),
      pr,
      drift,
    });
  }

  assertAcyclicDependencies(
    works.map((work) => ({
      issueNumber: work.issueNumber,
      dependencies: work.metadata.spec.dependencies,
    })),
  );

  const openManagedIssues = new Set(works.map((work) => work.issueNumber));
  const dependencyCache = new Map<number, "open" | "closed" | "missing">();

  for (const work of works) {
    for (const dependency of work.metadata.spec.dependencies) {
      if (openManagedIssues.has(dependency)) continue;

      let dependencyState = dependencyCache.get(dependency);
      if (!dependencyState) {
        try {
          const response = await github.octokit.rest.issues.get({ owner, repo, issue_number: dependency });
          dependencyState = response.data.state === "closed" ? "closed" : "open";
        } catch (error) {
          if (isNotFound(error)) dependencyState = "missing";
          else throw error;
        }
        dependencyCache.set(dependency, dependencyState);
      }

      if (dependencyState === "open") {
        work.drift.push(`dependency #${dependency} is open but is not a valid open Fugue work item`);
      }
      if (dependencyState === "missing") {
        work.drift.push(`dependency #${dependency} does not exist`);
      }
    }
  }

  for (const [workId, prs] of prByWork) {
    if (!works.some((work) => work.metadata.work_id === workId)) {
      repositoryDrift.push(`Open PR ${prs.map((pr) => `#${pr.number}`).join(", ")} references missing/open-unmanaged ${workId}`);
    }
  }

  return { policy, works: works.sort((a, b) => a.issueNumber - b.issueNumber), drift: repositoryDrift };
}

function labelName(label: string | { name?: string | null }): string {
  return typeof label === "string" ? label : label.name ?? "";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status?: number }).status === 404;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
