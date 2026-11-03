import { z } from "zod";
import { abortSignalSchema, throwIfAborted, withAbort } from "../abort.js";

export const segmentOptionsSchema = z.object({
  unit: z.enum(["paragraph", "line"]).default("paragraph"),
  trim: z.boolean().default(false),
  includeDelimiter: z.boolean().default(true),
  maxBuffer: z.number().int().positive().default(1_000_000),
  signal: abortSignalSchema.optional(),
});

export type SegmentOptions = z.input<typeof segmentOptionsSchema>;
export type SegmentUnit = z.infer<typeof segmentOptionsSchema>["unit"];

export interface ParaChunk {
  text: string;
  index: number;
  unit: SegmentUnit;
  /** True only for the residual emitted by the end-of-stream flush. */
  isFinal: boolean;
}

export type TextSource =
  | string
  | Iterable<string>
  | AsyncIterable<string>
  | ReadableStream<string>;

export const textSourceSchema = z.custom<TextSource>((value) => {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null) return false;
  if ("getReader" in value && typeof value.getReader === "function") return true;
  return (
    (Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function") ||
    (Symbol.iterator in value && typeof value[Symbol.iterator] === "function")
  );
});
const textChunkSchema = z.string();

function isReadableStream<T>(value: unknown): value is ReadableStream<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof value.getReader === "function"
  );
}

async function* textChunks(
  source: TextSource,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  throwIfAborted(signal);
  if (typeof source === "string") {
    if (source.length > 0) yield source;
    return;
  }

  if (isReadableStream<string>(source)) {
    const reader = source.getReader();
    let complete = false;
    const cancelOnAbort = (): void => {
      void reader.cancel(signal?.reason).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      while (true) {
        const next = await reader.read();
        throwIfAborted(signal);
        if (next.done) {
          complete = true;
          return;
        }
        const chunk = textChunkSchema.parse(next.value);
        if (chunk.length > 0) yield chunk;
      }
    } finally {
      signal?.removeEventListener("abort", cancelOnAbort);
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  const asyncSource = source as AsyncIterable<string>;
  if (typeof asyncSource[Symbol.asyncIterator] === "function") {
    for await (const chunk of withAbort(asyncSource, signal)) {
      const text = textChunkSchema.parse(chunk);
      if (text.length > 0) yield text;
    }
    return;
  }

  for (const chunk of source as Iterable<string>) {
    throwIfAborted(signal);
    const text = textChunkSchema.parse(chunk);
    if (text.length > 0) yield text;
  }
}

function delimiterLengthAtTail(tail: string, unit: SegmentUnit): number {
  if (unit === "line") {
    if (tail.endsWith("\r\n")) return 2;
    if (tail.endsWith("\n")) return 1;
    return 0;
  }

  if (tail.endsWith("\r\n\r\n")) return 4;
  if (tail.endsWith("\n\r\n")) return 3;
  if (tail.endsWith("\n\n")) return 2;
  return 0;
}

function formatUnit(
  value: string,
  delimiter: string,
  options: z.output<typeof segmentOptionsSchema>,
): string {
  const text = options.trim ? value.trim() : value;
  return options.includeDelimiter ? text + delimiter : text;
}

export interface TextSegmenter {
  push(chunk: string): ParaChunk[];
  finish(): ParaChunk | undefined;
}

export function createTextSegmenter(
  inputOptions: SegmentOptions = {},
): TextSegmenter {
  const options = segmentOptionsSchema.parse(inputOptions);
  let pieces: string[] = [];
  let pendingLength = 0;
  let tail = "";
  let index = 0;

  return {
    push(chunk: string): ParaChunk[] {
      const text = textChunkSchema.parse(chunk);
      if (text.length === 0) return [];

      const output: ParaChunk[] = [];
      let pieceStart = 0;

      for (let offset = 0; offset < text.length; offset += 1) {
        tail = (tail + text[offset]).slice(-4);
        const delimiterLength = delimiterLengthAtTail(tail, options.unit);

        if (delimiterLength > 0) {
          const piece = text.slice(pieceStart, offset + 1);
          pieces.push(piece);
          pendingLength += piece.length;

          const unitLength = pendingLength - delimiterLength;
          if (unitLength > options.maxBuffer) {
            throw new RangeError(
              `Pending ${options.unit} exceeds maxBuffer (${options.maxBuffer} UTF-16 code units)`,
            );
          }

          const full = pieces.join("");
          const unit = full.slice(0, unitLength);
          const delimiter = full.slice(unitLength);
          output.push({
            text: formatUnit(unit, delimiter, options),
            index,
            unit: options.unit,
            isFinal: false,
          });
          index += 1;
          pieces = [];
          pendingLength = 0;
          tail = "";
          pieceStart = offset + 1;
          continue;
        }

        const currentLength = pendingLength + offset - pieceStart + 1;
        if (currentLength > options.maxBuffer) {
          throw new RangeError(
            `Pending ${options.unit} exceeds maxBuffer (${options.maxBuffer} UTF-16 code units)`,
          );
        }
      }

      if (pieceStart < text.length) {
        const remainder = text.slice(pieceStart);
        pieces.push(remainder);
        pendingLength += remainder.length;
      }

      return output;
    },
    finish(): ParaChunk | undefined {
      if (pendingLength === 0) return undefined;
      const chunk: ParaChunk = {
        text: options.trim ? pieces.join("").trim() : pieces.join(""),
        index,
        unit: options.unit,
        isFinal: true,
      };
      pieces = [];
      pendingLength = 0;
      tail = "";
      index += 1;
      return chunk;
    },
  };
}

export async function* parastreamChunks(
  inputSource: TextSource,
  inputOptions: SegmentOptions = {},
): AsyncGenerator<ParaChunk> {
  const options = segmentOptionsSchema.parse(inputOptions);
  const source = textSourceSchema.parse(inputSource);
  throwIfAborted(options.signal);
  const segmenter = createTextSegmenter(options);

  for await (const chunk of textChunks(source, options.signal)) {
    yield* segmenter.push(chunk);
  }

  const finalChunk = segmenter.finish();
  if (finalChunk !== undefined) yield finalChunk;
}

export async function* parastream(
  source: TextSource,
  options: SegmentOptions = {},
): AsyncGenerator<string> {
  for await (const chunk of parastreamChunks(source, options)) {
    yield chunk.text;
  }
}
