# API contract (0.0.1 development)

This is the contract of the current source tree. It is not a stable semver promise.

## Normalize AI stream events

`normalizeAIStream(source, options?)` yields `NormalizedPart` values:

```ts
import { normalizeAIStream } from "parastream";

for await (const part of normalizeAIStream(response)) {
  if (part.kind === "text-delta" && part.channel === "output") {
    render(part.text);
  }
}
```

Supported source forms:

- `Response`: `Content-Type` selects `text`, `sse`, or `ndjson`.
- Iterable/async iterable/Web `ReadableStream` of parsed event objects: protocol detection runs per event.
- Iterable/async iterable of strings: treated as plain text by default.
- Unlabelled byte streams: require `transport: "text" | "sse" | "ndjson"`.
- A bare string: treated as plain text unless a transport is specified.

`application/json` is not assumed to be streaming. Pass a protocol/transport explicitly or decode a non-streaming response separately.

Options are Zod-validated:

```ts
normalizeAIStream(source, {
  transport: "sse", // "auto" | "text" | "sse" | "ndjson"
  protocol: "openai-responses", // "auto" or a supported protocol
  signal: abortController.signal,
});
```

An explicit protocol hint that conflicts with a recognized envelope throws. Unknown event types under an explicit hint remain `unknown` parts. Unknown shapes are never searched recursively for strings named `text`.

### Normalized part kinds

- `text-delta`: `channel` is `output`, `reasoning`, or `refusal`.
- `tool-input-delta`: partial tool arguments.
- `tool-call`: a tool call was recognized.
- `control`: recognized lifecycle, usage, or metadata event.
- `unknown`: unrecognized event; `raw` is retained.

The API does not combine reasoning/refusal with output. Consumers must deliberately select a channel.

## Segment text

`parastream(source, options?)` segments text chunks. `parastreamChunks()` additionally supplies `index`, `unit`, and `isFinal`.

```ts
import { parastream } from "parastream";

for await (const paragraph of parastream(textDeltas, {
  unit: "paragraph",
  includeDelimiter: false,
})) {
  render(paragraph);
}
```

Current options:

| Option | Default | Behavior |
|---|---|---|
| `unit` | `"paragraph"` | `"paragraph"` or `"line"` |
| `trim` | `false` | Trims unit content; opt-in and therefore not lossless |
| `includeDelimiter` | `true` | Keeps the boundary in the emitted value |
| `maxBuffer` | `1_000_000` | Maximum pending unit size in UTF-16 code units; overflow throws instead of splitting |
| `signal` | `undefined` | Cancels upstream consumption when aborted |

Paragraph boundaries are adjacent `\n\n`, `\n\r\n`, or `\r\n\r\n`. Line boundaries are `\n` and `\r\n`. Blank lines containing spaces between line endings are not treated as paragraph boundaries yet.

Defaults are lossless: `trim: false`, `includeDelimiter: true`. If delimiters are excluded or text is trimmed, exact reconstruction is not guaranteed. A residual unit is emitted on end-of-stream with `isFinal: true`; a stream ending immediately after a delimiter has no extra final chunk.

Sentence, word, grapheme, custom splitter, push controller, and AI SDK `TransformStream` integration remain in the 0.0.1 development scope but are not implemented in this initial baseline.

Both stream-normalization and text-segmentation options accept an `AbortSignal`. Aborting stops upstream reads and rejects iteration with the signal reason.
