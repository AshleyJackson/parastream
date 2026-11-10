import { describe, expect, test } from "bun:test";
import {
  normalizeAIStream,
  normalizeResponseEvent,
  type NormalizedPart,
  type ResponseProtocol,
} from "../src/index.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of source) output.push(value);
  return output;
}

async function fixture(name: string): Promise<string> {
  return Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
}

function parseJsonLines(text: string): unknown[] {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as unknown);
}

async function normalizeSse(name: string): Promise<NormalizedPart[]> {
  return collect(
    normalizeAIStream(
      new Response(await fixture(name), {
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
}

async function normalizeNdjson(name: string): Promise<NormalizedPart[]> {
  return collect(
    normalizeAIStream(
      new Response(await fixture(name), {
        headers: { "content-type": "application/x-ndjson" },
      }),
    ),
  );
}

function texts(
  parts: NormalizedPart[],
  channel: "output" | "reasoning" | "refusal" = "output",
): string[] {
  return parts.flatMap((part) =>
    part.kind === "text-delta" && part.channel === channel ? [part.text] : [],
  );
}

function toolInputDeltas(parts: NormalizedPart[]): string[] {
  return parts.flatMap((part) =>
    part.kind === "tool-input-delta" ? [part.text] : [],
  );
}

function expectProtocol(parts: NormalizedPart[], protocol: ResponseProtocol): void {
  expect(parts.length).toBeGreaterThan(0);
  expect(parts.every((part) => part.protocol === protocol)).toBe(true);
}

describe("provider stream fixtures", () => {
  test("OpenAI Chat Completions streams text, finish metadata, and [DONE]", async () => {
    const parts = await normalizeSse("openai-chat-completions.sse");

    expectProtocol(parts, "openai-chat-completions");
    expect(texts(parts)).toEqual(["Hello", " from OpenAI"]);
    expect(texts(parts, "refusal")).toEqual(["I can't help with that request."]);
    expect(toolInputDeltas(parts)).toEqual(['{"city":']);
    expect(parts.some((part) => part.kind === "control")).toBe(true);
    expect(parts.some((part) => part.kind === "unknown")).toBe(false);
  });

  test("OpenAI Responses keeps text, tool starts, arguments, and lifecycle distinct", async () => {
    const parts = await normalizeSse("openai-responses.sse");

    expectProtocol(parts, "openai-responses");
    expect(texts(parts)).toEqual(["The answer is "]);
    expect(texts(parts, "reasoning")).toEqual(["The result follows from the input."]);
    expect(parts.some((part) => part.kind === "tool-call")).toBe(true);
    expect(toolInputDeltas(parts)).toEqual(['{"city":']);
    expect(parts.some((part) => part.kind === "control" && part.eventType === "response.completed")).toBe(true);
  });

  test("Anthropic Messages keeps text, thinking, tool starts, and partial JSON separate", async () => {
    const parts = await normalizeSse("anthropic-messages.sse");

    expectProtocol(parts, "anthropic-messages");
    expect(texts(parts)).toEqual(["Hello from Claude."]);
    expect(texts(parts, "reasoning")).toEqual(["A short private thought."]);
    expect(parts.some((part) => part.kind === "tool-call")).toBe(true);
    expect(toolInputDeltas(parts)).toEqual(['{"query":']);
    expect(parts.some((part) => part.kind === "control" && part.eventType === "message_stop")).toBe(true);
  });

  test("Gemini streamGenerateContent handles text, thought parts, and function calls", async () => {
    const parts = await normalizeSse("gemini-stream.sse");

    expectProtocol(parts, "gemini-generate-content");
    expect(texts(parts)).toEqual(["Hello from Gemini."]);
    expect(texts(parts, "reasoning")).toEqual(["A short thought."]);
    expect(parts.some((part) => part.kind === "tool-call")).toBe(true);
    expect(parts.some((part) => part.kind === "control")).toBe(true);
  });

  test("Ollama /api/chat parses NDJSON text, thinking, calls, and final metrics", async () => {
    const parts = await normalizeNdjson("ollama-chat.ndjson");

    expectProtocol(parts, "ollama-chat");
    expect(texts(parts)).toEqual(["Hello from Ollama."]);
    expect(texts(parts, "reasoning")).toEqual(["A short thought."]);
    expect(parts.some((part) => part.kind === "tool-call")).toBe(true);
    expect(parts.some((part) => part.kind === "control")).toBe(true);
    expect(parts.some((part) => part.kind === "unknown")).toBe(false);
  });

  test("Ollama /api/generate parses response fragments and the terminal object", async () => {
    const parts = await normalizeNdjson("ollama-generate.ndjson");

    expectProtocol(parts, "ollama-generate");
    expect(texts(parts)).toEqual(["Hello ", "from Ollama."]);
    expect(parts.some((part) => part.kind === "control")).toBe(true);
    expect(parts.some((part) => part.kind === "unknown")).toBe(false);
  });

  test("Cohere Chat v2 parses typed SSE, content deltas, and tool argument deltas", async () => {
    const parts = await normalizeSse("cohere-chat-v2.sse");

    expectProtocol(parts, "cohere-chat-v2");
    expect(texts(parts)).toEqual(["Hello from Cohere."]);
    expect(parts.find((part) => part.kind === "tool-call")).toMatchObject({
      toolCallId: "tool_demo",
      toolName: "lookup",
      blockId: 0,
    });
    expect(toolInputDeltas(parts)).toEqual(['{"query":']);
    expect(parts.some((part) => part.kind === "control" && part.eventType === "message-end")).toBe(true);
  });

  test("Bedrock ConverseStream SDK events preserve tool, text, reasoning, and controls", async () => {
    const events = JSON.parse(await fixture("bedrock-converse-sdk-events.json")) as unknown[];
    const parts = await collect(normalizeAIStream(events));

    expectProtocol(parts, "aws-bedrock-converse");
    expect(texts(parts)).toEqual(["Hello from Bedrock."]);
    expect(texts(parts, "reasoning")).toEqual(["A short thought."]);
    expect(parts.some((part) => part.kind === "tool-call")).toBe(true);
    expect(toolInputDeltas(parts)).toEqual(['{"query":']);
    expect(parts.some((part) => part.kind === "control")).toBe(true);
  });

  test("Vercel AI SDK core parts preserve output, reasoning, and tool arguments", async () => {
    const events = parseJsonLines(await fixture("vercel-ai-sdk-core.jsonl"));
    const parts = await collect(normalizeAIStream(events));

    expectProtocol(parts, "ai-sdk");
    expect(texts(parts)).toEqual(["Hello from the AI SDK."]);
    expect(texts(parts, "reasoning")).toEqual(["A short thought."]);
    expect(parts.some((part) => part.kind === "tool-call")).toBe(true);
    expect(toolInputDeltas(parts)).toEqual(['{"query":']);
    expect(parts.some((part) => part.kind === "control" && part.eventType === "finish-step")).toBe(true);
  });

  test("Vercel AI SDK UI SSE distinguishes text, tool input, data, and controls", async () => {
    const parts = await normalizeSse("vercel-ai-sdk-ui.sse");

    expectProtocol(parts, "ai-sdk");
    expect(texts(parts)).toEqual(["Hello from the AI SDK UI."]);
    expect(toolInputDeltas(parts)).toEqual(['{"query":']);
    expect(parts.some((part) => part.kind === "tool-call")).toBe(true);
    expect(parts.some((part) => part.kind === "control" && part.eventType === "data-usage")).toBe(true);
    expect(parts.some((part) => part.kind === "unknown")).toBe(false);
  });

  test("Mistral Chat uses the shared Chat Completions stream shape", async () => {
    const parts = await normalizeSse("mistral-chat-completions.sse");

    expectProtocol(parts, "openai-chat-completions");
    expect(texts(parts)).toEqual(["Hello from Mistral."]);
    expect(parts.some((part) => part.kind === "control")).toBe(true);
  });

  test("Azure OpenAI keeps content-filter annotations out of text", async () => {
    const parts = await normalizeSse("azure-openai-chat-completions.sse");

    expectProtocol(parts, "openai-chat-completions");
    expect(texts(parts)).toEqual(["Hello from Azure OpenAI."]);
    expect(parts.some((part) => part.kind === "control")).toBe(true);
    expect(parts.some((part) => part.kind === "unknown")).toBe(false);
  });

  test("Hugging Face TGI OpenAI-compatible endpoint uses Chat Completions framing", async () => {
    const parts = await normalizeSse("huggingface-tgi-openai-compatible.sse");

    expectProtocol(parts, "openai-chat-completions");
    expect(texts(parts)).toEqual(["Hello from TGI.", " TGI."]);
    expect(parts.some((part) => part.kind === "control")).toBe(true);
  });

  test("Hugging Face TGI native token payload is not misidentified as Chat Completions", () => {
    expect(
      normalizeResponseEvent({ token: { id: 42, text: "native token" }, generated_text: null }),
    ).toMatchObject([{ kind: "unknown", protocol: "unknown" }]);
  });
});
