import { z } from "zod";
import type { NormalizedPart, ResponseProtocol } from "../protocols/normalize.js";

type TextPart = Extract<NormalizedPart, { kind: "text-delta" }>;
type ToolPart = Extract<NormalizedPart, { kind: "tool-call" | "tool-input-delta" }>;
export type AssemblerChannel = TextPart["channel"];

export const messageAssemblerOptionsSchema = z.object({
  channels: z.array(z.enum(["output", "reasoning", "refusal"])).default(["output", "reasoning", "refusal"]),
  toolInput: z.enum(["json", "text", "off"]).default("json"),
  /** Total retained text across all channels, in UTF-16 code units. */
  maxTextChars: z.number().int().nonnegative().default(2_000_000),
  /** Total retained serialized tool input, in UTF-16 code units. */
  maxToolInputChars: z.number().int().nonnegative().default(200_000),
  maxEntries: z.number().int().positive().default(10_000),
  onOverflow: z.enum(["throw", "truncate-marked"]).default("throw"),
});
export type MessageAssemblerOptions = z.input<typeof messageAssemblerOptionsSchema>;

export interface AssembledTextBlock {
  protocol: ResponseProtocol;
  channel: AssemblerChannel;
  blockId?: string | number;
  text: string;
  truncated: boolean;
}

export interface AssembledToolCall {
  protocol: ResponseProtocol;
  toolCallId?: string;
  toolName?: string;
  blockId?: string | number;
  inputText: string;
  input?: unknown;
  status: "pending" | "complete" | "invalid-json" | "incomplete" | "truncated";
}

export interface MessageState {
  text: string;
  reasoning: string;
  refusal: string;
  textBlocks: AssembledTextBlock[];
  toolCalls: AssembledToolCall[];
  truncated: boolean;
}

export type AssemblerEvent =
  | { type: "text"; channel: AssemblerChannel; text: string; blockId?: string | number }
  | { type: "tool-input"; text: string; toolCall: AssembledToolCall }
  | { type: "tool-call"; toolCall: AssembledToolCall }
  | { type: "tool-call-complete"; toolCall: AssembledToolCall }
  | { type: "tool-input-error"; toolCall: AssembledToolCall; reason: "invalid-json" | "incomplete" | "truncated" }
  | { type: "reset"; state: MessageState }
  | { type: "control"; part: Extract<NormalizedPart, { kind: "control" | "unknown" }> };

export interface MessageAssembler {
  readonly state: MessageState;
  push(part: NormalizedPart): AssemblerEvent[];
  finish(): AssemblerEvent[];
  cancel(): void;
}

function emptyState(): MessageState {
  return { text: "", reasoning: "", refusal: "", textBlocks: [], toolCalls: [], truncated: false };
}

function copyTool(call: AssembledToolCall): AssembledToolCall {
  return { ...call, ...(call.input === undefined ? {} : { input: structuredClone(call.input) }) };
}

function copyState(state: MessageState): MessageState {
  return { ...state, textBlocks: state.textBlocks.map((block) => ({ ...block })), toolCalls: state.toolCalls.map(copyTool) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Stateful, synchronous reducer; it never reads or owns the upstream stream. */
export function createMessageAssembler(inputOptions: MessageAssemblerOptions = {}): MessageAssembler {
  const options = messageAssemblerOptionsSchema.parse(inputOptions);
  let state = emptyState();
  let checkpoint: MessageState | undefined;
  let ended = new WeakSet<AssembledToolCall>();
  let checkpointEnded: number[] = [];
  let aiStepStart = 0;
  let checkpointStepStart = 0;
  let closed = false;

  function ensureOpen(): void {
    if (closed) throw new Error("Message assembler is closed");
  }

  function ensureEntry(): void {
    if (state.textBlocks.length + state.toolCalls.length >= options.maxEntries) {
      throw new RangeError("Message assembler maxEntries exceeded");
    }
  }

  function fit(text: string, used: number, limit: number, label: string): { text: string; truncated: boolean } {
    if (text.length <= limit - used) return { text, truncated: false };
    if (options.onOverflow === "throw") throw new RangeError(`Message assembler ${label} exceeded`);
    return { text: text.slice(0, Math.max(0, limit - used)), truncated: true };
  }

  function findTool(part: ToolPart): AssembledToolCall | undefined {
    const calls = part.protocol === "ai-sdk" ? state.toolCalls.slice(aiStepStart) : state.toolCalls;
    // Some providers use different call IDs for the start and deltas. Their block index links them.
    if (part.blockId !== undefined) {
      const byBlock = calls.find((call) => call.protocol === part.protocol && call.blockId === part.blockId);
      if (byBlock !== undefined) return byBlock;
    }
    if (part.toolCallId !== undefined) {
      return calls.find((call) => call.protocol === part.protocol && call.toolCallId === part.toolCallId);
    }
    return calls.find((call) => call.protocol === part.protocol && call.blockId === undefined && call.toolCallId === undefined && call.status === "pending");
  }

  function getTool(part: ToolPart): AssembledToolCall {
    // Complete calls without distinct IDs (e.g. Ollama) can occur multiple times in one event.
    let call = part.kind === "tool-call" && part.input !== undefined &&
      (part.protocol === "gemini-generate-content" || part.protocol === "ollama-chat")
      ? undefined : findTool(part);
    if (call === undefined) {
      ensureEntry();
      call = { protocol: part.protocol, inputText: "", status: "pending",
        ...(part.blockId === undefined ? {} : { blockId: part.blockId }),
        ...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }),
        ...(part.toolName === undefined ? {} : { toolName: part.toolName }) };
      state.toolCalls.push(call);
    } else {
      if (call.toolCallId === undefined && part.toolCallId !== undefined) call.toolCallId = part.toolCallId;
      if (call.toolName === undefined && part.toolName !== undefined) call.toolName = part.toolName;
      if (call.blockId === undefined && part.blockId !== undefined) call.blockId = part.blockId;
    }
    return call;
  }

  function appendInput(call: AssembledToolCall, text: string): string {
    if (options.toolInput === "off") return "";
    const used = state.toolCalls.reduce((sum, item) => sum + item.inputText.length, 0);
    const result = fit(text, used, options.maxToolInputChars, "maxToolInputChars");
    call.inputText += result.text;
    if (result.truncated) { call.status = "truncated"; state.truncated = true; }
    return result.text;
  }

  function complete(call: AssembledToolCall): AssemblerEvent[] {
    if (ended.has(call)) return [];
    if (call.status !== "pending" && call.status !== "truncated") return [];
    ended.add(call);
    if (call.status === "truncated") return [{ type: "tool-input-error", toolCall: copyTool(call), reason: "truncated" }];
    if (options.toolInput === "json") {
      try { call.input = JSON.parse(call.inputText) as unknown; }
      catch {
        call.status = "invalid-json";
        return [{ type: "tool-input-error", toolCall: copyTool(call), reason: "invalid-json" }];
      }
    }
    call.status = "complete";
    return [{ type: "tool-call-complete", toolCall: copyTool(call) }];
  }

  function completeMatching(protocol: ResponseProtocol, blockId?: string | number, toolCallId?: string): AssemblerEvent[] {
    const calls = protocol === "ai-sdk" ? state.toolCalls.slice(aiStepStart) : state.toolCalls;
    return calls.filter((call) => call.protocol === protocol &&
      (blockId === undefined || call.blockId === blockId) &&
      (toolCallId === undefined || call.toolCallId === toolCallId)).flatMap(complete);
  }

  function controlCompletions(part: Extract<NormalizedPart, { kind: "control" }>): AssemblerEvent[] {
    const raw = record(part.raw);
    if (part.protocol === "ai-sdk" && part.eventType === "tool-input-end") {
      return typeof raw?.toolCallId === "string" ? completeMatching(part.protocol, undefined, raw.toolCallId) : [];
    }
    if (part.protocol === "openai-responses" && part.eventType === "response.function_call_arguments.done") {
      if (typeof raw?.output_index !== "number") return [];
      const call = state.toolCalls.find((item) => item.protocol === part.protocol && item.blockId === raw.output_index);
      if (call !== undefined && call.status === "pending" && call.inputText.length === 0 && typeof raw.arguments === "string") {
        appendInput(call, raw.arguments);
      }
      return completeMatching(part.protocol, raw.output_index);
    }
    if ((part.protocol === "anthropic-messages" && part.eventType === "content_block_stop") ||
        (part.protocol === "cohere-chat-v2" && part.eventType === "tool-call-end")) {
      return typeof raw?.index === "number" ? completeMatching(part.protocol, raw.index) : [];
    }
    if (part.protocol === "aws-bedrock-converse") {
      const stop = record(raw?.contentBlockStop);
      return typeof stop?.contentBlockIndex === "number" ? completeMatching(part.protocol, stop.contentBlockIndex) : [];
    }
    if (part.protocol === "openai-chat-completions" && Array.isArray(raw?.choices) &&
        raw.choices.some((choice: unknown) => record(choice)?.finish_reason === "tool_calls")) {
      return completeMatching(part.protocol);
    }
    return [];
  }

  function push(part: NormalizedPart): AssemblerEvent[] {
    ensureOpen();
    if (part.kind === "text-delta") {
      if (!options.channels.includes(part.channel)) return [];
      const used = state.text.length + state.reasoning.length + state.refusal.length;
      const result = fit(part.text, used, options.maxTextChars, "maxTextChars");
      let block = state.textBlocks.find((item) => item.protocol === part.protocol && item.channel === part.channel && item.blockId === part.blockId);
      if (block === undefined) {
        ensureEntry();
        block = { protocol: part.protocol, channel: part.channel, text: "", truncated: false,
          ...(part.blockId === undefined ? {} : { blockId: part.blockId }) };
        state.textBlocks.push(block);
      }
      block.text += result.text;
      block.truncated ||= result.truncated;
      state.truncated ||= result.truncated;
      const key = part.channel === "output" ? "text" : part.channel;
      state[key] += result.text;
      return result.text.length === 0 ? [] : [{ type: "text", channel: part.channel, text: result.text,
        ...(part.blockId === undefined ? {} : { blockId: part.blockId }) }];
    }
    if (part.kind === "tool-call" || part.kind === "tool-input-delta") {
      const call = getTool(part);
      if (part.kind === "tool-input-delta") {
        if (ended.has(call) || (call.status !== "pending" && call.status !== "truncated")) return [];
        const text = appendInput(call, part.text);
        return text ? [{ type: "tool-input", text, toolCall: copyTool(call) }] : [];
      }
      const events: AssemblerEvent[] = [{ type: "tool-call", toolCall: copyTool(call) }];
      if (part.input !== undefined && call.status === "pending") {
        if (options.toolInput !== "off") {
          const serialized = JSON.stringify(part.input);
          if (serialized === undefined) throw new TypeError("Tool input is not JSON serializable");
          const used = state.toolCalls.reduce((sum, item) => sum + (item === call ? 0 : item.inputText.length), 0);
          const result = fit(serialized, used, options.maxToolInputChars, "maxToolInputChars");
          call.inputText = result.text;
          if (result.truncated) { call.status = "truncated"; state.truncated = true; }
        }
        events.push(...complete(call));
      } else if (part.input !== undefined && call.status === "truncated") {
        events.push(...complete(call));
      }
      return events;
    }
    if (part.kind === "control" && part.protocol === "ai-sdk") {
      if (part.eventType === "start-step" || part.eventType === "step-start") {
        checkpoint = copyState(state);
        checkpointEnded = state.toolCalls.flatMap((call, index) => ended.has(call) ? [index] : []);
        checkpointStepStart = aiStepStart;
        aiStepStart = state.toolCalls.length;
      }
      if (part.eventType === "reset-step") {
        if (checkpoint !== undefined) {
          state = copyState(checkpoint);
          ended = new WeakSet(checkpointEnded.flatMap((index) => state.toolCalls[index] ? [state.toolCalls[index]] : []));
          aiStepStart = checkpointStepStart;
        }
        checkpoint = undefined;
        return [{ type: "reset", state: copyState(state) }, { type: "control", part }];
      }
      if (part.eventType === "finish-step") checkpoint = undefined;
    }
    return part.kind === "control" ? [...controlCompletions(part), { type: "control", part }] : [{ type: "control", part }];
  }

  function finish(): AssemblerEvent[] {
    ensureOpen();
    closed = true;
    return state.toolCalls.flatMap((call): AssemblerEvent[] => {
      if (ended.has(call)) return [];
      if (call.status === "truncated") return [{ type: "tool-input-error", toolCall: copyTool(call), reason: "truncated" }];
      if (call.status !== "pending") return [];
      call.status = "incomplete";
      return [{ type: "tool-input-error", toolCall: copyTool(call), reason: "incomplete" }];
    });
  }

  return { get state() { return copyState(state); }, push, finish, cancel() { closed = true; } };
}
