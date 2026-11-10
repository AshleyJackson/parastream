import { describe, expect, test } from "bun:test";
import {
  normalizeAIReadableStream,
  partFilterTransform,
  segmentTextTransform,
  selectTextTransform,
} from "../src/index.js";

async function collectReadable<T>(source: ReadableStream<T>): Promise<T[]> {
  const reader = source.getReader();
  const output: T[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return output;
      output.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe("Web Streams adapters", () => {
  test("adapts normalized events without flattening semantic parts", async () => {
    const parts = normalizeAIReadableStream([
      {
        choices: [
          {
            index: 0,
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
      },
    ]);

    expect(await collectReadable(parts)).toMatchObject([
      { kind: "text-delta", channel: "output", text: "Calling tool." },
      {
        kind: "tool-input-delta",
        toolCallId: "call-1",
        toolName: "lookup",
        text: "{\"q\":",
      },
    ]);
  });

  test("forwards transport limits to the underlying parser", async () => {
    const stream = normalizeAIReadableStream("data: 12345\n\n", {
      transport: "sse",
      maxEventLength: 4,
    });

    await expect(collectReadable(stream)).rejects.toThrow("maxEventLength");
  });

  test("cancels the upstream iterator when the readable stream is cancelled", async () => {
    let returned = false;
    async function* source() {
      try {
        yield { type: "response.output_text.delta", delta: "first" };
        await new Promise<void>(() => undefined);
      } finally {
        returned = true;
      }
    }

    const reader = normalizeAIReadableStream(source()).getReader();
    expect((await reader.read()).value).toMatchObject({ text: "first" });
    await reader.cancel("consumer stopped");
    reader.releaseLock();

    expect(returned).toBe(true);
  });

  test("projects an explicit text channel and flushes a final segment", async () => {
    const text = normalizeAIReadableStream([
      { type: "response.output_text.delta", delta: "One\n" },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "not output" },
      },
      { type: "response.output_text.delta", delta: "\nTwo" },
    ])
      .pipeThrough(selectTextTransform({ channel: "output" }))
      .pipeThrough(segmentTextTransform({ unit: "paragraph" }));

    expect(await collectReadable(text)).toEqual([
      {
        text: "One\n\n",
        index: 0,
        unit: "paragraph",
        isFinal: false,
      },
      {
        text: "Two",
        index: 1,
        unit: "paragraph",
        isFinal: true,
      },
    ]);
  });

  test("filters text channels without dropping tools or other semantic parts", async () => {
    const parts = normalizeAIReadableStream([
      {
        choices: [
          {
            index: 0,
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
      },
    ]).pipeThrough(partFilterTransform({ textChannels: ["reasoning"] }));

    expect(await collectReadable(parts)).toMatchObject([
      {
        kind: "tool-input-delta",
        toolCallId: "call-1",
        toolName: "lookup",
      },
    ]);
  });
});
