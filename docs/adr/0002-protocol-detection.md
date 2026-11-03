# ADR 0002: Detect protocol envelopes, not model names

- Status: Accepted
- Date: 2026-11-03

## Context

Model names do not determine wire format. One vendor may expose several APIs, and many vendors implement the same OpenAI-compatible shape. Guessing from model IDs, URLs, or response text can silently extract the wrong field.

## Decision

Separate transport detection from payload detection. Use response headers or an explicit caller hint for transport, then use Zod-validated structural signatures on complete events. Support explicit protocol overrides. Return unknown when evidence is ambiguous; never recursively search arbitrary JSON for text.

## Consequences

- Detection results identify protocol families, not vendors or model families.
- A provider that is OpenAI-compatible can use that adapter without vendor-specific branching.
- Bare body streams without headers may require an explicit transport.
- New/unknown events can be surfaced without breaking the whole stream.
