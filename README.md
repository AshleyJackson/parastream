# Parastream

**Parastream 0.0.1** is an early-development, TypeScript-first ESM library for normalizing common AI response streams and splitting text deltas into useful units.

It sits between an upstream provider or SDK and your application:

```text
Provider / SDK
  -> SSE, NDJSON, plain text, or decoded events
  -> Parastream transport framing and protocol normalization
  -> typed text, tool-input, control, or unknown parts
  -> optional paragraph/line segmentation
  -> your UI, CLI, proxy, or agent runtime
```

Parastream does **not** make provider requests, hold credentials, execute tools, run a proxy server, or define a downstream application protocol. You own those pieces and choose which normalized events to expose.

> **Development status:** The API and protocol support may change. The package is currently marked `private` and is not published to npm. Import examples assume the package is linked or included in a workspace.

## Requirements

- Node.js 22 or newer
- ESM; CommonJS is not supported
- TypeScript declarations are included; a TypeScript consumer is not required
- Bun for development, tests, and builds
- Zod is installed as a runtime dependency

## Quick start

Pass a `Response`, SDK event iterable, or supported stream source to `normalizeAIStream()`. The example endpoint must return a supported streaming content type, such as `text/event-stream`, NDJSON, or `text/plain`; an ordinary `application/json` response is not assumed to be a stream. Segment only the text channel your application intends to display:

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

`normalizeAIStream()` separates output text from reasoning, refusal, partial tool input, tool-call markers, control events, and unknown events. `parastream()` receives only the output text selected by the caller.

## Compose with Web Streams

`normalizeAIReadableStream()` exposes the same `ReadableStream<NormalizedPart>` data, with a queue size of one and cancellation propagated to the upstream iterator. It is an alternative *consumer surface*, not a second parser. Use standard `pipeThrough()` and `pipeTo()` to compose it with sinks in browsers, Workers, Bun, or Node.js 22+.

```ts
import {
  normalizeAIReadableStream,
  segmentTextTransform,
  selectTextTransform,
} from "parastream";

const paragraphs = normalizeAIReadableStream(response)
  // This is an explicit text-only projection.
  .pipeThrough(selectTextTransform({ channel: "output" }))
  .pipeThrough(segmentTextTransform({ unit: "paragraph" }));

await paragraphs.pipeTo(
  new WritableStream({
    write({ text, isFinal }) {
      renderMessageParagraph(text, { isFinal });
    },
  }),
);
```

The normalized source stream retains every part type, including tool input/calls, controls, reasoning, refusals, and unknown events. `selectTextTransform()` deliberately projects one text channel to strings, so do not use it for an agent or gateway pipeline that needs those events. `partFilterTransform({ textChannels: ["output"] })` filters non-output text while retaining non-text parts.

## Consume an upstream provider

This server-side example calls the OpenAI Responses API directly. The `Response` content type selects SSE framing; Parastream recognizes the typed Responses events. Keep the API key on the server.

```ts
import { normalizeAIStream } from "parastream";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY on the server");

const abort = new AbortController();
const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "YOUR_MODEL",
    input: "Explain how a streaming response is consumed.",
    stream: true,
  }),
  signal: abort.signal,
});

if (!response.ok) {
  throw new Error(`Upstream returned HTTP ${response.status}`);
}

for await (const part of normalizeAIStream(response, { signal: abort.signal })) {
  if (part.kind === "text-delta" && part.channel === "output") {
    process.stdout.write(part.text);
  } else if (part.kind === "tool-input-delta") {
    // Keep partial arguments separate; they may not be valid JSON yet.
  } else if (part.kind === "tool-call") {
    // Hand off to application logic; Parastream does not execute tools.
  } else if (part.kind === "control") {
    // Handle finish, usage, or other recognized non-text events.
  }
}
```

The same normalizer can consume already-decoded SDK events. If the SDK yields an iterable of event objects, pass that iterable instead of a `Response`. If a gateway changes or omits headers, select the framing explicitly:

```ts
// A bare byte stream has no Response headers from which to infer framing.
for await (const part of normalizeAIStream(byteStream, {
  transport: "sse",
  protocol: "openai-responses",
})) {
  // Handle normalized parts.
}
```

For Anthropic Messages, the upstream request is different, but the response can use the same normalizer:

```ts
const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) throw new Error("Set ANTHROPIC_API_KEY on the server");

const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": anthropicKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "YOUR_MODEL",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "Say hello." }],
  }),
});

if (!anthropicResponse.ok) {
  throw new Error(`Upstream returned HTTP ${anthropicResponse.status}`);
}

for await (const part of normalizeAIStream(anthropicResponse, {
  protocol: "anthropic-messages",
})) {
  if (part.kind === "text-delta" && part.channel === "output") {
    process.stdout.write(part.text);
  } else if (part.kind === "tool-input-delta") {
    // Accumulate by part.toolCallId ?? part.blockId; this is partial JSON.
  }
}
```

`normalizeAIStream()` accepts `Response`, strings, byte streams, synchronous iterables, async iterables, and Web `ReadableStream`s. A `Response` is framed from `Content-Type`; an unlabelled byte stream requires `transport: "sse"` or `"ndjson"`. A generic `application/json` response is not assumed to be a stream.

## Build a text-only streaming proxy

A proxy can normalize an upstream provider and expose a simpler downstream response. This example forwards **output text only**, grouped into paragraphs. It reads one paragraph when the downstream stream pulls, propagates cancellation upstream, and returns provider errors without consuming their bodies.

```ts
import { normalizeAIStream, parastream } from "parastream";

export async function handleChat(request: Request): Promise<Response> {
  const { prompt } = (await request.json()) as { prompt: string };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Set OPENAI_API_KEY on the server");

  const upstreamAbort = new AbortController();
  const abortFromRequest = () => upstreamAbort.abort(request.signal.reason);

  if (request.signal.aborted) {
    abortFromRequest();
  } else {
    request.signal.addEventListener("abort", abortFromRequest, { once: true });
  }

  const removeAbortListener = () =>
    request.signal.removeEventListener("abort", abortFromRequest);

  let upstream: Response;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "YOUR_MODEL",
        input: prompt,
        stream: true,
      }),
      signal: upstreamAbort.signal,
    });
  } catch (error) {
    removeAbortListener();
    throw error;
  }

  if (!upstream.ok) {
    removeAbortListener();
    return upstream;
  }

  async function* outputText() {
    for await (const part of normalizeAIStream(upstream, {
      signal: upstreamAbort.signal,
    })) {
      if (part.kind === "text-delta" && part.channel === "output") {
        yield part.text;
      }
    }
  }

  const paragraphs = parastream(outputText(), {
    unit: "paragraph",
  })[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let downstreamCancelled = false;

  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const next = await paragraphs.next();
        if (next.done) {
          removeAbortListener();
          streamController.close();
        } else {
          streamController.enqueue(encoder.encode(next.value));
        }
      } catch (error) {
        upstreamAbort.abort(error);
        removeAbortListener();
        if (!downstreamCancelled) streamController.error(error);
      }
    },
    async cancel(reason) {
      downstreamCancelled = true;
      upstreamAbort.abort(reason);
      removeAbortListener();
      await paragraphs.return?.();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
```

The examples read secrets from `process.env`, as in Node.js or Bun. In an edge runtime such as Cloudflare Workers, read keys from that runtime's secret bindings instead.
Production proxies should also authenticate callers, validate request bodies, and set appropriate rate and input-size limits; those application policies are outside this stream example.

This is a **transforming** proxy, not a transparent relay: it intentionally drops tool, reasoning, refusal, usage, and other non-output events. If clients need those events, preserve the normalized part types in a downstream schema of your own rather than flattening everything to text. For a transparent proxy that does not inspect the body, pass `upstream.body` through directly and do not parse it with Parastream.

Streaming depends on the whole path. Do not buffer the upstream with `response.text()` or `response.json()` before returning a response. Configure any reverse proxy or CDN in front of your handler to stream rather than aggregate chunks. The example uses a `ReadableStream` pull to apply backpressure and cancels the provider request when the downstream consumer disconnects.

Paragraph mode trades first-visible latency for fewer UI updates. For token-by-token rendering, consume `normalizeAIStream()` or `normalizeAIReadableStream()` directly; use `unit: "line"` when line boundaries suit the response. The default delimiter behavior preserves paragraph boundaries.

Paragraph splitting recognizes adjacent LF/CRLF blank lines; line splitting recognizes LF/CRLF. By default, delimiters are preserved and text is not trimmed, so concatenating emitted units reconstructs the input. Boundaries with no content are folded into the next unit instead of producing empty chunks. A pending unit larger than the default `maxBuffer` (1,000,000 UTF-16 code units) throws instead of being silently split. Blank lines containing spaces are not paragraph delimiters yet.

## Supported upstream shapes

Parastream detects event payloads by their structure, not by model name:

| Upstream source | How to pass it |
|---|---|
| `fetch()` response with `text/event-stream` | `normalizeAIStream(response)` |
| `fetch()` response with NDJSON content type | `normalizeAIStream(response)` |
| Provider SDK's decoded event objects | `normalizeAIStream(events)` |
| Bare byte stream without headers | `normalizeAIStream(bytes, { transport: "sse" })` or `transport: "ndjson"` |
| Known gateway variant | Add an explicit `protocol` hint when needed |

Supported protocol families:

| Family | Recognized as |
|---|---|
| OpenAI Chat Completions-compatible, including Mistral, Azure OpenAI, and TGI’s OpenAI-compatible endpoint | `openai-chat-completions` |
| OpenAI Responses | `openai-responses` |
| Anthropic Messages | `anthropic-messages` |
| Gemini `streamGenerateContent` | `gemini-generate-content` |
| Native Ollama | `ollama-chat`, `ollama-generate` |
| Cohere Chat v2 | `cohere-chat-v2` |
| Decoded AWS Bedrock ConverseStream SDK events | `aws-bedrock-converse` |
| Vercel AI SDK core parts and UI message data stream | `ai-sdk` |
| Plain text, including the AI SDK text stream | `plain-text` |

This is not a claim that every API or modality from those providers is supported. Known gaps:

- **Gemini Interactions API** (`interaction.created`, `step.delta`, `interaction.completed`) is not normalized. Google recommends it for new projects, but its step envelopes carry `event_type` rather than `type`; Parastream reports those events as `unknown` rather than mistaking them for Generate Content.
- **Raw AWS EventStream** framing is not decoded. Bedrock support accepts SDK-decoded ConverseStream objects.
- **Hugging Face TGI native `textGenerationStream`** token events are not recognized; use its OpenAI-compatible endpoint.
- **OpenAI Responses WebSocket mode**, live audio/video sessions, and other socket or binary protocols are out of scope.

Examples of why normalization matters:

- OpenAI Responses emits semantic event types such as `response.output_text.delta`; tool arguments, refusals, reasoning, and completion have different event types.
- Anthropic Messages uses indexed content blocks. Tool input arrives as partial JSON string deltas, not a complete object on each event.
- OpenAI-compatible endpoints may include usage, moderation, or annotation chunks without text; Azure OpenAI sends filter annotations that way.
- Gemini and Ollama deliver complete tool-call argument objects, so they produce tool calls without partial-argument deltas.
- Reasoning and refusal text stay on their own channels, so a model that exposes private reasoning does not leak it into rendered prose by default.

See [protocol detection and support](docs/protocol-detection.md) for exact shapes and [protocol research](docs/protocol-research.md) for sources and interoperability findings.

## Other use cases

- **Chat UIs and CLIs:** Render output text while keeping reasoning, refusal, and tool input out of the prose path. Segment into paragraphs or lines when repainting every token is undesirable.
- **Provider-agnostic gateways:** Normalize several supported upstream formats to one application-owned event model. Keep control and tool events if downstream clients need to coordinate turns or tools.
- **Agent runtimes:** Route text, tool calls, and partial tool arguments to separate handlers. Accumulate and validate tool arguments in the application; do not execute a tool merely because a partial-argument event arrived.
- **Moderation or redaction middleware:** Inspect bounded text units before forwarding them. If a policy requires checking the complete response first, buffer intentionally and account for the resulting latency and memory limits.
- **Stream observability:** Measure time-to-first-text, inter-event timing, event counts, and byte counts without storing prompts or raw payloads. Raw events can contain user data and credentials.
- **SDK adapters and test harnesses:** Feed decoded SDK events directly into normalization, or use offline fixtures to verify a provider/gateway adapter without live credentials.

## Important limits

- This package does not make authenticated provider requests, retry interrupted requests, execute tools, or provide a proxy/server framework.
- Segmentation currently supports paragraphs and lines. Sentence, word, grapheme, and custom splitting are not implemented.
- Transport parsing and normalized events do not provide a reconnect cursor, replay guarantee, or general duplicate-event suppression. The application owns reconnect and idempotency policy. SSE `id` and `retry` fields are reported on frames but not remembered.
- Framing is deliberately lenient in two places: a `data: [DONE]` payload ends the stream for SSE and NDJSON alike, and an SSE frame still open at end of stream is flushed rather than discarded. A truncated stream can therefore surface one partial frame that a strict reader would drop.
- A `text-delta` is append-only. A provider or application that sends replaceable text snapshots needs explicit replacement/removal handling; a snapshot cannot safely be converted to an append delta if earlier text may need to be retracted. The AI SDK's `reset-step` control is reported faithfully but not applied.
- Tool arguments, reasoning, refusal, controls, and unknown events remain separate parts. Parastream does not assemble every tool lifecycle into an executable call.
- Raw Bedrock EventStream, the Gemini Interactions API, native Hugging Face TGI token events, OpenAI's Responses WebSocket mode, and general socket, audio, and video protocols are outside the current scope.

## Potential future directions

These are possible extensions, not commitments or current API:

- Web `TransformStream` helpers for raw transport framing and provider-specific transforms.
- Stateful helpers for tool-argument assembly, replay-aware event handling, and replaceable snapshot/correction events.
- Sentence, word, grapheme, and caller-provided segmentation strategies.
- Additional provider and SDK adapters backed by documented fixtures.
- Typed audio/video and other multimodal stream parts.

## Development

```sh
bun install
bun run test
bun run test:unit
bun run typecheck
bun run build
```

All automated tests live under `tests/`. `bun run test` includes a delayed visual playback that demonstrates paragraph buffering and immediate activity events; `bun run test:unit` runs only the deterministic unit suite, and `bun run check` pairs that suite with the type check. See [the docs index](docs/README.md) for architecture, protocol detection, research references, testing, and ADRs.

## References

Wire framing:

- [WHATWG HTML: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [NDJSON specification](https://github.com/ndjson/ndjson-spec)

Providers and SDKs:

- [OpenAI: Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [OpenAI: Chat Completions streaming](https://platform.openai.com/docs/api-reference/chat-streaming)
- [Anthropic: Streaming messages](https://docs.anthropic.com/en/docs/build-with-claude/streaming)
- [Gemini: `streamGenerateContent`](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent)
- [Gemini: Streaming interactions](https://ai.google.dev/gemini-api/docs/streaming)
- [Ollama API](https://docs.ollama.com/api)
- [Cohere: Streaming responses](https://docs.cohere.com/v2/docs/streaming)
- [Amazon Bedrock ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)
- [Vercel AI SDK: Stream protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [Mistral: Chat](https://docs.mistral.ai/api/endpoint/chat)
- [Azure OpenAI: Content streaming](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/content-streaming)
- [Hugging Face TGI: Streaming](https://huggingface.co/docs/text-generation-inference/conceptual/streaming)

Runtime and streams:

- [MDN: Streams API concepts and backpressure](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Concepts)
- [Cloudflare Workers: Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)
