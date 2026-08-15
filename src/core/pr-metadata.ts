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

export function upsertPrMetadata(body: string, metadata: PrMetadata): string {
  const block = `${START}\n${stringifyYaml(metadata).trim()}\n${END}`;
  const start = body.indexOf(START);
  if (start < 0) return `${body.trimEnd()}\n\n${block}\n`;
  const end = body.indexOf(END, start + START.length);
  if (end < 0) throw new Error("Unterminated fugue-pr metadata block.");
  return `${body.slice(0, start)}${block}${body.slice(end + END.length)}`;
}
