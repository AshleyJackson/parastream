# ADR 0002: Detect protocol envelopes, not model names

- Status: Accepted
- Date: 2026-11-03
- Amended: 2026-11-10

## Context

Model names do not determine wire format. One vendor may expose several APIs, and many vendors implement the same OpenAI-compatible shape. Guessing from model IDs, URLs, or response text can silently extract the wrong field.

## Decision

Separate transport detection from payload detection. Use response headers or an explicit caller hint for transport, then use Zod-validated structural signatures on complete events. Support explicit protocol overrides. Return unknown when evidence is ambiguous; never recursively search arbitrary JSON for text.

## Consequences

- Detection results identify protocol families, not vendors or model families.
- A provider that is OpenAI-compatible can use that adapter without vendor-specific branching.
- Bare body streams without headers may require an explicit transport.
- New/unknown events can be surfaced without breaking the whole stream.

## Amendment (2026-11-10)

The detection vocabulary is the set of families in `docs/protocol-detection.md`. Signatures may be structural (an AWS union member, `candidates[]`), type-based (an event `type` or a bounded set of typed event names), or a family prefix such as `response.*`.

Weak discriminators require corroboration. `metadata` identifies Bedrock only as an event's sole top-level key, and `ping` belongs to Anthropic rather than to the AI SDK. When a vendor ships several APIs, each one is a separate family: the Gemini Interactions API is not approximated by the Generate Content adapter, and an unsupported family is reported as `unknown`. A caller's hint that contradicts a recognized family is an error rather than a silent override.
