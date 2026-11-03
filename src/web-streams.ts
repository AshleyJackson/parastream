import { z } from "zod";
import {
  normalizeAIStream,
  normalizeStreamOptionsSchema,
  type AIStreamSource,
  type NormalizeStreamOptions,
} from "./normalize-stream.js";
import {
  normalizedPartSchema,
  type NormalizedPart,
} from "./protocols/normalize.js";
import {
  createTextSegmenter,
  segmentOptionsSchema,
  type ParaChunk,
  type SegmentOptions,
} from "./core/segment.js";

const textChannelSchema = z.enum(["output", "reasoning", "refusal"]);
export type TextChannel = z.infer<typeof textChannelSchema>;

export const textSelectionOptionsSchema = z.object({
  channel: textChannelSchema.default("output"),
});
export type TextSelectionOptions = z.input<typeof textSelectionOptionsSchema>;

export const partFilterOptionsSchema = z.object({
  textChannels: z.array(textChannelSchema).optional(),
});
export type PartFilterOptions = z.input<typeof partFilterOptionsSchema>;

/**
 * Adapts normalized parts to a Web ReadableStream.
 *
 * Each pull reads at most one normalized part. Cancellation aborts the
 * underlying iterator, which releases a locked Response body or source stream.
 */
export function normalizeAIReadableStream(
  inputSource: AIStreamSource,
  inputOptions: NormalizeStreamOptions = {},
): ReadableStream<NormalizedPart> {
  const options = normalizeStreamOptionsSchema.parse(inputOptions);
  const abortController = new AbortController();
  const userSignal = options.signal;
  const abortFromUser = (): void => {
    abortController.abort(userSignal?.reason);
  };

  if (userSignal?.aborted) {
    abortFromUser();
  } else {
    userSignal?.addEventListener("abort", abortFromUser, { once: true });
  }

  const iterator = normalizeAIStream(inputSource, {
    transport: options.transport,
    protocol: options.protocol,
    signal: abortController.signal,
  })[Symbol.asyncIterator]();
  let complete = false;

  const cleanup = (): void => {
    userSignal?.removeEventListener("abort", abortFromUser);
  };
  const cancel = async (reason?: unknown): Promise<void> => {
    if (complete) return;
    complete = true;
    abortController.abort(reason);
    cleanup();
    await iterator.return?.(undefined);
  };

  return new ReadableStream<NormalizedPart>(
    {
      async pull(controller): Promise<void> {
        if (complete) return;
        try {
          const next = await iterator.next();
          if (complete) return;
          if (next.done) {
            complete = true;
            cleanup();
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          if (complete) return;
          complete = true;
          cleanup();
          controller.error(error);
        }
      },
      cancel,
    },
    { highWaterMark: 1 },
  );
}

/**
 * Projects one normalized text channel into strings.
 *
 * This intentionally drops all non-text parts. Use partFilterTransform() when
 * a pipeline must retain tool, control, reasoning, refusal, or unknown parts.
 */
export function selectTextTransform(
  inputOptions: TextSelectionOptions = {},
): TransformStream<NormalizedPart, string> {
  const { channel } = textSelectionOptionsSchema.parse(inputOptions);
  return new TransformStream<NormalizedPart, string>({
    transform(part, controller): void {
      const normalized = normalizedPartSchema.parse(part);
      if (normalized.kind === "text-delta" && normalized.channel === channel) {
        controller.enqueue(normalized.text);
      }
    },
  });
}

/**
 * Filters text channels while preserving every non-text normalized part.
 *
 * This is useful when a consumer wants to omit, for example, reasoning text
 * but retain tool input, tool calls, controls, and unknown events.
 */
export function partFilterTransform(
  inputOptions: PartFilterOptions = {},
): TransformStream<NormalizedPart, NormalizedPart> {
  const { textChannels } = partFilterOptionsSchema.parse(inputOptions);
  const selectedChannels = textChannels === undefined ? undefined : new Set(textChannels);

  return new TransformStream<NormalizedPart, NormalizedPart>({
    transform(part, controller): void {
      const normalized = normalizedPartSchema.parse(part);
      if (
        normalized.kind === "text-delta" &&
        selectedChannels !== undefined &&
        !selectedChannels.has(normalized.channel)
      ) {
        return;
      }
      controller.enqueue(normalized);
    },
  });
}

/**
 * Segments a stream of text chunks without flattening it into one string.
 * The final residual is emitted from flush() with isFinal set to true.
 */
export function segmentTextTransform(
  inputOptions: SegmentOptions = {},
): TransformStream<string, ParaChunk> {
  segmentOptionsSchema.parse(inputOptions);
  const segmenter = createTextSegmenter(inputOptions);

  return new TransformStream<string, ParaChunk>({
    transform(text, controller): void {
      for (const chunk of segmenter.push(text)) {
        controller.enqueue(chunk);
      }
    },
    flush(controller): void {
      const finalChunk = segmenter.finish();
      if (finalChunk !== undefined) controller.enqueue(finalChunk);
    },
  });
}
