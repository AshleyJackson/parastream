# Testing

All automated tests belong under `tests/`. Do not put test files beside source modules or under `src/`.

## Test layers

1. **Schema and detection tests**: positive and negative signatures for every protocol; ambiguous payloads return unknown; unknown fields survive; malformed known envelopes fail predictably. This includes look-alikes that must not be confused, such as a chat chunk carrying `metadata`, an Anthropic `error` envelope next to the AI SDK `error` part, `ping` as an Anthropic control, and every Bedrock exception member next to the Bedrock metadata member.
2. **Transport tests**: SSE and NDJSON split at every meaningful boundary, including CRLF, multi-line SSE data, comments, `[DONE]`, JSON strings split across byte chunks, malformed frames, empty `data` keep-alives, and final unterminated lines.
3. **Normalization tests**: output text, reasoning, refusal, tool input, non-text, and control parts remain distinct and in source order; recognized-but-textless events become controls rather than empty text deltas.
4. **Segmentation tests**: paragraph/line boundaries, delimiter preservation options, final flush, Unicode, arbitrary text chunking, and overflow behavior.
5. **Cancellation tests**: abort signal, consumer cancellation, upstream `return()`/reader cancellation, and error cleanup.
6. **Provider stream fixtures**: small, synthetic examples of documented provider payloads, stored under `tests/fixtures/`. Each fixture records its primary reference and review date. Tests cover OpenAI Chat Completions and Responses, Anthropic Messages, Gemini `streamGenerateContent`, Ollama chat/generate, Cohere Chat v2, decoded Bedrock ConverseStream SDK events, Vercel AI SDK core/UI streams, and Chat Completions-compatible Mistral, Azure OpenAI, and Hugging Face TGI.
7. **Message assembler tests**: interleaved text blocks, tool input JSON completion, `reset-step` checkpoint restoration, buffer limits with overflow, late delta tolerance, incomplete calls at EOF, and per-step isolation. These tests verify the push reducer, `consume()` adapter, and event ordering.
8. **Visual stream playback**: a deterministic, delayed mixed stream with short, medium, and long message responses. Only output-channel message text passes through paragraph segmentation; agent, tool, and non-output events render as soon as they arrive.

Families that are recognized but deliberately not normalized have no fixture claiming support. TGI's native token events and other unsupported shapes are covered as `unknown` where they appear at all; the Gemini Interactions API is documented as unsupported and is not fixture-backed.

Never use live credentials or make network calls in unit tests. Provider integration tests, if later needed, must be opt-in and isolated.

## Required invariants

- For text mode, output reconstructs the exact source when delimiters are included and trimming is disabled.
- Splitting a text/byte source at different chunk boundaries produces the same normalized events and text units.
- A UTF-8 code point split across byte chunks decodes correctly.
- No tool-argument, reasoning, refusal, image/audio, or unknown JSON field is silently emitted as ordinary text.
- Emitted events preserve source order.
- New optional fields do not break parsing; unknown event types are observable.
- A conflicting protocol hint fails instead of falling back silently.
- Tests run with `bun test`.

## Commands

```sh
bun run test        # unit suite, then visual playback
bun run test:unit   # deterministic unit suite only
bun run test:visual # visual playback only
bun run typecheck
bun run build
bun run check       # typecheck plus unit suite
```

`bun run test` runs the unit suite and the visual playback. `bun run test:unit` enumerates the non-visual test files, and `bun run check` uses that unit-only path for fast validation. `bun run build` cleans `dist/` and emits declarations plus ESM output.
