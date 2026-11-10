import { z } from "zod";
import {
  detectResponseProtocol,
  normalizeResponseEvent,
  normalizedPartSchema,
  protocolHintSchema,
  type NormalizedPart,
  type ProtocolHint,
  type ResponseProtocol,
} from "./protocols/normalize.js";
import { abortSignalSchema, throwIfAborted } from "./abort.js";
import { decodeTextChunks, sourceValues, type ChunkSource } from "./transports/framing.js";
import { parseNDJSON } from "./transports/ndjson.js";
import { parseSSE } from "./transports/sse.js";

export const streamTransportSchema = z.enum(["auto", "text", "sse", "ndjson"]);
export type StreamTransport = z.infer<typeof streamTransportSchema>;

export const normalizeStreamOptionsSchema = z.object({
  transport: streamTransportSchema.default("auto"),
  protocol: protocolHintSchema.default("auto"),
  /** Maximum bytes of one SSE/NDJSON line; defaults to the parser limit. */
  maxLineLength: z.number().int().positive().optional(),
  /** Maximum size of one SSE event's combined data; SSE only. */
  maxEventLength: z.number().int().positive().optional(),
  signal: abortSignalSchema.optional(),
});

interface TransportLimits {
  maxLineLength?: number;
  maxEventLength?: number;
}

function transportLimits(options: z.output<typeof normalizeStreamOptionsSchema>): TransportLimits {
  const limits: TransportLimits = {};
  if (options.maxLineLength !== undefined) limits.maxLineLength = options.maxLineLength;
  if (options.maxEventLength !== undefined) limits.maxEventLength = options.maxEventLength;
  return limits;
}

export type NormalizeStreamOptions = z.input<typeof normalizeStreamOptionsSchema>;

export type AIStreamSource =
  | Response
  | string
  | Uint8Array
  | ReadableStream<unknown>
  | AsyncIterable<unknown>
  | Iterable<unknown>;

export const aiStreamSourceSchema = z.custom<AIStreamSource>((value) => {
  if (typeof value === "string" || value instanceof Uint8Array || isResponse(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  if ("getReader" in value && typeof value.getReader === "function") return true;
  return (
    (Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function") ||
    (Symbol.iterator in value && typeof value[Symbol.iterator] === "function")
  );
});

function isResponse(value: unknown): value is Response {
  if (typeof value !== "object" || value === null) return false;
  if (!("headers" in value) || !("body" in value)) return false;
  const headers = value.headers;
  const body = value.body;
  const validBody =
    body === null ||
    (typeof body === "object" &&
      body !== null &&
      "getReader" in body &&
      typeof body.getReader === "function");
  return (
    typeof headers === "object" &&
    headers !== null &&
    "get" in headers &&
    typeof headers.get === "function" &&
    validBody
  );
}

function isByteChunk(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function resolveResponseTransport(
  contentType: string,
  requested: StreamTransport,
): Exclude<StreamTransport, "auto"> {
  if (requested !== "auto") return requested;

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "text/event-stream") return "sse";
  if (
    mediaType === "application/x-ndjson" ||
    mediaType === "application/ndjson" ||
    mediaType === "application/jsonl"
  ) {
    return "ndjson";
  }
  if (mediaType === "text/plain" || mediaType === "text/markdown") return "text";
  throw new TypeError(`Cannot infer stream transport from Content-Type "${contentType || "(missing)"}"`);
}

function makePlainTextPart(text: string): NormalizedPart {
  return normalizedPartSchema.parse({
    kind: "text-delta",
    protocol: "plain-text",
    channel: "output",
    text,
    raw: text,
  });
}

function attachEventName(value: unknown, eventName: string | undefined): unknown {
  if (eventName === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string") return value;
  return { ...record, type: eventName };
}

async function* decodeTransport(
  source: ChunkSource,
  transport: Exclude<StreamTransport, "auto">,
  protocol: ProtocolHint,
  limits: TransportLimits,
): AsyncGenerator<NormalizedPart> {
  if (transport === "text") {
    if (protocol !== "auto" && protocol !== "plain-text") {
      throw new TypeError(
        `Protocol hint "${protocol}" cannot be applied to a plain text stream; ` +
          "use SSE or NDJSON transport for protocol events",
      );
    }
    for await (const text of decodeTextChunks(source)) {
      if (text.length > 0) yield makePlainTextPart(text);
    }
    return;
  }

  if (transport === "ndjson") {
    for await (const event of parseNDJSON(source, limits)) {
      yield* normalizeResponseEvent(event, protocol);
    }
    return;
  }

  for await (const frame of parseSSE(source, limits)) {
    if (frame.data.trim() === "[DONE]") return;
    // Comment-only or empty data frames are spec-legal keep-alives.
    if (frame.data.trim().length === 0) continue;
    if (protocol === "plain-text") {
      yield makePlainTextPart(frame.data);
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(frame.data) as unknown;
    } catch {
      throw new SyntaxError(`Invalid JSON in SSE event "${frame.event ?? "(unnamed)"}"`);
    }
    const annotated = attachEventName(payload, frame.event);
    if (annotated === payload) {
      yield* normalizeResponseEvent(payload, protocol);
      continue;
    }
    // The event name was attached for detection only; keep `raw` faithful
    // to the provider payload.
    for (const part of normalizeResponseEvent(annotated, protocol)) {
      yield { ...part, raw: payload };
    }
  }
}

async function* replayFirst(
  first: unknown,
  iterator: AsyncIterator<unknown>,
): AsyncGenerator<unknown> {
  let complete = false;
  try {
    yield first;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        complete = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!complete) await iterator.return?.();
  }
}

/**
 * Reads common AI stream transports and normalizes each complete event.
 * A Response is framed from its Content-Type; bare byte streams need an explicit transport.
 */
export async function* normalizeAIStream(
  inputSource: AIStreamSource,
  inputOptions: NormalizeStreamOptions = {},
): AsyncGenerator<NormalizedPart> {
  const options = normalizeStreamOptionsSchema.parse(inputOptions);
  const source = aiStreamSourceSchema.parse(inputSource);
  throwIfAborted(options.signal);

  const limits = transportLimits(options);

  if (isResponse(source)) {
    if (source.body === null) return;
    const transport = resolveResponseTransport(
      source.headers.get("content-type") ?? "",
      options.transport,
    );
    yield* decodeTransport(
      sourceValues(source.body, options.signal),
      transport,
      options.protocol,
      limits,
    );
    return;
  }

  if (typeof source === "string") {
    if (options.transport === "auto" || options.transport === "text") {
      yield* decodeTransport(
        sourceValues(source, options.signal),
        "text",
        options.protocol,
        limits,
      );
      return;
    }
    if (options.transport === "sse" || options.transport === "ndjson") {
      yield* decodeTransport(
        sourceValues(source, options.signal),
        options.transport,
        options.protocol,
        limits,
      );
    }
    return;
  }

  if (isByteChunk(source)) {
    if (options.transport === "auto") {
      throw new TypeError("Specify transport for a byte stream without Response headers");
    }
    yield* decodeTransport(
      sourceValues(source, options.signal),
      options.transport,
      options.protocol,
      limits,
    );
    return;
  }

  const iterator = sourceValues(source, options.signal)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;

  const firstValue = first.value;
  if (typeof firstValue === "string" || isByteChunk(firstValue)) {
    let transport: Exclude<StreamTransport, "auto">;
    if (options.transport === "auto") {
      if (isByteChunk(firstValue)) {
        await iterator.return?.(undefined);
        throw new TypeError("Specify transport for a byte stream without Response headers");
      }
      transport = "text";
    } else {
      transport = options.transport;
    }
    yield* decodeTransport(
      replayFirst(firstValue, iterator),
      transport,
      options.protocol,
      limits,
    );
    return;
  }

  if (options.transport !== "auto") {
    await iterator.return?.(undefined);
    throw new TypeError("Explicit text/SSE/NDJSON transport requires string or Uint8Array chunks");
  }

  for await (const event of replayFirst(firstValue, iterator)) {
    yield* normalizeResponseEvent(event, options.protocol);
  }
}

/** Useful when a caller wants to inspect a single event before choosing an adapter. */
export function identifyResponseProtocol(value: unknown): ResponseProtocol {
  return detectResponseProtocol(value);
}
