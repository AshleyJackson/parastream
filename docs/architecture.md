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

- `text/event-stream`: parse Server-Sent Events, including multi-line `data`, comments, CRLF, and event names.
- `application/x-ndjson` / `application/ndjson` / `application/jsonl`: parse one JSON value per line.
- Plain text: treat chunks as text deltas.
- Unknown content types: require an explicit transport option rather than guessing.

Byte decoding must be incremental. A UTF-8 code point can span byte chunks, so use one streaming `TextDecoder` and flush it at end-of-stream.

For a `Response`, HTTP headers are the preferred transport signal. A bare `ReadableStream` has no headers, so callers must provide the framing format when it cannot be determined safely. Never interpret arbitrary text as SSE or JSON just because a chunk happens to start with `data:` or `{`.

## 2. Protocol detection

Protocol detection operates on a complete parsed event or SDK part. It checks a small set of discriminating fields with Zod schemas. It does not inspect model names, URLs, prompts, or arbitrary nested strings.

Some protocols are structurally similar. OpenAI-compatible providers intentionally share the Chat Completions event shape, so detection can say “OpenAI Chat Completions-compatible” but cannot prove which vendor served it.

When an event is ambiguous or unrecognized:

1. Use an explicit protocol hint if the caller knows the source.
2. Otherwise return an unrecognized event, preserving its raw value.
3. Do not guess a provider or emit arbitrary object fields as text.

Protocol detection is per event. A stream-level adapter may remember a positively detected protocol for later events that contain only usage or finish metadata, but it must not infer the initial protocol from an ambiguous metadata-only event.

## 3. Normalized response parts

Adapters map provider-specific event shapes into a small typed union:

- `text-delta`: user-facing text.
- `reasoning-delta`: a distinct channel, never implicitly merged into user-facing text.
- `refusal-delta`: a distinct channel.
- `tool-input-delta`: partial structured arguments, never prose.
- `control`: lifecycle, usage, finish, or other recognized non-text event.
- `unknown`: unrecognized event plus its raw payload.

Keep provider identifiers and useful block/item IDs where present. A text segmenter consumes only the selected text channel. It must not merge text across distinct message/content blocks or reorder text around tool/control events.

Zod schemas validate the fields the adapter reads and use passthrough behavior for forward compatibility. Strict validation of an entire provider object is brittle because providers can add optional fields and event types.

## 4. Text segmentation

Segmentation receives text deltas only. It is independent of the provider protocol and transport.

The current implementation supports paragraph splitting on adjacent LF or CRLF blank lines and line splitting on LF/CRLF. Sentence, word, grapheme, and custom strategies remain in the 0.0.1 development scope but are not implemented yet; each must specify how it holds back a suffix that could still grow. End-of-stream is an explicit flush boundary.

Text segmentation must state whether delimiters and surrounding whitespace are preserved. A size limit cannot silently split a unit while claiming it is complete; overflow must be explicit.

## Cross-layer invariants

- Preserve event ordering.
- Never treat tool arguments, image/audio payloads, or arbitrary JSON as prose.
- Decode UTF-8 across chunk boundaries correctly.
- Preserve source text exactly unless the caller opts into normalization.
- Respect cancellation and close the upstream reader/iterator when downstream consumption ends.
- Handle unknown event types without crashing solely because a provider extended its protocol.

## Out of scope for 0.0.1

- Provider HTTP clients, authentication, retries, or request construction.
- Model-family or model-name classification.
- Arbitrary WebSocket/binary protocols such as live audio sessions.
- Parsing model-generated JSON, markdown ASTs, or partial tool JSON into application objects.
- Promise of support for every provider, gateway, API version, or multimodal response.
- Sentence/word/grapheme/custom segmentation and a public custom-adapter registry are not implemented yet.
- Provider wire formats that are not plain text, SSE, or NDJSON (for example raw AWS EventStream or WebSocket binary frames).
