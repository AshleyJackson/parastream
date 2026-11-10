import { describe, expect, test } from "bun:test";
import {
  normalizeAIStream,
  parseNDJSON,
  parseSSE,
} from "../src/index.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of source) output.push(value);
  return output;
}

describe("SSE framing", () => {
  test("parses CRLF, comments, multiline data, and IDs across chunks", async () => {
    const chunks = [
      ": keep-alive\r",
      "\nid: 42\r\nevent: content_block_delta\r\ndata: {\"type\":\r",
      "\ndata: \"content_block_delta\"}\r\n\r\n",
    ];
    const frames = await collect(parseSSE(chunks));

    expect(frames).toEqual([
      {
        data: "{\"type\":\n\"content_block_delta\"}",
        event: "content_block_delta",
        id: "42",
      },
    ]);
  });

  test("flushes a final event without a trailing blank line", async () => {
    expect(await collect(parseSSE("data: final"))).toEqual([{ data: "final" }]);
  });

  test("bounds accumulated event data", async () => {
    await expect(
      collect(parseSSE("data: 12345\n\n", { maxEventLength: 4 })),
    ).rejects.toThrow("maxEventLength");
  });
});

describe("NDJSON framing", () => {
  test("parses objects with arbitrary chunking and a final unterminated line", async () => {
    const events = await collect(parseNDJSON([
      "{\"a\":",
      "1}\r\n{\"b\":2}",
    ]));
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("preserves UTF-8 characters split across byte chunks", async () => {
    const bytes = new TextEncoder().encode("{\"text\":\"🙂\"}\n");
    const emojiStart = bytes.findIndex((value, index) =>
      value === 0xf0 && bytes[index + 1] === 0x9f,
    );
    async function* chunks() {
      yield bytes.slice(0, emojiStart + 1);
      yield bytes.slice(emojiStart + 1);
    }

    expect(await collect(parseNDJSON(chunks()))).toEqual([{ text: "🙂" }]);
  });

  test("surfaces malformed JSON with a line number", async () => {
    await expect(collect(parseNDJSON(["{\"valid\":true}\n", "not-json\n"])))
      .rejects.toThrow("Invalid NDJSON at line 2");
  });

  test("stops at a [DONE] sentinel", async () => {
    const events = await collect(parseNDJSON("{\"a\":1}\n[DONE]\n{\"b\":2}\n"));
    expect(events).toEqual([{ a: 1 }]);
  });
});

describe("normalizeAIStream", () => {
  test("uses Response content type to select SSE and recognizes an event", async () => {
    const response = new Response(
      'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );

    expect(await collect(normalizeAIStream(response))).toMatchObject([
      {
        kind: "text-delta",
        protocol: "openai-responses",
        channel: "output",
        text: "Hello",
      },
    ]);
  });

  test("requires framing for an unlabelled byte stream", async () => {
    const bytes = new TextEncoder().encode("data: hi\n\n");
    await expect(
      collect(normalizeAIStream([bytes])),
    ).rejects.toThrow("Specify transport for a byte stream");
  });

  test("validates stream sources with Zod", async () => {
    await expect(collect(normalizeAIStream(null as never))).rejects.toThrow();
  });

  test("treats plain string iterables as text unless told otherwise", async () => {
    expect(await collect(normalizeAIStream(["Hello", " world"]))).toMatchObject([
      { kind: "text-delta", protocol: "plain-text", text: "Hello" },
      { kind: "text-delta", protocol: "plain-text", text: " world" },
    ]);
  });

  test("can explicitly parse SSE supplied without Response headers", async () => {
    const source = ["data: {\"type\":\"response.output_text.delta\",", "\"delta\":\"Hi\"}\n\n"];
    expect(
      await collect(normalizeAIStream(source, { transport: "sse" })),
    ).toMatchObject([{ protocol: "openai-responses", text: "Hi" }]);
  });

  test("accepts a single byte buffer with an explicit transport", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
    );
    expect(
      await collect(normalizeAIStream(bytes, { transport: "sse" })),
    ).toMatchObject([{ protocol: "openai-responses", text: "Hi" }]);
  });

  test("AbortSignal interrupts a pending async source read", async () => {
    const controller = new AbortController();
    async function* events() {
      yield { type: "response.output_text.delta", delta: "first" };
      await new Promise<void>(() => undefined);
    }
    const iterator = normalizeAIStream(events(), { signal: controller.signal });
    expect((await iterator.next()).value).toMatchObject({ text: "first" });

    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
  });

  test("skips empty SSE data frames as keep-alives", async () => {
    const parts = await collect(
      normalizeAIStream(
        'data:\n\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
        { transport: "sse" },
      ),
    );
    expect(parts).toMatchObject([{ kind: "text-delta", text: "Hi" }]);
  });

  test("rejects a protocol hint for plain text", async () => {
    await expect(
      collect(normalizeAIStream("hello", { protocol: "openai-chat-completions" })),
    ).rejects.toThrow(/cannot be applied to a plain text stream/);
  });

  test("forwards line and event limits to the parsers", async () => {
    await expect(
      collect(
        normalizeAIStream("data: 12345\n\n", { transport: "sse", maxEventLength: 4 }),
      ),
    ).rejects.toThrow("maxEventLength");
    await expect(
      collect(
        normalizeAIStream("{\"a\":123456}\n", { transport: "ndjson", maxLineLength: 8 }),
      ),
    ).rejects.toThrow("maxLineLength");
  });

  test("keeps raw faithful to the payload when an event name is attached", async () => {
    const parts = await collect(
      normalizeAIStream(
        'event: message\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        { transport: "sse" },
      ),
    );
    expect(parts).toMatchObject([{ kind: "text-delta", text: "Hi" }]);
    expect(parts[0]?.raw).toEqual({ choices: [{ delta: { content: "Hi" } }] });
  });
});
