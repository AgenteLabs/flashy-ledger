# The invariants, numbered

The artifact an auditor asks for: every guarantee this package makes, stated
once, numbered so it can be cited, and mapped to the executable check that
proves it. A guarantee with no test behind it is a preference.

`tests/invariants.test.ts` asserts that this table and the code agree — every
invariant below names a test that exists, and the count here matches the count
there. The document cannot drift from the suite without failing the build.
`vendor-invariants.mjs` at the root — a byte-identical copy of spec-kit's
`invariants/1` harness, pinned to canon by `tests/vendor-invariants-drift.test.ts`
and reported UNKNOWN when canon is absent — checks the same contract from the
command line (`node vendor-invariants.mjs check .`) and is what
`tests/invariants-harness.test.ts` drives: the invariants that are about *pairs*
of writes, run under every schedule the harness knows and under seeded random
command sequences, with the pre-fix reference store handed to the harness so a
green run means the harness can see.

## I-1 · Append-only

**Claim.** An entry, once written, is never modified or removed. A correction is
a new entry that references what it corrects.

**Why.** History you can edit is not evidence. The incident register, the
inclusion proofs and the anchored roots all rest on this one.

**Enforced by.** `LedgerStore` exposes no update and no delete — not as policy
but as absence, so there is no method to call. `reverse()` produces a
compensating entry rather than mutating the original.

**Proved by.** `ledger.test.ts` › *undoes by mirroring, never by editing history*,
and the two tamper checks that make the absence detectable rather than merely
intended: › *detects an entry edited after the fact* and
› *detects a removed entry by the break it leaves in the chain*.

Those tamper checks are only as strong as the bytes they hash, and `post()` and
`verifyEntry()` both call `hashEntry`, so a change to the preimage would be
self-consistent and leave every one of them green while every chain already
written stopped verifying. `entry-hash.test.ts` pins the format itself, to
digests computed outside this codebase:
› *hashes the twelve fields, in order, joined by NUL, to a vector computed outside this codebase*,
› *matches a second outside vector: chained, negative, no source id, millisecond precision* and
› *joins with a NUL byte and nothing else*.
[`entry-hash.md`](./entry-hash.md) states those bytes for a reader outside this
repository.

A correction is a new entry that points at what it corrects, and
`reversal.test.ts` runs `reverse()` through a store:
› *lands as a new entry, not a replay of the original, and returns the balance to where it began*,
› *carries the original’s tenant, identity and asset, and points its source at the original* —
the reference the claim asks a correction to carry — and
› *still reverses once the credited funds have been spent, taking the balance below zero*,
so a correction after the money has moved is recorded rather than refused.

`verifyChain` is what finds an edit or a removal, and `verify-chain.test.ts`
breaks its rules one at a time and asserts the complete list of problems rather
than a pattern:
› *content: an edit to a hashed field that was not re-sealed is the only problem reported*,
› *link: an entry that does not chain onto its predecessor is the only problem reported* and
› *start: a chain whose first entry names a predecessor has lost its beginning*.
The last is how history trimmed from the front is noticed.

## I-2 · Signed integer minor units

**Claim.** Every amount is a whole number of the asset's smallest unit, carried
as a branded `Minor`. Never a float, never a formatted string.

**Why.** Binary floating point cannot represent most decimal fractions exactly,
so sums drift as volume grows. The predecessor stored amounts as `Float` and 185
production rows disagreed with their own balance movement. See ADR 0002.

**Enforced by.** The `Minor` brand, so a raw number cannot be passed by accident;
`fromDecimal` throws `PrecisionError` on more precision than the asset allows,
rather than rounding.

**Proved by.** `ledger.test.ts` › *rejects precision the asset cannot hold rather than rounding it*,
› *rejects non-finite and non-integer values*, and
› *adds exactly where floating point would not* — the last being the case the
predecessor failed in production. The brand is a compile-time promise, so
`post()` re-asserts it at runtime on the one path every entry takes:
› *re-asserts the Minor brand at runtime, so a JSON body cannot hash a NaN, a fraction or a string into a chain*.

## I-3 · One sign convention

**Claim.** Credits are positive, debits negative, everywhere, with no unsigned
variant and no separate debit function.

**Why.** So that `SUM(amount)` means something. The predecessor had services
writing debits both ways, which made the sum meaningless and is precisely why
the reconciliation invariant on flashynetwork.com cannot yet run.

**Enforced by.** `post()` derives `balanceAfter` from the signed amount. There is
no API that takes a magnitude and a direction.

**Proved by.** `ledger.test.ts` › *debits with a negative amount, one convention throughout*,
and › *produces a matched debit and credit, never a bare balance edit*.
A transfer takes one positive magnitude and derives both signs, so there is no
direction to hand it, and `transfer-guards.test.ts` holds the guard that keeps it
so: › *refuses a negative amount, which would debit a recipient who never consented*.
The refusal carries the code `ZERO_AMOUNT`, whose message talks about zero; the
code is what a caller switches on.

## I-4 · Idempotent writes

**Claim.** A write carries a key derived from its source event. A replay of that
key returns the original entry and writes nothing.

**Why.** Retries are constant at scale, and a retry that awards twice is a money
bug that looks like generosity.

**Enforced by.** A unique index on `(tenantId, idempotencyKey)`, so the database
refuses a duplicate even when two processes race — code in one file runs once per
process, an index runs on every write from every process forever.

**Proved by.** `conformance.test.ts` › *returns the original entry when a key is replayed, and writes nothing*,
run against every adapter, and
› *still deduplicates a genuine replay within one tenant*, which guards the
scoping change in I-6 from over-correcting into a lost deduplication. Under
interleaving, `invariants-harness.test.ts`
› *the same key appended twice, under every schedule: one entry on the record, both callers handed it, exactly one reported as new* —
sequential, both orders, started together, a macrotask apart — with the
mutation check › *refuses a store that forgot its key index: the replay lands twice on every schedule*.
A transfer is two writes from one source event, so it carries two keys, and
`transfer-guards.test.ts` pins them:
› *keys the legs exactly `<key>:out` and `<key>:in`, debit first* and
› *returns both legs deduplicated and leaves both balances unchanged* when the
same transfer is retried. A reversal derives its key from the entry it reverses,
and `reversal.test.ts` shows the consequence:
› *lands once when the same original is reversed twice, with state re-read each time*.

## I-5 · Balances are derived

**Claim.** A balance is a fold over entries. Any stored balance is a cache of
that fold and must be rebuildable from it at any time.

**Why.** A cache can be rebuilt; a truth cannot. This is what lets projections be
sharded, rebuilt or thrown away, and what makes Σ(entries) = Σ(balances) a
meaningful question rather than a tautology.

**Enforced by.** `balanceOf()` folds entries; stores hold projections and are
never the source.

**Proved by.** `ledger.test.ts` › *derives a balance from entries alone*, and
› *keeps assets separate on one identity*, so the fold is per asset rather than
per identity. Under random sequences of `post`, `postTransfer`, `reverse`, a
replay and a write against a stale head, `invariants-harness.test.ts`
› *every stored balance is the fold over its entries, every chain verifies, every head is the last entry, and no balance goes negative except by a reversal* —
the stored state is compared to the fold after every command, so a store
whose projection can part from its entries fails the run. Within one chain,
`verify-chain.test.ts` catches the balances recorded on the entries parting from
each other, one rule each:
› *continuity: an entry that opens at a different balance than its predecessor closed at is the only problem reported* and
› *arithmetic: an entry whose amount does not account for its own movement is the only problem reported*.

## I-6 · Tenant isolation

**Claim.** Every read and every uniqueness constraint is scoped to one tenant. No
read returns another tenant's entry, and no write is refused because a different
tenant used the same idempotency key.

**Why.** Added in 0.2.0. `tenantId` was written onto every entry and used in no
query, which is harmless with one tenant and three money bugs with two — the
worst being a cross-tenant idempotency collision that returned another tenant's
entry while reporting a successful deduplication.

**Enforced by.** `AccountRef` and `HistoryRef` make the tenant a required
parameter, so a cross-tenant read does not compile; unique indexes on
`(tenantId, idempotencyKey)` and `(tenantId, identityId, assetId, previousHash)`;
`ensureIndexes()` drops the pre-0.2 global indexes, which would otherwise defeat
the change silently.

**Proved by.** `conformance.test.ts` › *tenant isolation* — six cases, run against
every adapter, of which four were verified to fail against the pre-0.2
implementation. The two that name the money bugs directly:
› *lets two tenants use the same idempotency key without deduplicating* and
› *scopes findByIdempotencyKey, so a lookup never returns another tenants entry*.

`GoldLedgerReader` is read-only and so outside that catalog (see *Coverage*).
`gold-ledger-tenancy.test.ts` holds it directly, with two tenants that share a
customer id, an asset id and an idempotency key:
› *findByIdempotencyKey returns the asked tenant’s entry and never the other’s*,
› *readState reports the asked tenant’s balance, and an empty one for a stranger* and
› *readEntries returns only the asked tenant’s entries, and stamps each with that tenant*.

**Known exception.** `GoldLedgerReader.verifyBalance` compares the tenant-scoped
ledger balance with a wallet document it finds by `customerId` alone, because the
wallet record carries no tenant. Its ledger half is scoped and its wallet half is
not; `gold-ledger.test.ts` checks the comparison, and no test here checks the
wallet half against a second tenant.

## I-7 · All or nothing consumption

**Claim.** A multi-asset consumption that cannot be afforded in full produces no
entries at all. No asset in the bill is debited unless every asset can be.

**Why.** Added in 0.3.0 with `postConsume`, the primitive building needs. The
failure it prevents is the partial spend: wood debited, stone found short, and
someone left poorer with nothing to show for it. That bug is silent — it surfaces
weeks later as a support ticket about missing resources, with no entry anywhere
saying what happened.

**Enforced by.** Ordering, not error handling. `postConsume` computes the
shortfalls across every cost before it produces a single entry, and throws
`InsufficientForConsumptionError` carrying all of them. The same `shortfalls()`
function answers the caller's "can this be built?", so a preview cannot disagree
with the rule. `allowNegative` is not part of `ConsumeCommand`, so a build cannot
be financed with debt by passing a flag.

Completeness of an *affordable* build is the store's guarantee, not the domain's:
the entries go to `appendAll` on a `TransactionalLedgerStore`. A loop over
`append` that fails on the third leg has spent the first two — the same failure,
one layer down.

**Proved by.** `consume.test.ts` › *destroys nothing — not even the assets it could have paid for*,
› *reports every shortfall, not the first one found*,
› *offers no way to finance a build with debt*, and
› *lands every leg together, and each asset keeps its own verifiable chain*.

## I-8 · Identities are opaque

**Claim.** An `identityId` is an opaque token scoped to one tenant. It is never a
natural key — never an email address, a phone number, a wallet address or a
public key.

**Why.** Added in 0.5.0. The ledger keys on a tenant-scoped identifier and never
resolves who a person is; linkage across tenants belongs to an identity layer,
where it can be consented to and withdrawn. A link recorded inside an entry
cannot be withdrawn at all — the entry is immutable and every subsequent hash
depends on it, so a consent revoked later has nothing to act on.

That reasoning is worth little by itself. The failure that actually happens is a
service passing `user@example.com` because it was the value to hand, into a
record that is append-only, hash-chained and published. A natural key correlates
across tenants **even with no shared namespace at all**, which makes the careful
scoping moot in practice and does so silently.

**Enforced by.** `assertOpaqueIdentity()`, called from `post()` before anything
is hashed — the one path every entry takes, rather than a helper a caller may
forget. The patterns are deliberately narrow: a guard with false positives gets
switched off, and then nothing is checked. ObjectIds, ULIDs, UUIDs, nanoids and
bare integers all pass, and base58 is not attempted at all because it cannot be
told from an opaque token.

`surrogateIdentity(value, tenantSalt)` gives the caller the fix rather than only
a refusal, and its per-tenant salt produces the pairwise property: the same
person at two issuers yields two unrelated identifiers, with no coordination
between the tenants.

**Proved by.** `identity.test.ts` › *refuses at post(), so no entry can be written that skips the check*,
which was verified by removing the call and watching it fail. The false-positive
half matters as much: › *does not reject a 24-hex ObjectId as a wallet address*
guards the one consumer this package has. The surrogate is held to
› *differs per tenant, which is the pairwise property*,
› *produces something the guard accepts* — otherwise the advice in the error
message would be wrong — and
› *refuses a salt short enough to be brute-forced*.
The derivation itself is pinned by `surrogate-identity.test.ts` to digests
computed outside this codebase:
› *derives sha256 of `<salt> <value>` to a vector computed outside this codebase* and
› *matches a second tenant vector, so the salt is part of the preimage and not decoration*,
and the floor is held at its edge by
› *refuses a 15-character salt and accepts a 16-character one*.

## I-9 · One head per chain

**Claim.** Every entry chains onto the head of its `(tenantId, identityId,
assetId)` chain as it stood when the entry was written. Two appends that both
read the same head cannot both land; the second is refused and the caller
re-reads state and retries.

**Why.** Added in the 1.0.x line. Port contract §4 had promised this since the
store interface was written, and the Mongo adapter kept it by a unique index on
`(tenantId, identityId, assetId, previousHash)`. The in-memory reference
implementation — the executable specification every adapter is measured against
— did not: two interleaved debits of a whole balance both settled, the stored
balance read zero, and the fold over the entries read minus the balance. A
transfer from an identity to itself was the same fault reached a different way:
both legs posted against one state, so the chain forked and the holder was
credited the sum of both legs.

**Enforced by.** `InMemoryLedgerStore.appendAll` computes the live head of each
candidate's chain — including anything staged earlier in the same batch — and
refuses a candidate whose `previousHash` is not that head, with the same error
the Mongo path raises when its index refuses the insert. `postTransfer` refuses
`from.identityId === to.identityId` outright, because no store can make two legs
on one head mean anything.

**Proved by.** `conformance.test.ts` › *refuses a second append on a head another append has already moved*
and › *refuses a batch whose entries fork one chain, and lands neither*, both
run against every adapter; and `ledger.test.ts`
› *refuses a transfer from an identity to itself, which would fork its chain and mint the amount*;
`transfer-guards.test.ts` adds that the refusal comes first:
› *is refused with SELF_TRANSFER before any leg is built*.

Those run the race in the order the test chose. Under interleaving,
`invariants-harness.test.ts`
› *two debits of the whole balance and a credit, every ordered pair, every schedule: exactly one of the debits lands, the chain verifies, and the stored state is the fold*
(nine ordered pairs, forty-five schedules), and the mutation check hands the
harness the reference store as it was before this invariant was enforced:
› *refuses the pre-fix reference store, whose appendAll ignores the head, on exactly the two started-together schedules* —
`a||b` and `b||a`, and no other: sequentially the second read sees the moved
head and `post()` refuses, and a macrotask apart the first append has landed.
That is the exact shape of the defect, a guarantee that held for one write at a
time. The same store under random sequences is refused by
› *refuses the pre-fix reference store under the same sequences — a write against a stale head lands, and shrinks to capture, write, stale write*,
the port's §4 case — a caller that did not re-read state — reduced to three
commands.

## I-10 · The domain is pure and storage-agnostic

**Claim.** `src/domain/**` reads no database, calls no clock, and generates no
randomness. Its only dependencies are other domain modules and `node:crypto`
for hashing, which is deterministic. The dependency arrow points one way:
`index` and `ports` and `adapters` may import the domain; the domain imports
none of them.

**Why.** This is the sentence the README and the roadmap rest the whole package
on — it is *the entire reason the ledger can move onto a chain without its rules
changing*, and why the rules can be tested exhaustively with no database in
sight. Purity has two halves and they fail differently. A clock or a random
source in the domain makes a hash non-replayable, so a verifier recomputing it
later disagrees with the sealed value — the invariant that Phase 2 anchoring
depends on. A dependency pointing the wrong way — a domain module importing an
adapter or `node:fs` — is quieter still: it typechecks, it lints, it passes
every behavioural test, and the seam that lets storage be swapped is gone with
nothing red to say so.

**Enforced by.** Two guards for the two halves. The runtime half is eslint on
`src/domain/**`: `no-restricted-globals` bans `Date`, and `no-restricted-properties`
bans `Date.now` and `Math.random`, each with the message that points at the
fix (pass `occurredAt` in from the caller). The dependency half is
`domain-purity.test.ts`, which reads the real import graph with the compiler's
own `ts.preProcessFile` — never a regex, which would read an `import` inside a
comment the same as a real one — and refuses any specifier that is not a domain
sibling or `node:crypto`: an adapter, a port, an I/O builtin, or a third-party
package. The two are complementary: lint catches a global *used*, the test
catches a module *imported*, and neither alone is the invariant.

**Proved by.** `domain-purity.test.ts` › *imports no adapter and no port, so storage never leaks upward*,
› *imports no I/O builtin, only deterministic node:crypto*, and
› *takes no third-party dependency* — the last two run over a set the suite
first proves non-empty, so a walk that resolved nothing cannot pass them
vacuously. The runtime half shows up as determinism:
`ledger.test.ts` › *is pure: the same inputs always produce the same hash* and
`merkle.test.ts` › *is deterministic regardless of input order*.

## Coverage · the suite runs against every adapter, and that is derived

Every invariant above that names `conformance.test.ts` is run *against every
adapter* — the phrase does the work only if "every adapter" is a fact rather
than a hand-kept list that quietly stopped matching the package. A guarantee
proven against the in-memory reference and no one else is a guarantee about the
reference, not about the Mongo store a network actually runs.

So the population is **derived**. `tests/adapters.catalog.ts` declares every
writable `LedgerStore` the package ships; `conformance.test.ts` builds its
harnesses from that catalog (so the suite runs exactly those classes, Mongo
skipped without a database but never dropped from the count); and
`adapter-coverage.test.ts` checks the catalog against the package's real
exports, recognising a writable store by structure — an `append` method — so
the read-only `GoldLedgerReader` is excluded by the same fact that makes it
read-only. A new writable adapter that is exported and not cataloged, or
cataloged and not harnessed, fails the build rather than shipping with no
conformance behind it. This is the `pulse.yml` lesson applied locally: a check
is only as good as the population it is pointed at, and that population is the
part nobody re-reads, so it is computed rather than trusted.

**Proved by.** `conformance.test.ts` › *harnesses every writable store class the catalog declares, and no stranger*
and `adapter-coverage.test.ts` › *catalogs exactly the writable stores the package exports — no more, no fewer*,
› *excludes the read-only reader by structure, not by an allowlist*.

