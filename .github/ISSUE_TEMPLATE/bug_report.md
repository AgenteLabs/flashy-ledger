---
name: Bug report
about: Something this package does that its rules say it must not
title: ""
labels: bug
assignees: ""
---

## What happened

<!-- One paragraph. What you posted, what came back, what you expected. -->

## Reproduction

<!-- Smallest thing that shows it. A failing test in tests/ is ideal;
     a snippet against InMemoryLedgerStore is fine. -->

```ts
```

## Which invariant

<!-- docs/INVARIANTS.md numbers them I-1 to I-8. Name the one this breaks,
     or say "none — it is a defect outside the invariants". -->

## Environment

- `@flashylabs/ledger` version:
- Node version:
- Store adapter (memory / mongo / your own):
- If mongo: driver version, and whether `ensureIndexes()` has run

## Security

<!-- If this could let a balance move without an entry, be forged, or be
     read across a tenant, do NOT file it here — see SECURITY.md. -->
