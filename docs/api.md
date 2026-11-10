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

| Source | Behavior |
|---|---|
| `Response` | `Content-Type` selects SSE, NDJSON, or text; anything else needs an explicit `transport` |
| Decoded event objects (iterable, async iterable, or `ReadableStream`) | Protocol detection runs per event; an explicit `transport` is rejected |
| Strings or bytes (iterable, async iterable, or `ReadableStream`) | Default to plain text; an unlabelled byte stream requires `transport: "sse"` or `"ndjson"` |
| A bare string | Plain text unless a transport is specified |

`application/json` is not assumed to be streaming. Pass a protocol/transport explicitly, or decode a non-streaming response separately.

Options are Zod-validated:

```ts
normalizeAIStream(source, {
  transport: "sse", // "auto" | "text" | "sse" | "ndjson"
  protocol: "openai-responses", // "auto" or a supported protocol
  maxLineLength: 1_000_000, // maximum SSE/NDJSON line length
  maxEventLength: 1_000_000, // maximum combined data of one SSE event
  signal: abortController.signal,
});
```

| Option | Default | Behavior |
|---|---|---|
| `transport` | `"auto"` | Framing choice. `"auto"` reads a `Response` content type and treats string chunks as plain text |
| `protocol` | `"auto"` | Adapter choice. Ignored framing evidence is never overridden silently: a conflicting detection throws |
| `maxLineLength` | `1_000_000` | Longest accepted SSE or NDJSON line; overflow throws with the line number |
| `maxEventLength` | `1_000_000` | Longest combined `data` payload in one SSE event; overflow throws |
| `signal` | `undefined` | Aborting cancels upstream reads and rejects iteration with the signal reason |

### Transport behavior

- Content types: `text/event-stream` → SSE; `application/x-ndjson`, `application/ndjson`, `application/jsonl` → NDJSON; `text/plain`, `text/markdown` → text. Any other or missing type throws unless `transport` says otherwise.
- A `data: [DONE]` payload ends the stream. This is an OpenAI-compatible convention rather than part of SSE or NDJSON, and it is honored for both framings.
- SSE frames with no `data` field, or with empty data, produce no part; they are keep-alives, matching the specification's empty-data-buffer rule.
- An SSE frame that is still open at end of stream is flushed, so a stream that closes right after its last `data` line still yields that event. The SSE specification would discard it.
- Malformed JSON inside an SSE frame throws a `SyntaxError` naming the event; malformed NDJSON throws a `SyntaxError` naming the line.
- NDJSON blank lines are skipped, and a final line without a trailing newline is parsed.
- When an SSE `event:` name is used for detection, `raw` still holds the original provider payload rather than the annotated record.
- A protocol hint other than `auto`/`plain-text` combined with the `text` transport throws, because plain text carries no protocol events.
- The `plain-text` hint also works on decoded values: `normalizeResponseEvent(value, "plain-text")` accepts a string payload and rejects anything else.

### Single-event helpers

Whole streams are the usual entry point, but each layer is exported for gateways, adapters, and tests:

```ts
import { detectResponseProtocol, identifyResponseProtocol, normalizeResponseEvent } from "parastream";

const family = detectResponseProtocol(event); // "openai-responses", "unknown", …
const parts = normalizeResponseEvent(event); // NormalizedPart[]
const hinted = normalizeResponseEvent(event, "ai-sdk"); // explicit adapter
```

`identifyResponseProtocol(value)` is an alias for `detectResponseProtocol(value)` and exists for callers that inspect one event before choosing an adapter. Detection is stateless and per event; see [protocol detection](protocol-detection.md) for the signals it uses.

An explicit hint that disagrees with a recognized family throws, and a hint whose envelope does not match the payload throws. Unknown event types under an explicit hint remain `unknown` parts instead of failing the stream. Unknown shapes are never searched recursively for strings named `text`.

### Normalized part kinds

- `text-delta`: `channel` is `output`, `reasoning`, or `refusal`; `blockId` carries the provider's content-block, choice, candidate, or item index where present.
- `tool-input-delta`: partial tool arguments; carries `toolCallId`, `toolName`, and `blockId` where the provider supplies them.
- `tool-call`: a tool call was recognized; carries the same identity fields so concurrent tool calls can be told apart.
- `control`: recognized lifecycle, usage, finish, or metadata event; `eventType` names it when the provider supplies a name.
- `unknown`: unrecognized event; `raw` is retained.

Channel assignments by family, where the provider distinguishes them:

| Family | `output` | `reasoning` | `refusal` |
|---|---|---|---|
| OpenAI Chat Completions | `delta.content` | `reasoning_content` | `refusal` |
| OpenAI Responses | `response.output_text.delta` | `response.reasoning_text.delta`, `response.reasoning_summary_text.delta` | `response.refusal.delta` |
| Anthropic Messages | `text_delta`, non-empty text block start | `thinking_delta`, non-empty thinking block start | — |
| Gemini Generate Content | `part.text` | `part.text` where `part.thought === true` | — |
| Ollama chat | `message.content` | `message.thinking` | — |
| Cohere Chat v2 | `delta.message.content.text` | — | — |
| Bedrock ConverseStream | `delta.text` | `delta.reasoningContent.reasoningText.text` | — |
| Vercel AI SDK | `text-delta` | `reasoning-delta` | `refusal-delta` |

The API does not combine reasoning or refusal with output. Consumers must deliberately select a channel. An event that carries recognized structure but no text becomes a `control` instead of an empty `text-delta`.

### Tool identity

Identity fields are reported only where the provider supplies them, and the identifier available on an argument delta is not always the same one a tool-call start carries:

| Family | Tool call | Argument deltas |
|---|---|---|
| OpenAI Chat Completions | `tool_calls[].id`, `function.name`, `blockId` = tool index (else choice index) | `blockId` = tool index; `toolCallId` appears only on chunks that repeat `id` |
| OpenAI Responses | `call_id` (else item id), `name`, `blockId` = `output_index` | `toolCallId` carries `item_id`, so pair with the tool call by `blockId` |
| Anthropic Messages | `id`, `name`, `blockId` = content block index | `blockId` = content block index |
| Gemini Generate Content | `functionCall.id` when present, name, `blockId` = candidate index | None: arguments arrive as a complete object on the part |
| Ollama chat | `function.name`; the API supplies no call id | None: arguments arrive as a complete object |
| Cohere Chat v2 | `id`, function name, `blockId` = event `index` | `blockId` = event `index` |
| Bedrock ConverseStream | `toolUseId`, name, `blockId` = `contentBlockIndex` | `blockId` = `contentBlockIndex` |
| Vercel AI SDK | `toolCallId`, `toolName` | `toolCallId`, `toolName` |

Tool arguments stay separate from prose in every family, because their shape differs: OpenAI, Anthropic, Cohere, Bedrock, and the AI SDK deliver partial argument strings, while Gemini and Ollama deliver complete argument objects and therefore produce `tool-call` parts without a preceding `tool-input-delta`. Complete input is exposed as `tool-call.input` when supplied by Gemini, Ollama, or an AI SDK tool-call part.

## Assemble a message

`createMessageAssembler(options?)` is a synchronous push reducer over `NormalizedPart`; it does not own or read a stream. `push(part)` returns ordered `AssemblerEvent[]`. `finish()` closes the assembler and reports unfinished tool calls; `cancel()` closes it without synthesizing completion. Both are terminal. `state` returns a detached snapshot and remains readable after closing.

```ts
const assembler = createMessageAssembler({ toolInput: "json" });
for await (const part of normalizeAIStream(response)) {
  for (const event of assembler.push(part)) handle(event);
}
for (const event of assembler.finish()) handle(event);
console.log(assembler.state.text, assembler.state.textBlocks, assembler.state.toolCalls);
```

`text`, `reasoning`, and `refusal` are accumulated in arrival order. `textBlocks` separately groups text by protocol, channel, and `blockId`; absent IDs share one block per channel. The output text is not reconstructed by concatenating blocks, since blocks can interleave. `toolCalls` contain IDs when known, `inputText`, a status, and, in JSON mode after successful completion, parsed `input`.

| Option | Default | Behavior |
|---|---|---|
| `channels` | all three | Select text channels to retain and emit |
| `toolInput` | `"json"` | `"json"` parses at completion; `"text"` retains text without parsing; `"off"` retains no arguments |
| `maxTextChars` | `2_000_000` | Total retained text across channels, measured in UTF-16 code units |
| `maxToolInputChars` | `200_000` | Total retained serialized tool input across calls, measured in UTF-16 code units |
| `maxEntries` | `10_000` | Maximum combined text blocks and tool calls; exceeding it always throws |
| `onOverflow` | `"throw"` | Throw `RangeError`, or `"truncate-marked"` and mark the affected block/call and state |

These limits bound retained content and entry counts, not arbitrary provider event/identifier sizes, transport buffers, JSON parsing allocations, or snapshots held by the caller. Aggregate text duplicates block content and a step checkpoint can temporarily duplicate state. Truncated tool input is never parsed or presented as complete; a `tool-input-error` reports `truncated`. Truncated text events contain only retained characters; inspect `state.truncated` and each block's `truncated` flag.

Events include `text`, `tool-input`, `tool-call`, `tool-call-complete`, `tool-input-error`, `reset`, and `control`. `control` also carries unrecognized parts so consumers can inspect `raw`. JSON parse errors are events with reason `invalid-json`, not exceptions. A pending call at `finish()` has status and error reason `incomplete`; EOF alone does not prove success. The assembler recognizes tool completion from AI SDK `tool-input-end` or a complete tool-call input, OpenAI Responses argument-done, Anthropic block-stop, Cohere tool-call-end, Bedrock block-stop, and OpenAI Chat's `tool_calls` finish control. Full Gemini and Ollama inputs complete immediately. Completion is not a tool execution or a guarantee that the provider's stream succeeded; handle failure controls before acting.

Tool correlation uses protocol plus block ID where present, otherwise tool call ID. OpenAI Responses uses its output index to bridge different call and item IDs. Provider IDs can be missing or insufficient: for example, Chat Completions tool indexes are not scoped by choice in the normalized model, so simultaneous tool calls from multiple choices cannot be reliably assembled; unidentified concurrent calls may also collide. Use raw events or separate streams when identity is ambiguous. A new AI SDK step starts a new tool identity scope.

AI SDK `start-step`/`step-start` takes a checkpoint; `reset-step` restores that checkpoint and emits `reset` with a detached `state` snapshot. Without a checkpoint, it emits `reset` but does not change state. `finish-step` commits the checkpoint. Previously delivered events and external side effects cannot be undone: a consumer must retract them on `reset`, and should defer irreversible actions until its own policy permits them.

`consume(source, handlers?, options?)` combines `normalizeAIStream` and an assembler and returns the final `MessageState`. Pass normalization options in `options.normalize` and assembler options in `options.assembler`. Handler names are `event` (all events), `text`, `toolInput`, `toolCall`, `toolCallComplete`, `toolInputError`, `reset`, and `control`. The generic handler runs before the specific handler; each is awaited in order, providing backpressure. A handler exception closes the upstream iterator and rejects `consume`; a normalization abort signal also stops consumption and rejects with its reason. An already-running handler is not forcibly interrupted: it must cooperate with cancellation itself. `consume` accepts the same sources as `normalizeAIStream`, not an iterable of already normalized parts; use the push reducer for those.

## Web Streams adapters

`normalizeAIReadableStream(source, options?)` exposes the same normalized parts as a `ReadableStream<NormalizedPart>` with a queue size of one. Cancelling it aborts the source iterator.

```ts
import { partFilterTransform, segmentTextTransform, selectTextTransform } from "parastream";

const paragraphs = normalizeAIReadableStream(response)
  .pipeThrough(partFilterTransform({ textChannels: ["output"] }))
  .pipeThrough(selectTextTransform({ channel: "output" }))
  .pipeThrough(segmentTextTransform({ unit: "paragraph" }));
```

| Helper | Input → output | Notes |
|---|---|---|
| `selectTextTransform({ channel })` | `NormalizedPart` → `string` | Drops every non-text part; `channel` defaults to `"output"` |
| `partFilterTransform({ textChannels? })` | `NormalizedPart` → `NormalizedPart` | Omits the listed text channels and keeps every non-text part; omit `textChannels` to pass all parts through |
| `segmentTextTransform(options)` | `string` → `ParaChunk` | Emits the final residual from `flush()` with `isFinal: true` |

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
| `maxBuffer` | `1_000_000` | Maximum pending unit content in UTF-16 code units; overflow throws instead of splitting. A possible trailing delimiter prefix is not charged against the budget |
| `signal` | `undefined` | Cancels upstream consumption when aborted |

Paragraph boundaries are adjacent `\n\n`, `\n\r\n`, or `\r\n\r\n`. Line boundaries are `\n` and `\r\n`. Blank lines containing spaces between line endings are not treated as paragraph boundaries yet.

A boundary with no content is not a unit: consecutive delimiters are folded into the next emitted unit's text (with `includeDelimiter: true`) so no empty chunks are produced. For example, `"a\n\n\n\nb"` segments to `["a\n\n", "\n\nb"]`.

Defaults are lossless: `trim: false`, `includeDelimiter: true`. If delimiters are excluded or text is trimmed, exact reconstruction is not guaranteed. A residual unit is emitted on end-of-stream with `isFinal: true`; a stream ending immediately after a delimiter has no extra final chunk.

Sentence, word, grapheme, custom splitter, and push controllers remain in the 0.0.1 development scope but are not implemented.

Both stream-normalization and text-segmentation options accept an `AbortSignal`. Aborting stops upstream reads and rejects iteration with the signal reason.

## Low-level framers

The transport parsers are exported for callers that need frames without normalization:

```ts
import { parseSSE, parseNDJSON, decodeTextChunks, sourceValues } from "parastream";

for await (const frame of parseSSE(response.body!)) {
  // { data: string, event?: string, id?: string, retry?: number }
}

for await (const value of parseNDJSON(response.body!)) {
  // one parsed JSON value per line; a [DONE] line ends iteration
}
```

- `parseSSE` and `parseNDJSON` accept a string, `Uint8Array`, iterable, async iterable, or `ReadableStream` of chunks, and apply their own line/event limits.
- `decodeTextChunks` performs the incremental UTF-8 decode; `sourceValues` normalizes any accepted source into an async iterable of raw chunks, cancelling a locked reader when the signal aborts.

## Errors

| Condition | Error |
|---|---|
| Unsupported or missing content type without an explicit transport | `TypeError` naming the content type |
| Byte stream with `transport: "auto"` | `TypeError` telling the caller to choose a transport |
| Explicit text/SSE/NDJSON transport with non-string, non-byte chunks | `TypeError` |
| Protocol hint that conflicts with a detected family, or does not match the payload | `TypeError` |
| Malformed JSON in an SSE frame or NDJSON line | `SyntaxError` naming the event or line |
| Line or SSE event over its size limit | `RangeError` |
| Pending unit over `maxBuffer` | `RangeError` |
| Abort signal fired | The signal's reason |
