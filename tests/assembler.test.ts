import { describe, expect, test } from "bun:test";
import { consume, createMessageAssembler, normalizeAIStream, normalizeResponseEvent, type AssemblerEvent, type NormalizedPart } from "../src/index.js";

async function fixture(name: string): Promise<string> {
  return Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
}

function events(text: string): unknown[] {
  return text.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
}

describe("message assembler", () => {
  test("assembles interleaved blocks and tool JSON, then rolls back only the reset step", async () => {
    const assembler = createMessageAssembler();
    const emitted: AssemblerEvent[] = [];
    for await (const part of normalizeAIStream(events(await fixture("assembler-ai-sdk.jsonl")))) {
      emitted.push(...assembler.push(part));
    }
    emitted.push(...assembler.finish());
    expect(assembler.state.text).toBe("Hello otherworld!");
    expect(assembler.state.reasoning).toBe("thinking");
    expect(assembler.state.textBlocks).toMatchObject([
      { channel: "output", blockId: "a", text: "Hello world!" },
      { channel: "output", blockId: "b", text: "other" },
      { channel: "reasoning", blockId: "a", text: "thinking" },
    ]);
    expect(assembler.state.toolCalls).toMatchObject([{ toolCallId: "call-1", status: "complete", input: { query: "weather" } }]);
    expect(emitted.filter((event) => event.type === "tool-call-complete")).toHaveLength(2);
    expect(emitted.filter((event) => event.type === "reset")).toHaveLength(1);
    const snapshot = assembler.state;
    snapshot.textBlocks[0]!.text = "mutated";
    expect(assembler.state.textBlocks[0]!.text).toBe("Hello world!");
    expect(() => assembler.push(normalizeResponseEvent("late", "plain-text")[0]!)).toThrow();
  });

  test("joins Anthropic arguments by block index and completes at block stop", async () => {
    const response = new Response(await fixture("assembler-anthropic.sse"), { headers: { "content-type": "text/event-stream" } });
    const completed: unknown[] = [];
    const state = await consume(response, { toolCallComplete: (event) => { completed.push(event.toolCall); } });
    expect(completed).toMatchObject([{ toolCallId: "tool-1", toolName: "lookup", input: { q: 42 } }]);
    expect(state.toolCalls[0]?.status).toBe("complete");
  });

  test("correlates OpenAI Responses call IDs and item IDs by output index", async () => {
    const completed: string[] = [];
    const state = await consume(events(await fixture("assembler-openai-responses.jsonl")), {
      toolCallComplete: (event) => { completed.push(event.toolCall.toolCallId!); },
    });
    expect(completed).toEqual(["call-1", "call-0"]);
    expect(state.toolCalls).toMatchObject([
      { toolCallId: "call-0", input: { a: 1 }, status: "complete" },
      { toolCallId: "call-1", input: { b: 2 }, status: "complete" },
    ]);
  });

  test("uses final OpenAI arguments when no deltas were supplied", async () => {
    const state = await consume([
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call", name: "f" } },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" },
    ]);
    expect(state.toolCalls[0]).toMatchObject({ status: "complete", input: {} });
  });

  test("uses complete Gemini and Ollama tool input without merging calls in one event", async () => {
    for (const [name, contentType] of [["gemini-stream.sse", "text/event-stream"], ["ollama-chat.ndjson", "application/x-ndjson"]] as const) {
      const state = await consume(new Response(await fixture(name), { headers: { "content-type": contentType } }));
      expect(state.toolCalls).toMatchObject([{ status: "complete", input: { query: "weather" } }]);
    }
    const state = await consume([{ candidates: [{ index: 0, content: { parts: [
      { functionCall: { name: "a", args: { a: 1 } } },
      { functionCall: { name: "b", args: { b: 2 } } },
    ] } }] }]);
    expect(state.toolCalls.map((call) => call.input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("reports invalid and unfinished JSON separately", async () => {
    const failures: string[] = [];
    const state = await consume([
      { type: "tool-input-start", toolCallId: "bad", toolName: "f" },
      { type: "tool-input-delta", toolCallId: "bad", delta: "{" },
      { type: "tool-input-end", toolCallId: "bad" },
      { type: "tool-input-start", toolCallId: "unfinished", toolName: "g" },
      { type: "tool-input-delta", toolCallId: "unfinished", delta: "{" },
    ], { toolInputError: (event) => { failures.push(event.reason); } });
    expect(failures).toEqual(["invalid-json", "incomplete"]);
    expect(state.toolCalls.map((call) => call.status)).toEqual(["invalid-json", "incomplete"]);
  });

  test("applies global text and tool limits with explicit truncation or errors", async () => {
    const input = events(await fixture("assembler-ai-sdk.jsonl"));
    await expect(consume(input, {}, { assembler: { maxTextChars: 3 } })).rejects.toThrow("maxTextChars");
    const failures: string[] = [];
    const state = await consume(input, { toolInputError: (event) => { failures.push(event.reason); } },
      { assembler: { maxTextChars: 5, maxToolInputChars: 4, onOverflow: "truncate-marked" } });
    expect(state.text.length + state.reasoning.length + state.refusal.length).toBe(5);
    expect(state.truncated).toBe(true);
    expect(state.toolCalls[0]).toMatchObject({ inputText: '{"qu', status: "truncated" });
    expect(failures).toEqual(["truncated", "truncated"]);
    await expect(consume(input, {}, { assembler: { maxEntries: 1 } })).rejects.toThrow("maxEntries");
    await expect(consume(input, {}, { assembler: { maxToolInputChars: 3 } })).rejects.toThrow("maxToolInputChars");
  });

  test("supports text and off modes and avoids parsing truncated input", async () => {
    const source = [{ type: "tool-input-start", toolCallId: "id" }, { type: "tool-input-delta", toolCallId: "id", delta: "not json" }, { type: "tool-input-end", toolCallId: "id" }];
    const text = await consume(source, {}, { assembler: { toolInput: "text" } });
    expect(text.toolCalls[0]).toMatchObject({ inputText: "not json", status: "complete" });
    const off = await consume(source, {}, { assembler: { toolInput: "off" } });
    expect(off.toolCalls[0]).toMatchObject({ inputText: "", status: "complete" });
  });

  test("an explicit complete input replaces partial fragments before completion", async () => {
    const state = await consume([
      { type: "tool-input-start", toolCallId: "id" },
      { type: "tool-input-delta", toolCallId: "id", delta: "{" },
      { type: "tool-input-available", toolCallId: "id", input: { value: 1 } },
    ]);
    expect(state.toolCalls[0]).toMatchObject({ input: { value: 1 }, inputText: '{"value":1}', status: "complete" });
  });

  test("reports a truncated call once when a full input follows fragments", async () => {
    const failures: string[] = [];
    const state = await consume([
      { type: "tool-input-start", toolCallId: "id" },
      { type: "tool-input-delta", toolCallId: "id", delta: '{"long":' },
      { type: "tool-input-available", toolCallId: "id", input: { long: 1 } },
    ], { toolInputError: ({ reason }) => { failures.push(reason); } },
    { assembler: { maxToolInputChars: 2, onOverflow: "truncate-marked" } });
    expect(failures).toEqual(["truncated"]);
    expect(state.toolCalls[0]?.status).toBe("truncated");
  });

  test("awaits handlers and closes the upstream iterator on handler failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    let closed = false;
    async function* source(): AsyncGenerator<unknown> {
      try {
        reads++;
        yield { type: "text-delta", text: "a" };
        reads++;
        yield { type: "text-delta", text: "b" };
      } finally { closed = true; }
    }
    const consuming = consume(source(), { text: async () => { await gate; throw new Error("handler failed"); } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(1);
    release();
    await expect(consuming).rejects.toThrow("handler failed");
    expect(closed).toBe(true);
  });

  test("cancel closes the push assembler without fabricating completion", () => {
    const assembler = createMessageAssembler();
    assembler.push(normalizeResponseEvent({ type: "tool-input-start", toolCallId: "id" })[0] as NormalizedPart);
    assembler.cancel();
    expect(assembler.state.toolCalls[0]?.status).toBe("pending");
    expect(() => assembler.finish()).toThrow("closed");
  });

  test("honors aborts from a handler and closes the source", async () => {
    const abort = new AbortController();
    const reason = new Error("stop");
    let closed = false;
    async function* source(): AsyncGenerator<unknown> {
      try { yield { type: "text-delta", text: "a" }; yield { type: "text-delta", text: "b" }; }
      finally { closed = true; }
    }
    await expect(consume(source(), { text: () => { abort.abort(reason); } }, { normalize: { signal: abort.signal } })).rejects.toBe(reason);
    expect(closed).toBe(true);
  });

  test("isolates tool IDs reused by subsequent AI SDK steps", async () => {
    const state = await consume([
      { type: "start-step" }, { type: "tool-call", toolCallId: "id", input: { n: 1 } }, { type: "finish-step" },
      { type: "start-step" }, { type: "tool-call", toolCallId: "id", input: { n: 2 } }, { type: "finish-step" },
    ]);
    expect(state.toolCalls.map((call) => call.input)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("a reset supplies restored state and restores the text budget", async () => {
    const snapshots: string[] = [];
    const state = await consume([
      { type: "text-delta", id: "a", text: "a" },
      { type: "start-step" }, { type: "text-delta", id: "a", text: "discard" },
      { type: "reset-step" }, { type: "start-step" }, { type: "text-delta", id: "a", text: "b" },
    ], { reset: (event) => { snapshots.push(event.state.text); } },
    { assembler: { maxTextChars: 2, onOverflow: "truncate-marked" } });
    expect(snapshots).toEqual(["a"]);
    expect(state.text).toBe("ab");
    expect(state.truncated).toBe(false);
  });

  test("late tool-input deltas are silently ignored after completion", async () => {
    const late: string[] = [];
    await consume([
      { type: "tool-input-start", toolCallId: "id" },
      { type: "tool-input-delta", toolCallId: "id", delta: "x" },
      { type: "tool-input-end", toolCallId: "id" },
      { type: "tool-input-delta", toolCallId: "id", delta: "late" },
    ], { toolInput: ({ text }) => { late.push(text); } });
    expect(late).toEqual(["x"]);
  });

  test("tool-call without input is reported incomplete when stream ends", async () => {
    const failures: string[] = [];
    await consume(
      [{ type: "tool-call", toolCallId: "id", toolName: "f", protocol: "ai-sdk" }],
      { toolInputError: ({ reason }) => { failures.push(reason); } },
      { assembler: { toolInput: "json" } },
    );
    expect(failures).toEqual(["incomplete"]);
  });

  test("cancel leaves pending calls without completing", () => {
    const assembler = createMessageAssembler();
    assembler.push(normalizeResponseEvent({ type: "tool-input-start", toolCallId: "id" })[0] as NormalizedPart);
    assembler.cancel();
    expect(assembler.state.toolCalls[0]?.status).toBe("pending");
    expect(assembler.state.toolCalls[0]?.inputText).toBe("");
    expect(() => assembler.finish()).toThrow("closed");
  });
});
