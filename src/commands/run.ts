import type { QaRole } from "../core/attestations.js";
import { CodexCliExecutor } from "../core/codex-executor.js";
import { captureEvaluation } from "../core/evaluation.js";
import { ManualChatExecutor, type ExecutionRole, type ExecutorInstruction } from "../core/executor.js";
import { requireWritableGitHub, type FugueGitHub } from "../core/github.js";
import { discoverRepository } from "../core/git.js";
import { reconstructState, type WorkState } from "../core/state.js";
import { actionLabel, observeWork, planWork, type WorkflowAction, type WorkflowObservation } from "../core/workflow.js";
import { runHandoff } from "./handoff.js";
import { runIntegrate } from "./integrate.js";

export type ExecutorMode = "manual-chat" | "codex";

export interface RunOptions {
  issue?: string;
  pr?: string;
  interval?: string;
  executor?: string;
  model?: string;
}

interface RunMemory {
  notifications: Map<number, string>;
  attempts: Set<string>;
}

const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_INTERVAL_SECONDS = 10;

export async function runOrchestrator(options: RunOptions): Promise<void> {
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const intervalSeconds = parseInterval(options.interval);
  const memory: RunMemory = { notifications: new Map(), attempts: new Set() };
  const manual = new ManualChatExecutor();
  const executorMode = parseExecutorMode(options.executor);
  const codex = executorMode === "codex" ? new CodexCliExecutor(options.model ? { model: options.model } : {}) : null;
  if (codex) await codex.assertAvailable();

  console.log(`FUGUE RUN — ${repository.fullName}`);
  console.log(`Executor ${executorMode}. Polling every ${intervalSeconds}s. Durable state remains in GitHub; Ctrl-C is safe.`);
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
        try {
          const observation = await observeWork(github, work);
          const action = planWork(observation);
          const result = await runAction({
            repository: repository.fullName,
            github,
            work,
            observation,
            action,
            manual,
            codex,
            memory,
          });
          immediate = immediate || result.immediate;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          emitOnce(memory, work.issueNumber, `work-error:${work.workSpecDigest}:${work.pr?.headSha ?? "no-pr"}:${detail}`, () => {
            console.error(`WORK #${work.issueNumber} ERROR — ${detail}`);
          });
        }
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
  manual: ManualChatExecutor;
  codex: CodexCliExecutor | null;
  memory: RunMemory;
}): Promise<{ immediate: boolean }> {
  const { repository, github, work, observation, action, manual, codex, memory } = input;
  const notification = notificationFingerprint(work, observation, action);

  switch (action.kind) {
    case "allocate_worker": {
      await runHandoff("worker", { issue: String(work.issueNumber) });
      if (codex) return { immediate: true };

      const instruction = manual.instruction({
        repository,
        role: "worker",
        issueNumber: work.issueNumber,
        workId: work.metadata.work_id,
      });
      emitOnce(memory, work.issueNumber, workerExecutionFingerprint(work), () => printInstruction(instruction));
      return { immediate: true };
    }

    case "wait_worker":
    case "resume_worker": {
      if (codex) {
        const attempt = codexWorkerAttemptFingerprint(work);
        if (!claimAttempt(memory, attempt)) {
          emitAttemptSuppressed(memory, work, attempt, "Codex Worker");
          return { immediate: false };
        }
        printState(work, action);
        const result = await codex.executeWorker(github, work);
        console.log(`CODEX WORKER COMPLETE — PR #${result.prNumber} @ ${result.headSha.slice(0, 8)}`);
        memory.notifications.delete(work.issueNumber);
        return { immediate: true };
      }

      const instruction = manual.instruction({
        repository,
        role: "worker",
        issueNumber: work.issueNumber,
        workId: work.metadata.work_id,
      });
      emitOnce(memory, work.issueNumber, action.kind === "wait_worker" ? workerExecutionFingerprint(work) : notification, () => {
        printState(work, action);
        printInstruction(instruction);
      });
      return { immediate: false };
    }

    case "start_qa": {
      const prNumber = requirePr(work);
      const instructions: ExecutorInstruction[] = [];
      let launchedCodex = false;

      for (const role of action.roles) {
        await runHandoff(`${role}-qa`, { pr: String(prNumber) });
        const executionRoleValue = executionRole(role);
        if (codex?.supports(executionRoleValue)) {
          const attempt = codexQaAttemptFingerprint(work, role);
          if (!claimAttempt(memory, attempt)) {
            emitAttemptSuppressed(memory, work, attempt, `Codex ${role.toUpperCase()} QA`);
            continue;
          }
          const snapshot = await captureEvaluation(github, prNumber);
          await codex.executeQa(github, snapshot, role as Exclude<QaRole, "visual">);
          console.log(`CODEX ${role.toUpperCase()} QA COMPLETE — PR #${prNumber}`);
          launchedCodex = true;
        } else {
          instructions.push(manual.instruction({
            repository,
            role: executionRoleValue,
            prNumber,
            workId: work.metadata.work_id,
          }));
        }
      }

      if (instructions.length) {
        emitOnce(memory, work.issueNumber, qaExecutionFingerprint(work, action.roles), () => {
          printState(work, action);
          for (const instruction of instructions) printInstruction(instruction);
        });
      }
      return { immediate: launchedCodex || (!codex && !instructions.length) };
    }

    case "wait_qa": {
      const prNumber = requirePr(work);
      const instructions: ExecutorInstruction[] = [];
      let launchedCodex = false;

      for (const role of action.roles) {
        const executionRoleValue = executionRole(role);
        if (codex?.supports(executionRoleValue)) {
          const attempt = codexQaAttemptFingerprint(work, role);
          if (!claimAttempt(memory, attempt)) {
            emitAttemptSuppressed(memory, work, attempt, `Codex ${role.toUpperCase()} QA`);
            continue;
          }
          const snapshot = await captureEvaluation(github, prNumber);
          await codex.executeQa(github, snapshot, role as Exclude<QaRole, "visual">);
          console.log(`CODEX ${role.toUpperCase()} QA COMPLETE — PR #${prNumber}`);
          launchedCodex = true;
        } else {
          instructions.push(manual.instruction({
            repository,
            role: executionRoleValue,
            prNumber,
            workId: work.metadata.work_id,
          }));
        }
      }

      if (instructions.length) {
        emitOnce(memory, work.issueNumber, qaExecutionFingerprint(work, action.roles), () => {
          printState(work, action);
          for (const instruction of instructions) printInstruction(instruction);
        });
      }
      return { immediate: launchedCodex };
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

export function codexWorkerAttemptFingerprint(work: WorkState): string {
  return ["codex-worker", work.metadata.work_id, work.workSpecDigest, work.pr?.headSha ?? "no-pr"].join("|");
}

export function codexQaAttemptFingerprint(work: WorkState, role: QaRole): string {
  return ["codex-qa", role, work.metadata.work_id, work.workSpecDigest, work.pr?.headSha ?? "no-pr"].join("|");
}

function claimAttempt(memory: RunMemory, fingerprint: string): boolean {
  if (memory.attempts.has(fingerprint)) return false;
  memory.attempts.add(fingerprint);
  return true;
}

function emitAttemptSuppressed(memory: RunMemory, work: WorkState, attempt: string, label: string): void {
  emitOnce(memory, work.issueNumber, `attempt-suppressed:${attempt}`, () => {
    console.log(`${label} already ran for the current evaluation identity. Fugue will not retry it every poll; restart fugue run to retry explicitly.`);
  });
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

export function parseExecutorMode(value?: string): ExecutorMode {
  const normalized = value ?? "manual-chat";
  if (normalized === "manual-chat" || normalized === "codex") return normalized;
  throw new Error(`Unknown executor ${normalized}; expected manual-chat or codex.`);
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
