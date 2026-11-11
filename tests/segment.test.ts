import { describe, expect, test } from "bun:test";
import { paratoken, paratokenChunks } from "../src/index.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of source) output.push(value);
  return output;
}

describe("paratoken", () => {
  test("preserves paragraph separators and residual text by default", async () => {
    const source = ["First paragraph\n", "\nSecond\r\n", "\r\nLast paragraph"];
    const chunks = await collect(paratoken(source));

    expect(chunks).toEqual(["First paragraph\n\n", "Second\r\n\r\n", "Last paragraph"]);
    expect(chunks.join("")).toBe(source.join(""));
  });

  test("supports LF lines and optional delimiter removal", async () => {
    const chunks = await collect(
      paratoken(["one\ntwo", "\nthree"], {
        unit: "line",
        includeDelimiter: false,
      }),
    );

    expect(chunks).toEqual(["one", "two", "three"]);
  });

  test("marks only end-of-stream residuals as final", async () => {
    const chunks = await collect(
      paratokenChunks("One\n\nTwo", { unit: "paragraph" }),
    );

    expect(chunks.map(({ text, isFinal }) => [text, isFinal])).toEqual([
      ["One\n\n", false],
      ["Two", true],
    ]);
  });

  test("applies trim only when requested and preserves a delimiter", async () => {
    const chunks = await collect(
      paratoken("  text  \n\n", { trim: true }),
    );

    expect(chunks).toEqual(["text\n\n"]);
  });

  test("rejects an unbounded semantic unit instead of splitting it", async () => {
    await expect(
      collect(paratoken("12345", { maxBuffer: 4 })),
    ).rejects.toThrow(RangeError);
  });

  test("does not charge a trailing delimiter against maxBuffer", async () => {
    expect(await collect(paratoken("1234\n\n", { maxBuffer: 4 }))).toEqual([
      "1234\n\n",
    ]);
    expect(
      await collect(paratoken("1234\r\n", { unit: "line", maxBuffer: 4 })),
    ).toEqual(["1234\r\n"]);
    await expect(
      collect(paratoken("12345\n\n", { maxBuffer: 4 })),
    ).rejects.toThrow(RangeError);
  });

  test("folds empty paragraph boundaries into the next unit", async () => {
    const chunks = await collect(paratoken("a\n\n\n\nb"));
    expect(chunks).toEqual(["a\n\n", "\n\nb"]);
    expect(chunks.join("")).toBe("a\n\n\n\nb");

    expect(
      await collect(paratoken("a\n\n\n\nb", { includeDelimiter: false })),
    ).toEqual(["a", "b"]);

    expect(await collect(paratoken("\n\nb"))).toEqual(["\n\nb"]);
    expect(await collect(paratoken("\n\n"))).toEqual(["\n\n"]);
    expect(await collect(paratoken("\n\n", { includeDelimiter: false }))).toEqual([]);
  });

  test("validates options with Zod", async () => {
    await expect(
      collect(paratoken("text", { maxBuffer: 0 })),
    ).rejects.toThrow();
    await expect(
      collect(paratoken("text", { unit: "sentence" as "paragraph" })),
    ).rejects.toThrow();
    await expect(collect(paratoken(42 as never))).rejects.toThrow();
    await expect(collect(paratoken([42] as never))).rejects.toThrow();
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

    for await (const value of paratoken(source())) {
      expect(value).toBe("first\n\n");
      break;
    }

    expect(returned).toBe(true);
  });

  test("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(paratoken("text", { signal: controller.signal })),
    ).rejects.toHaveProperty("name", "AbortError");
  });
});
