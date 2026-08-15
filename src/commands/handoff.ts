import { beginReview } from "../core/reviews.js";
import type { QaRole } from "../core/attestations.js";
import { createWorkId, parseWorkMetadata, upsertWorkMetadata, workMetadataSchema, workSpecDigest } from "../core/metadata.js";
import { discoverRepository } from "../core/git.js";
import { requireWritableGitHub } from "../core/github.js";
import { resolveActivePolicy } from "../core/policy.js";
import { claimWorker } from "../core/worker.js";

export interface HandoffOptions {
  issue?: string;
  pr?: string;
  resume?: boolean;
}

export async function runHandoff(role: string, options: HandoffOptions): Promise<void> {
  if (role === "worker") {
    await runWorkerHandoff(options);
    return;
  }

  const qaRole = qaRoleFromHandoff(role);
  if (qaRole) {
    await runQaHandoff(qaRole, options);
    return;
  }

  throw new Error(`Role ${role} is not implemented yet.`);
}

async function runQaHandoff(role: QaRole, options: HandoffOptions): Promise<void> {
  if (!options.pr) throw new Error(`${role}-qa handoff requires --pr <number>.`);
  const prNumber = parsePositiveInteger(options.pr, "PR");
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const { snapshot, session } = await beginReview(github, prNumber, role);
  const requirement = snapshot.qa.required.find((entry) => entry.role === role);

  console.log(`${roleHeading(role)} HANDOFF`);
  console.log("");
  console.log(`Repository   ${repository.fullName}`);
  console.log(`PR           #${prNumber} — ${snapshot.pr.title}`);
  console.log(`Session      ${session.session_id}`);
  console.log(`Head         ${snapshot.identity.headSha}`);
  console.log(`Base         ${snapshot.identity.baseBranch} @ ${snapshot.identity.baseSha.slice(0, 8)}`);
  console.log(`Policy       ${snapshot.identity.policyDigest.slice(0, 19)}`);
  console.log(`Work spec    ${snapshot.identity.workSpecDigest.slice(0, 19)}`);
  console.log("");
  console.log("WHY REQUIRED");
  for (const reason of requirement?.reasons ?? []) console.log(`- ${reason}`);
  console.log("");
  console.log("READ");
  console.log(`- protected-base ${snapshot.policy.config.repository.agents_file}`);
  console.log("- protected-base .fugue/config.yml");
  console.log(`- Issue #${snapshot.identity.issueNumber}`);
  console.log(`- PR #${prNumber} and exact head ${snapshot.identity.headSha}`);
  console.log("- relevant tests/runtime evidence");
  console.log("");
  console.log("FINISH");
  console.log(`Record the verdict with fugue review ${prNumber} --role ${role} ...`);
}

async function runWorkerHandoff(options: HandoffOptions): Promise<void> {
  if (!options.issue) throw new Error("Worker handoff requires --issue <number>.");

  const issueNumber = parsePositiveInteger(options.issue, "issue");
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const policy = await resolveActivePolicy(github);
  const { owner, repo } = repository;

  const response = await github.octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const issue = response.data;
  if (issue.state !== "open") throw new Error(`Issue #${issueNumber} is not open.`);

  const labels = issue.labels.map(labelName);
  const body = issue.body ?? "";
  let metadata = parseWorkMetadata(body);

  if (!metadata) {
    if (options.resume) throw new Error(`Issue #${issueNumber} has no Fugue work metadata to resume.`);
    if (!labels.includes("state:ready")) throw new Error(`Issue #${issueNumber} must have state:ready before allocation.`);
    if (!labels.includes("agent:ready")) throw new Error(`Issue #${issueNumber} must have agent:ready before allocation.`);

    metadata = workMetadataSchema.parse({
      version: 1,
      work_id: createWorkId(issueNumber),
      spec: {},
      execution: {},
    });
  }

  if (!options.resume) {
    await assertDependenciesSatisfied(github, metadata.spec.dependencies);
  }

  const claim = claimWorker(
    metadata,
    issueNumber,
    issue.title,
    policy.config.branches.worker_pattern,
    options.resume ?? false,
  );

  if (!claim.resumed) {
    try {
      await github.octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${claim.branch}`,
        sha: policy.identity.baseSha,
      });
    } catch (error) {
      if (!isRefAlreadyExists(error)) throw error;
      throw new Error(`Assigned branch ${claim.branch} already exists; Coordinator must resolve the collision.`);
    }

    const nextLabels = [
      ...labels.filter((label) => !label.startsWith("state:")),
      "state:working",
    ];

    await github.octokit.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      body: upsertWorkMetadata(body, claim.metadata),
      labels: [...new Set(nextLabels)],
    });
  }

  const digest = workSpecDigest(body, claim.metadata);
  printWorkerHandoff({
    repository: repository.fullName,
    issueNumber,
    issueTitle: issue.title,
    workerId: claim.workerId,
    branch: claim.branch,
    resumed: claim.resumed,
    baseBranch: policy.identity.baseBranch,
    baseSha: policy.identity.baseSha,
    policyDigest: policy.identity.policyDigest,
    workSpecDigest: digest,
    dependencies: claim.metadata.spec.dependencies,
    agentsFile: policy.config.repository.agents_file,
  });
}

async function assertDependenciesSatisfied(
  github: Awaited<ReturnType<typeof requireWritableGitHub>>,
  dependencies: number[],
): Promise<void> {
  const { owner, repo } = github.repository;
  for (const dependency of dependencies) {
    const response = await github.octokit.rest.issues.get({ owner, repo, issue_number: dependency });
    if (response.data.state !== "closed") {
      throw new Error(`Dependency #${dependency} is not satisfied; it is still open.`);
    }
  }
}

function printWorkerHandoff(input: {
  repository: string;
  issueNumber: number;
  issueTitle: string;
  workerId: string;
  branch: string;
  resumed: boolean;
  baseBranch: string;
  baseSha: string;
  policyDigest: string;
  workSpecDigest: string;
  dependencies: number[];
  agentsFile: string;
}): void {
  console.log(input.resumed ? "RESUMING EXISTING FUGUE WORK" : "FUGUE WORKER HANDOFF");
  console.log("");
  console.log(`Repository   ${input.repository}`);
  console.log(`Issue        #${input.issueNumber} — ${input.issueTitle}`);
  console.log(`Worker ID    ${input.workerId}`);
  console.log(`Branch       ${input.branch}`);
  console.log(`Base         ${input.baseBranch} @ ${input.baseSha.slice(0, 8)}`);
  console.log(`Policy       ${input.policyDigest.slice(0, 19)}`);
  console.log(`Work spec    ${input.workSpecDigest.slice(0, 19)}`);
  console.log(`Dependencies ${input.dependencies.length ? input.dependencies.map((n) => `#${n}`).join(", ") : "none"}`);
  console.log("");
  console.log("READ");
  console.log(`- protected-base ${input.agentsFile}`);
  console.log("- protected-base .fugue/config.yml");
  console.log(`- Issue #${input.issueNumber}`);
  console.log("- relevant source and tests");
  console.log("");
  console.log("RULES");
  console.log("- Work only the assigned issue scope.");
  console.log("- Do not merge or self-approve.");
  console.log("- Record durable findings in GitHub.");
  console.log("- Candidate policy changes do not change the current rules.");
}

function qaRoleFromHandoff(role: string): QaRole | null {
  if (role === "code-qa") return "code";
  if (role === "security-qa") return "security";
  if (role === "visual-qa") return "visual";
  return null;
}

function roleHeading(role: QaRole): string {
  if (role === "code") return "CODE QA";
  if (role === "security") return "SECURITY QA";
  return "VISUAL / UX QA";
}

function labelName(label: string | { name?: string | null }): string {
  return typeof label === "string" ? label : label.name ?? "";
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}

function isRefAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status?: number }).status === 422;
}
