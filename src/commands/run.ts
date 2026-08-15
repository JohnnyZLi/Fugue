import type { QaRole } from "../core/attestations.js";
import { ManualChatExecutor, type ExecutionRole, type ExecutorInstruction } from "../core/executor.js";
import { requireWritableGitHub, type FugueGitHub } from "../core/github.js";
import { discoverRepository } from "../core/git.js";
import { reconstructState, type WorkState } from "../core/state.js";
import { actionLabel, observeWork, planWork, type WorkflowAction, type WorkflowObservation } from "../core/workflow.js";
import { runHandoff } from "./handoff.js";
import { runIntegrate } from "./integrate.js";

export interface RunOptions {
  issue?: string;
  pr?: string;
  interval?: string;
}

interface RunMemory {
  notifications: Map<number, string>;
}

const DEFAULT_INTERVAL_SECONDS = 15;
const MIN_INTERVAL_SECONDS = 2;

export async function runOrchestrator(options: RunOptions): Promise<void> {
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const intervalSeconds = parseInterval(options.interval);
  const memory: RunMemory = { notifications: new Map() };
  const executor = new ManualChatExecutor();

  console.log(`FUGUE RUN — ${repository.fullName}`);
  console.log(`Polling every ${intervalSeconds}s. Durable state remains in GitHub; Ctrl-C is safe.`);
  console.log("");

  while (true) {
    let immediate = false;

    try {
      const state = await reconstructState(github);
      const works = selectWorks(state.works, options);

      if (!works.length) {
        emitOnce(memory, 0, "no-work", () => console.log("No matching open Fugue work items. Waiting for GitHub state to change."));
      } else {
        memory.notifications.delete(0);
      }

      for (const work of works) {
        const observation = await observeWork(github, work);
        const action = planWork(observation);
        const result = await runAction({
          repository: repository.fullName,
          github,
          work,
          observation,
          action,
          executor,
          memory,
        });
        immediate = immediate || result.immediate;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      emitOnce(memory, -1, `loop-error:${detail}`, () => console.error(`FUGUE RUN ERROR — ${detail}`));
    }

    if (!immediate) await sleep(intervalSeconds * 1000);
  }
}

async function runAction(input: {
  repository: string;
  github: FugueGitHub;
  work: WorkState;
  observation: WorkflowObservation;
  action: WorkflowAction;
  executor: ManualChatExecutor;
  memory: RunMemory;
}): Promise<{ immediate: boolean }> {
  const { repository, github, work, observation, action, executor, memory } = input;
  const notification = notificationFingerprint(work, observation, action);

  switch (action.kind) {
    case "allocate_worker": {
      await runHandoff("worker", { issue: String(work.issueNumber) });
      const instruction = executor.instruction({
        repository,
        role: "worker",
        issueNumber: work.issueNumber,
        workId: work.metadata.work_id,
      });
      emitOnce(memory, work.issueNumber, workerExecutionFingerprint(work), () => printInstruction(instruction));
      return { immediate: true };
    }

    case "wait_worker": {
      const instruction = executor.instruction({
        repository,
        role: "worker",
        issueNumber: work.issueNumber,
        workId: work.metadata.work_id,
      });
      emitOnce(memory, work.issueNumber, workerExecutionFingerprint(work), () => {
        printState(work, action);
        printInstruction(instruction);
      });
      return { immediate: false };
    }

    case "resume_worker": {
      const instruction = executor.instruction({
        repository,
        role: "worker",
        issueNumber: work.issueNumber,
        workId: work.metadata.work_id,
      });
      emitOnce(memory, work.issueNumber, notification, () => {
        printState(work, action);
        printInstruction(instruction);
      });
      return { immediate: false };
    }

    case "start_qa": {
      const prNumber = requirePr(work);
      const instructions: ExecutorInstruction[] = [];
      for (const role of action.roles) {
        await runHandoff(`${role}-qa`, { pr: String(prNumber) });
        instructions.push(executor.instruction({
          repository,
          role: executionRole(role),
          prNumber,
          workId: work.metadata.work_id,
        }));
      }
      emitOnce(memory, work.issueNumber, qaExecutionFingerprint(work, action.roles), () => {
        printState(work, action);
        for (const instruction of instructions) printInstruction(instruction);
      });
      return { immediate: true };
    }

    case "wait_qa": {
      const prNumber = requirePr(work);
      const instructions = action.roles.map((role) => executor.instruction({
        repository,
        role: executionRole(role),
        prNumber,
        workId: work.metadata.work_id,
      }));
      emitOnce(memory, work.issueNumber, qaExecutionFingerprint(work, action.roles), () => {
        printState(work, action);
        for (const instruction of instructions) printInstruction(instruction);
      });
      return { immediate: false };
    }

    case "mark_pr_ready": {
      await markPrReady(github, requirePr(work));
      emitOnce(memory, work.issueNumber, notification, () => printState(work, action));
      return { immediate: true };
    }

    case "integrate": {
      emitOnce(memory, work.issueNumber, notification, () => printState(work, action));
      try {
        await runIntegrate(String(requirePr(work)));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        emitOnce(memory, work.issueNumber, `${notification}:error:${detail}`, () => {
          console.error(`Integration attempt for PR #${requirePr(work)} did not pass: ${detail}`);
        });
      }
      return { immediate: true };
    }

    case "wait_integration":
      emitOnce(memory, work.issueNumber, notification, () => printState(work, action));
      return { immediate: false };

    case "human_control_plane_ack":
      emitOnce(memory, work.issueNumber, notification, () => {
        printState(work, action);
        console.log(`HUMAN ACTION — review PR #${requirePr(work)} control-plane changes, then record the acknowledgement.`);
      });
      return { immediate: false };

    case "ready_to_merge":
      emitOnce(memory, work.issueNumber, notification, () => {
        printState(work, action);
        console.log(`MERGE READY — PR #${requirePr(work)} passed current Fugue Integration. Final merge remains human-controlled.`);
      });
      return { immediate: false };

    case "blocked":
      emitOnce(memory, work.issueNumber, notification, () => printState(work, action));
      return { immediate: false };
  }
}

export function notificationFingerprint(
  work: WorkState,
  observation: WorkflowObservation,
  action: WorkflowAction,
): string {
  const roles = "roles" in action ? action.roles.join(",") : "";
  const reason = action.kind === "blocked" ? action.reason : "";
  return [
    action.kind,
    roles,
    reason,
    work.metadata.work_id,
    work.workSpecDigest,
    work.pr?.headSha ?? "no-pr",
    observation.integration,
  ].join("|");
}

export function workerExecutionFingerprint(work: WorkState): string {
  return ["worker", work.metadata.work_id, work.workSpecDigest, work.pr?.headSha ?? "no-pr"].join("|");
}

export function qaExecutionFingerprint(work: WorkState, roles: QaRole[]): string {
  return ["qa", work.metadata.work_id, work.pr?.headSha ?? "no-pr", [...roles].sort().join(",")].join("|");
}

function emitOnce(memory: RunMemory, issueNumber: number, fingerprint: string, emit: () => void): void {
  if (memory.notifications.get(issueNumber) === fingerprint) return;
  memory.notifications.set(issueNumber, fingerprint);
  emit();
}

async function markPrReady(github: FugueGitHub, prNumber: number): Promise<void> {
  const { owner, repo } = github.repository;
  const pr = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (!pr.data.draft) return;

  await github.octokit.graphql(
    `mutation MarkReady($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest { isDraft }
      }
    }`,
    { pullRequestId: pr.data.node_id },
  );
}

function printState(work: WorkState, action: WorkflowAction): void {
  console.log(`WORK #${work.issueNumber} — ${work.title}`);
  console.log(`Next         ${actionLabel(action)}`);
}

function printInstruction(instruction: ExecutorInstruction): void {
  console.log("EXTERNAL EXECUTION REQUIRED");
  console.log(`Chat         ${instruction.label}`);
  console.log(`Prompt       ${instruction.prompt}`);
  console.log("");
}

function executionRole(role: QaRole): ExecutionRole {
  if (role === "code") return "code-qa";
  if (role === "security") return "security-qa";
  return "visual-qa";
}

function requirePr(work: WorkState): number {
  if (!work.pr) throw new Error(`Work #${work.issueNumber} has no linked PR.`);
  return work.pr.number;
}

function selectWorks(works: WorkState[], options: RunOptions): WorkState[] {
  if (options.issue && options.pr) throw new Error("Choose at most one of --issue or --pr.");
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

function parseInterval(value?: string): number {
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
