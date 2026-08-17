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

const START = "<!-- fugue-pr\n";
const LOOSE_START = "<!-- fugue-pr";
const END = "-->";

export function parsePrMetadata(body: string | null | undefined): PrMetadata | null {
  if (!body) return null;
  const range = trailingMetadataRange(body);
  if (!range) return null;
  return prMetadataSchema.parse(parseYaml(body.slice(range.start + START.length, range.end).trim()));
}

export function samePrMetadata(left: PrMetadata, right: PrMetadata): boolean {
  return left.version === right.version &&
    left.work_id === right.work_id &&
    left.issue === right.issue &&
    left.worker_id === right.worker_id &&
    left.branch === right.branch;
}

export function upsertPrMetadata(body: string, metadata: PrMetadata): string {
  return canonicalizePrMetadata(body, metadata);
}

export function canonicalizePrMetadata(body: string, metadata: PrMetadata): string {
  const block = metadataBlock(metadata);
  const range = trailingMetadataRange(body);
  if (range) {
    const prefix = body.slice(0, range.start).trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${block}\n`;
  }

  const loose = body.lastIndexOf(LOOSE_START);
  const prefix = (loose >= 0 && !body.slice(loose).includes(END) ? body.slice(0, loose) : body).trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${block}\n`;
}

function trailingMetadataRange(body: string): { start: number; end: number } | null {
  const start = body.lastIndexOf(START);
  if (start < 0) return null;
  const end = body.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated trailing fugue-pr metadata block.");
  if (body.slice(end + END.length).trim()) return null;
  return { start, end };
}

function metadataBlock(metadata: PrMetadata): string {
  return `${START}${stringifyYaml(metadata).trim()}\n${END}`;
}
