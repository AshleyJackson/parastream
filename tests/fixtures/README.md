# Protocol fixtures

These are synthetic, sanitized examples of documented streamed payload shapes, not recordings from live provider accounts. They contain no credentials or personal data. Fixtures were checked against the linked primary references on **2026-11-03**.

The provider-fixture tests run each event stream through transport framing and normalization where that transport is supported. Bedrock fixtures contain SDK-decoded event objects, not the raw AWS EventStream wire format. Gemini fixtures use SSE framing; Ollama fixtures use NDJSON. Vercel AI SDK core parts are decoded objects, while UI parts use its SSE data-stream format.

| Fixture | Shape under test | Primary reference |
|---|---|---|
| `openai-chat-completions.sse` | OpenAI Chat Completions chunks and `[DONE]` | [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming) |
| `openai-responses.sse` | OpenAI Responses lifecycle, text, and function-call events | [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming) |
| `anthropic-messages.sse` | Anthropic named events, text, thinking, and tool-input deltas | [Anthropic streaming](https://docs.anthropic.com/en/docs/build-with-claude/streaming) |
| `gemini-stream.sse` | Gemini `streamGenerateContent` SSE candidates, thought-marked text, and function calls | [Gemini `streamGenerateContent`](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent) |
| `ollama-chat.ndjson`, `ollama-generate.ndjson` | Native Ollama chat and generate response objects | [Ollama API](https://docs.ollama.com/api) |
| `cohere-chat-v2.sse` | Cohere typed events, content deltas, and tool-call deltas | [Cohere streaming](https://docs.cohere.com/v2/docs/streaming) |
| `bedrock-converse-sdk-events.json` | SDK-decoded Bedrock ConverseStream union events | [Bedrock ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html) |
| `vercel-ai-sdk-core.jsonl` | Vercel AI SDK core stream parts | [AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) |
| `vercel-ai-sdk-ui.sse` | Vercel AI SDK UI SSE data-stream parts | [AI SDK UI stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) |
| `mistral-chat-completions.sse` | Mistral Chat Completions-compatible chunks | [Mistral Chat](https://docs.mistral.ai/api/endpoint/chat) |
| `azure-openai-chat-completions.sse` | Azure Chat Completions chunks and moderation annotation | [Azure content streaming](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/content-streaming) |
| `huggingface-tgi-openai-compatible.sse` | TGI OpenAI-compatible Chat Completions chunks | [TGI streaming](https://huggingface.co/docs/text-generation-inference/conceptual/streaming) |

Mistral, Azure OpenAI, and TGI use the shared Chat Completions protocol adapter in these tests. Passing these fixtures verifies the documented envelope handling, not every model, deployment, or provider-specific extension. TGI's native token-event format is deliberately tested as unknown rather than claimed as supported.
