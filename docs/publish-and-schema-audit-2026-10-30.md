# Publish status and schema admission — measured 2026-10-30

This repository's slice of the round-2 boardroom synthesis for "Flashy
Financial infrastructure" (the shared rail: flashy-finance, flashy-rails,
flashy-ledger). That synthesis named five steps; this repository owned step 4
in full and a share of step 5. Steps 1–3 (making flashy-rails' sibling-aware
contract-drift test an unconditional CI gate, a scheduled multi-sibling job,
and porting `additionalProperties: false` to flashy-rails' own consent and
grant-attenuation payloads) belong to flashy-rails / flashy-contracts and are
out of scope here; this document does not claim them.

## Step 4 — "move the ledger from a vendored copy to a published, versioned dependency"

The roadmap's framing assumed this was still blocked on a registry
credential. It is not, and saying so plainly is the point of this document —
"never claim something is published... until a real check proves it" cuts
both ways: it also forbids insisting something is *unpublished* once a real
check says otherwise.

**What was measured, read-only, with no `NPM_TOKEN` and no publish attempt:**

1. `curl https://registry.npmjs.org/@flashyos/ledger` — the raw registry
   endpoint, not through any local npm config — answers with `dist-tags.latest`
   = `1.0.1`, published at `2026-10-26T12:51:10.512Z`.
2. That version's own `gitHead` field is
   `4a0d3a648f2c1cae79b8ed841f9dde77f2404872`.
3. `git rev-parse v1.0.1` on this repository's shipping ref (`main`) resolves
   to the **same** commit, and `git merge-base --is-ancestor` confirms that
   commit is on `main`'s history.
4. Checking out that exact commit and running `npm ci && npm pack --dry-run`
   reproduces the published tarball **byte-for-byte**: shasum
   `af6c34c7ed895ae8dc2876804adab30943d7cff1`, the identical sha512
   integrity, 89 files, 325.4 kB unpacked — not a second opinion that a
   publish happened, but the identical artifact.

Four independent signals (the registry's own dist-tag, its `gitHead`, this
repository's own tag, and a from-scratch rebuild) agree. `@flashyos/ledger`
is a real, published, versioned npm dependency today, not a vendored copy —
the thing step 4 asked for. `.backlog/items.json`'s
`backlog/flashy-ledger/reconcile-version-and-target-flashynetwork` item
(filed 2026-10-29, `status: done`) already recorded the underlying rename
and republish under `@flashyos/ledger`; what this document adds is the
registry-side proof of the specific artifact, and the fix for the two
documents that still contradicted it.

**What was actually stale, and is fixed by this change:**

- `README.md`, "Publishing" — said "Not yet on the public registry" and
  pointed at a 404 measured 2026-10-26, which was true in that moment but
  stopped being true a few minutes later the same day, when the publish
  itself landed. Nobody updated it. Corrected, with the measurement above.
- `RELEASES.md`'s `1.0.1` row — read `Tagged ❌ | pending`. Both halves were
  wrong: the tag exists (`v1.0.1` → `4a0d3a6`) and the publish landed.
  Corrected, and `tests/releases.test.ts`'s existing rule ("claims a tag only
  where a publish actually landed") now holds the corrected row rather than
  passing by accident on a row that claimed nothing.
- `CHANGELOG.md`'s `## [1.0.1]` heading — read "pending first publish".
  Corrected to the measured date, with the registry-gitHead match noted
  inline.

**What is genuinely still open, named rather than silently dropped:**

- A **further** release (1.0.2+) still needs `NPM_TOKEN` set as a repository
  secret before `publish.yml` will run — that workflow refuses before
  installing anything without it, by design (see the workflow's own
  comments). This is not a new finding; it is the one piece of the original
  framing that remains true, just scoped correctly to "the next release"
  rather than "the first one."
- Downstream consumers have not uniformly moved off vendored/pinned copies
  onto the registry dependency. ClaimYour.Gold's `package.json` is confirmed
  updated to `"@flashyos/ledger": "^1.0.1"` (per the backlog item above).
  flashy-rails still vendors a committed build under `vendor/ledger`
  (`vendor-ledger.mjs`, drift-tested against a sibling checkout) and
  flashy.gold still pins by git tag (`#v0.8.0`, now stale against 1.0.1).
  Moving either is a decision for that repository, not this one — named here
  so it is not lost between repositories, not filed as this repository's own
  backlog item.

**What is now machine-readable, going forward:** `node
scripts/check-publish-status.mjs [--json]` repeats the registry-vs-tag-vs-tarball
comparison above on demand, without a credential, and distinguishes
`published-current`, `published-stale` (package.json has moved ahead of what
the registry actually has — the shape the original roadmap wording
anticipated), `not-found`, and `unreachable` (a network failure, never
folded into "not published" — the same discipline the estate already uses
for every other collector that can be told "no" by its own proxy rather than
by the thing it is asking about). `tests/publish-status.test.mjs` pins the
pure classification and tarball-comparison logic against fixtures, offline;
the live network call only happens when the script is run directly.

## Step 5 (this repository's share) — the `additionalProperties` sweep

The AAO charter schema had `additionalProperties: true` until recently
closed; the roadmap asked whether the same admission gap — an unsupported
field silently accepted into something the rules actually read — recurs
elsewhere, starting with anything touching consent, grants or spend.

**flashy-ledger's own schemas were already closed, at every level checked
by hand:** all five `schema/*.json` documents (`entry.json`, `asset.json`,
`snapshot-entry.json`, `commitment.json`, `inclusion-proof.json`) declare
`additionalProperties: false` at their top level, and `entry.json`'s nested
`source` sub-schema (`$defs.source`) does too, with a concrete fixture-backed
test (`tests/schema.test.mjs`) proving an extra field such as
`source.channel` is actually refused — not merely declared closed in
prose. `entry.json`'s `amount`, `balanceBefore` and `balanceAfter` are the
fields that actually move value through this ledger, and they resolve
through `$ref` to `$defs.minor`, a plain bounded integer with no object
shape to leave open at all.

**What the sweep found, and what it did about the one thing it is not fixing:**
the only object-shaped schema node in this repository with no
`additionalProperties` restriction is `entry.json#/properties/metadata` —
explicitly documented, both in the schema's own description and in
`docs/entry-hash.md`, as free-form caller data that `hashEntry()` never
reads. That is a different shape from the AAO charter's gap: the charter's
open field could be silently admitted into something the conformance rules
*did* evaluate, where `metadata` cannot reach anything this package's rules
evaluate at all, by construction (it is excluded from the hash by name).
Closing it would turn a documented extension point into a breaking change
for every caller currently using it, for no safety gained. It is kept open
on purpose, and that purpose is now written down and tested rather than
assumed: `tests/schema-admission-sweep.test.mjs` names it in an explicit,
reasoned `ALLOWED_OPEN` allowlist, asserts the reason is substantive (≥60
characters), and asserts the allowlist names nothing that is not actually
both present and actually open — an allowlist entry for a gap that does not
exist would be exactly the kind of unverified check this estate's own record
warns against.

The sweep itself is new and is the part that outlives today's answer: the
five **existing** per-file tests in `tests/schema.test.mjs` check named
schemas by name, so a sixth schema file landing tomorrow with the AAO
charter's original shape (`additionalProperties: true`, or simply omitted)
would pass every test in this repository unnoticed. `openObjectNodes()` in
`tests/schema-admission-sweep.test.mjs` instead walks every `schema/*.json`
file that declares `$schema`, and every nested object node inside it
(`properties`, `patternProperties`, `$defs`, `items`, `oneOf`/`anyOf`/`allOf`),
so the next schema — named or nested — is checked by construction, not by
remembering to add a row.

**What this sweep deliberately did not check**, named rather than silently
skipped: the other two repositories the full round-2 roadmap names
(flashy-rails' `draftRedeem` / `draftTransfer` / `attenuate` payload schemas,
and flashy-finance's own schemas, if any) are outside this checkout and were
not read in depth here. That is the estate-wide half of step 5 and belongs
to whichever agent owns those repositories' scope; this document is this
repository's contribution to that sweep, not the whole of it.

## Tests added

- `tests/publish-status.test.mjs` — 13 cases, pure, offline, no network call.
  Pins `classifyPublishState`'s four statuses (including the asymmetry
  between "the registry has nothing newer" and "the registry simply could
  not be asked") and `compareTarball`'s field-by-field comparison, against a
  trimmed fixture of the real registry document this audit measured.
- `tests/schema-admission-sweep.test.mjs` — 8 cases. Walks every schema file
  that exists today and asserts the sweep itself is non-vacuous (checks more
  than zero files); a mutation check (`additionalProperties: true` reinstated
  on `asset.json`, then reverted) confirmed it fails exactly the way the AAO
  charter's original gap would have.

Full-suite counts, this repository, before and after this change (vitest +
`node --test`, `tests/devlog.test.ts`'s one sibling-drift case excluded from
both counts — it depends on a `../flashyos` checkout happening to be beside
this one and is unrelated to this work either way):

| | vitest | `node --test` |
|---|---|---|
| Before | 293 passed | 47 passed |
| After | 293 passed | 68 passed (+13 publish-status, +8 schema-sweep) |

`npm run typecheck`, `npm run lint`, `npm run coverage` (98.32% statements /
93.83% branches / 100% functions / 100% lines over `src/`, against the
90%/85%/90%/90% gate — unchanged by this work, since nothing here touches
`src/`), `node scripts/check-charter.mjs`, `npm run directory:check` and
`node scripts/check-frontdoor.mjs` all pass with this change applied.
