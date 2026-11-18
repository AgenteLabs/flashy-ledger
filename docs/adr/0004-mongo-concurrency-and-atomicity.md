# ADR 0004 — Concurrency and atomicity live in the Mongo adapter, as indexes

**Status:** Accepted · 2026-10-04

## Context

ADR 0003 made the domain pure and put persistence behind `LedgerStore`. That
leaves the hard operational guarantees — a replay never becomes a second entry,
two concurrent appends never both build on one chain head, a transfer never
lands half — to the adapter. The domain cannot help here: it reads no database,
so it cannot see the race. The port (`src/ports/store.ts`) states the
guarantees; this ADR records how the Mongo adapter keeps them, because the
reasoning is not obvious from the code and the wrong fix (enforcing them in
application code) looks correct right up until two processes race.

## Decision

**The guarantees are indexes, not code.** `ensureIndexes()` creates two unique
indexes, and they — not the `findByIdempotencyKey` pre-check in `append()` — are
the real guard, because code in this file runs once per process and an index
runs on every write from every process forever.

- `uniq_tenant_idempotency` on `(tenantId, idempotencyKey)` makes a replay a
  no-op even when two processes submit the same key in the same instant, and
  scopes the key to the tenant so two networks deriving a similar key from
  similar source events do not deduplicate against each other.
- `uniq_tenant_chain_head` on `(tenantId, identityId, assetId, previousHash)`
  lets exactly one of two appends that read the same head actually land; the
  loser gets a duplicate-key error. It needs no partial filter: `identityId` and
  `assetId` are in the key, so "one entry with no predecessor" is scoped per
  chain rather than one null across the collection.

**A duplicate-key error is disambiguated, not swallowed.** On `insertOne`
failing with code 11000, `append()` re-reads by idempotency key. A winner found
means this was a replay — return it, `deduplicated: true`. No winner means the
collision was on the chain head — a genuine conflict, thrown so the caller
re-reads state and retries. Collapsing those two into one outcome would turn a
lost update into a silent success.

**Legacy indexes are dropped by name, first.** The pre-0.2 indexes were globally
unique rather than tenant-scoped. A surviving `uniq_idempotency` would keep
rejecting a second tenant's legitimate write that the new index permits, so
creating the new indexes without dropping the old would look like a migration
and behave like none.

**A multi-entry append requires a session, and refuses without one.** A
transfer's two legs must both commit or neither, which a single-document
database cannot give for free. `appendAll` opens a transaction via a
`MongoClient`; constructed without one, it rejects any batch of more than one
entry rather than writing the first leg and failing on the second. A torn
transfer is worse than a refused one. (A single-entry batch and an empty batch
need no session and are allowed.)

## Consequences

Good: the guarantees hold under real concurrency, across processes, without a
lock the application has to remember to take. The same conformance suite that
the in-memory reference passes runs against this adapter unchanged (ADR 0003),
against real Mongo in CI (`MONGO_URL` set), so "behaves like the reference" is
proven, not asserted.

Costs: multi-entry atomicity needs a replica set, so a standalone `mongod`
cannot run transfers — which the adapter surfaces as a refusal, not a
half-write. Transactions carry retry semantics: `withTransaction` may re-run the
callback, so `appendAll` resets its per-attempt results rather than appending
across attempts.

## How it is proved

- The concurrency and atomicity behaviour: `tests/conformance.test.ts` —
  idempotent replay, the chain-head race, tenant isolation, and transfer
  atomicity, run against every adapter the catalog declares (see
  `docs/INVARIANTS.md`, *Coverage*), with Mongo exercised in CI.
- The refusal without a client, which conformance does not reach because it
  always passes one: `tests/mongo-adapter.test.ts` — a multi-entry append with
  no client throws before touching the collection, and names the fix.
- The amount-encoding boundary that an adoption is most likely to relax:
  `tests/field-map.test.ts`, *the amount guard* (invariant I-2).
