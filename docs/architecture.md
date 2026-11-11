# Architecture

Parastream separates the problem into four layers. A single provider adapter should not own transport decoding, protocol identification, and paragraph splitting at once.

```text
Response / byte or string source
  -> transport framing and UTF-8 decoding
  -> validated protocol-event detection
  -> normalized typed response parts
  -> text-unit segmentation
```

## 1. Transport framing

Transport framing recovers complete messages from arbitrary network chunks. It does not identify a model or decide which content is user-facing text.

- `text/event-stream`: parse Server-Sent Events, including multi-line `data`, comments, CRLF, CR, event names, `id`, and `retry`.
- `application/x-ndjson` / `application/ndjson` / `application/jsonl`: parse one JSON value per line, accepting a final line without a newline.
- `text/plain` and `text/markdown`: treat chunks as text deltas.
- Unknown or missing content types: require an explicit transport option rather than guessing.

Byte decoding must be incremental. A UTF-8 code point can span byte chunks, so use one streaming `TextDecoder` and flush it at end-of-stream.

For a `Response`, HTTP headers are the preferred transport signal. A bare `ReadableStream` has no headers, so callers must provide the framing format when it cannot be determined safely. Never interpret arbitrary text as SSE or JSON just because a chunk happens to start with `data:` or `{`.

Framing is also where two deliberate leniencies live, both documented because they differ from a strict reading of the specifications:

- An SSE frame still open at end of stream is flushed, so an upstream that closes immediately after its last `data` line still delivers that event. A truncated stream can therefore surface one partial frame the specification would have discarded.
- A `[DONE]` payload terminates the stream at the protocol layer, for SSE and NDJSON alike. `[DONE]` is an OpenAI-compatible convention, not part of either framing format.

Line and event sizes are bounded by `maxLineLength` and, for SSE, `maxEventLength`. Exceeding a bound throws instead of truncating.

## 2. Protocol detection

Protocol detection operates on a complete parsed event or SDK part. It checks a small set of discriminating fields with Zod schemas. It does not inspect model names, URLs, prompts, or arbitrary nested strings.

Some protocols are structurally similar. OpenAI-compatible providers intentionally share the Chat Completions event shape, so detection can say “OpenAI Chat Completions-compatible” but cannot prove which vendor served it. Some vendors ship several unrelated APIs, so detection names the API family, for example Gemini Generate Content as distinct from the Gemini Interactions API.

Detection prefers strong discriminators (an event `type`, a bounded set of typed event names, an AWS union member) over weaker structural hints, and it requires corroboration for ambiguous keys: a bare `metadata` field is not evidence of Bedrock, and `ping` belongs to Anthropic rather than the AI SDK.

When an event is ambiguous or unrecognized:

1. Use an explicit protocol hint if the caller knows the source.
2. Otherwise return an unrecognized event, preserving its raw value.
3. Do not guess a provider or emit arbitrary object fields as text.

Protocol detection is per event and stateless. Terminal events that carry only usage or finish metadata must still classify structurally: family envelopes such as the `response.*` type prefix, Gemini `candidates` finish/safety metadata, and `promptFeedback` are part of the detection signatures so a metadata-only tail event lands in the same family. An ambiguous first event must not be used to guess a protocol.

## 3. Normalized response parts

Adapters map provider-specific event shapes into a small typed union:

- `text-delta`: text on a distinct `channel` (`output`, `reasoning`, or `refusal`); reasoning and refusal are never implicitly merged into user-facing text.
- `tool-input-delta`: partial structured arguments, never prose.
- `tool-call`: a tool call was recognized.
- `control`: lifecycle, usage, finish, or other recognized non-text event.
- `unknown`: unrecognized event plus its raw payload.

An event that carries recognized structure but no text becomes a `control` rather than an empty `text-delta`, so consumers never see zero-length text.

Keep provider identifiers and useful block/item IDs where present: tool parts carry `toolCallId`, `toolName`, and `blockId` (the provider's tool-call id, name, and content-block/item index) so partial arguments from concurrent tool calls can be accumulated per call. A text segmenter consumes only the selected text channel. It must not merge text across distinct message/content blocks or reorder text around tool/control events. A streaming tool-call input is assembled into complete input when the provider signals completion; a call without arguments is treated as complete with empty input.

Controls are not all equivalent. Lifecycle and usage controls are informational, while an AI SDK `reset-step` invalidates parts already streamed for the current step. Parastream reports the event faithfully; a consumer that renders parts must decide how to apply it.

Zod schemas validate the fields the adapter reads and use passthrough behavior for forward compatibility. Strict validation of an entire provider object is brittle because providers can add optional fields and event types.

## 4. Text segmentation

Segmentation receives text deltas only. It is independent of the provider protocol and transport.

The current implementation supports paragraph splitting on adjacent LF or CRLF blank lines and line splitting on LF/CRLF. Sentence, word, grapheme, and custom strategies remain in the 0.0.1 development scope but are not implemented yet; each must specify how it holds back a suffix that could still grow. End-of-stream is an explicit flush boundary.

Text segmentation must state whether delimiters and surrounding whitespace are preserved. A size limit cannot silently split a unit while claiming it is complete; overflow must be explicit. Because a unit boundary can depend on characters that have not arrived yet, the delimiter lookahead is not charged against `maxBuffer`.

## Cross-layer invariants

- Preserve event ordering.
- Never treat tool arguments, image/audio payloads, or arbitrary JSON as prose.
- Decode UTF-8 across chunk boundaries correctly.
- Preserve source text exactly unless the caller opts into normalization.
- Respect cancellation and close the upstream reader/iterator when downstream consumption ends.
- Handle unknown event types without crashing solely because a provider extended its protocol.
- A recognized protocol hint that disagrees with the detected family fails loudly instead of silently dropping fields.

## Out of scope for 0.0.1

- Provider HTTP clients, authentication, retries, or request construction.
- Model-family or model-name classification.
- The Gemini Interactions API, and each vendor's newest API generation in general, until a dedicated adapter and fixtures exist.
- Raw AWS EventStream decoding, WebSocket protocols such as OpenAI's Responses WebSocket mode or live audio sessions, and native Hugging Face TGI token events.
- Parsing model-generated JSON, markdown ASTs, or partial tool JSON into application objects.
- Promise of support for every provider, gateway, API version, or multimodal response.
- Sentence/word/grapheme/custom segmentation and a public custom-adapter registry are not implemented yet.
- Provider wire formats that are not plain text, SSE, or NDJSON.
