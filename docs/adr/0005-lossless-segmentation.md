# ADR 0005: Lossless text segmentation contract

- Status: Accepted
- Date: 2026-11-03

## Context

Trimming text or dropping separators changes the source. Forced emission at a buffer limit can also split a semantic unit. Those behaviors conflict with transparent stream processing unless documented as transformations.

## Decision

The default core contract is lossless: do not trim output or drop delimiters implicitly. Any normalization is opt-in. End-of-stream is an explicit flush. A hard buffer limit must fail explicitly or emit a separately identified fragment; it must not claim a forced fragment is a complete paragraph or sentence.

## Consequences

- Tests can assert exact reconstruction of source text.
- Callers who want presentation-friendly chunks must request trimming or delimiter removal.
- A bounded-memory policy must be part of the API rather than an undocumented truncation.

## Amendment (2026-11-10)

The implemented contract adds three details:

- **No empty units.** A boundary with no content is not a unit. Consecutive delimiters are folded into the next emitted unit, so `"a\n\n\n\nb"` yields `["a\n\n", "\n\nb"]` with delimiters preserved.
- **Overflow is an error.** A pending unit larger than `maxBuffer` throws a `RangeError` instead of being split into a fragment that claims to be complete.
- **Lookahead is not content.** Up to three buffered code units (one for lines) can still turn out to be part of a delimiter, so they are not charged against `maxBuffer`. End-of-stream emits the residual with `isFinal: true`, and a stream that ends immediately after a delimiter adds no trailing empty unit.
