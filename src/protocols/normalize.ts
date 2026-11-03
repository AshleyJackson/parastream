import { z } from "zod";

export const responseProtocolSchema = z.enum([
  "plain-text",
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate-content",
  "ollama-chat",
  "ollama-generate",
  "cohere-chat-v2",
  "aws-bedrock-converse",
  "ai-sdk",
  "unknown",
]);

export type ResponseProtocol = z.infer<typeof responseProtocolSchema>;
export const protocolHintSchema = z.union([
  z.literal("auto"),
  responseProtocolSchema.exclude(["unknown"]),
]);
export type ProtocolHint = z.infer<typeof protocolHintSchema>;

const textChannelSchema = z.enum(["output", "reasoning", "refusal"]);
const normalizedBaseSchema = z.object({
  protocol: responseProtocolSchema,
  raw: z.unknown(),
});

export const normalizedPartSchema = z.discriminatedUnion("kind", [
  normalizedBaseSchema.extend({
    kind: z.literal("text-delta"),
    channel: textChannelSchema,
    text: z.string(),
    blockId: z.union([z.string(), z.number()]).optional(),
  }),
  normalizedBaseSchema.extend({
    kind: z.literal("tool-input-delta"),
    text: z.string(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
  }),
  normalizedBaseSchema.extend({
    kind: z.literal("tool-call"),
  }),
  normalizedBaseSchema.extend({
    kind: z.literal("control"),
    eventType: z.string().optional(),
  }),
  normalizedBaseSchema.extend({
    kind: z.literal("unknown"),
  }),
]);

export type NormalizedPart = z.infer<typeof normalizedPartSchema>;

const recordSchema = z.record(z.string(), z.unknown());
type JsonRecord = z.infer<typeof recordSchema>;

const knownOpenAIResponseEvents = new Set([
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.reasoning_summary_text.delta",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
]);

const knownAnthropicEvents = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
]);

const knownAiSdkPartTypes = new Set([
  "start",
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-input-error",
  "tool-call",
  "tool-call-delta",
  "tool-call-streaming-start",
  "tool-result",
  "tool-error",
  "tool-output-available",
  "tool-output-error",
  "tool-output-denied",
  "tool-approval-request",
  "tool-approval-response",
  "step-start",
  "start-step",
  "finish-step",
  "finish",
  "abort",
  "message-metadata",
  "source-url",
  "source-document",
  "reasoning-file",
  "file",
  "custom",
  "error",
  "raw",
]);

function isAiSdkPartType(type: string): boolean {
  return knownAiSdkPartTypes.has(type) || type.startsWith("data-");
}

function isAiSdkToolCallDelta(record: JsonRecord): boolean {
  return (
    stringField(record, "toolCallId") !== undefined ||
    stringField(record, "toolName") !== undefined ||
    stringField(record, "argsTextDelta") !== undefined ||
    stringField(record, "inputTextDelta") !== undefined
  );
}

const knownCohereEventTypes = new Set([
  "message-start",
  "content-start",
  "content-delta",
  "content-end",
  "message-end",
  "citation-start",
  "citation-end",
  "tool-plan-delta",
  "tool-call-start",
  "tool-call-delta",
  "tool-call-end",
]);

function asRecord(value: unknown): JsonRecord | undefined {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function hasTextParts(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  return value.some((part) => {
    const record = asRecord(part);
    return record?.type === "text" && typeof record.text === "string";
  });
}

function isOpenAIChatEvent(record: JsonRecord): boolean {
  const choices = record.choices;
  if (!Array.isArray(choices)) return false;
  if (choices.length === 0) {
    return (
      asRecord(record.usage) !== undefined ||
      typeof record.object === "string" ||
      "prompt_annotations" in record ||
      "prompt_filter_results" in record
    );
  }
  return choices.some((choice) => {
    const item = asRecord(choice);
    return item !== undefined && (asRecord(item.delta) !== undefined || asRecord(item.message) !== undefined);
  });
}

function isGeminiEvent(record: JsonRecord): boolean {
  if (!Array.isArray(record.candidates)) return false;
  return record.candidates.some((candidate) => {
    const candidateRecord = asRecord(candidate);
    const content = asRecord(candidateRecord?.content);
    return content !== undefined && Array.isArray(content.parts);
  });
}

function isOllamaChatEvent(record: JsonRecord): boolean {
  const message = asRecord(record.message);
  return (
    typeof record.done === "boolean" &&
    message !== undefined &&
    typeof message.role === "string" &&
    ("content" in message || "thinking" in message || "tool_calls" in message)
  );
}

function isOllamaGenerateEvent(record: JsonRecord): boolean {
  return typeof record.done === "boolean" && typeof record.response === "string";
}

function isBedrockEvent(record: JsonRecord): boolean {
  return [
    "contentBlockDelta",
    "contentBlockStart",
    "contentBlockStop",
    "messageStart",
    "messageStop",
    "metadata",
    "modelStreamErrorException",
    "serviceUnavailableException",
    "throttlingException",
    "validationException",
  ].some((key) => key in record);
}

/** Detects a protocol family from one complete decoded event, not a model name. */
export function detectResponseProtocol(value: unknown): ResponseProtocol {
  const record = asRecord(value);
  if (record === undefined) return "unknown";

  const type = stringField(record, "type");
  if (type !== undefined && knownOpenAIResponseEvents.has(type)) {
    return "openai-responses";
  }
  if (type !== undefined && knownAnthropicEvents.has(type)) {
    return "anthropic-messages";
  }
  if (
    type === "tool-call-delta" &&
    isAiSdkPartType(type) &&
    isAiSdkToolCallDelta(record)
  ) {
    return "ai-sdk";
  }
  if (type !== undefined && knownCohereEventTypes.has(type)) {
    return "cohere-chat-v2";
  }

  if (isOllamaChatEvent(record)) return "ollama-chat";
  if (isOllamaGenerateEvent(record)) return "ollama-generate";
  if (isBedrockEvent(record)) return "aws-bedrock-converse";
  if (isOpenAIChatEvent(record)) return "openai-chat-completions";
  if (isGeminiEvent(record)) return "gemini-generate-content";

  if (type !== undefined && isAiSdkPartType(type)) {
    return "ai-sdk";
  }

  return "unknown";
}

function matchesProtocolEnvelope(record: JsonRecord, hint: ResponseProtocol): boolean {
  const type = stringField(record, "type");
  if (hint === "openai-chat-completions") {
    return (
      Array.isArray(record.choices) ||
      asRecord(record.usage) !== undefined ||
      "prompt_annotations" in record ||
      "prompt_filter_results" in record
    );
  }
  if (hint === "openai-responses") return type?.startsWith("response.") === true;
  if (hint === "anthropic-messages" || hint === "cohere-chat-v2" || hint === "ai-sdk") {
    return type !== undefined;
  }
  if (hint === "gemini-generate-content") {
    return Array.isArray(record.candidates) || asRecord(record.promptFeedback) !== undefined;
  }
  if (hint === "ollama-chat") return asRecord(record.message) !== undefined;
  if (hint === "ollama-generate") {
    return typeof record.response === "string" && typeof record.done === "boolean";
  }
  if (hint === "aws-bedrock-converse") return isBedrockEvent(record);
  return false;
}

function makeText(
  protocol: ResponseProtocol,
  channel: z.infer<typeof textChannelSchema>,
  text: string,
  raw: unknown,
  blockId?: string | number,
): NormalizedPart {
  return normalizedPartSchema.parse({
    kind: "text-delta",
    protocol,
    channel,
    text,
    raw,
    ...(blockId === undefined ? {} : { blockId }),
  });
}

function makeToolInput(
  protocol: ResponseProtocol,
  text: string,
  raw: unknown,
  toolCallId?: string,
  toolName?: string,
): NormalizedPart {
  return normalizedPartSchema.parse({
    kind: "tool-input-delta",
    protocol,
    text,
    raw,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(toolName === undefined ? {} : { toolName }),
  });
}

function makePart(
  kind: "tool-call" | "control" | "unknown",
  protocol: ResponseProtocol,
  raw: unknown,
  eventType?: string,
): NormalizedPart {
  return normalizedPartSchema.parse({
    kind,
    protocol,
    raw,
    ...(eventType === undefined ? {} : { eventType }),
  });
}

function textContentParts(
  value: unknown,
  protocol: ResponseProtocol,
  raw: unknown,
  blockId?: string | number,
): NormalizedPart[] {
  if (typeof value === "string") {
    return value.length === 0 ? [] : [makeText(protocol, "output", value, raw, blockId)];
  }
  if (!hasTextParts(value)) return [];

  const parts: NormalizedPart[] = [];
  for (const item of value) {
    const part = asRecord(item);
    if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      parts.push(makeText(protocol, "output", part.text, raw, blockId));
    }
  }
  return parts;
}

function normalizeOpenAIChat(record: JsonRecord, raw: unknown): NormalizedPart[] {
  if (!Array.isArray(record.choices)) {
    return [makePart("control", "openai-chat-completions", raw)];
  }

  const output: NormalizedPart[] = [];
  for (const choiceValue of record.choices) {
    const choice = asRecord(choiceValue);
    if (choice === undefined) continue;

    const payload = asRecord(choice.delta) ?? asRecord(choice.message);
    if (payload === undefined) continue;
    const blockId =
      typeof choice.index === "number" || typeof choice.index === "string"
        ? choice.index
        : undefined;

    output.push(...textContentParts(payload.content, "openai-chat-completions", raw, blockId));

    const refusal = stringField(payload, "refusal");
    if (refusal !== undefined && refusal.length > 0) {
      output.push(makeText("openai-chat-completions", "refusal", refusal, raw, blockId));
    }

    const reasoning = stringField(payload, "reasoning_content");
    if (reasoning !== undefined && reasoning.length > 0) {
      output.push(makeText("openai-chat-completions", "reasoning", reasoning, raw, blockId));
    }

    if (Array.isArray(payload.tool_calls)) {
      for (const callValue of payload.tool_calls) {
        const call = asRecord(callValue);
        const fn = asRecord(call?.function);
        const argumentsDelta = stringField(fn ?? {}, "arguments");
        if (argumentsDelta !== undefined && argumentsDelta.length > 0) {
          output.push(
            makeToolInput(
              "openai-chat-completions",
              argumentsDelta,
              raw,
              stringField(call ?? {}, "id"),
              stringField(fn ?? {}, "name"),
            ),
          );
        } else if (call !== undefined) {
          output.push(makePart("tool-call", "openai-chat-completions", raw));
        }
      }
    }
  }

  if (output.length === 0) {
    output.push(makePart("control", "openai-chat-completions", raw));
  }
  return output;
}

function normalizeOpenAIResponses(record: JsonRecord, raw: unknown): NormalizedPart[] {
  const type = stringField(record, "type") ?? "response.event";
  if (!knownOpenAIResponseEvents.has(type)) {
    return [makePart("unknown", "openai-responses", raw, type)];
  }
  if (type === "response.output_item.added") {
    const item = asRecord(record.item);
    if (item?.type === "function_call") {
      return [makePart("tool-call", "openai-responses", raw, type)];
    }
  }
  const delta = stringField(record, "delta");
  if (delta === undefined || delta.length === 0) {
    return [makePart("control", "openai-responses", raw, type)];
  }

  if (type === "response.output_text.delta") {
    return [makeText("openai-responses", "output", delta, raw)];
  }
  if (type === "response.refusal.delta") {
    return [makeText("openai-responses", "refusal", delta, raw)];
  }
  if (type === "response.reasoning_summary_text.delta") {
    return [makeText("openai-responses", "reasoning", delta, raw)];
  }
  if (type === "response.function_call_arguments.delta") {
    return [
      makeToolInput(
        "openai-responses",
        delta,
        raw,
        stringField(record, "item_id"),
        stringField(record, "name"),
      ),
    ];
  }
  return [makePart("control", "openai-responses", raw, type)];
}

function normalizeAnthropic(record: JsonRecord, raw: unknown): NormalizedPart[] {
  const type = stringField(record, "type") ?? "anthropic.event";
  if (type === "content_block_start") {
    const block = asRecord(record.content_block);
    return [
      makePart(
        block?.type === "tool_use" ? "tool-call" : "control",
        "anthropic-messages",
        raw,
        type,
      ),
    ];
  }
  if (type !== "content_block_delta") {
    return knownAnthropicEvents.has(type)
      ? [makePart("control", "anthropic-messages", raw, type)]
      : [makePart("unknown", "anthropic-messages", raw, type)];
  }

  const delta = asRecord(record.delta);
  if (delta === undefined) return [makePart("control", "anthropic-messages", raw, type)];
  const deltaType = stringField(delta, "type");
  const index = typeof record.index === "number" ? record.index : undefined;

  if (deltaType === "text_delta") {
    const text = stringField(delta, "text");
    return text === undefined || text.length === 0
      ? [makePart("control", "anthropic-messages", raw, deltaType)]
      : [makeText("anthropic-messages", "output", text, raw, index)];
  }
  if (deltaType === "thinking_delta") {
    const text = stringField(delta, "thinking");
    return text === undefined || text.length === 0
      ? [makePart("control", "anthropic-messages", raw, deltaType)]
      : [makeText("anthropic-messages", "reasoning", text, raw, index)];
  }
  if (deltaType === "input_json_delta") {
    const text = stringField(delta, "partial_json");
    return text === undefined || text.length === 0
      ? [makePart("control", "anthropic-messages", raw, deltaType)]
      : [makeToolInput("anthropic-messages", text, raw)];
  }
  return [makePart("control", "anthropic-messages", raw, deltaType ?? type)];
}

function normalizeGemini(record: JsonRecord, raw: unknown): NormalizedPart[] {
  if (!Array.isArray(record.candidates)) {
    return [makePart("control", "gemini-generate-content", raw)];
  }

  const output: NormalizedPart[] = [];
  for (const candidateValue of record.candidates) {
    const candidate = asRecord(candidateValue);
    if (candidate === undefined) continue;
    const content = asRecord(candidate.content);
    const blockId = typeof candidate.index === "number" ? candidate.index : undefined;
    if (content !== undefined && Array.isArray(content.parts)) {
      for (const partValue of content.parts) {
        const part = asRecord(partValue);
        if (part === undefined) continue;
        const text = stringField(part, "text");
        if (text !== undefined && text.length > 0) {
          output.push(
            makeText(
              "gemini-generate-content",
              part.thought === true ? "reasoning" : "output",
              text,
              raw,
              blockId,
            ),
          );
        } else if ("functionCall" in part || "function_call" in part) {
          output.push(makePart("tool-call", "gemini-generate-content", raw));
        } else {
          output.push(makePart("control", "gemini-generate-content", raw));
        }
      }
    }
    if (stringField(candidate, "finishReason") !== undefined) {
      output.push(makePart("control", "gemini-generate-content", raw, "finish"));
    }
  }

  if (record.usageMetadata !== undefined) {
    output.push(makePart("control", "gemini-generate-content", raw, "usage"));
  }

  if (output.length === 0) {
    output.push(makePart("control", "gemini-generate-content", raw));
  }
  return output;
}

function normalizeOllamaChat(record: JsonRecord, raw: unknown): NormalizedPart[] {
  const message = asRecord(record.message);
  if (message === undefined) return [makePart("unknown", "ollama-chat", raw)];

  const output: NormalizedPart[] = [];
  const content = stringField(message, "content");
  if (content !== undefined && content.length > 0) {
    output.push(makeText("ollama-chat", "output", content, raw));
  }
  const thinking = stringField(message, "thinking");
  if (thinking !== undefined && thinking.length > 0) {
    output.push(makeText("ollama-chat", "reasoning", thinking, raw));
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    output.push(makePart("tool-call", "ollama-chat", raw));
  }
  if (output.length === 0) output.push(makePart("control", "ollama-chat", raw));
  return output;
}

function normalizeAiSdk(record: JsonRecord, raw: unknown): NormalizedPart[] {
  const type = stringField(record, "type") ?? "ai-sdk.part";
  const id = stringField(record, "id");
  const text = stringField(record, "text") ?? stringField(record, "delta");

  if (type === "text-delta" && text !== undefined && text.length > 0) {
    return [makeText("ai-sdk", "output", text, raw, id)];
  }
  if (type === "reasoning-delta" && text !== undefined && text.length > 0) {
    return [makeText("ai-sdk", "reasoning", text, raw, id)];
  }
  if (type === "refusal-delta" && text !== undefined && text.length > 0) {
    return [makeText("ai-sdk", "refusal", text, raw, id)];
  }
  if (type === "tool-input-delta" || type === "tool-call-delta") {
    const inputDelta =
      stringField(record, "inputTextDelta") ??
      stringField(record, "argsTextDelta") ??
      stringField(record, "delta");
    if (inputDelta !== undefined && inputDelta.length > 0) {
      return [
        makeToolInput(
          "ai-sdk",
          inputDelta,
          raw,
          stringField(record, "toolCallId"),
          stringField(record, "toolName"),
        ),
      ];
    }
  }

  if (
    type === "tool-call" ||
    type === "tool-input-start" ||
    type === "tool-input-available" ||
    type === "tool-call-streaming-start"
  ) {
    return [makePart("tool-call", "ai-sdk", raw, type)];
  }

  return isAiSdkPartType(type)
    ? [makePart("control", "ai-sdk", raw, type)]
    : [makePart("unknown", "ai-sdk", raw, type)];
}

function normalizeCohere(record: JsonRecord, raw: unknown): NormalizedPart[] {
  const type = stringField(record, "type") ?? "cohere.event";
  const delta = asRecord(record.delta);
  const message = asRecord(delta?.message);

  if (type === "content-delta") {
    const content = asRecord(message?.content);
    const text = stringField(content ?? {}, "text");
    return text === undefined || text.length === 0
      ? [makePart("control", "cohere-chat-v2", raw, type)]
      : [
          makeText(
            "cohere-chat-v2",
            "output",
            text,
            raw,
            typeof record.index === "number" ? record.index : undefined,
          ),
        ];
  }

  if (type === "tool-call-delta") {
    const toolCalls = asRecord(message?.tool_calls);
    const fn = asRecord(toolCalls?.function);
    const args = stringField(fn ?? {}, "arguments");
    return args === undefined || args.length === 0
      ? [makePart("control", "cohere-chat-v2", raw, type)]
      : [makeToolInput("cohere-chat-v2", args, raw)];
  }

  if (knownCohereEventTypes.has(type)) {
    return [
      makePart(
        type === "tool-call-start" ? "tool-call" : "control",
        "cohere-chat-v2",
        raw,
        type,
      ),
    ];
  }
  return [makePart("unknown", "cohere-chat-v2", raw, type)];
}

function normalizeBedrock(record: JsonRecord, raw: unknown): NormalizedPart[] {
  const startEvent = asRecord(record.contentBlockStart);
  const start = asRecord(startEvent?.start);
  if (asRecord(start?.toolUse) !== undefined) {
    return [makePart("tool-call", "aws-bedrock-converse", raw, "contentBlockStart")];
  }

  const event = asRecord(record.contentBlockDelta);
  if (event === undefined) {
    const known = isBedrockEvent(record);
    return [
      makePart(
        known ? "control" : "unknown",
        "aws-bedrock-converse",
        raw,
      ),
    ];
  }

  const delta = asRecord(event.delta);
  const index = typeof event.contentBlockIndex === "number" ? event.contentBlockIndex : undefined;
  if (delta === undefined) {
    return [makePart("control", "aws-bedrock-converse", raw, "contentBlockDelta")];
  }

  const text = stringField(delta, "text");
  if (text !== undefined && text.length > 0) {
    return [makeText("aws-bedrock-converse", "output", text, raw, index)];
  }

  const toolUse = asRecord(delta.toolUse);
  const input = stringField(toolUse ?? {}, "input");
  if (input !== undefined && input.length > 0) {
    return [makeToolInput("aws-bedrock-converse", input, raw)];
  }

  const reasoningContent = asRecord(delta.reasoningContent);
  const reasoningText = asRecord(reasoningContent?.reasoningText);
  const reasoning = stringField(reasoningText ?? {}, "text");
  if (reasoning !== undefined && reasoning.length > 0) {
    return [makeText("aws-bedrock-converse", "reasoning", reasoning, raw, index)];
  }

  return [makePart("control", "aws-bedrock-converse", raw, "contentBlockDelta")];
}

/**
 * Converts a parsed provider event or SDK part into typed, ordered parts.
 * Unknown shapes are returned as `unknown`; they are never searched recursively for text.
 */
export function normalizeResponseEvent(
  value: unknown,
  inputHint: ProtocolHint = "auto",
): NormalizedPart[] {
  const hint = protocolHintSchema.parse(inputHint);
  const record = asRecord(value);
  if (record === undefined) {
    return [makePart("unknown", "unknown", value)];
  }

  const detected = detectResponseProtocol(record);
  if (hint !== "auto" && detected !== "unknown" && hint !== detected) {
    throw new TypeError(`Protocol hint "${hint}" conflicts with detected protocol "${detected}"`);
  }
  if (
    hint !== "auto" &&
    detected === "unknown" &&
    !matchesProtocolEnvelope(record, hint)
  ) {
    throw new TypeError(`Payload does not match protocol hint "${hint}"`);
  }
  const protocol = hint === "auto" ? detected : hint;

  if (protocol === "openai-chat-completions") return normalizeOpenAIChat(record, value);
  if (protocol === "openai-responses") return normalizeOpenAIResponses(record, value);
  if (protocol === "anthropic-messages") return normalizeAnthropic(record, value);
  if (protocol === "gemini-generate-content") return normalizeGemini(record, value);
  if (protocol === "ollama-chat") return normalizeOllamaChat(record, value);
  if (protocol === "ollama-generate") {
    const response = stringField(record, "response");
    return response === undefined || response.length === 0
      ? [makePart("control", protocol, value)]
      : [makeText(protocol, "output", response, value)];
  }
  if (protocol === "cohere-chat-v2") return normalizeCohere(record, value);
  if (protocol === "aws-bedrock-converse") return normalizeBedrock(record, value);
  if (protocol === "ai-sdk") return normalizeAiSdk(record, value);
  return [makePart("unknown", protocol, value)];
}
