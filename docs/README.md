# Parastream documentation

This documentation describes the 0.0.1 development target. Compatibility means support for a documented protocol shape, not every model or deployment using that provider. [Protocol detection](protocol-detection.md) carries the support matrix, including the families that are recognized but deliberately not normalized.

## Guides

- [Architecture](architecture.md): processing layers, data flow, and invariants.
- [API contract](api.md): current functions, options, and examples.
- [Protocol detection](protocol-detection.md): signals, extraction rules, support matrix, and fallback behavior.
- [Protocol research](protocol-research.md): primary references consulted and what they imply for the design.
- [Testing](testing.md): test location, fixtures, boundary cases, and validation commands.

## Architecture decisions

- [ADR 0001: TypeScript, ESM, Zod, and Bun](adr/0001-typescript-esm-zod-bun.md)
- [ADR 0002: Detect protocol envelopes, not model names](adr/0002-protocol-detection.md)
- [ADR 0003: Normalize typed events and preserve unknowns](adr/0003-normalized-events.md)
- [ADR 0004: Node.js 22 minimum](adr/0004-node-22.md)
- [ADR 0005: Lossless text segmentation contract](adr/0005-lossless-segmentation.md)

## Versioning note

These are working decisions for version `0.0.1`, not a promise of stable API compatibility. Update the relevant ADR when a decision changes.
