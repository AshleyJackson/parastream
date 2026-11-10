# Protocol research notes

Research refreshed on **2026-11-10**; first pass on 2026-11-03. Provider APIs change, so treat the linked primary documentation as authoritative and re-check it before a release. This survey informs the protocol adapters. It is not a support claim for every provider, API version, model, or modality.

Each finding below is scoped to a **documented stream shape**. A shape can be recognized without its vendor, and a vendor can ship several incompatible streaming APIs at once; both cases are recorded explicitly.

## Framing-level specifications

Framing is the layer below protocol detection, so its rules are worth stating separately from any vendor.

### Server-Sent Events (WHATWG HTML, server-sent events section)

Verified behavior: the stream is UTF-8 with at most one leading byte-order mark stripped; line endings may be CRLF, LF, or CR; a blank line dispatches the pending event; multiple `data` lines are joined with `\n`; `id` is ignored when it contains a NULL; `retry` must be ASCII digits; unknown fields are ignored; `event` defaults to `message`; a stream that ends mid-event discards the pending event.

Parastream implements this framing with three deliberate differences, all visible to callers:

1. **Pending event at end of stream.** The specification discards an event that is still open at end of stream. Parastream flushes it, so an upstream that closes immediately after the last `data` line without a trailing blank line still yields that event. Provider streams that end at the last chunk benefit from this; a truncated stream can therefore surface one partial frame that the specification would have dropped.
2. **`[DONE]` sentinel.** Not part of SSE. It is handled at the protocol layer as a terminator, matching OpenAI-compatible practice.
3. **`id` and `retry` are reported, not remembered.** They are parsed and exposed on the frame but are not used to implement reconnect or replay, which remain application responsibilities.

An empty `data` field or a frame with no `data` field produces no normalized part, which matches the specification's "empty data buffer" behavior.

### NDJSON (ndjson-spec 1.0.0)

Verified behavior: each JSON text is followed by `\n`, a parser must also accept `\r\n`, a parser may ignore empty lines if that is documented, unparsable input should produce an error, and the media type is `application/x-ndjson`. The specification has no termination sentinel.

Parastream accepts `application/x-ndjson`, `application/ndjson`, and `application/jsonl`; ignores blank lines; parses a final line that has no trailing newline; raises a `SyntaxError` that names the line number for invalid JSON; and, as a documented extension, stops at a line containing only `[DONE]` because OpenAI-compatible proxies emit that sentinel over NDJSON too.

## Provider APIs

### OpenAI

The Responses API emits typed semantic events. `response.created`, `response.output_text.delta`, and `response.completed` are the common flow, and the reference enumerates text, refusal (`response.refusal.delta`), function-argument (`response.function_call_arguments.delta`), reasoning text and reasoning-summary deltas, `response.output_text.annotation.added`, output-item and content-part lifecycle, file-search, code-interpreter, image-generation, and MCP tool events. Failures arrive as a top-level `error` event carrying `code`, `param`, or `sequence_number`. OpenAI recommends Responses for new integrations. A WebSocket mode also exists for Responses; it is outside a byte-stream library's scope.

Chat Completions remains data-only SSE: `object: "chat.completion.chunk"`, `choices[].delta`, `finish_reason` of `stop`, `length`, `tool_calls`, `content_filter`, or `function_call`, a `refusal` string field, parallel `tool_calls[].index` values, an optional terminal `usage`, and a `data: [DONE]` marker.

**Detection:** recognize Responses first, by `response.*` type prefix or the top-level error shape. Recognize Chat Completions by `choices[]` carrying `delta` or `message`, or an empty `choices` array alongside `usage`, `object`, `prompt_annotations`, or `prompt_filter_results`. The Chat Completions envelope identifies a shape, not a vendor.

References: [streaming responses](https://developers.openai.com/api/docs/guides/streaming), [Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming), [Chat Completions streaming](https://platform.openai.com/docs/api-reference/chat-streaming).

### Azure OpenAI

Azure serves the Chat Completions shape but can also stream moderation annotations in chunks with an empty `choices` array: `prompt_annotations` or `prompt_filter_results` before generation, `content_filter_results` per choice, and `content_filter_offsets` with check/start/end offsets. A filtered completion ends with `finish_reason: "content_filter"`. Asynchronous filter mode delays those signals, with a default annotation window measured in characters, so a consumer can see text before the corresponding annotation.

**Detection:** the shared Chat Completions family. Empty-`choices` chunks become controls, so annotations never reach the text channel.

Reference: [Azure content streaming](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/content-streaming).

### Anthropic Messages

Streams use named SSE events. The flow is `message_start`, then one or more content blocks (`content_block_start`, `content_block_delta`*, `content_block_stop`), then `message_delta`*, then `message_stop`. `ping` can appear anywhere. Mid-stream failures arrive as `{"type":"error","error":{"type":"overloaded_error",...}}`.

Delta types include `text_delta`, `thinking_delta` (followed by a `signature_delta` before the block stops), and `input_json_delta`, whose `partial_json` fragments are only valid JSON once the block stops. Blocks can also be `server_tool_use`, `web_search_tool_result`, or one of a pair of `fallback` blocks. Unknown event types are expected to appear.

**Detection:** use the event or payload `type`, then the nested `delta.type`. The Anthropic error envelope is distinguished from the AI SDK's generic `error` part by its nested `error.type` and by the absence of `errorText`. Block indexes stay separate, and tool JSON and thinking signatures never become prose.

Reference: [streaming messages](https://docs.anthropic.com/en/docs/build-with-claude/streaming).

### Google Gemini, Generate Content API

`models.streamGenerateContent` returns the same `GenerateContentResponse` envelopes as the non-streaming call. With `?alt=sse` the response is SSE; without it the endpoint returns a JSON array of response objects, which is not a stream frame format Parastream accepts. Candidates carry `content.parts[]`, `finishReason`, `safetyRatings`, `citationMetadata`, and `index`. A part may hold `text`, `thought`, `thoughtSignature`, `functionCall` (`name`, `id`, `args`), `functionResponse`, `inlineData`, `executableCode`, `codeExecutionResult`, `toolCall`, or `toolResponse`. `promptFeedback.blockReason` reports a blocked prompt, and `usageMetadata` can arrive in a final chunk with no candidates. Finish reasons include `CONTINUATION` (with `continuationToken`), `MALFORMED_FUNCTION_CALL`, and `UNEXPECTED_TOOL_CALL`.

**Detection:** `candidates` with `content.parts`, candidate finish/safety metadata, an empty `candidates` array with `usageMetadata`, or `promptFeedback`. Parts marked `thought: true` go to the reasoning channel; `functionCall` parts become tool calls. Function arguments are complete objects, not incremental strings, so Generate Content has no tool-input delta.

Reference: [streamGenerateContent](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent).

### Google Gemini, Interactions API

Google now leads with the Interactions API, which is generally available and recommended for new projects; `generateContent` remains supported as the legacy interface. Interactions stream as SSE from `POST /v1beta/interactions` with `stream: true`, and the event flow is `interaction.created`, `interaction.status_update`, repeated step groups (`step.start`, `step.delta`*, `step.stop`), `interaction.completed`, and `error`, ending with `event: done` and `data: [DONE]`. Step types are `model_output`, `thought`, `function_call`, and server-side tool steps such as `google_search_call`. Delta types include `text`, `image`, `audio`, `thought_summary` (nested at `delta.content.text`), `thought_signature`, and `arguments_delta`.

**Support status:** not supported. This is a different family from Generate Content: the payloads carry `event_type` rather than `type`, use step envelopes, and have no `candidates` array. Parastream reports those events as `unknown` instead of misclassifying them, and normalization of `arguments_delta` or `thought_summary` would need a dedicated adapter.

References: [Interactions API](https://ai.google.dev/gemini-api/docs/interactions), [streaming interactions](https://ai.google.dev/gemini-api/docs/streaming).

### Ollama

Both native endpoints stream NDJSON. `/api/chat` returns `message` objects with `role`, `content`, `thinking`, `images`, and `tool_calls`, plus a terminal `done` object with metrics. `/api/generate` returns `response` and `thinking` fragments with the same terminal object, `done_reason`, and optional logprobs. `tool_calls[].function.arguments` is a JSON **object**, not a string, so it is a complete call rather than a partial-argument delta. The `think` request field accepts a boolean, a level string, or null. Ollama also exposes OpenAI-compatible endpoints, which are recognized by their own shape.

**Detection:** `message` with `role` plus `done`, and `response` plus `done`. Each object is framed independently as NDJSON.

Reference: [Ollama API](https://docs.ollama.com/api).

### Mistral

Mistral Chat streams data-only SSE with `chat.completion.chunk` objects, `choices[].delta.content`, `finish_reason`, and a final chunk carrying `usage`. The API reference describes stream completion as the end of the response rather than documenting a `[DONE]` marker, so treat a sentinel as optional for this vendor. Mistral has since added a Responses-shaped API (preview) and an Agents/Conversations API; neither is claimed here.

**Detection:** the shared Chat Completions family when chunks match `choices[].delta`.

Reference: [Mistral Chat](https://docs.mistral.ai/api/endpoint/chat).

### Hugging Face TGI

Text Generation Inference offers an OpenAI-compatible `/v1/chat/completions` endpoint, which uses the Chat Completions shape. Its native `/generate_stream` emits `textGenerationStream` events whose token payload is `token.text`, a different family.

**Detection:** the OpenAI-compatible endpoint only. Native token events are outside current support and are tested as unknown rather than claimed.

Reference: [TGI streaming](https://huggingface.co/docs/text-generation-inference/conceptual/streaming).

### Cohere Chat v2

Chat v2 emits typed events: `message-start`, `content-start`, `content-delta`, `content-end`, `message-end`, `citation-start`, `citation-end`, `tool-plan-delta`, `tool-call-start`, `tool-call-delta`, and `tool-call-end`. Text is at `delta.message.content.text`. Tool calls are nested at `delta.message.tool_calls` with `id`, `type`, and `function.name` / `function.arguments`; argument deltas follow the same nesting at `delta.message.tool_calls.function.arguments`. Parallel calls repeat the start/delta/end sequence with an `index`. A third-party client patch (LiteLLM PR #47794) confirms the nested shape, and some compatible gateways emit a flatter `tool_call` object instead.

**Detection:** the event `type`, then the nested content or tool-call path. Citations, tool plans, and message lifecycle stay separate from text.

References: [Cohere streaming](https://docs.cohere.com/v2/docs/streaming), [LiteLLM tool-call fix](https://github.com/BerriAI/litellm/pull/47794).

### Amazon Bedrock ConverseStream

ConverseStream returns an event union: `messageStart`, `contentBlockStart`, `contentBlockDelta`, `contentBlockStop`, `messageStop`, `metadata`, and the failure members `internalServerException`, `modelStreamErrorException`, `serviceUnavailableException`, `throttlingException`, and `validationException`. Blocks carry `contentBlockIndex`. The `ContentBlockDelta` union includes `text`, `toolUse`, `reasoningContent`, `citation`, `image`, and `toolResult`; `metadata` carries metrics, usage, and trace. The AWS SDK delivers these as typed objects; the service's raw wire format is a binary event stream, not SSE or NDJSON.

**Detection:** a single-key union match, or any distinctive union key other than a bare `metadata`. `metadata` identifies the family only when it is the event's sole top-level key, because other providers use that field name. Tool-use starts produce tool calls with `toolUseId` and name; `toolUse.input` fragments produce tool-input deltas; `reasoningContent.reasoningText.text` goes to the reasoning channel; citations, images, tool results, and failure members are controls.

Reference: [Bedrock ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html).

### Vercel AI SDK

The SDK has three distinct stream surfaces.

- **Core model parts** from `streamText().stream`: `start`, `text-start`/`text-delta`/`text-end`, `reasoning-start`/`reasoning-delta`/`reasoning-end`, `reasoning-part-finish`, `tool-input-start`/`tool-input-delta`/`tool-input-end`, `tool-call`, `tool-result`, `source`, `file`, `reasoning-file`, `custom`, `start-step`/`finish-step`, `finish`, `error`, `abort`, `raw`, `ping`, and experimental `steering-message`.
- **UI message data stream**: SSE carrying the header `x-vercel-ai-ui-message-stream: v1`. Parts are `start`, `text-start`/`text-delta`/`text-end`, the reasoning trio, `reasoning-file`, `source-url`, `source-document`, `file`, `custom`, `data-*`, `error` with `errorText`, `tool-input-start` (with optional `inputEncoding`), `tool-input-delta` with `inputTextDelta`, `tool-input-available`, `tool-approval-request`/`tool-approval-response`, `tool-output-available`/`tool-output-denied`, `steering-message`, `start-step`, `finish-step`, `reset-step`, `finish`, and `abort`, terminated by `data: [DONE]`.
- **Text stream protocol**: plain text chunks only, which Parastream reads as plain text.

**Detection:** the part `type` discriminant, after SSE framing for the UI protocol. Text, reasoning, refusal, and tool input are separated; lifecycle, step, source, file, data, approval, and error parts become controls. `reset-step` is recognized as a control because it invalidates earlier parts of the current message; a consumer that renders parts must act on it rather than treating it as a no-op.

References: [streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text), [stream protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol).

One collision is unavoidable at the payload level: a bare `{"type":"ping"}` part has the same shape as Anthropic's keep-alive, so it is reported as an Anthropic control. Every other AI SDK part in the lists above is detected as `ai-sdk`.

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
11. Wire specifications leave room for provider sentinels and leniency. A sentinel such as `[DONE]` belongs to the protocol layer, not to SSE or NDJSON.
12. One vendor can run several streaming APIs at once (Gemini Generate Content and Interactions, Mistral Chat and Responses, OpenAI Responses and Chat Completions). Support is scoped per API shape, never per vendor.
13. Invalidating events exist. The AI SDK's `reset-step` removes parts already streamed for the current step, which no append-only text channel can express; a consumer must handle it explicitly.

## Research limits

This pass reviewed primary documentation for the SSE and NDJSON wire specifications, OpenAI Responses and Chat Completions, Azure OpenAI content filtering, Anthropic Messages, Google Gemini Generate Content and Interactions, Ollama, Mistral, Hugging Face TGI, Cohere Chat v2, Amazon Bedrock ConverseStream, and the Vercel AI SDK stream protocols; it also reviewed the pinned source snapshots for OpenCode, OpenClaude, Vercel AI SDK Workflows, Continue, and the local T3 Code commit noted above.

It was a source-level review, not live-provider certification. It did not exercise hosted gateways, Vertex AI wrappers, OpenAI's Responses WebSocket mode, Bedrock's raw event-stream binary framing, provider SDK type definitions at a pinned release, or any multimodal payload beyond noting its existence. Beta and preview APIs change without notice, and one vendor's compatible-mode endpoint can lag its native API. Re-check the linked sources, and the fixtures in `tests/fixtures/`, before relying on these observations for a release.
