import type { FugueGitHub } from "./github.js";
import { upsertWorkMetadata, type WorkMetadata } from "./metadata.js";
import type { PrMetadata } from "./pr-metadata.js";
import type { ActivePolicy } from "./policy.js";
import { resolveQaRequirements, type QaResolution } from "./qa.js";
import type { EvaluationIdentity } from "./protocol.js";
import { reconstructState } from "./state.js";

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
  const state = await reconstructState(github);
  const policy = state.policy;
  const work = state.works.find((candidate) => candidate.pr?.number === prNumber);
  if (!work?.pr) {
    throw new Error(`PR #${prNumber} is not linked by current protected Fugue work-state evidence.`);
  }

  const { owner, repo } = github.repository;
  const prResponse = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const pr = prResponse.data;

  if (pr.base.ref !== policy.identity.baseBranch) {
    throw new Error(
      `PR #${prNumber} targets ${pr.base.ref}; Fugue currently governs ${policy.identity.baseBranch}.`,
    );
  }

  const prMetadata = work.pr.metadata;
  const workMetadata = work.metadata;
  if (workMetadata.work_id !== prMetadata.work_id || work.issueNumber !== prMetadata.issue) {
    throw new Error(`PR #${prNumber} canonical work linkage is internally inconsistent.`);
  }
  if (workMetadata.execution.worker_id !== prMetadata.worker_id) {
    throw new Error(`PR #${prNumber} Worker ID does not match canonical work state.`);
  }
  if (workMetadata.execution.branch !== prMetadata.branch || pr.head.ref !== prMetadata.branch) {
    throw new Error(`PR #${prNumber} branch identity does not match canonical work state.`);
  }

  const files = await github.octokit.paginate(github.octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const changedFiles = files.map((file) => file.filename);
  const qa = resolveQaRequirements(policy.config, changedFiles, workMetadata.spec.qa.force);
  const issueBody = upsertWorkMetadata(work.requirements, workMetadata);

  return {
    identity: {
      prNumber,
      headSha: pr.head.sha,
      baseBranch: policy.identity.baseBranch,
      baseSha: policy.identity.baseSha,
      policyDigest: policy.identity.policyDigest,
      protocolVersion: policy.identity.protocolVersion,
      issueNumber: work.issueNumber,
      workId: workMetadata.work_id,
      workSpecDigest: work.workSpecDigest,
    },
    policy,
    pr: {
      number: prNumber,
      title: pr.title,
      body: pr.body ?? "",
      headSha: pr.head.sha,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      draft: work.pr.draft,
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
