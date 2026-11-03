import { z } from "zod";
import { streamLines, type ChunkSource } from "./framing.js";

export const ndjsonOptionsSchema = z.object({
  maxLineLength: z.number().int().positive().default(1_000_000),
});

/** Parses newline-delimited JSON values, including a final line without a newline. */
export async function* parseNDJSON(
  source: ChunkSource,
  inputOptions: z.input<typeof ndjsonOptionsSchema> = {},
): AsyncGenerator<unknown> {
  const options = ndjsonOptionsSchema.parse(inputOptions);
  for await (const { line, lineNumber } of streamLines(source, options.maxLineLength)) {
    if (line.trim().length === 0) continue;
    try {
      yield JSON.parse(line) as unknown;
    } catch {
      throw new SyntaxError(`Invalid NDJSON at line ${lineNumber}`);
    }
  }
}
