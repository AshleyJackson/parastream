# Protocol detection and support

## Core rule

Detect the **wire protocol and event shape**, not the underlying model. Hundreds of models can use the same OpenAI-compatible API, and a provider can expose multiple incompatible API families at once. A model identifier alone is not a reliable signal.

Detection has two stages:

1. **Transport detection**: decide whether the body is plain text, SSE, or newline-delimited JSON. For a `Response`, use `Content-Type`. For an unlabelled stream, require an explicit transport when the framing is ambiguous.
2. **Payload detection**: validate a complete decoded event against known structural signatures. A recognized signature yields a protocol family; ambiguity yields `unknown`.

Do not mix the stages. An SSE frame tells us how a message was framed, not which vendor produced it.

## Detection signals

| Protocol family | Discriminator | Text extraction | Other data that must not become prose |
|---|---|---|---|
| `plain-text` | Explicit `text/plain`, `text/markdown`, a caller-selected text transport, or the `plain-text` hint | The chunk itself | None; no provider identity is inferred |
| `openai-chat-completions` | `choices[]` whose entries carry `delta` or `message`; an empty `choices` array counts when the event also has `usage`, `object`, `prompt_annotations`, or `prompt_filter_results` | `choices[].delta.content` string, or `{"type":"text"}` content parts | Tool-call argument fragments, `refusal`, `reasoning_content`, usage, finish reason, annotation chunks |
| `openai-responses` | Any event `type` starting with `response.`, or a top-level `error` event carrying `code`, `param`, or `sequence_number` | `response.output_text.delta` → `delta` | Refusal deltas, function-call arguments, reasoning text and summaries, annotations, lifecycle and usage events |
| `anthropic-messages` | A known event `type` (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`), or `{"type":"error","error":{"type":…}}` without `errorText` | `delta.type === "text_delta"` → `delta.text`; non-empty `text` on a text block start | `thinking_delta`, `signature_delta`, `input_json_delta`, `server_tool_use` and `web_search_tool_result` blocks, usage, error objects |
| `gemini-generate-content` | `candidates[]` with `content.parts`, candidate `finishReason`/`safetyRatings`/`index`, an empty `candidates` array with `usageMetadata`, or `promptFeedback` | Each non-empty `part.text` | Parts marked `thought: true` (reasoning channel), `functionCall`/`function_call`, `thoughtSignature`, inline media, code execution parts, finish/safety metadata |
| `ollama-chat` | `done` boolean plus a `message` object with `role` and at least one of `content`, `thinking`, `tool_calls` | `message.content` | `message.thinking`, tool calls, final metrics |
| `ollama-generate` | `done` boolean plus a `response` string | `response` | Metrics, `context`, `done_reason`, logprobs |
| `cohere-chat-v2` | A known typed event name such as `content-delta`, `tool-call-start`, or `message-end` | `delta.message.content.text` | Tool-call argument deltas, citations, tool plans, message lifecycle |
| `aws-bedrock-converse` | A single-key union member (`messageStart`, `contentBlockStart`, `contentBlockDelta`, `contentBlockStop`, `messageStop`, `metadata`, `internalServerException`, `modelStreamErrorException`, `serviceUnavailableException`, `throttlingException`, `validationException`), or any of those keys other than a bare `metadata` | `contentBlockDelta.delta.text` | Reasoning text, tool-use input fragments, citation/image/tool-result deltas, metadata, exception members |
| `ai-sdk` | A recognized part `type`, such as `text-delta`, `reasoning-delta`, `refusal-delta`, `tool-input-delta`, `start-step`, `finish`, `abort`, `error`, or a `data-*` type | `text-delta` `text` or `delta`; `reasoning-delta`; `refusal-delta` | Tool input and tool lifecycle parts, step lifecycle (`reset-step` included), sources, files, data parts, approvals, provider metadata |
| `unknown` | No signature matched | None | The raw payload is preserved |

Detection runs in this order, because some discriminators are weaker than others: Responses `type` prefix, Anthropic event names, the Anthropic error envelope, the Responses error envelope, AI SDK `tool-call-delta`, Cohere event names, then structural checks for Ollama, Bedrock, Chat Completions, and Gemini candidates, and finally the general AI SDK type set. `metadata` alone is never enough to claim Bedrock, and `{"type":"ping"}` is Anthropic keep-alive rather than an AI SDK part.

The exact schema is version-sensitive. Each adapter validates only the discriminating fields it consumes, retains unknown keys, and is tested against fixtures taken from the provider's current documentation.

## Support matrix

Supported today, at the level of documented event shapes:

| Source | How it is supported |
|---|---|
| OpenAI Chat Completions-compatible SSE | Text, refusal, reasoning (`reasoning_content`), tool calls and argument fragments, controls; `[DONE]` terminates |
| OpenAI Responses SSE | Output text, refusals, reasoning text and summaries, function-call arguments, controls |
| Anthropic Messages SSE | Output text, thinking, tool-use starts and partial JSON, controls; unknown event types preserved |
| Gemini `streamGenerateContent` (`?alt=sse`) | Candidate text, thought parts, function calls, controls |
| Ollama `/api/chat` and `/api/generate` NDJSON | Text, thinking, tool calls, controls |
| Cohere Chat v2 SSE | Content deltas, tool-call starts and argument deltas, controls |
| Bedrock ConverseStream SDK events | Text, reasoning, tool-use starts and input fragments, controls and exception members |
| Vercel AI SDK core parts and UI message data stream | Text, reasoning, refusals, tool input and calls, controls |
| Plain text (`text/plain`, `text/markdown`) | Each chunk is an output text delta |
| Mistral, Azure OpenAI, TGI OpenAI-compatible endpoint, other compatible gateways | The shared Chat Completions adapter when the actual emitted chunks match `choices[].delta` |

Recognized framing that Parastream deliberately does not normalize:

| Source | Status |
|---|---|
| Gemini **Interactions API** SSE (`interaction.created`, `step.delta`, `interaction.completed`) | Not supported. Events carry `event_type`, not `type`, and have no `candidates` array, so they surface as `unknown` rather than being mistaken for Generate Content. |
| Raw AWS EventStream binary framing | Not supported. Pass SDK-decoded ConverseStream event objects instead. |
| Hugging Face TGI native `textGenerationStream` (`token.text`) | Not supported. Its OpenAI-compatible endpoint is. |
| OpenAI Responses WebSocket mode | Not supported; Parastream reads byte or decoded-event streams, not sockets. |
| AI SDK text stream protocol | Supported as plain text, since it is a text stream with no parts. |
| Provider SDK token events for other vendors, audio/video session protocols | Not supported; unknown payloads are preserved, never searched recursively for text. |

## Framing behavior

- `Content-Type: text/event-stream` → SSE. Blank lines dispatch a frame, multiple `data` lines are joined with `\n`, comments are ignored, `id` is ignored when it contains a NULL, `retry` must be digits, and `event` names are preserved.
- `application/x-ndjson`, `application/ndjson`, `application/jsonl` → NDJSON. Blank lines are skipped, a final line without a newline is parsed, and invalid JSON raises an error naming the line.
- `text/plain`, `text/markdown` → text.
- Any other or missing content type requires an explicit `transport`, and an unlabelled byte stream always does.

Two SSE behaviors are intentional and worth knowing:

- A frame that is still open at end of stream is **flushed**, so an upstream that closes right after its last `data` line does not lose that event. The SSE specification discards such a frame.
- A `data` payload of `[DONE]` terminates the stream at the protocol layer. `[DONE]` is a provider convention, not part of SSE or NDJSON; NDJSON framing accepts it as a documented extension.
- Frames with no `data` field, or with empty data, produce no part. That matches the specification's empty-data-buffer behavior and covers keep-alives.

## Compatibility boundary

“OpenAI-compatible” is a protocol claim, not a vendor claim. Ollama also provides its own NDJSON API in addition to compatibility modes. Gemini has both Generate Content and Interactions, Mistral has Chat and Responses, and the AI SDK has core parts, a UI data stream, and a plain text stream. Each documented shape needs its own adapter, and support is scoped per shape.

The 0.0.1 implementation extracts text from these documented text-capable stream families. It is not a promise to normalize every modality. Images, audio, video, tool arguments, reasoning, refusals, and structured data remain separate typed parts, and applications choose what to expose. Azure moderation annotations and Bedrock citations/images are controls rather than text, so a filtered or cited response cannot silently read as ordinary prose.

Future custom integrations should be able to register an adapter with:

- a stable protocol identifier;
- a Zod predicate/schema for the minimum discriminating shape;
- a normalizer that emits typed parts;
- fixtures proving chunk-boundary, ordering, unknown-field, and unknown-event behavior.

Version 0.0.1 does not yet expose a public adapter registry.

## Failure behavior

- Malformed JSON in an SSE or NDJSON frame: surface a parse error with frame context; do not silently drop it. Spec-legal frames with empty `data` are skipped instead.
- Structurally valid but unknown payload: preserve it as `unknown`.
- Known protocol hint with a shape mismatch: return a validation error; do not silently fall back to another adapter.
- A protocol hint other than `plain-text` combined with the text transport: rejected explicitly, because plain text carries no protocol events.
- A hint that disagrees with a detected family: rejected, so a misrouted gateway fails loudly instead of silently dropping fields.
- Unsupported transport or binary frame: return an explicit unsupported-format error.
- New fields on a known event: accepted and preserved.
- New event type: preserved as `unknown`, with any `event:` name attached for identification.

## Re-checking support

`docs/protocol-research.md` records the sources behind each row above, and `tests/fixtures/README.md` lists the fixture that pins each shape. Provider previews move; re-read the primary documentation before widening a claim.
