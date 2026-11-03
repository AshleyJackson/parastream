# Testing

All automated tests belong under `tests/`. Do not put test files beside source modules or under `src/`.

## Test layers

1. **Schema and detection tests**: positive and negative signatures for every protocol; ambiguous payloads return unknown; unknown fields survive; malformed known envelopes fail predictably.
2. **Transport tests**: SSE and NDJSON split at every meaningful boundary, including CRLF, multi-line SSE data, comments, `[DONE]`, JSON strings split across byte chunks, malformed frames, and final unterminated lines.
3. **Normalization tests**: output text, reasoning, refusal, tool input, non-text, and control parts remain distinct and in source order.
4. **Segmentation tests**: paragraph/line boundaries, delimiter preservation options, final flush, Unicode, arbitrary text chunking, and overflow behavior.
5. **Cancellation tests**: abort signal, consumer cancellation, upstream `return()`/reader cancellation, and error cleanup.
6. **Provider stream fixtures**: small, synthetic examples of documented provider payloads, stored under `tests/fixtures/`. Each fixture records its primary reference and review date. Tests cover OpenAI Chat Completions and Responses, Anthropic Messages, Gemini, Ollama chat/generate, Cohere Chat v2, decoded Bedrock ConverseStream SDK events, Vercel AI SDK core/UI streams, and Chat Completions-compatible Mistral, Azure OpenAI, and Hugging Face TGI.
7. **Visual stream playback**: a deterministic, delayed mixed stream with short, medium, and long message responses. Only output-channel message text passes through paragraph segmentation; agent, tool, and non-output events render as soon as they arrive.

Never use live credentials or make network calls in unit tests. Provider integration tests, if later needed, must be opt-in and isolated.

## Required invariants

- For text mode, output reconstructs the exact source when delimiters are included and trimming is disabled.
- Splitting a text/byte source at different chunk boundaries produces the same normalized events and text units.
- A UTF-8 code point split across byte chunks decodes correctly.
- No tool-argument, reasoning, refusal, image/audio, or unknown JSON field is silently emitted as ordinary text.
- Emitted events preserve source order.
- New optional fields do not break parsing; unknown event types are observable.
- Tests run with `bun test`.

## Commands

```sh
bun run test
bun run test:unit
bun run typecheck
bun run build
```

`bun run test` runs the unit suite and visual playback. `bun run test:unit` runs only the non-visual unit suite; `bun run check` uses this unit-only path for fast validation.
