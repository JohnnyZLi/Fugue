import type { FugueGitHub } from "./github.js";
import {
  createProtocolComment,
  escapeProtocolMarkers,
  isTrustedProtocolActor,
  stripProtocolPublisherProof,
  updateProtocolComment,
} from "./provenance.js";
import type { WorkState } from "./state.js";
import { actionLabel, type WorkflowAction } from "./workflow.js";

const START = "<!-- fugue-state";
const END = "-->";

export function renderStateComment(
  repository: string,
  work: WorkState,
  action: WorkflowAction,
): string {
  const safe = escapeProtocolMarkers;
  const marker = `${START}\nversion: 1\nwork_id: ${safe(work.metadata.work_id)}\n${END}`;
  const lines = [
    marker,
    "",
    "## FUGUE STATE",
    "",
    `- Work: \`${safe(work.metadata.work_id)}\``,
    `- Issue: #${work.issueNumber}`,
    `- Worker: ${work.metadata.execution.worker_id ? `\`${safe(work.metadata.execution.worker_id)}\`` : "unclaimed"}`,
    `- Branch: ${work.metadata.execution.branch ? `\`${safe(work.metadata.execution.branch)}\`` : "not allocated"}`,
    `- PR: ${work.pr ? `#${work.pr.number} @ \`${safe(work.pr.headSha.slice(0, 8))}\`${work.pr.draft ? " (draft)" : ""}` : "none"}`,
    `- Next: **${safe(actionLabel(action))}**`,
    "",
  ];

  const instruction = externalInstruction(repository, work, action);
  if (instruction) {
    lines.push(
      "## HUMAN ACTION",
      "",
      safe(instruction.heading),
      "",
      "Paste into a fresh ChatGPT chat:",
      "",
      "```text",
      safe(instruction.prompt),
      "```",
      "",
    );
  } else if (action.kind === "human_control_plane_ack") {
    lines.push(
      "## HUMAN ACTION",
      "",
      `Review PR #${work.pr?.number ?? "?"} as a protected control-plane change. Tell the Fugue Leader whether you acknowledge the exact current head. The Leader records the acknowledgement in GitHub; no terminal command is required.`,
      "",
    );
  } else if (action.kind === "ready_to_merge") {
    lines.push(
      "## HUMAN ACTION",
      "",
      `PR #${work.pr?.number ?? "?"} has current Fugue Integration success and is ready for the final Human merge decision.`,
      "",
    );
  } else if (action.kind === "blocked") {
    lines.push("## BLOCKED", "", safe(action.reason), "");
  } else {
    lines.push("No Human action is currently required.", "");
  }

  lines.push("_This comment is maintained by the protected-base Fugue control plane. GitHub remains durable truth._");
  return lines.join("\n");
}

export async function upsertStateComment(
  github: FugueGitHub,
  work: WorkState,
  action: WorkflowAction,
): Promise<void> {
  const { owner, repo } = github.repository;
  const body = renderStateComment(github.repository.fullName, work, action);
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: work.issueNumber,
    per_page: 100,
  });

  const reusable: typeof comments = [];
  for (const comment of comments) {
    // This lookup is locator-only: the dashboard is presentation state and is overwritten by the
    // current protected writer before use. Actor + strict state marker lets one stable comment ID
    // survive publisher-revision rollover without making an old proof current protocol authority.
    if (!isTrustedProtocolActor(comment.user)) continue;
    const canonical = stripProtocolPublisherProof(comment.body ?? "");
    const marker = canonical.match(/^<!-- fugue-state\nversion: 1\nwork_id: ([^\n]+)\n-->/);
    if (marker?.[1] !== work.metadata.work_id) continue;
    reusable.push(comment);
  }
  reusable.sort((a, b) => {
    const left = Date.parse(a.created_at ?? "");
    const right = Date.parse(b.created_at ?? "");
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return a.id - b.id;
  });

  const current = reusable[0];
  if (!current) {
    await createProtocolComment(github, work.issueNumber, body);
    return;
  }
  if (stripProtocolPublisherProof(current.body ?? "") !== body) {
    await updateProtocolComment(github, current.id, body);
  }

  // Historical protected-base revisions may have left duplicate state dashboards. They are
  // presentation only; current trusted reconciliation keeps the oldest stable comment ID and
  // removes later signed duplicates after refreshing it under the current publisher revision.
  for (const duplicate of reusable.slice(1)) {
    await github.octokit.rest.issues.deleteComment({ owner, repo, comment_id: duplicate.id });
  }
}

export function externalInstruction(
  repository: string,
  work: WorkState,
  action: WorkflowAction,
): { heading: string; prompt: string } | null {
  if (action.kind === "wait_worker") {
    return {
      heading: "**NEEDS WORKER CHAT**",
      prompt: `Fugue Worker for ${repository} ${work.metadata.work_id}. Reconstruct the current assignment, Worker claim, assigned branch, repository contract, and scope from GitHub. Implement only that work on the assigned branch, use GitHub CI as authoritative remote validation, and open or update the implementation PR. Do not merge or self-approve. Do not ask the Human to operate Fugue from the terminal.`,
    };
  }

  if (action.kind === "resume_worker") {
    return {
      heading: "**NEEDS WORKER CHAT**",
      prompt: `Fugue Worker resume for ${repository} ${work.metadata.work_id}. Reconstruct the existing assigned branch, PR, current CI state, and current QA findings from GitHub. Address only the blocking findings within the existing ownership contract, update the same PR, and do not merge or self-approve. Do not ask the Human to operate Fugue from the terminal.`,
    };
  }

  if (action.kind === "start_qa" || action.kind === "wait_qa") {
    const role = action.roles[0];
    if (!role || !work.pr) return null;
    const readable = role === "code" ? "Code QA" : role === "security" ? "Security QA" : "Visual QA";
    return {
      heading: `**NEEDS ${readable.toUpperCase()} CHAT**`,
      prompt: `Fugue ${readable} for ${repository} PR #${work.pr.number}. Reconstruct the current pending Fugue review session from GitHub, review the exact committed evaluation identity independently, and submit the verdict as a fugue-review-submit PR comment for that session. Do not implement fixes. Submit the result directly to GitHub; do not ask the Human to use a terminal or relay the verdict.`,
    };
  }

  return null;
}
