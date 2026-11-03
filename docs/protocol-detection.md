# Protocol detection and support

## Core rule

Detect the **wire protocol and event shape**, not the underlying model. Hundreds of models can use the same OpenAI-compatible API, and a provider can expose multiple incompatible API families. A model identifier alone is not a reliable signal.

Detection has two stages:

1. **Transport detection**: determine whether the body is plain text, SSE, or newline-delimited JSON. For a `Response`, prefer `Content-Type`. For an unlabelled stream, require an explicit transport when the framing is ambiguous.
2. **Payload detection**: validate a complete decoded event against known structural signatures. A recognized signature yields a protocol family; ambiguity yields `unknown`.

Do not mix the stages. An SSE frame tells us how a message was framed, not which vendor produced it.

## Detection signals

| Protocol family | Strong event signal | Text extraction | Other data that must not become prose |
|---|---|---|---|
| OpenAI Chat Completions-compatible | `choices[]` with `delta` (or a complete `message`) | `choices[].delta.content` string or recognized text parts | tool-call argument deltas, refusal, usage, finish reason |
| OpenAI Responses | known `response.*` event `type` | `response.output_text.delta` → `delta` | refusal, function-call arguments, reasoning summaries, lifecycle events |
| Anthropic Messages | event `type` such as `content_block_delta`, paired with block/delta type | `delta.type === "text_delta"` → `delta.text` | `thinking_delta`, partial tool `input_json_delta`, signatures, ping, usage |
| Gemini `streamGenerateContent` | `candidates[]` containing `content.parts[]` | each `part.text` string | `thought` channel, function calls, inline media, candidate finish/safety metadata |
| Ollama `/api/chat` | `message` object plus boolean `done` | `message.content` | `message.thinking`, tool calls, final metrics |
| Ollama `/api/generate` | `response` string plus boolean `done` | `response` | final metrics, context, done reason |
| Cohere Chat v2 | typed hyphenated event names such as `content-delta` | `delta.message.content.text` | tool-call deltas, citations, message lifecycle |
| AWS Bedrock ConverseStream SDK | event-union key such as `contentBlockDelta` | `contentBlockDelta.delta.text` | reasoning, tool-use input, image/audio blocks, metadata |
| Vercel AI SDK core parts | recognized `type` discriminant, such as `text-delta` or `reasoning-delta` | only the field defined for the matching SDK part | tool parts, step/lifecycle parts, provider metadata |
| Vercel AI SDK UI data stream | SSE JSON with UI part `type`, e.g. `text-delta`, `text-start`, `text-end` | `text-delta.delta` | reasoning, data, source, tool, file, error, and control parts |
| Plain text | explicit `text/plain` or caller-selected text transport | each text chunk | none; no provider identity is inferred |

The exact schema is version-sensitive. Each adapter should validate only the discriminating fields it consumes, retain unknown keys, and be tested against fixtures from the provider’s current documentation.

Mistral Chat, Azure OpenAI Chat Completions, and Hugging Face TGI’s OpenAI-compatible Messages endpoint use the shared Chat Completions family when their emitted chunks match `choices[].delta`. This is format-level compatibility, not per-model or per-deployment certification. Azure may also emit moderation annotations with empty `choices`; Parastream classifies those as controls, not text.

## Practical auto-detection policy

- `Response` + `text/event-stream` → SSE framing.
- `Response` + `application/x-ndjson`, `application/ndjson`, or `application/jsonl` → NDJSON framing.
- `Response` + `text/plain` → text framing.
- Unsupported or generic JSON content type → ask the caller to specify the framing or pass already-decoded events.
- After framing and JSON parsing, detect each payload by its schema signature.
- When a `type` is a known discriminator, prefer it over weaker structural matches.
- Keep protocol state after a clear event so an empty-choice usage event can still be associated with its stream; do not use an ambiguous first event to guess.
- On an unknown event, yield an `unknown` part with raw data (or let the caller reject it). Do not recursively search for a `text` property.
- Allow an explicit protocol override for compatible gateways and older/newer variants.

## Broad-compatibility boundary

“OpenAI-compatible” is a protocol claim, not a vendor claim. Ollama also provides its own NDJSON API in addition to compatibility modes. Gemini’s REST streaming response, Anthropic’s named SSE events, Cohere’s typed events, Bedrock’s SDK event union, and the AI SDK UI data protocol are distinct families and need distinct adapters.

The 0.0.1 implementation extracts text from these documented text-capable stream families. It is not a promise to normalize every modality. Images, audio, video, tool arguments, reasoning, and structured data remain separate typed parts. Applications choose what to expose. Bedrock support accepts SDK-decoded ConverseStream event objects, not raw AWS EventStream framing. Hugging Face TGI’s native token-event format is not currently recognized; use its OpenAI-compatible endpoint.

Future custom integrations should be able to register an adapter with:

- a stable protocol identifier;
- a Zod predicate/schema for the minimum discriminating shape;
- a normalizer that emits typed parts;
- fixtures proving chunk-boundary, ordering, unknown-field, and unknown-event behavior.

Version 0.0.1 does not yet expose a public adapter registry.

## Failure behavior

- Malformed JSON in an SSE/NDJSON data frame: surface a parse error with frame context; do not silently drop it.
- Structurally valid but unknown payload: preserve it as unknown.
- Known protocol hint with a shape mismatch: return a validation error; do not silently fall back to another adapter.
- Unsupported transport or binary frame: return an explicit unsupported-format error.
- New fields on a known event: accept and preserve them.
- New event type: preserve as unknown unless the caller opts into strict mode.
