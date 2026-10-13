# Contributing to @flashylabs/ledger

This package is part of the Flashy Labs estate, a Fortune 10-grade open source platform.

## Quick Start

```bash
npm install
npm test        # must pass
npm run lint    # must pass
```

## Rules

These rules are enforced by tests; they're not decorative.

### Architecture
- **Balance can't go negative** — `LedgerError` is thrown before any write (test: `tests/ledger.test.ts`)
- **Replay is idempotent** — the same `idempotencyKey` settles exactly once, never twice (test: `tests/conformance.test.ts`, run against every adapter)
- **The append-only log is immutable** — entries cannot be deleted or modified after written (test: `tests/ledger.test.ts`, the tamper checks)
- **The wire shapes match the code** — `schema/*.json` agree with the TypeScript unions (test: `tests/schema.test.mjs`)

### Before you push

1. **Tests pass:** `npm test` (no mocks; real invariants only)
2. **Lint passes:** `npm run lint` (house style)
3. **Standalone tests pass:** `npm run test:standalone` (wire schemas, and all "See also" links are well-formed)

If a test fails, the fix belongs in this repository, not in the test.

### Commit messages

- Link to the issue or decision you're addressing
- One sentence summary of the change
- Co-author with your name: `Co-Authored-By: Your Name <you@example.com>`

Example:
```
Fix balance check on negative transfer (#42)

The `debit` method was accepting negative amounts without throwing.
Added validation to LedgerError before any write.

Co-Authored-By: Jane Doe <jane@example.com>
```

### No half-finished work

If you're unsure whether something is right, add a test that fails on the wrong behavior. Don't merge a test that passes with a FIXME comment.

### Documentation

- Every package invariant has a test
- Every test failure message is a complete sentence (no abbreviations)
- Every README section has a real example that runs
- README "See also" links all resolve (test enforces this)

## The two boundaries that outrank everything

**No token or incentive mechanic may ever be an input to any algorithm this package enforces.**

This is inherited estate doctrine. Consent, trust, standing, and authorization are never influenced by rewards.

**No training on relationship data, by default and by design.**

If you're working on a feature that collects or exports relationship data for model training, the answer is no — unless the user has explicitly opted in, per-graph, with explicit revocation.

## Questions?

See [flashy.tools](https://flashy.tools) for the full package ecosystem and integration examples.

## License

Apache-2.0, © 2026 Flashy Labs
