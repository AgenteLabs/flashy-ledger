---
name: Feature request
about: A capability the ledger should have, and which rule it must not bend to get it
title: ""
labels: enhancement
assignees: ""
---

## The need

<!-- What are you trying to settle, record or verify that you cannot today? -->

## The proposal

<!-- Shape of the API or the change. A type signature is worth a paragraph. -->

## Invariants

<!-- Tick each, or explain underneath why it does not apply. A request that
     needs one of these to bend is a request for a different product. -->

- [ ] Entries remain **append-only** — nothing updates or deletes history
- [ ] Amounts stay **signed integers in minor units** — no floats, one convention
- [ ] Every write is **idempotent** under a stable key
- [ ] Balances stay **derived** — no new authoritative balance column
- [ ] The **domain stays pure** — no clock, randomness or I/O under `src/domain`
- [ ] Reads and uniqueness stay **tenant-scoped**

## Migration impact

<!-- Does this change the entry format or the hash input? If so, what happens
     to chains written before the change? -->
