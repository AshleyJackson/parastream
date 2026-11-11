import { describe, expect, test } from "bun:test";
import {
  normalizeResponseEvent,
  normalizedPartSchema,
  paratokenChunks,
  type NormalizedPart,
  type ParaChunk,
} from "../src/index.js";

type QueueResult = IteratorResult<string, void>;
type QueueWaiter = (result: QueueResult) => void;

class AsyncTextQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private readonly waiters: QueueWaiter[] = [];
  private closed = false;

  push(value: string): void {
    if (this.closed) throw new Error("Cannot push to a closed text queue");
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  next(): Promise<QueueResult> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<string, void> {
    return this;
  }
}

function responseDelta(text: string): NormalizedPart {
  return normalizedPartSchema.parse({
    kind: "text-delta",
    protocol: "ai-sdk",
    channel: "output",
    text,
    raw: { type: "text-delta", text },
  });
}

function controlEvent(eventType: string): NormalizedPart {
  return normalizedPartSchema.parse({
    kind: "control",
    protocol: "ai-sdk",
    eventType,
    raw: { eventType },
  });
}

function singleNormalizedPart(value: unknown): NormalizedPart {
  const part = normalizeResponseEvent(value)[0];
  if (part === undefined) throw new Error("Expected one normalized part");
  return part;
}

function splitIntoDeltas(text: string, widths: number[]): string[] {
  const chunks: string[] = [];
  let offset = 0;
  let widthIndex = 0;
  while (offset < text.length) {
    const width = widths[widthIndex % widths.length] ?? 32;
    chunks.push(text.slice(offset, offset + width));
    offset += width;
    widthIndex += 1;
  }
  return chunks;
}

function activityLabel(part: NormalizedPart): string {
  if (part.kind === "control") return part.eventType ?? "control";
  if (part.kind === "tool-call") return "tool-call";
  if (part.kind === "tool-input-delta") return "tool-input-delta";
  if (part.kind === "text-delta") return `${part.channel}-text`;
  return "unknown";
}

async function* simulatedStream(
  paragraphs: string[],
): AsyncGenerator<NormalizedPart> {
  const delay = 60;
  const first = splitIntoDeltas(paragraphs[0] ?? "", [17, 38, 21, 55]);
  for (const [index, text] of first.entries()) {
    yield responseDelta(text);
    await Bun.sleep(delay);

    if (index === 0) yield controlEvent("agent.started");
    if (index === 1) {
      yield singleNormalizedPart({
        type: "tool-call",
        toolCallId: "tool-lookup",
        toolName: "lookup",
      });
    }
    if (index === 1) {
      yield normalizedPartSchema.parse({
        kind: "text-delta",
        protocol: "ai-sdk",
        channel: "reasoning",
        text: "Internal reasoning stays outside the message paragraph lane.",
        raw: { type: "reasoning-delta" },
      });
    }
  }
  yield responseDelta("\n");
  await Bun.sleep(delay);
  yield responseDelta("\n");

  const second = splitIntoDeltas(paragraphs[1] ?? "", [44, 19, 73, 31, 58]);
  for (const [index, text] of second.entries()) {
    yield responseDelta(text);
    await Bun.sleep(delay);
    if (index === 1) yield controlEvent("agent.progress");
  }
  yield responseDelta("\n\n");

  const third = splitIntoDeltas(paragraphs[2] ?? "", [29, 73, 15, 51, 93, 24]);
  for (const [index, text] of third.entries()) {
    yield responseDelta(text);
    await Bun.sleep(delay);
    if (index === 2) {
      yield singleNormalizedPart({
        type: "tool-call-delta",
        toolCallId: "tool-lookup",
        toolName: "lookup",
        argsTextDelta: "{\"query\":",
      });
      yield controlEvent("tool.result");
    }
    if (index === 7) yield controlEvent("agent.summarizing");
  }
  yield controlEvent("agent.completed");
}

function renderParagraph(chunk: ParaChunk, startedAt: number): void {
  const text = chunk.text.endsWith("\n\n") ? chunk.text.slice(0, -2) : chunk.text;
  const finalLabel = chunk.isFinal ? " · final flush" : "";
  process.stdout.write(
    `\n\n[+${Math.round(performance.now() - startedAt)}ms] MESSAGE PARAGRAPH ${String(chunk.index + 1).padStart(2, "0")} · ${text.length} chars${finalLabel}\n`,
  );
  process.stdout.write(`${text.split("\n").map((line) => `  ${line}`).join("\n")}\n`);
  process.stdout.write("[response deltas buffered] ");
}

describe("visual stream playback", () => {
  test("buffers only message output into paragraphs and prints activity immediately", async () => {
    const response = (
      await Bun.file(new URL("./fixtures/visual-response.txt", import.meta.url)).text()
    ).trimEnd();
    const paragraphs = response.split(/\r?\n\r?\n/);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]!.length).toBeLessThan(paragraphs[1]!.length);
    expect(paragraphs[1]!.length).toBeLessThan(paragraphs[2]!.length);

    const expectedParagraphs = paragraphs.map((paragraph, index) =>
      index === paragraphs.length - 1 ? paragraph : `${paragraph}\n\n`,
    );
    const queue = new AsyncTextQueue();
    const emittedParagraphs: ParaChunk[] = [];
    const emittedActivities: string[] = [];
    const renderedOrder: string[] = [];
    const startedAt = performance.now();

    process.stdout.write(
      "\n\n=== Paratoken visual stream test ===\nOnly output-message text is buffered to paragraph boundaries. Activity is printed as soon as it arrives.\n[response deltas buffered] ",
    );

    const paragraphRenderer = (async () => {
      for await (const chunk of paratokenChunks(queue, { unit: "paragraph" })) {
        emittedParagraphs.push(chunk);
        renderedOrder.push(`paragraph:${chunk.index}`);
        renderParagraph(chunk, startedAt);
      }
    })();

    try {
      for await (const part of simulatedStream(paragraphs)) {
        if (part.kind === "text-delta" && part.channel === "output") {
          queue.push(part.text);
          process.stdout.write("·");
          continue;
        }

        const label = activityLabel(part);
        emittedActivities.push(label);
        renderedOrder.push(`activity:${label}`);
        process.stdout.write(
          `\n[+${Math.round(performance.now() - startedAt)}ms] INSTANT ${label}\n[response deltas buffered] `,
        );
      }
    } finally {
      queue.close();
    }
    await paragraphRenderer;

    expect(emittedParagraphs.map((chunk) => chunk.text)).toEqual(expectedParagraphs);
    expect(emittedParagraphs.map((chunk) => chunk.isFinal)).toEqual([false, false, true]);
    expect(emittedActivities).toEqual([
      "agent.started",
      "tool-call",
      "reasoning-text",
      "agent.progress",
      "tool-input-delta",
      "tool.result",
      "agent.summarizing",
      "agent.completed",
    ]);
    expect(renderedOrder.indexOf("activity:agent.started")).toBeLessThan(
      renderedOrder.indexOf("paragraph:0"),
    );

    process.stdout.write("\n\nVisual stream assertions passed.\n");
  });
});
