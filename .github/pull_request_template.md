## What changed

<!-- One paragraph. What moves, and why now. -->

## Ledger invariants

Tick each, or explain underneath why it does not apply.

- [ ] Entries remain **append-only** — nothing updates or deletes history
- [ ] Amounts are **signed integers in minor units** — no floats
- [ ] **One sign convention** — credits positive, debits negative, no unsigned variant
- [ ] Every write is **idempotent** under a stable key
- [ ] Balances stay **derived** — no new authoritative balance column
- [ ] Every read and every uniqueness constraint is **scoped to a tenant** — nothing is global
- [ ] The **domain stays pure** — no clock, randomness or I/O under `src/domain`

The full numbered set, with the test behind each, is `docs/INVARIANTS.md`.

## Verification

- [ ] `npm run check` passes locally
- [ ] New behaviour is covered by tests, including its failure cases

## Migration impact

<!-- Does this change the entry format or the hash input? If so, say what
     happens to chains written before this change. -->
