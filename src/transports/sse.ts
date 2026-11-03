import { z } from "zod";
import { streamLines, type ChunkSource } from "./framing.js";

export const sseOptionsSchema = z.object({
  maxLineLength: z.number().int().positive().default(1_000_000),
  maxEventLength: z.number().int().positive().default(1_000_000),
});

export const sseFrameSchema = z.object({
  data: z.string(),
  event: z.string().optional(),
  id: z.string().optional(),
  retry: z.number().int().nonnegative().optional(),
});

export type SseFrame = z.infer<typeof sseFrameSchema>;

function parseField(line: string): [string, string] {
  const colon = line.indexOf(":");
  if (colon < 0) return [line, ""];
  const field = line.slice(0, colon);
  const value = line.slice(colon + 1);
  return [field, value.startsWith(" ") ? value.slice(1) : value];
}

/** Parses SSE framing only. It does not JSON-parse or identify provider payloads. */
export async function* parseSSE(
  source: ChunkSource,
  inputOptions: z.input<typeof sseOptionsSchema> = {},
): AsyncGenerator<SseFrame> {
  const options = sseOptionsSchema.parse(inputOptions);
  let data: string[] = [];
  let dataLength = 0;
  let hasData = false;
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  const dispatch = (): SseFrame | undefined => {
    if (!hasData) {
      data = [];
      dataLength = 0;
      event = undefined;
      retry = undefined;
      return undefined;
    }
    const frame = sseFrameSchema.parse({
      data: data.join("\n"),
      ...(event === undefined ? {} : { event }),
      ...(id === undefined ? {} : { id }),
      ...(retry === undefined ? {} : { retry }),
    });
    data = [];
    dataLength = 0;
    hasData = false;
    event = undefined;
    retry = undefined;
    return frame;
  };

  for await (const { line } of streamLines(source, options.maxLineLength)) {
    if (line.length === 0) {
      const frame = dispatch();
      if (frame !== undefined) yield frame;
      continue;
    }
    if (line.startsWith(":")) continue;

    const [field, value] = parseField(line);
    if (field === "data") {
      const nextLength = dataLength + value.length + (hasData ? 1 : 0);
      if (nextLength > options.maxEventLength) {
        throw new RangeError(`SSE event exceeds maxEventLength (${options.maxEventLength})`);
      }
      data.push(value);
      dataLength = nextLength;
      hasData = true;
    } else if (field === "event") {
      event = value;
    } else if (field === "id" && !value.includes("\0")) {
      id = value;
    } else if (field === "retry" && /^\d+$/.test(value)) {
      retry = Number(value);
    }
  }

  const finalFrame = dispatch();
  if (finalFrame !== undefined) yield finalFrame;
}
