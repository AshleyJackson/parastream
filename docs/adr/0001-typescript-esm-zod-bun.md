# ADR 0001: TypeScript, ESM, Zod, and Bun

- Status: Accepted
- Date: 2026-11-03

## Context

Paratoken needs a single predictable source format, runtime validation at provider boundaries, and local commands that match this repository’s Bun instructions.

## Decision

- Author all project source in strict TypeScript.
- Publish ESM only; do not generate a CommonJS entry point.
- Use Zod for public option validation and protocol-envelope discrimination.
- Use Bun for install, test, and local build commands.
- Keep provider schemas permissive for unknown fields while validating every field used by an adapter.

## Consequences

- There is one module graph and no dual-package hazard.
- Zod is a runtime dependency and contributes to the package’s dependency footprint.
- TypeScript is a development/build dependency; consumers can use the emitted JavaScript without TypeScript at runtime.
- ESM-only excludes consumers that require CommonJS without an ESM bridge.
