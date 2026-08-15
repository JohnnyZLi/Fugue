import { randomBytes } from "node:crypto";
import type { WorkMetadata } from "./metadata.js";

export interface WorkerClaimResult {
  metadata: WorkMetadata;
  workerId: string;
  branch: string;
  resumed: boolean;
}

export function claimWorker(
  metadata: WorkMetadata,
  issueNumber: number,
  issueTitle: string,
  workerPattern: string,
  resume: boolean,
): WorkerClaimResult {
  const existingWorker = metadata.execution.worker_id;
  const existingBranch = metadata.execution.branch;

  if (resume) {
    if (!existingWorker || !existingBranch) {
      throw new Error(`Issue #${issueNumber} has no existing Worker claim to resume.`);
    }
    return {
      metadata,
      workerId: existingWorker,
      branch: existingBranch,
      resumed: true,
    };
  }

  if (existingWorker || existingBranch) {
    throw new Error(
      `Issue #${issueNumber} is already claimed by ${existingWorker ?? "unknown Worker"} on ${existingBranch ?? "unknown branch"}. Use --resume to replace a prior chat session.`,
    );
  }

  const workerId = `wkr-${randomBytes(4).toString("hex")}`;
  const branch = workerPattern
    .replace("{issue}", String(issueNumber))
    .replace("{slug}", slugify(issueTitle));

  const claimed: WorkMetadata = {
    ...metadata,
    execution: {
      worker_id: workerId,
      branch,
    },
  };

  return { metadata: claimed, workerId, branch, resumed: false };
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "work";
}
