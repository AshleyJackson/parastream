# Parastream

**Parastream 0.0.1** is an early-development, TypeScript-only, ESM library for turning incremental AI output into useful text units and normalizing common AI stream protocols.

The library is protocol-aware, not model-name-aware. It recognizes response envelopes from common provider protocols, extracts typed text-like deltas without confusing tool arguments or multimodal payloads with prose, and keeps transport framing separate from text segmentation.

> Development status: API and protocol support are subject to change. No provider API clients, credentials, or network requests are included.

## Requirements

- Node.js 22 or newer
- ESM
- TypeScript source and declarations
- Zod for runtime validation
- Bun for development, tests, and builds

## Development

```sh
bun install
bun run test
bun run typecheck
bun run build
```

All automated tests live under `tests/`. `bun run test` includes a visual stream playback: output-message text appears only after paragraph boundaries, while tool and agent activity prints immediately. See [the docs index](docs/README.md) for architecture, protocol detection, research references, testing, and ADRs.

## Quick start

```ts
import { normalizeAIStream, parastream } from "parastream";

const response = await fetch("/api/generate");

async function* outputText() {
  for await (const part of normalizeAIStream(response)) {
    if (part.kind === "text-delta" && part.channel === "output") {
      yield part.text;
    }
  }
}

for await (const paragraph of parastream(outputText())) {
  console.log(paragraph);
}
```

`normalizeAIStream` separates text, reasoning, refusal, tool input, control, and unknown events. Only the explicitly selected output channel is sent to the text segmenter.

## Protocol scope

The current implementation recognizes plain text, OpenAI Chat Completions-compatible and Responses events, Anthropic Messages events, Gemini `streamGenerateContent` objects, native Ollama chat/generate objects, Cohere Chat v2 events, AWS Bedrock ConverseStream SDK events, and Vercel AI SDK part shapes. Models served through Mistral, Azure OpenAI, Hugging Face TGI’s OpenAI-compatible route, and other gateways can use the shared Chat Completions adapter when their actual event shape matches.

This does not mean every API or modality from those providers is supported. In particular, AWS Bedrock’s raw EventStream wire format and Hugging Face TGI’s native token event format are not parsed by this release; use SDK-decoded Bedrock event objects or the TGI OpenAI-compatible endpoint.

Detection uses transport metadata and validated payload structure. A model name or arbitrary prose is not a reliable protocol signal. Unknown events remain unknown; Parastream does not recursively search arbitrary JSON for fields named `text`.

Text segmentation currently supports paragraphs and lines. See [the API contract](docs/api.md) and [protocol detection and support](docs/protocol-detection.md) for exact behavior and limits.

## Decisions

- ESM-only; no CommonJS entry point.
- Node.js 22 is the minimum runtime.
- TypeScript is required for project source, with strict type checking.
- Zod validates public options and the portions of protocol envelopes used by adapters.
- Provider-specific extraction is separated from transport framing and segmentation.
- Unknown event fields are preserved or surfaced as unrecognized, rather than rejected just because a provider added fields.

See [ADRs](docs/README.md#architecture-decisions).
