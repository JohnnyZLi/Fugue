import type { QaRole } from "../core/attestations.js";
import { ManualChatExecutor, type ExecutionRole } from "../core/executor.js";
import { createGitHub } from "../core/github.js";
import { discoverRepository } from "../core/git.js";
import { reconstructState, type WorkState } from "../core/state.js";
import { actionLabel, observeWork, planWork, type WorkflowAction } from "../core/workflow.js";
import { runHandoff } from "./handoff.js";
import { runIntegrate } from "./integrate.js";

export interface AdvanceOptions {
  issue?: string;
  pr?: string;
  dryRun?: boolean;
}

export async function runAdvance(options: AdvanceOptions): Promise<void> {
  const repository = await discoverRepository();
  const github = await createGitHub(repository);
  const state = await reconstructState(github);
  const works = selectWorks(state.works, options);
  const executor = new ManualChatExecutor();

  if (!works.length) {
    console.log("FUGUE ADVANCE — no matching open work items.");
    return;
  }

  for (const work of works) {
    const observation = await observeWork(github, work);
    const action = planWork(observation);

    console.log(`FUGUE ADVANCE — #${work.issueNumber} ${work.title}`);
    console.log(`Current      ${work.stateLabel.replace("state:", "")}${work.pr ? ` / PR #${work.pr.number}` : ""}`);
    console.log(`Next         ${actionLabel(action)}`);

    if (options.dryRun) {
      console.log("Mode         dry-run; no mutation performed");
      console.log("");
      continue;
    }

    await executeAction(repository.fullName, work, action, executor);
    console.log("");
  }
}

async function executeAction(
  repository: string,
  work: WorkState,
  action: WorkflowAction,
  executor: ManualChatExecutor,
): Promise<void> {
  switch (action.kind) {
    case "allocate_worker": {
      await runHandoff("worker", { issue: String(work.issueNumber) });
      printInstruction(executor.instruction({
        repository,
        role: "worker",
        issueNumber: work.issueNumber,
        workId: work.metadata.work_id,
      }));
      return;
    }
    case "wait_worker":
    case "resume_worker": {
      printInstruction(executor.instruction({
        repository,
        role: "worker",
        issueNumber: work.issueNumber,
        workId: work.metadata.work_id,
      }));
      return;
    }
    case "start_qa": {
      const prNumber = requirePr(work);
      for (const role of action.roles) {
        await runHandoff(`${role}-qa`, { pr: String(prNumber) });
        printInstruction(executor.instruction({
          repository,
          role: executionRole(role),
          prNumber,
          workId: work.metadata.work_id,
        }));
      }
      return;
    }
    case "wait_qa": {
      const prNumber = requirePr(work);
      for (const role of action.roles) {
        printInstruction(executor.instruction({
          repository,
          role: executionRole(role),
          prNumber,
          workId: work.metadata.work_id,
        }));
      }
      return;
    }
    case "human_control_plane_ack": {
      const prNumber = requirePr(work);
      console.log("HUMAN ACTION");
      console.log(`Review the control-plane change on PR #${prNumber}, then run:`);
      console.log(`fugue acknowledge ${prNumber} --control-plane`);
      return;
    }
    case "integrate": {
      await runIntegrate(String(requirePr(work)));
      return;
    }
    case "wait_integration":
      console.log("Integration is already running for the current head; no action taken.");
      return;
    case "ready_to_merge":
      console.log(`MERGE READY — PR #${requirePr(work)} has a current successful Fugue Integration attestation.`);
      return;
    case "blocked":
      console.log(`BLOCKED — ${action.reason}`);
      return;
  }
}

function printInstruction(instruction: { label: string; prompt: string }): void {
  console.log("");
  console.log("EXTERNAL EXECUTION REQUIRED");
  console.log(`Chat         ${instruction.label}`);
  console.log(`Prompt       ${instruction.prompt}`);
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

function selectWorks(works: WorkState[], options: AdvanceOptions): WorkState[] {
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

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}
