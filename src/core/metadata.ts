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

const START = "<!-- fugue-work";
const END = "-->";

export function parseWorkMetadata(issueBody: string): WorkMetadata | null {
  const start = issueBody.indexOf(START);
  if (start < 0) return null;

  const end = issueBody.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated fugue-work metadata block.");

  const yaml = issueBody.slice(start + START.length, end).trim();
  return workMetadataSchema.parse(parseYaml(yaml));
}

export function stripWorkMetadata(issueBody: string): string {
  const start = issueBody.indexOf(START);
  if (start < 0) return normalizeRequirements(issueBody);

  const end = issueBody.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated fugue-work metadata block.");

  return normalizeRequirements(`${issueBody.slice(0, start)}${issueBody.slice(end + END.length)}`);
}

export function upsertWorkMetadata(issueBody: string, metadata: WorkMetadata): string {
  const block = `${START}\n${stringifyYaml(metadata).trim()}\n${END}`;
  const start = issueBody.indexOf(START);

  if (start < 0) {
    return `${issueBody.trimEnd()}\n\n${block}\n`;
  }

  const end = issueBody.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated fugue-work metadata block.");

  return `${issueBody.slice(0, start)}${block}${issueBody.slice(end + END.length)}`;
}

export function workSpecDigest(issueBody: string, metadata: WorkMetadata): string {
  return digestCanonical({
    requirements: stripWorkMetadata(issueBody),
    spec: metadata.spec,
  });
}

export function createWorkId(issueNumber: number): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number: ${issueNumber}`);
  }
  return `work-${issueNumber}`;
}

function normalizeRequirements(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}
