# @flashylabs/ledger

```
        ██
       ██
      ██████
        ██
       ██
      ██
```

An append-only, multi-asset settlement ledger, open under Apache-2.0. Flashy
Gold is the first asset on it, not the thing itself — ore, stone and wheat are
configuration records, not new code paths.

This is the verification layer of the [Flashy](https://flashygroup.com)
estate — the rules that [flashynetwork.com](https://flashynetwork.com) checks
the books against, published so nobody has to take "verifiable" on faith.
Read the rules you are trusting. That is the whole point of them being here.

The domain is pure. It reads no database, calls no clock, and generates no
randomness. Everything that touches storage sits behind one interface, which is
the entire reason this can move onto different infrastructure — including a
chain — without its rules changing.

### When to use alone

- You need a battle-tested financial settlement layer
- Your system must guarantee idempotent replay
- You require audit-trail immutability
- You're building multi-asset or cross-chain rails

### In the Flashy ecosystem

- Powered by [@flashylabs/rails](https://github.com/flashylabs/flashy-rails) (consent-gated settlement on ledger)
- Adopted by [ClaimYour.Gold](https://claimyour.gold) (rewards settlement)
- Foundation for the full integration example at [flashy-network](https://flashynetwork.com)

### See also

- [@flashylabs/rails](https://github.com/flashylabs/flashy-rails) — Consent layer on top of ledger
- [Flashy Finance](https://flashy.financial) — Live financial rail (built on ledger + rails)
- [flashy.tools](https://flashy.tools) — Full package catalog with discovery

## Quick start

**Consumer** — once published (it is not yet; see **Publishing**, below):

```bash
npm install @flashylabs/ledger
```

**Developer** — clone and check:

```bash
npm ci
npm run check     # typecheck + lint + tests with coverage gates + standalone node tests
```

## Using it

```ts
import {
  InMemoryLedgerStore, post, fromDecimal, type Asset,
} from '@flashylabs/ledger'

const gold: Asset = {
  id: 'asset_fg', slug: 'flashy-gold', symbol: 'FG',
  decimals: 2, class: 'REWARD_CURRENCY', tenantId: 'flashy',
}

const store = new InMemoryLedgerStore()

const state = await store.readState({
  tenantId: 'flashy', identityId: 'identity_1', assetId: gold.id,
})
const entry = post(state, {
  tenantId: 'flashy',
  identityId: 'identity_1',
  asset: gold,
  amount: fromDecimal(25, gold.decimals),   // 2500 minor units
  kind: 'EARN',
  source: { type: 'quest', id: 'q_9' },
  idempotencyKey: 'quest:q_9:identity_1',   // stable, not a timestamp
  occurredAt: new Date(),
})

await store.append(entry)
```

Transfers are two entries, never one balance edit:

```ts
const [debit, credit] = postTransfer(
  { state: senderState, identityId: 'a' },
  { state: recipientState, identityId: 'b' },
  { tenantId: 'flashy', asset: gold, amount: fromDecimal(5, 2),
    source: { type: 'gift' }, idempotencyKey: 'gift:g_1', occurredAt: new Date() },
)
await store.appendAll([debit, credit])   // both land, or neither
```

## Tenancy is a boundary, not a label

Every read names a tenant, and every uniqueness constraint is scoped to one:

```ts
await store.readState({ tenantId, identityId, assetId })
await store.readEntries({ tenantId, identityId })          // assetId optional
await store.findByIdempotencyKey(tenantId, key)
```

There is no overload without a tenant, so a cross-tenant read does not compile.
This matters most for idempotency keys, which are derived from source events —
two networks running similar mechanics generate colliding keys by construction,
and a globally scoped lookup would hand one tenant another's entry while
reporting a successful deduplication.

**Upgrading from 0.1.x:** `ensureIndexes()` drops the pre-0.2 global indexes
before creating the scoped ones. Run it once per deployment before writing. A
surviving `uniq_idempotency` silently defeats the change.

## The five invariants

Everything here follows from these. They are enforced in code, checked in tests,
and repeated on the PR template because they are easy to erode one convenience
at a time.

| Invariant | Why | Enforced by |
| --- | --- | --- |
| **Append-only** | History you can edit is not evidence | No update or delete on `LedgerStore` |
| **Signed integer minor units** | Floats drift; chains reject fractions | `Minor` branded type; `fromDecimal` rejects over-precision |
| **One sign convention** | `SUM(amount)` must mean something | `post()` derives balances from the signed amount |
| **Idempotent writes** | Retries are constant at scale | Unique `idempotencyKey`; a replay returns the original |
| **Balances are derived** | A cache can be rebuilt; a truth cannot | `balanceOf()` folds entries; stores hold projections |

## Layout

```
src/
  domain/     Pure. No I/O, no clock, no randomness.
    money.ts    Minor units, exact arithmetic
    asset.ts    Asset records — gold, ore, stone, wheat
    entry.ts    Entry shape, content hashing, chain verification
    post.ts     The decision function: state + command -> entry
    fold.ts     Balances as folds over entries
    errors.ts   Typed rejections
  ports/
    store.ts    The seam. The only thing a new backing store implements.
  adapters/
    memory.ts   Reference implementation and executable specification
```

The dependency rule is one-directional: `adapters` depend on `ports` depend on
`domain`, and `domain` depends on nothing. A lint rule fails the build if
anything under `src/domain` reaches for `Date.now()` or `Math.random()`.

## Why the hash chain

Each entry carries the hash of the one before it for that identity. Altering an
old entry changes its hash and breaks every hash after it, so tampering is
detectable without anyone having to trust the operator.

That property is worth having on its own. It also means a merkle export — and
therefore a migration onto a chain — is a mechanical exercise rather than a
research project. `verifyChain()` is what an auditor runs.

## Adding an asset

Declare it in the registry. There is no second step.

```ts
export const WHEAT = defineAsset({
  slug: 'wheat', symbol: 'WHT', name: 'Wheat',
  decimals: 0,                    // whole units only
  class: 'COMMODITY_UNIT',
  description: 'A bushel of wheat, settled on the same books as everything else.',
})
```

Add it to `FLASHY_ASSET_DEFINITIONS` and every consumer sees it — the public
asset page, the read API, the balances endpoint. `defineAsset` validates the
shape at module load, so a malformed declaration is a startup failure in every
consumer at once rather than a wrong number in one of them later.

### Definition, then materialize

An `AssetDefinition` holds what is true everywhere: slug, symbol, name,
decimals, class. An `Asset` adds `id` and `tenantId`, which describe where a
copy of it lives:

```ts
const gold = materialize(FLASHY_GOLD, {
  id: process.env.FLASHY_GOLD_ASSET_ID!, tenantId: 'flashy',
})
```

The id is supplied at the edge and has no default. In production it is the
ObjectId of a row in ClaimYour.Gold's `assets` collection; entries are keyed on
it, and putting a slug in that field is the exact bug that once made four
payouts fail silently with no type error to catch it. `materialize` throws on
an empty id for the same reason.

### Why the registry exists at all

Flashy Gold used to be declared independently in four places. Three said
`decimals: 2`. One said `decimals: 4` — and it was the one published on the
settlement record, so an integrator following the public registry rendered
every balance a hundred times wrong. That class of bug is not fixed by
correcting the four. It is fixed by there being one.

Precision is per asset and enforced at the boundary: `fromDecimal(0.5, 0)`
throws rather than rounding, because rounding somebody's holding is not a thing
a ledger may do quietly.

Multi-asset does **not** mean assets exchange freely. Conversion is a commercial
decision with its own controls; the ledger records it as two entries and does
not invent a rate.

## What this package is not

- **Not a wallet or an identity system.** It records movements against an
  identity id it is given.
- **Not a pricing engine.** No rates, no conversion, no valuation.
- **Not on a chain, and not pretending to be.** It is built so that becoming so
  is a storage decision rather than a rewrite.

## Where this is going

Every meaningful autonomous action becomes a proof:

```
agent → signed intent → authorization → execution → Flashy Ledger event → proof
```

This package is the foundation of that chain — the immutable, hash-chained,
deterministically replayable half that ships today. The rest is a four-phase
arc: cryptographic **agent and organization signatures** on every event; the
**Flashy Anchor Protocol**, which writes Merkle checkpoint roots to public
blockchains so history is *auditable by an adversary*, chain-neutrally
(Ethereum, Base, Bitcoin, or a Web2 org's own choice); an **interorganizational
ledger** where two autonomous organizations exchange signed messages and both
hold mutually verifiable receipts; and, only once that traffic is real,
**federated validators** over an established permissioned BFT/PoA network. Not
another L1 — a chain-neutral proof layer for autonomous work.

The full sequence, with each phase's honest status, is in
[`docs/ROADMAP.md`](./docs/ROADMAP.md). Foundation is live and checkable with
[`@flashyos/verify`](https://www.npmjs.com/package/@flashyos/verify); everything
past it is labelled North Star until its code ships.

## Status

`package.json` declares 1.0.0, and nothing at that version is on the public
registry yet ([Publishing](#publishing)). The entry format and the hash input
are what a major version pins: changing the fields `hashEntry` joins, or
their order, invalidates every existing chain and is a breaking change with a
re-hashing plan, never a refactor. See `docs/adr/` for the decisions behind
the design and [Wire shapes](#wire-shapes) for the format as it stands.

## Wire shapes

The JSON an entry or an asset takes on a wire, as JSON Schema (draft
2020-12), for anybody validating what this package emits or consuming it from
another language:

- [`schema/entry.json`](./schema/entry.json) — `Entry` from
  `src/domain/entry.ts`. Every amount is an integer in minor units, bounded to
  the exact range `minor()` accepts; `amount` may not be zero; `occurredAt`
  is an RFC 3339 string (a `Date` in TypeScript); `previousHash` is a
  64-hex digest or `null`. A `ProposedEntry` is the same shape without `id`.
- [`schema/asset.json`](./schema/asset.json) — `Asset` from
  `src/domain/asset.ts`, with the slug, symbol and decimals rules
  `defineAsset()` enforces.

Both refuse unknown keys unless they are `x-` prefixed. `metadata` is free
and is not part of the hash. `tests/schema.test.mjs` (`npm run
test:standalone`, no install needed) builds real entries through `post()`
and `InMemoryLedgerStore`, validates them, and fails if the `kind` or `class`
enums or the asset patterns drift from the TypeScript source.

## Publishing

**Not yet on the public registry.** `npm view @flashylabs/ledger --registry
https://registry.npmjs.org/` answered 404 on 2026-09-28. Versions up to
0.8.0 were published to GitHub Packages (see [`RELEASES.md`](./RELEASES.md)),
which needs a token even to read a public package — so that is no longer the
target.

`publishConfig` points at `https://registry.npmjs.org/` with `access:
public`, and `.github/workflows/publish.yml` publishes there on a pushed
`vX.Y.Z` tag matching `package.json`, or on a manual dispatch that tags after
the publish lands. It needs exactly one repository secret:

| Secret | What | Where it comes from |
|---|---|---|
| `NPM_TOKEN` | An npm access token with publish rights on the `@flashylabs` scope (granular token: read and write on the package or scope, with 2FA bypass for automation) | npmjs.com → Access Tokens; store it only as a GitHub Actions secret, never in a file |

Without it the workflow refuses to run — it does not fall back to another
registry. When the first publish lands, replace the first sentence of this
section with the version and date, and add the row to `RELEASES.md`.

## The invariants

Six guarantees, numbered so they can be cited in an audit, each mapped to the
test that proves it: `docs/INVARIANTS.md`. The mapping is itself asserted —
`tests/invariants.test.ts` fails the build if the document cites a test that no
longer exists, so a rename cannot quietly hollow out the spec.

## Shipping record

`DEVLOG.md` is a plain-language changelog of this repository, derived from its
own commit history by `vendor-shiplog.mjs` (`devlog/1`; see
`packages/shiplog/SPEC.md` in flashyos). It regenerates on every push and is
never hand-edited. `.shiplog/config.json` also serves it at
`public/.well-known/devlog.fragment.json`, matching how `shiplog.json` is
already served from the same directory — no live deployment for this
repository was confirmed while wiring this up (it publishes to GitHub
Packages; nothing here deploys a website), so treat that served copy's actual
reachability as unverified rather than assumed.

## The npm version

`packageManager` pins npm to 10.9.8, the version CI runs.

This is worth being precise about, because the field is easy to over-trust: it
is a **declaration, not an enforcement**. npm does not read it. Corepack does.
On a machine where Corepack is not enabled, npm 12 will install against this
pin without a word of complaint — verified, not assumed.

That matters because the failure it guards against is silent on the way in and
loud somewhere else entirely. npm 12 resolves a different tree and prunes
entries npm 10 expects; `npm install` accepts the result, and `npm ci` on the
runner then refuses it with `Missing: <package> from lock file` — an error that
names a package nobody touched, in a repository whose only change was a version
bump. It cost an afternoon in a sibling repository.

So: enable Corepack once, on any machine that will regenerate a lockfile here.

```
corepack enable
```

After that the pin is real, and `npm install` uses 10.9.8 whatever the global
npm happens to be.

## The mongodb peer dependency

`mongodb` is an **optional** peer, accepted at `^6.21.0 || ^7.0.0`.

Optional because the domain — `post`, `postTransfer`, `hashEntry`,
`verifyChain`, the money helpers — imports no driver at all. A consumer that
only needs the rules, or that brings its own storage, should not be made to
install a database driver to get them. ClaimYour.Gold is exactly that consumer
today: it computes hash chains with this package and writes through Prisma.

The range spans both majors because the adapters use only driver APIs that did
not change between them: `collection`, `createIndex`, `insertOne`, `findOne`,
`find`/`sort`/`limit`/`toArray`, `startSession`, `withTransaction`,
`endSession`. Pinning to v6 forced consumers on v7 into `--legacy-peer-deps`,
which silences every peer conflict in the tree rather than the one that was
actually understood.

## ⚡ The Strike

This README commits to a secret, the way this ledger commits to everything:

```
sha256: 101609b65c4dc55f049e6609c2d8435c9a143bebc488cba73b05d65c630fdfa5
```

The preimage is already on this page — a single sentence a careful reader of
the five invariants can reconstruct exactly. Recover it, verify the hash
yourself (never trust, verify — that includes us), and open an issue titled
`⚡ STRIKE` containing the preimage. First verified striker per release gets
their name sealed into [STRIKERS.md](./STRIKERS.md) — the only file in this
repository that is append-only by tradition rather than by code.

No prize, no token, no airdrop. Bragging rights on a settlement ledger are
denominated in proofs.

## License

[Apache-2.0](./LICENSE). The rules are open; the books they settle are not —
the Flashy network's ledger data lives in its infrastructure, not in this
repository, which is exactly the boundary you would want from a settlement
layer: fork the rules, run your own books, verify ours.
