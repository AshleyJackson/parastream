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

## Cross-provider conclusions

1. Model identity and response protocol are different concepts.
2. The same HTTP transport can carry unrelated event schemas; transport detection alone is insufficient.
3. SSE frames can contain JSON, plain text, or a sentinel such as `[DONE]`; only the protocol adapter knows what the payload means.
4. “Text-like” does not mean “user-facing text.” Reasoning, refusals, tool JSON, and multimodal parts need distinct channels.
5. Some providers emit protocol lifecycle and usage events with no text. Preserve ordering and associate them with the stream.
6. Forward-compatible parsers should accept unknown optional fields and preserve unknown event types.
7. A versioned schema test corpus is more reliable than provider-name or model-name heuristics.

## Research limits

This pass reviewed primary documentation for OpenAI, Anthropic, Google Gemini, Ollama, Mistral, Azure OpenAI, Hugging Face TGI, Cohere, Amazon Bedrock, and Vercel AI SDK. It did not audit every hosted gateway, SDK release, Vertex wrapper, WebSocket protocol, or multimodal output format. Additional adapters should be added only with primary references and representative fixtures.
