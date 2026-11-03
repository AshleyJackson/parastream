import { z } from "zod";
import { throwIfAborted, withAbort } from "../abort.js";

export type ChunkSource =
  | string
  | Uint8Array
  | ReadableStream<unknown>
  | AsyncIterable<unknown>
  | Iterable<unknown>;

function isChunkSource(value: unknown): value is ChunkSource {
  if (typeof value === "string" || value instanceof Uint8Array) return true;
  if (typeof value !== "object" || value === null) return false;
  if (
    "getReader" in value &&
    typeof value.getReader === "function"
  ) {
    return true;
  }
  return (
    (Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function") ||
    (Symbol.iterator in value && typeof value[Symbol.iterator] === "function")
  );
}

export const chunkSourceSchema = z.custom<ChunkSource>(isChunkSource);

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof value.getReader === "function"
  );
}

export async function* sourceValues(
  inputSource: ChunkSource,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const source = chunkSourceSchema.parse(inputSource);
  throwIfAborted(signal);
  if (typeof source === "string") {
    yield source;
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }

  if (isReadableStream(source)) {
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
        yield next.value;
      }
    } finally {
      signal?.removeEventListener("abort", cancelOnAbort);
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  const asyncSource = source as AsyncIterable<unknown>;
  if (typeof asyncSource[Symbol.asyncIterator] === "function") {
    yield* withAbort(asyncSource, signal);
    return;
  }

  for (const value of source as Iterable<unknown>) {
    throwIfAborted(signal);
    yield value;
  }
}

export async function* decodeTextChunks(
  source: ChunkSource,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const value of sourceValues(source, signal)) {
    if (typeof value === "string") {
      const pending = decoder.decode();
      if (pending.length > 0) yield pending;
      if (value.length > 0) yield value;
      continue;
    }

    if (!(value instanceof Uint8Array)) {
      throw new TypeError("Expected stream chunks to be strings or Uint8Array values");
    }
    const decoded = decoder.decode(value, { stream: true });
    if (decoded.length > 0) yield decoded;
  }

  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

async function* lines(
  source: ChunkSource,
  maxLineLength: number,
): AsyncGenerator<{ line: string; lineNumber: number }> {
  let buffer = "";
  let lineNumber = 0;

  for await (const text of decodeTextChunks(source)) {
    buffer += text;
    while (true) {
      let breakIndex = -1;
      let breakLength = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const character = buffer[index];
        if (character === "\n") {
          breakIndex = index;
          breakLength = 1;
          break;
        }
        if (character === "\r") {
          if (index === buffer.length - 1) break;
          breakIndex = index;
          breakLength = buffer[index + 1] === "\n" ? 2 : 1;
          break;
        }
      }

      if (breakIndex < 0) break;
      const line = buffer.slice(0, breakIndex);
      buffer = buffer.slice(breakIndex + breakLength);
      lineNumber += 1;
      if (line.length > maxLineLength) {
        throw new RangeError(`Stream line ${lineNumber} exceeds maxLineLength (${maxLineLength})`);
      }
      yield { line, lineNumber };
    }

    if (buffer.length > maxLineLength) {
      throw new RangeError(`Stream line ${lineNumber + 1} exceeds maxLineLength (${maxLineLength})`);
    }
  }

  while (buffer.length > 0) {
    const crIndex = buffer.indexOf("\r");
    const lfIndex = buffer.indexOf("\n");
    const breakIndex =
      crIndex < 0 ? lfIndex : lfIndex < 0 ? crIndex : Math.min(crIndex, lfIndex);
    if (breakIndex < 0) break;
    const line = buffer.slice(0, breakIndex);
    const breakLength =
      buffer[breakIndex] === "\r" && buffer[breakIndex + 1] === "\n" ? 2 : 1;
    buffer = buffer.slice(breakIndex + breakLength);
    lineNumber += 1;
    if (line.length > maxLineLength) {
      throw new RangeError(`Stream line ${lineNumber} exceeds maxLineLength (${maxLineLength})`);
    }
    yield { line, lineNumber };
  }

  if (buffer.length > 0) {
    lineNumber += 1;
    if (buffer.length > maxLineLength) {
      throw new RangeError(`Stream line ${lineNumber} exceeds maxLineLength (${maxLineLength})`);
    }
    yield { line: buffer, lineNumber };
  }
}

export { lines as streamLines };
