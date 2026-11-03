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
              { functionCall: { name: "search", args: { q: "x" } } },
            ],
          },
        },
      ],
    };
    expect(detectResponseProtocol(event)).toBe("gemini-generate-content");
    expect(normalizeResponseEvent(event)).toMatchObject([
      { kind: "text-delta", text: "A response" },
      { kind: "tool-call" },
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
});
