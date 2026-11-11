# ADR 0003: Normalize typed events and preserve unknowns

- Status: Accepted
- Date: 2026-11-03
- Amended: 2026-11-10

## Context

Provider streams mix user text with reasoning, refusals, tool input, usage, lifecycle events, and multimodal content. Flattening every string field into one text buffer risks leaking or corrupting non-user-facing content and reorders structured interactions.

## Decision

Normalize recognized payloads into typed parts: text, reasoning, refusal, tool-input, control, and unknown. Preserve event order and useful block/item identifiers. Only the caller-selected text channel enters text segmentation. Keep raw payloads for unknown events and allow unknown fields on recognized events.

## Consequences

- Provider adapters remain small and composable.
- Applications must explicitly choose which channels to display or segment.
- `unknown` is a supported result, not a parser failure.
- Full tool-call parsing and multimodal decoding remain outside the text segmenter.

## Amendment (2026-11-10)

The part union is `text-delta` (with `channel` of `output`, `reasoning`, or `refusal`), `tool-input-delta`, `tool-call`, `control`, and `unknown`. Tool and control parts carry `toolCallId`, `toolName`, `blockId`, or `eventType` when the provider supplies them, so concurrent calls and blocks stay distinguishable.

Two refinements follow from practice:

- A recognized event that carries no text becomes a `control`, never an empty `text-delta`.
- Some controls are not informational. The AI SDK `reset-step` part invalidates parts already emitted for the current step. Paratoken's message assembler restores its checkpoint and emits `reset` with the restored state. A bare `reset-step` report is faithful; previously delivered events and external side effects cannot be automatically retracted.

For applications that need accumulated state and completed tool inputs, `consume()` and `createMessageAssembler()` provide text buffers, tool-argument accumulation, JSON parsing, limits, and `reset-step` support.
