# ADR 0003: Normalize typed events and preserve unknowns

- Status: Accepted
- Date: 2026-11-03

## Context

Provider streams mix user text with reasoning, refusals, tool input, usage, lifecycle events, and multimodal content. Flattening every string field into one text buffer risks leaking or corrupting non-user-facing content and reorders structured interactions.

## Decision

Normalize recognized payloads into typed parts: text, reasoning, refusal, tool-input, control, and unknown. Preserve event order and useful block/item identifiers. Only the caller-selected text channel enters text segmentation. Keep raw payloads for unknown events and allow unknown fields on recognized events.

## Consequences

- Provider adapters remain small and composable.
- Applications must explicitly choose which channels to display or segment.
- `unknown` is a supported result, not a parser failure.
- Full tool-call parsing and multimodal decoding remain outside the text segmenter.
