import { describe, expect, test } from "bun:test";
import {
  detectResponseProtocol,
  normalizeResponseEvent,
} from "../src/index.js";

describe("AI response protocol detection", () => {
  test("recognizes OpenAI Chat Completions-compatible chunks", () => {
    const event = {
      choices: [{ index: 0, delta: { content: "hello" } }],
    };
    expect(detectResponseProtocol(event)).toBe("openai-chat-completions");
    expect(normalizeResponseEvent(event)).toMatchObject([
      { kind: "text-delta", channel: "output", text: "hello" },
    ]);
  });

  test("keeps tool argument deltas separate from text", () => {
    const event = {
      choices: [
        {
          delta: {
            content: "Calling tool.",
            tool_calls: [
              {
                id: "call-1",
                function: { name: "lookup", arguments: "{\"q\":" },
              },
            ],
          },
        },
      ],
    };
    expect(normalizeResponseEvent(event)).toMatchObject([
      { kind: "text-delta", text: "Calling tool." },
      {
        kind: "tool-input-delta",
        text: "{\"q\":",
        toolCallId: "call-1",
        toolName: "lookup",
      },
    ]);
  });

  test("recognizes OpenAI Responses text and tool-argument events", () => {
    expect(
      normalizeResponseEvent({
        type: "response.output_text.delta",
        delta: "Hello",
      }),
    ).toMatchObject([{ kind: "text-delta", text: "Hello", protocol: "openai-responses" }]);

    expect(
      normalizeResponseEvent({
        type: "response.function_call_arguments.delta",
        item_id: "item-1",
        delta: "{\"city\":",
      }),
    ).toMatchObject([{ kind: "tool-input-delta", text: "{\"city\":" }]);
  });

  test("keeps Anthropic thinking and partial tool JSON distinct", () => {
    expect(
      normalizeResponseEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: "private reasoning" },
      }),
    ).toMatchObject([{ kind: "text-delta", channel: "reasoning", text: "private reasoning" }]);

    expect(
      normalizeResponseEvent({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "{\"x\":" },
      }),
    ).toMatchObject([{ kind: "tool-input-delta", text: "{\"x\":" }]);
  });

  test("extracts Gemini text parts without treating function calls as prose", () => {
    const event = {
      candidates: [
        {
          index: 0,
          content: {
            parts: [
              { text: "A response" },
              { functionCall: { name: "search", id: "fc-1", args: { q: "x" } } },
            ],
          },
        },
      ],
    };
    expect(detectResponseProtocol(event)).toBe("gemini-generate-content");
    expect(normalizeResponseEvent(event)).toMatchObject([
      { kind: "text-delta", text: "A response" },
      { kind: "tool-call", toolName: "search", toolCallId: "fc-1" },
    ]);
  });

  test("recognizes both native Ollama response families", () => {
    expect(
      normalizeResponseEvent({
        done: false,
        message: { role: "assistant", content: "Hi", thinking: "reason" },
      }),
    ).toMatchObject([
      { protocol: "ollama-chat", kind: "text-delta", channel: "output", text: "Hi" },
      { protocol: "ollama-chat", kind: "text-delta", channel: "reasoning", text: "reason" },
    ]);

    expect(
      normalizeResponseEvent({ done: false, response: "Hi" }),
    ).toMatchObject([{ protocol: "ollama-generate", kind: "text-delta", text: "Hi" }]);
  });

  test("normalizes Cohere v2 text and tool-input events", () => {
    expect(
      normalizeResponseEvent({
        type: "content-delta",
        index: 0,
        delta: { message: { content: { text: "Hello" } } },
      }),
    ).toMatchObject([
      { protocol: "cohere-chat-v2", kind: "text-delta", text: "Hello" },
    ]);

    expect(
      normalizeResponseEvent({
        type: "tool-call-delta",
        delta: { message: { tool_calls: { function: { arguments: "{\"q\":" } } } },
      }),
    ).toMatchObject([
      { protocol: "cohere-chat-v2", kind: "tool-input-delta", text: "{\"q\":" },
    ]);
  });

  test("normalizes AWS Bedrock ConverseStream SDK events", () => {
    const textEvent = {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { text: "Hello" },
      },
    };
    expect(detectResponseProtocol(textEvent)).toBe("aws-bedrock-converse");
    expect(normalizeResponseEvent(textEvent)).toMatchObject([
      { protocol: "aws-bedrock-converse", kind: "text-delta", text: "Hello" },
    ]);

    expect(
      normalizeResponseEvent({
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { reasoningContent: { reasoningText: { text: "thinking" } } },
        },
      }),
    ).toMatchObject([
      { kind: "text-delta", channel: "reasoning", text: "thinking" },
    ]);
  });

  test("uses shared Chat Completions shape without guessing provider identity", () => {
    const providers = [
      { choices: [{ index: 0, delta: { content: "token" } }] },
      {
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "token" } }],
      },
    ];

    for (const event of providers) {
      expect(detectResponseProtocol(event)).toBe("openai-chat-completions");
    }

    const filterAnnotation = {
      choices: [],
      usage: null,
      prompt_annotations: [],
    };
    expect(detectResponseProtocol(filterAnnotation)).toBe("openai-chat-completions");
  });

  test("recognizes SDK parts and preserves unknown objects", () => {
    expect(
      normalizeResponseEvent({ type: "text-delta", id: "t1", delta: "Hi" }),
    ).toMatchObject([{ protocol: "ai-sdk", kind: "text-delta", text: "Hi" }]);
    expect(
      normalizeResponseEvent({ type: "data-weather", data: { location: "SF" } }),
    ).toMatchObject([{ protocol: "ai-sdk", kind: "control", eventType: "data-weather" }]);
    expect(normalizeResponseEvent({ nested: { text: "not a delta" } })).toMatchObject([
      { kind: "unknown", protocol: "unknown" },
    ]);
  });

  test("does not silently accept a conflicting protocol hint", () => {
    expect(() =>
      normalizeResponseEvent(
        { type: "response.output_text.delta", delta: "Hi" },
        "anthropic-messages",
      ),
    ).toThrow(/conflicts with detected protocol/);

    expect(() =>
      normalizeResponseEvent({ arbitrary: "value" }, "openai-chat-completions"),
    ).toThrow(/does not match protocol hint/);

    expect(
      normalizeResponseEvent(
        { type: "response.future_event" },
        "openai-responses",
      ),
    ).toMatchObject([{ kind: "unknown", protocol: "openai-responses" }]);
  });

  test("applies the plain-text hint to string payloads only", () => {
    expect(normalizeResponseEvent("hello", "plain-text")).toMatchObject([
      { kind: "text-delta", protocol: "plain-text", channel: "output", text: "hello" },
    ]);
    expect(() => normalizeResponseEvent({ foo: 1 }, "plain-text")).toThrow(
      /does not match protocol hint/,
    );
  });
});

describe("protocol detection edge cases", () => {
  test("classifies Anthropic in-stream errors as Anthropic, not the AI SDK", () => {
    const event = {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    };
    expect(detectResponseProtocol(event)).toBe("anthropic-messages");
    expect(normalizeResponseEvent(event)).toMatchObject([
      { kind: "control", protocol: "anthropic-messages", eventType: "error" },
    ]);
    expect(normalizeResponseEvent(event, "anthropic-messages")).toMatchObject([
      { kind: "control", protocol: "anthropic-messages", eventType: "error" },
    ]);
  });

  test("does not mistake a chat chunk carrying metadata for Bedrock", () => {
    const event = {
      choices: [{ index: 0, delta: { content: "Hello" } }],
      metadata: { trace_id: "t-1" },
    };
    expect(detectResponseProtocol(event)).toBe("openai-chat-completions");
    expect(normalizeResponseEvent(event)).toMatchObject([
      { kind: "text-delta", text: "Hello" },
    ]);
  });

  test("still recognizes Bedrock events including metadata-only events", () => {
    expect(detectResponseProtocol({ metadata: { usage: { inputTokens: 3 } } }))
      .toBe("aws-bedrock-converse");
    expect(
      detectResponseProtocol({ contentBlockDelta: { delta: {} }, extra: true }),
    ).toBe("aws-bedrock-converse");
  });

  test("recognizes Bedrock exception members as controls", () => {
    for (const member of [
      "internalServerException",
      "modelStreamErrorException",
      "serviceUnavailableException",
      "throttlingException",
      "validationException",
    ]) {
      const event = { [member]: { message: "stream failed" } };
      expect(detectResponseProtocol(event)).toBe("aws-bedrock-converse");
      expect(normalizeResponseEvent(event)).toMatchObject([
        { kind: "control", protocol: "aws-bedrock-converse" },
      ]);
    }
  });

  test("classifies AI SDK lifecycle parts and refusal deltas", () => {
    expect(
      normalizeResponseEvent({ type: "refusal-delta", id: "r1", delta: "I cannot" }),
    ).toMatchObject([
      { kind: "text-delta", channel: "refusal", protocol: "ai-sdk", text: "I cannot" },
    ]);
    for (const type of [
      "start",
      "text-start",
      "text-end",
      "reasoning-part-finish",
      "tool-input-end",
      "start-step",
      "finish-step",
      "reset-step",
      "finish",
      "abort",
      "error",
      "raw",
      "source",
      "message-metadata",
    ]) {
      expect(normalizeResponseEvent({ type })).toMatchObject([
        { kind: "control", protocol: "ai-sdk", eventType: type },
      ]);
    }
  });

  test("keeps Gemini terminal metadata chunks in the Gemini family", () => {
    const finalChunk = {
      candidates: [{ index: 0, finishReason: "STOP", safetyRatings: [] }],
      usageMetadata: { totalTokenCount: 12 },
    };
    expect(detectResponseProtocol(finalChunk)).toBe("gemini-generate-content");
    const parts = normalizeResponseEvent(finalChunk);
    expect(parts.every((part) => part.protocol === "gemini-generate-content")).toBe(true);
    expect(parts.some((part) => part.kind === "unknown")).toBe(false);

    expect(detectResponseProtocol({ promptFeedback: { blockReason: "SAFETY" } }))
      .toBe("gemini-generate-content");
  });

  test("detects OpenAI Responses events by family prefix and keeps reasoning text", () => {
    expect(
      normalizeResponseEvent({ type: "response.reasoning_text.delta", delta: "thinking" }),
    ).toMatchObject([
      { kind: "text-delta", channel: "reasoning", protocol: "openai-responses" },
    ]);
    expect(normalizeResponseEvent({ type: "response.queued" })).toMatchObject([
      { kind: "control", protocol: "openai-responses" },
    ]);
    expect(
      normalizeResponseEvent({ type: "response.some_future_event", sequence_number: 4 }),
    ).toMatchObject([{ kind: "unknown", protocol: "openai-responses" }]);
  });

  test("surfaces Anthropic content_block_start text and thinking", () => {
    expect(
      normalizeResponseEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "Hello" },
      }),
    ).toMatchObject([
      { kind: "control", protocol: "anthropic-messages" },
      { kind: "text-delta", channel: "output", text: "Hello" },
    ]);
    expect(
      normalizeResponseEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking", thinking: "reasoning" },
      }),
    ).toMatchObject([
      { kind: "control" },
      { kind: "text-delta", channel: "reasoning", text: "reasoning" },
    ]);
  });
});

describe("tool call identity", () => {
  test("distinguishes parallel Anthropic tool calls by block identity", () => {
    expect(
      normalizeResponseEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
      }),
    ).toMatchObject([
      { kind: "tool-call", toolCallId: "toolu_1", toolName: "get_weather", blockId: 1 },
    ]);
    expect(
      normalizeResponseEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{\"city\":" },
      }),
    ).toMatchObject([{ kind: "tool-input-delta", blockId: 1 }]);
    expect(
      normalizeResponseEvent({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "{\"zip\":" },
      }),
    ).toMatchObject([{ kind: "tool-input-delta", blockId: 2 }]);
  });

  test("carries the tool call index through Chat Completions continuation chunks", () => {
    const continuation = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 1, function: { arguments: "1}" } }],
          },
        },
      ],
    };
    expect(normalizeResponseEvent(continuation)).toMatchObject([
      { kind: "tool-input-delta", text: "1}", blockId: 1 },
    ]);
  });

  test("exposes Responses function call identity and output index", () => {
    expect(
      normalizeResponseEvent({
        type: "response.output_item.added",
        output_index: 2,
        item: { type: "function_call", call_id: "call_9", name: "lookup" },
      }),
    ).toMatchObject([
      { kind: "tool-call", toolCallId: "call_9", toolName: "lookup", blockId: 2 },
    ]);
    expect(
      normalizeResponseEvent({
        type: "response.function_call_arguments.delta",
        item_id: "call_9",
        output_index: 2,
        delta: "{\"q\":",
      }),
    ).toMatchObject([{ kind: "tool-input-delta", toolCallId: "call_9", blockId: 2 }]);
    expect(
      normalizeResponseEvent({
        type: "response.output_text.delta",
        output_index: 1,
        delta: "Hi",
      }),
    ).toMatchObject([{ kind: "text-delta", blockId: 1 }]);
  });

  test("exposes Cohere and Bedrock tool identity", () => {
    expect(
      normalizeResponseEvent({
        type: "tool-call-start",
        index: 0,
        delta: {
          message: {
            tool_calls: { id: "call-2", function: { name: "lookup", arguments: "" } },
          },
        },
      }),
    ).toMatchObject([
      { kind: "tool-call", toolCallId: "call-2", toolName: "lookup", blockId: 0 },
    ]);
    // Compatible gateways may send the call at the top level instead.
    expect(
      normalizeResponseEvent({
        type: "tool-call-start",
        index: 0,
        id: "call-1",
        tool_call: { id: "call-1", function: { name: "search" } },
      }),
    ).toMatchObject([
      { kind: "tool-call", toolCallId: "call-1", toolName: "search", blockId: 0 },
    ]);
    expect(
      normalizeResponseEvent({
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "tu-1", name: "calc" } },
        },
      }),
    ).toMatchObject([
      { kind: "tool-call", toolCallId: "tu-1", toolName: "calc", blockId: 1 },
    ]);
    expect(
      normalizeResponseEvent({
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: "{\"x\":" } },
        },
      }),
    ).toMatchObject([{ kind: "tool-input-delta", blockId: 1 }]);
  });
});
