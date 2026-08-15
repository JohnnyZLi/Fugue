export type ExecutionRole = "worker" | "code-qa" | "security-qa" | "visual-qa";

export interface ManualExecutionRequest {
  repository: string;
  role: ExecutionRole;
  issueNumber?: number;
  prNumber?: number;
  workId?: string;
}

export interface ExecutorInstruction {
  executor: "manual-chat";
  role: ExecutionRole;
  label: string;
  prompt: string;
}

export interface Executor {
  readonly kind: string;
  instruction(request: ManualExecutionRequest): ExecutorInstruction;
}

export class ManualChatExecutor implements Executor {
  readonly kind = "manual-chat";

  instruction(request: ManualExecutionRequest): ExecutorInstruction {
    if (request.role === "worker") {
      if (!request.issueNumber || !request.workId) {
        throw new Error("Manual Worker execution requires issueNumber and workId.");
      }
      return {
        executor: "manual-chat",
        role: request.role,
        label: `Worker — ${request.repository} #${request.issueNumber}`,
        prompt: `Fugue Worker for ${request.repository} ${request.workId}. Reconstruct your assignment from GitHub, work only the assigned issue and branch, validate it, open/link the implementation PR, and record durable findings. Do not merge or self-approve.`,
      };
    }

    if (!request.prNumber) {
      throw new Error(`Manual ${request.role} execution requires prNumber.`);
    }

    const readableRole = request.role === "code-qa"
      ? "Code QA"
      : request.role === "security-qa"
        ? "Security QA"
        : "Visual QA";

    return {
      executor: "manual-chat",
      role: request.role,
      label: `${readableRole} — ${request.repository} PR #${request.prNumber}`,
      prompt: `Fugue ${readableRole} for ${request.repository} PR #${request.prNumber}. Reconstruct the current pending Fugue review session from GitHub, review the exact committed evaluation identity independently, and record the verdict durably. Do not implement fixes.`,
    };
  }
}
