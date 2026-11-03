# Protocol research notes

Research checked on **2026-11-03**. Provider APIs change; treat the linked primary documentation as authoritative and re-check it before releases. This survey informs a protocol-adapter design, it does not claim exhaustive coverage of all provider APIs.

## Findings

### OpenAI

The current streaming guide describes the Responses API as typed semantic events, including `response.output_text.delta`, and still documents Chat Completions as data-only SSE whose chunks contain `choices[].delta`. OpenAI recommends Responses for new streaming integrations. Tool-call arguments and refusals have distinct events and must not be appended to user-facing text.

**Detection:** for Responses, use a recognized `response.*` event `type`; for Chat Completions-compatible streams, validate `choices[].delta` or the corresponding complete message. The Chat Completions envelope does not identify a specific vendor.

Reference: [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming)

### Anthropic Messages

Messages streams use named SSE events. A message has start/stop lifecycle events and indexed content blocks. `content_block_delta` is a wrapper: `delta.type` distinguishes `text_delta`, `thinking_delta`, and partial `input_json_delta`, among others. Unknown event types are expected to be possible and should be handled gracefully.

**Detection:** use the event/data `type`, then the nested delta type. Keep content block indexes separate. Do not convert tool JSON or thinking signatures into text.

Reference: [Streaming messages](https://docs.anthropic.com/en/docs/build-with-claude/streaming)

### Google Gemini

The Generate Content API has a `streamGenerateContent` method in addition to the non-streaming method. The response envelope contains candidates and content parts, and parts may carry text, function calls, thought annotations, or non-text modalities.

**Detection:** validate the candidate/content/parts structure and only extract string `text` parts. Keep thought-marked content and function calls distinct. The HTTP streaming framing should be detected separately from the Gemini JSON schema.

Reference: [Generating content API](https://ai.google.dev/api/generate-content)

### Ollama

Ollama’s native streaming endpoints return a sequence of JSON objects. `/api/chat` uses `message.content` (and may include thinking or tool calls); `/api/generate` uses `response`. A final object has `done: true` and may carry metrics. Ollama also supports OpenAI-compatible endpoints, which should be recognized by their actual event shape rather than the local model name.

**Detection:** use `message` plus `done` for chat; `response` plus `done` for generate. Frame each JSON object independently as NDJSON.

Reference: [Ollama API](https://docs.ollama.com/api)

### Mistral, Azure OpenAI, and Hugging Face TGI

Mistral Chat documents data-only SSE with `[DONE]` and Chat Completions-shaped chunks. Azure OpenAI Chat Completions uses `choices[].delta.content` but can also emit moderation annotations in separate chunks with empty choices. Hugging Face TGI offers an OpenAI-compatible Chat Completions endpoint; its native token API has a separate event shape.

**Detection:** route matching `choices[].delta` chunks through the common Chat Completions adapter regardless of vendor. Treat empty-choice annotations as controls. Do not claim support for TGI’s native token events without a dedicated fixture/schema.

References: [Mistral Chat](https://docs.mistral.ai/api/endpoint/chat), [Azure content streaming](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/content-streaming), [Hugging Face TGI streaming](https://huggingface.co/docs/text-generation-inference/conceptual/streaming)

### Cohere Chat v2

Cohere Chat v2 emits typed events such as `message-start`, `content-start`, `content-delta`, `content-end`, `tool-call-delta`, and `message-end`. Text is nested at `delta.message.content.text`; tool argument deltas have their own event family.

**Detection:** use the event `type` and read text only from the content delta path. Keep tool plans/calls and citations separate.

Reference: [Cohere streaming responses](https://docs.cohere.com/v2/docs/streaming)

### Amazon Bedrock ConverseStream

Bedrock provides a model-agnostic `ConverseStream` API with event-union members such as `contentBlockDelta`, `contentBlockStart`, `contentBlockStop`, `messageStart`, `messageStop`, and `metadata`. The AWS SDK exposes these as typed event objects. The service’s raw wire framing is not SSE/NDJSON.

**Detection:** accept SDK-decoded event objects using the union member key. Do not claim raw Bedrock transport support without a dedicated AWS EventStream decoder.

Reference: [Bedrock ConverseStream API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)

### Vercel AI SDK

The SDK distinguishes core model-output parts from UI wire protocols. Core `streamText` transformations use a `StreamTextTransform` object whose `transform(options)` returns a `TransformStream`. UI data streams are SSE with typed JSON parts, start/delta/end patterns, and control/tool/data events. A plain text stream is a separate simpler protocol.

**Detection:** use the SDK part `type` when consuming objects. For UI wire streams, parse SSE first, then validate the JSON part `type`. Do not treat every SDK stream as an array of strings.

References: [streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text), [UI stream protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol), [smoothStream](https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream)

## Consumer-side and agent-app protocols

A provider's response format is not the same thing as an application client's event protocol. The following source review checks how several agent applications consume, transform, and deliver streamed output. These are implementation examples, not protocols that Parastream automatically supports.

### T3 Code and OpenCode

A read-only review of the local T3 Code checkout at commit `3525ecd59` traced its OpenCode adapter into orchestration ingestion:

- `apps/server/src/provider/Layers/OpenCodeAdapter.ts` maps OpenCode's append-only `message.part.delta` events to canonical `content.delta` events. It also receives `message.part.updated` text snapshots and reconciles them against retained text with a longest-common-prefix comparison.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` appends canonical assistant deltas. It can buffer visible text by token, paragraph, or turn; tool lifecycle events are kept on a separate activity path. Non-terminal tool updates are projected because their data can include the accumulated output on every update, causing quadratic persistence if stored verbatim.
- **Snapshot replacement needs an end-to-end check.** For example, the adapter's `Hello world` → `Hello there` reconciliation emits `there`. An append-only consumer cannot remove ` world`. Ingestion only uses the completed snapshot as fallback when the projected message is absent or empty. Confirm with an ingestion-level regression test that a non-prefix replacement produces the correct final message. Part removal and replacement with a non-text part also need explicit correction/removal semantics if already-emitted text must disappear.

OpenCode's own application protocol is an SSE event feed, not a provider token format. Its schema separates ephemeral `message.part.delta` events (session/message/part IDs, field, and delta) from durable `message.part.updated` events containing a full part snapshot. The server emits `server.connected` and heartbeats; each subscriber has a bounded queue, and a slow subscriber is disconnected on overflow. The client surfaces `server.connected` after reconnect so callers can resync. Do not assume a reconnect replays missed events.

References: [OpenCode event schema](https://github.com/anomalyco/opencode/blob/1bf08ae46a91f7793c756e4ee521e37b6b554064/packages/schema/src/v1/session.ts), [SSE handler](https://github.com/anomalyco/opencode/blob/1bf08ae46a91f7793c756e4ee521e37b6b554064/packages/server/src/handlers/event.ts), [event feed](https://github.com/anomalyco/opencode/blob/1bf08ae46a91f7793c756e4ee521e37b6b554064/packages/server/src/event-feed.ts), [shared client events](https://github.com/anomalyco/opencode/blob/1bf08ae46a91f7793c756e4ee521e37b6b554064/packages/client/src/shared-events.ts).

### OpenClaude

OpenClaude's inspected gRPC service is bidirectional: client messages carry requests, permission replies, or cancellation; server messages are a oneof containing text chunks, tool start/results, permission prompts, errors, or completion. Text chunks are append deltas, while `done` carries the accumulated `full_text` and usage. Consumers should treat `done.full_text` as final state, not append it again. Cancellation ends the stream without a `done` event. This custom gRPC contract is distinct from SSE and from the Anthropic events consumed internally by its query engine.

References: [pinned gRPC protocol](https://github.com/Twigpine/openclaude/blob/a7b976383c1d103bfa746c7470acb1c2e31c77cf/src/proto/openclaude.proto), [pinned server implementation](https://github.com/Twigpine/openclaude/blob/a7b976383c1d103bfa746c7470acb1c2e31c77cf/src/grpc/server.ts).

### Vercel AI SDK Workflows and Continue

- The inspected Vercel AI SDK Workflow normalizer tracks text/reasoning part lifecycles by ID. It handles duplicate or replayed frames and repairs missing starts for those part types. Its comments note that an orphaned delta can otherwise fail the consumer; tool-input framing is not repaired by this text/reasoning normalizer. This finding applies to the workflow stream path, not every AI SDK consumer. [Pinned normalizer](https://github.com/vercel/ai/blob/2feaeecbd6a921a27123aafa75db6af34e1f246b/packages/workflow/src/normalize-ui-message-stream.ts).
- Continue's OpenAI-compatible stream consumer maps tool-call indexes to IDs and accumulates argument fragments until the JSON parses. A fragment without an ID or a previously mapped index is discarded. Partial tool arguments must therefore remain distinct from complete, executable tool calls. Continue also reads usage independently from choice content, which matters for usage-only chunks. [Pinned consumer](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/stream/streamChatResponse.ts), [tool-call assembly](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/stream/streamChatResponse.helpers.ts).

## Cross-provider conclusions

1. Model identity and response protocol are different concepts.
2. The same HTTP transport can carry unrelated event schemas; transport detection alone is insufficient.
3. SSE frames can contain JSON, plain text, or a sentinel such as `[DONE]`; only the protocol adapter knows what the payload means.
4. “Text-like” does not mean “user-facing text.” Reasoning, refusals, tool JSON, and multimodal parts need distinct channels.
5. Some providers emit protocol lifecycle and usage events with no text. Preserve ordering and associate them with the stream.
6. Forward-compatible parsers should accept unknown optional fields and preserve unknown event types.
7. A versioned schema test corpus is more reliable than provider-name or model-name heuristics.
8. Append deltas, replaceable snapshots, and final accumulated text are different update semantics. Do not convert snapshots into append deltas unless the consumer can also represent replacement or removal.
9. Reconnect and replay behavior belongs to the application protocol. Stable event/part/tool IDs and lifecycle framing are needed to reconcile duplicates and recover state; identical text is not a safe deduplication key.
10. Repeated full snapshots can make serialized or persisted stream cost quadratic. Prefer deltas for incremental updates, or project cumulative payloads before persisting each update.

## Research limits

This pass reviewed primary provider documentation for OpenAI, Anthropic, Google Gemini, Ollama, Mistral, Azure OpenAI, Hugging Face TGI, Cohere, Amazon Bedrock, and Vercel AI SDK; it also reviewed pinned source snapshots for OpenCode, OpenClaude, Vercel AI SDK Workflows, Continue, and the local T3 Code commit noted above. This was a source-level review, not live-provider certification or an exhaustive audit of every application version, hosted gateway, SDK release, Vertex wrapper, WebSocket protocol, or multimodal format. Re-check pinned sources before relying on these observations for a release.
