# flashy-ledger — `@flashyos/ledger`

An append-only, multi-asset, storage-agnostic settlement ledger, published as
a TypeScript library (ESM and CJS builds, no runtime dependencies; `mongodb`
is an optional peer). Flashy Gold is the first asset on it, not the thing
itself. Consumed by flashy-rails (consent-gated settlement on top of it),
ClaimYour.Gold (hash chains computed here, written through Prisma, and the
nightly Merkle anchor) and flashy.gold (read-only, through `GoldLedgerReader`).
There is no deployed website: what ships is a package — which is why the
estate fold-coverage survey reads this as a record repository with no served
URL rather than a gap — and as of 2026-09-28 it is **not yet on the public npm
registry** (see Publishing).

## Commands

```bash
npm ci                     # installs and builds (prepare runs the build)
npm run typecheck          # tsc --noEmit
npm run lint               # eslint src tests (type-checked; .mjs untyped)
npm test                   # vitest run — tests/**/*.test.ts
npm run coverage           # the same, with the thresholds CI fails on
npm run test:standalone    # node --test tests/*.test.mjs — no install needed
npm run check              # typecheck + lint + coverage + standalone
npm run build              # dist/ (ESM) + dist-cjs/ (CJS), both gitignored
MONGO_URL=mongodb://localhost:27017/?directConnection=true \
  npx vitest run tests/conformance.test.ts   # the Mongo adapter, on a replica set
```

CI (`ci.yml`) runs typecheck, lint, coverage, the standalone tests and the
build on every push to `main` and every pull request, then the conformance
suite against a single-node Mongo replica set started with `--replSet` — a
`services:` container cannot take that flag, and the job ran a standalone
for months while a comment said otherwise.

## What makes this repository different

**Append-only, as absence rather than policy.** `LedgerStore`
(`src/ports/store.ts`) has no update and no delete. The only way to undo an
entry is `reverse()`, which posts its mirror image. Each entry carries the
hash of the one before it for that identity, so an edit or a removal breaks
every hash after it and `verifyChain()` says so.

**Multi-asset means an asset is a configuration record.** Nothing in the
engine knows what gold is. `defineAsset` (`src/domain/registry.ts`) validates
slug, symbol and decimals at module load; `materialize` adds the `id` and
`tenantId` at the edge, and refuses an empty id because a slug in that field
once made four payouts fail with no type error. `SKILL_XP` is deliberately not
transferable: status settled with money's discipline, never convertible to it.

**Storage-agnostic by construction.** `src/domain` is pure — no clock, no
randomness, no I/O — and a lint rule fails the build if anything under it
reaches for `Date` or `Math.random()`. `src/ports/store.ts` is the seam;
`src/adapters/memory.ts` is the reference implementation *and* the executable
specification, because `tests/conformance.test.ts` runs the same suite
against it and against `MongoLedgerStore`. A backing store behaves
identically or fails the build. The dependency rule is one-directional:
adapters → ports → domain → nothing — and that direction is enforced, not
only stated: `tests/domain-purity.test.ts` reads the real import graph of
`src/domain` with the compiler's own `ts.preProcessFile` and refuses any
specifier that is not a domain sibling or `node:crypto` (I-10). Lint catches a
global *used*; the test catches a module *imported*; neither alone is the
invariant.

**The conformance population is derived, never hand-kept.**
`tests/adapters.catalog.ts` is the one list of writable `LedgerStore` classes;
`conformance.test.ts` builds its harnesses from it (Mongo skipped without a
database, never dropped from the count) and `tests/adapter-coverage.test.ts`
checks the catalog against the package's real exports, recognising a writable
store by structure — an `append` method — so the read-only `GoldLedgerReader`
is excluded by the same fact that makes it read-only. An exported store that
is not harnessed fails the build. The Mongo adapter's concurrency and
atomicity design — why a transfer needs a client, what the two unique indexes
refuse — is written down in `docs/adr/0004-mongo-concurrency-and-atomicity.md`.

**`Minor` is a branded integer and refuses to be anything else.**
`src/domain/money.ts`: `minor()` throws `PrecisionError` on a non-integer or
an unsafe integer; `fromDecimal(0.5, 0)` throws rather than rounds, because
rounding somebody's holding is not a thing a ledger may do quietly; `add`
refuses a sum outside the exact range. Never do money arithmetic with raw
operators, and never a `bigint` literal — it throws the moment it meets a
ledger amount. Proved by `ledger.test.ts` › *rejects precision the asset
cannot hold rather than rounding it* and › *rejects non-finite and
non-integer values*.

**Idempotent replay.** A write carries a key derived from its source event
(`quest:q_9:identity_1`, never a timestamp). A replay returns the original
entry with `deduplicated: true` and writes nothing. The constraint is a unique
index on `(tenantId, idempotencyKey)` — code runs once per process, an index
runs on every write from every process forever.

**Tenancy is a boundary, not a label.** There is no read without a
`tenantId`, so a cross-tenant read does not compile. Two networks running
similar mechanics generate colliding idempotency keys by construction; a
global lookup would hand one tenant another's entry while reporting a
successful deduplication. That is I-6, added in 0.2.0.

**Identities are opaque.** `assertOpaqueIdentity()` runs inside `post()`,
before anything is hashed, and refuses an email, a phone number, a wallet
address or a public key — a natural key in an immutable, published record is
a consent that can never be withdrawn.

**The hash input is the format.** `hashEntry()` joins a fixed list of fields
in a fixed order. Changing either invalidates every chain ever written. Treat
it as a breaking migration with a re-hashing plan, never a refactor.
`schema/entry.json` and `schema/asset.json` are the machine-readable wire
shapes (JSON Schema 2020-12; amounts are integers; unknown keys refused
unless `x-`), and `tests/schema.test.mjs` fails if their enums or patterns
drift from the TypeScript source. `schema/snapshot-entry.json`,
`commitment.json` and `inclusion-proof.json` do the same for the Merkle
snapshot documents.

`docs/entry-hash.md` states the bytes `hashEntry()` hashes and
`schema/entry-hash-vectors.json` pins them: digests computed outside the
codebase, pinned rather than generated — never regenerate one from `hashEntry`.
The separator is one literal U+0000 byte in `src/domain/entry.ts`, so git calls
the file binary and `git diff` shows no line diff of it; review it with
`git diff --text`, and do not edit it with a tool that might not preserve the
byte.

## Rules the tests enforce — none decorative

- `docs/INVARIANTS.md` numbers ten invariants, each citing a test by name;
  `tests/invariants.test.ts` fails if a cited test no longer exists, if the
  numbering has a gap, or if a section is missing one of its four headings.
- `tests/domain-purity.test.ts`: nothing under `src/domain` imports an
  adapter, a port, an I/O builtin or a third-party package (I-10).
- `tests/adapter-coverage.test.ts`: every exported writable store is in the
  conformance catalog and every cataloged store is exported.
- `tests/entry-hash-vectors.test.mjs`: the pinned vectors reproduce from their
  own strings with `node:crypto`, from the field order in `docs/entry-hash.md`,
  and from the built `hashEntry()`.
- `tests/package-surface.test.mjs`: every target in the `exports` map exists,
  `files` ships both builds, `dist-cjs` carries its CommonJS marker, and the
  CommonJS and ESM builds export the same names and hash alike.
- `tests/docs-drift.test.ts`: the README states no count of the invariants
  other than the one `docs/INVARIANTS.md` numbers, and `CHANGELOG.md` has a
  section for the declared version and for every version `RELEASES.md` records.
- `tests/public-api.test.ts` lists every export by hand. Removing one is a
  major version, and the list is deliberately not a generated snapshot.
- `tests/workflow-pins.test.ts`: every third-party `uses:` in a workflow is
  pinned to a 40-character commit SHA with a version comment.
- `tests/releases.test.ts`: `package.json`'s version has a row in
  `RELEASES.md`, a tag is claimed only where a publish landed, and the trail
  is in ascending order.
- `tests/schema.test.mjs`: the wire schemas match the code, and real
  entries built through `post()` and `InMemoryLedgerStore` validate.
- `tests/cross-linking.test.mjs`: the README's "See also" links resolve to
  https or relative targets.
- `vitest.config.ts`: 90 % lines/functions/statements, 85 % branches, over
  `src/` minus the Mongo adapter, which the conformance job covers instead.
- `tests/devlog.test.ts`: `DEVLOG.md` and the served fragment are derived by
  the vendored emitter, never hand-written.

## Publishing

`publishConfig` targets `https://registry.npmjs.org/` with public access, and
`.github/workflows/publish.yml` publishes there on a `v*` tag or a manual
dispatch — **only** when the `NPM_TOKEN` secret is set; without it the job
refuses before installing anything. GitHub Packages is no longer a target;
versions up to 0.8.0 live there and stay there. `npm view @flashylabs/ledger`
answered 404 on the public registry on 2026-09-28: the package is prepared
for publication and not published. When the first publish lands, update
README "Publishing" and add the row to `RELEASES.md` — the release ledger is
hand-maintained by design.

## Don't

- Reach for `Date`, `Math.random()`, the network or a driver under
  `src/domain`. The lint rule will catch the first two; the review must catch
  the rest.
- Add an update or delete to `LedgerStore`, or a store that skips
  `tests/conformance.test.ts`.
- Pass a raw `number` where a `Minor` goes, or round on the way in.
- Change the fields `hashEntry` joins, or their order, without a migration.
- Hand-edit `DEVLOG.md`, `*.fragment.json`, `public/.well-known/*`,
  `dist/` or the lockfile. Regenerate the lockfile with npm 10.9.8 (Corepack;
  `packageManager` is a declaration, not an enforcement).
- Commit a credential, a `.env`, or a `MONGO_URL` with a password in it.
- Decide the licence here — it is Apache-2.0 because flashyos's
  `tools/estate-licences.mjs` says so, and that file is the only place to
  change it.

<!-- estate:house-rules -->
<!-- Synced from flashyos/tools/estate-house-rules.mjs. Edit it there, not here.
     Anything outside these two markers is this repository's own and is never
     touched by the sync. -->

## House rules — true in every repository in this estate

**`main` is not necessarily the default branch.** Eleven of thirty-five
repositories deploy from a `claude/*` branch. Ask, every time:

```bash
git symbolic-ref --short refs/remotes/origin/HEAD
```

Work pushed to `main` in one of those deploys nothing and is read by nobody,
and the failure is silent — the push succeeds.

**Say which branch you measured.** Reading `git ls-files` or the working tree
tells you about your checkout, not about the repository. That mistake reported
the estate's secret scanning as 35/35 when it was 15/35, and was then made a
second time, in a different tool, by a different agent, four hours later. If a
claim is about what ships, read the ref.

**Re-vendor before you trust a vendored change.** Files named `vendor-*.mjs`
are copies of a package in flashyos. Changing the source does nothing here
until the copy is replaced, and a stale copy does not fail — it disagrees,
silently, about whichever field somebody has just changed.
`node tools/estate-hygiene.mjs` in flashyos reports every copy that has
drifted.

**No secret in a file, a repo, or an artifact.** Secret Manager only. A
committed credential is burned the moment it lands and stays burned after the
file is deleted, because history keeps it — removal is not rotation.

**The licence is declared once**, in `tools/estate-licences.mjs` in flashyos,
along with the copyright holder. Do not decide a repository's licence inside
that repository. Client work is never open-licensed: the grant is not ours to
make.

**A generated file is regenerated, never hand-edited.** `shiplog.fragment.json`,
`backlog.fragment.json`, built `public/` directories and lockfiles are outputs.
Editing one is a change that the next run silently discards.

**Report what happened, including when it is worse than expected.** A number
somebody assumed is worth less than a number somebody measured, and a
measurement nobody checked is an opinion with a progress bar.
<!-- /estate:house-rules -->
