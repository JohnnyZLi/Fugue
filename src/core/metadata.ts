import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { digestCanonical } from "./hash.js";

const workSpecSchema = z.object({
  dependencies: z.array(z.number().int().positive()).default([]),
  ownership: z.object({
    owned: z.array(z.string()).default([]),
    coordinate: z.array(z.string()).default([]),
    forbidden: z.array(z.string()).default([]),
  }).default({ owned: [], coordinate: [], forbidden: [] }),
  qa: z.object({ force: z.array(z.enum(["code", "security", "visual"])).default([]) }).default({ force: [] }),
  authorized_changes: z.object({
    agents_invariants: z.array(z.string()).default([]),
  }).default({ agents_invariants: [] }),
});

const executionSchema = z.object({
  worker_id: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});

export const workMetadataSchema = z.object({
  version: z.literal(1),
  work_id: z.string().min(1),
  spec: workSpecSchema,
  execution: executionSchema.default({}),
});

export type WorkMetadata = z.infer<typeof workMetadataSchema>;
export type WorkSpec = z.infer<typeof workSpecSchema>;

const START = "<!-- fugue-work\n";
const LOOSE_START = "<!-- fugue-work";
const END = "-->";

export function parseWorkMetadata(issueBody: string): WorkMetadata | null {
  const range = trailingMetadataRange(issueBody);
  if (!range) return null;
  const yaml = issueBody.slice(range.start + START.length, range.end).trim();
  return workMetadataSchema.parse(parseYaml(yaml));
}

export function assertWorkMetadataForIssue(metadata: WorkMetadata, issueNumber: number): void {
  const expected = createWorkId(issueNumber);
  if (metadata.work_id !== expected) {
    throw new Error(
      `Issue #${issueNumber} declares work_id ${metadata.work_id}; expected ${expected}. Coordinator must repair the machine metadata.`,
    );
  }
}

export function stripWorkMetadata(issueBody: string): string {
  const range = trailingMetadataRange(issueBody);
  if (!range) return normalizeRequirements(issueBody);
  return normalizeRequirements(issueBody.slice(0, range.start));
}

export function upsertWorkMetadata(issueBody: string, metadata: WorkMetadata): string {
  const block = `${START}${stringifyYaml(metadata).trim()}\n${END}`;
  const range = trailingMetadataRange(issueBody);
  if (range) {
    return `${issueBody.slice(0, range.start).trimEnd()}\n\n${block}\n`;
  }

  // A malformed loose trailing marker is presentation corruption; discard that suffix before
  // writing the protected mirror rather than allowing it to shadow the canonical trailing block.
  const loose = issueBody.lastIndexOf(LOOSE_START);
  const base = loose >= 0 && !issueBody.slice(loose).includes(END)
    ? issueBody.slice(0, loose).trimEnd()
    : issueBody.trimEnd();
  return `${base}${base ? "\n\n" : ""}${block}\n`;
}

export function workSpecDigest(issueBody: string, metadata: WorkMetadata): string {
  return workSpecDigestFromRequirements(stripWorkMetadata(issueBody), metadata);
}

export function workSpecDigestFromRequirements(requirements: string, metadata: WorkMetadata): string {
  return digestCanonical({
    requirements: normalizeRequirements(requirements),
    spec: metadata.spec,
  });
}

export function createWorkId(issueNumber: number): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number: ${issueNumber}`);
  }
  return `work-${issueNumber}`;
}

function trailingMetadataRange(issueBody: string): { start: number; end: number } | null {
  const start = issueBody.lastIndexOf(START);
  if (start < 0) return null;
  const end = issueBody.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated trailing fugue-work metadata block.");
  if (issueBody.slice(end + END.length).trim()) return null;
  return { start, end };
}

function normalizeRequirements(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}
