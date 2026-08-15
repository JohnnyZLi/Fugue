import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const prMetadataSchema = z.object({
  version: z.literal(1),
  work_id: z.string().min(1),
  issue: z.number().int().positive(),
  worker_id: z.string().min(1),
  branch: z.string().min(1),
});

export type PrMetadata = z.infer<typeof prMetadataSchema>;

const START = "<!-- fugue-pr";
const END = "-->";

export function parsePrMetadata(body: string | null | undefined): PrMetadata | null {
  if (!body) return null;
  const start = body.indexOf(START);
  if (start < 0) return null;
  const end = body.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated fugue-pr metadata block.");
  return prMetadataSchema.parse(parseYaml(body.slice(start + START.length, end).trim()));
}

export function samePrMetadata(left: PrMetadata, right: PrMetadata): boolean {
  return left.version === right.version &&
    left.work_id === right.work_id &&
    left.issue === right.issue &&
    left.worker_id === right.worker_id &&
    left.branch === right.branch;
}

export function upsertPrMetadata(body: string, metadata: PrMetadata): string {
  const block = metadataBlock(metadata);
  const start = body.indexOf(START);
  if (start < 0) return `${body.trimEnd()}\n\n${block}\n`;
  const end = body.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated fugue-pr metadata block.");
  return `${body.slice(0, start)}${block}${body.slice(end + END.length)}`;
}

export function canonicalizePrMetadata(body: string, metadata: PrMetadata): string {
  const block = metadataBlock(metadata);
  const start = body.indexOf(START);
  if (start < 0) return `${body.trimEnd()}\n\n${block}\n`;
  const end = body.indexOf(END, start + START.length);
  if (end < 0) {
    const prefix = body.slice(0, start).trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${block}\n`;
  }
  return `${body.slice(0, start)}${block}${body.slice(end + END.length)}`;
}

function metadataBlock(metadata: PrMetadata): string {
  return `${START}\n${stringifyYaml(metadata).trim()}\n${END}`;
}
