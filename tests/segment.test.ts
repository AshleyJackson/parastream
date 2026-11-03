import { describe, expect, test } from "bun:test";
import { parastream, parastreamChunks } from "../src/index.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of source) output.push(value);
  return output;
}

describe("parastream", () => {
  test("preserves paragraph separators and residual text by default", async () => {
    const source = ["First paragraph\n", "\nSecond\r\n", "\r\nLast paragraph"];
    const chunks = await collect(parastream(source));

    expect(chunks).toEqual(["First paragraph\n\n", "Second\r\n\r\n", "Last paragraph"]);
    expect(chunks.join("")).toBe(source.join(""));
  });

  test("supports LF lines and optional delimiter removal", async () => {
    const chunks = await collect(
      parastream(["one\ntwo", "\nthree"], {
        unit: "line",
        includeDelimiter: false,
      }),
    );

    expect(chunks).toEqual(["one", "two", "three"]);
  });

  test("marks only end-of-stream residuals as final", async () => {
    const chunks = await collect(
      parastreamChunks("One\n\nTwo", { unit: "paragraph" }),
    );

    expect(chunks.map(({ text, isFinal }) => [text, isFinal])).toEqual([
      ["One\n\n", false],
      ["Two", true],
    ]);
  });

  test("applies trim only when requested and preserves a delimiter", async () => {
    const chunks = await collect(
      parastream("  text  \n\n", { trim: true }),
    );

    expect(chunks).toEqual(["text\n\n"]);
  });

  test("rejects an unbounded semantic unit instead of splitting it", async () => {
    await expect(
      collect(parastream("12345", { maxBuffer: 4 })),
    ).rejects.toThrow(RangeError);
  });

  test("validates options with Zod", async () => {
    await expect(
      collect(parastream("text", { maxBuffer: 0 })),
    ).rejects.toThrow();
    await expect(
      collect(parastream("text", { unit: "sentence" as "paragraph" })),
    ).rejects.toThrow();
    await expect(collect(parastream(42 as never))).rejects.toThrow();
    await expect(collect(parastream([42] as never))).rejects.toThrow();
  });

  test("supports async iterables and returns upstream on early cancellation", async () => {
    let returned = false;
    async function* source() {
      try {
        yield "first\n\n";
        yield "second\n\n";
      } finally {
        returned = true;
      }
    }

    for await (const value of parastream(source())) {
      expect(value).toBe("first\n\n");
      break;
    }

    expect(returned).toBe(true);
  });

  test("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(parastream("text", { signal: controller.signal })),
    ).rejects.toHaveProperty("name", "AbortError");
  });
});
