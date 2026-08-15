import type { FugueGitHub } from "./github.js";
import { parseWorkMetadata, workSpecDigest, type WorkMetadata } from "./metadata.js";
import { parsePrMetadata, type PrMetadata } from "./pr-metadata.js";
import { resolveActivePolicy, type ActivePolicy } from "./policy.js";
import { resolveQaRequirements, type QaResolution } from "./qa.js";
import type { EvaluationIdentity } from "./protocol.js";

export interface EvaluationSnapshot {
  identity: EvaluationIdentity;
  policy: ActivePolicy;
  pr: {
    number: number;
    title: string;
    body: string;
    headSha: string;
    headBranch: string;
    baseBranch: string;
    draft: boolean;
  };
  prMetadata: PrMetadata;
  workMetadata: WorkMetadata;
  issueBody: string;
  changedFiles: string[];
  qa: QaResolution;
}

export async function captureEvaluation(
  github: FugueGitHub,
  prNumber: number,
): Promise<EvaluationSnapshot> {
  const policy = await resolveActivePolicy(github);
  const { owner, repo } = github.repository;
  const prResponse = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const pr = prResponse.data;

  if (pr.base.ref !== policy.identity.baseBranch) {
    throw new Error(
      `PR #${prNumber} targets ${pr.base.ref}; Fugue currently governs ${policy.identity.baseBranch}.`,
    );
  }

  const prMetadata = parsePrMetadata(pr.body);
  if (!prMetadata) throw new Error(`PR #${prNumber} is missing fugue-pr metadata.`);

  const issueResponse = await github.octokit.rest.issues.get({
    owner,
    repo,
    issue_number: prMetadata.issue,
  });
  const issueBody = issueResponse.data.body ?? "";
  const workMetadata = parseWorkMetadata(issueBody);
  if (!workMetadata) throw new Error(`Issue #${prMetadata.issue} is missing fugue-work metadata.`);

  if (workMetadata.work_id !== prMetadata.work_id) {
    throw new Error(`PR #${prNumber} work_id does not match Issue #${prMetadata.issue}.`);
  }
  if (workMetadata.execution.worker_id !== prMetadata.worker_id) {
    throw new Error(`PR #${prNumber} Worker ID does not match Issue #${prMetadata.issue}.`);
  }

  const files = await github.octokit.paginate(github.octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const changedFiles = files.map((file) => file.filename);
  const qa = resolveQaRequirements(policy.config, changedFiles, workMetadata.spec.qa.force);

  return {
    identity: {
      prNumber,
      headSha: pr.head.sha,
      baseBranch: policy.identity.baseBranch,
      baseSha: policy.identity.baseSha,
      policyDigest: policy.identity.policyDigest,
      protocolVersion: policy.identity.protocolVersion,
      issueNumber: prMetadata.issue,
      workId: workMetadata.work_id,
      workSpecDigest: workSpecDigest(issueBody, workMetadata),
    },
    policy,
    pr: {
      number: prNumber,
      title: pr.title,
      body: pr.body ?? "",
      headSha: pr.head.sha,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      draft: pr.draft ?? false,
    },
    prMetadata,
    workMetadata,
    issueBody,
    changedFiles,
    qa,
  };
}

export function sameEvaluationIdentity(a: EvaluationIdentity, b: EvaluationIdentity): boolean {
  return a.prNumber === b.prNumber &&
    a.headSha === b.headSha &&
    a.baseBranch === b.baseBranch &&
    a.baseSha === b.baseSha &&
    a.policyDigest === b.policyDigest &&
    a.protocolVersion === b.protocolVersion &&
    a.issueNumber === b.issueNumber &&
    a.workId === b.workId &&
    a.workSpecDigest === b.workSpecDigest;
}
