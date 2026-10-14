# Release ledger — @flashylabs/ledger

The versions this package has declared, whether each was tagged, and whether the
publish actually landed. It exists because a package whose whole pitch is
verifiability cannot have published versions that no commit is tagged for — that
fails on the first question a serious adopter asks.

`tests/releases.test.ts` asserts the version in `package.json` has a row here, so
a bump that nobody records fails CI instead of shipping untraceably.

## What was actually measured

The roadmap said "0.7.0 and 0.8.0 shipped untraceable." Read against the git
history and the publish workflow, that was imprecise in two ways worth stating,
because the real diagnosis points at a different fix:

- **0.7.0 existed, and an earlier version of this file said it did not.**
  That claim was written here on 2026-09-05 and pinned by a test asserting the
  ledger must *not* contain a 0.7.0 row — a guard holding a false fact in
  place, which is the worst shape a check can take: recording the truth would
  have failed CI. Commit `6af5ee1`, "0.7.0 — declare the civilization
  commodities", is a real version bump and is the **direct parent** of the
  0.8.0 bump `e52704b`. Verified by reading `package.json` at every commit in
  the repository: exactly two carry 0.7.0, and no path from 0.6.3 reaches
  0.8.0 without passing through it. The row is restored below and the test now
  requires its presence.
- **The untagged versions did not "ship untraceable" — their publishes
  failed.** `.github/workflows/publish.yml` records that every publish since the
  token change (0.6.3, 0.8.0) died with **E401 on the PUT**. `@flashylabs/ledger`
  was created by manual PAT publishes, and the package's own *Actions access
  list* — not the workflow's `permissions:` block — decides who may PUT new
  versions. `GITHUB_TOKEN` can read the package but cannot publish to it.

So the release trail is not blocked on remembering to tag. It is blocked on
registry access, which is an operator action (below). The workflow is already
correct: it verifies the pushed tag matches `package.json`, refuses to
dispatch-release an already-tagged version, and tags **only after** a successful
publish — so a failed publish never leaves a tag claiming a release that did not
happen. That is why 0.6.3 and 0.8.0 have no tag: the publishes they would have
tagged never succeeded.

## The ledger

| Version | Commit | Tagged | Publish landed | Notes |
|---|---|---|---|---|
| 0.1.0 | — | ✅ v0.1.0 | assumed | first cut |
| 0.1.1 | — | ✅ v0.1.1 | assumed | clean release tag |
| 0.1.2 | — | ✅ v0.1.2 | assumed | scope rename to @flashylabs |
| 0.2.0 | — | ✅ v0.2.0 | assumed | tenancy a boundary |
| 0.3.0 | — | ✅ v0.3.0 | assumed | experience domain |
| 0.4.0 | — | ✅ v0.4.0 | assumed | — |
| 0.5.0 | — | ✅ v0.5.0 | assumed | refuse a person-named identity |
| 0.6.0 | — | ✅ v0.6.0 | assumed | asset registry; last tagged version |
| 0.6.1 | `cdcf009` | ❌ | manual publish | "the npm mirror release"; claimed on GH Packages by hand during token rotation |
| 0.6.2 | `a5c9012` | ❌ | manual publish | "re-cut of the release that died between registries" |
| 0.6.3 | `d10f9dc` | ✅ v0.6.3 | **landed** (run 13) | publish succeeded; the mirror step failed after it, so the tag was skipped. Tagged 2026-09-05; run 17 then answered E409, confirming it is on the registry |
| 0.7.0 | `6af5ee1` | ❌ | never dispatched | "declare the civilization commodities"; superseded by 0.8.0 the same day |
| 0.8.0 | `e52704b` | ✅ v0.8.0 | **landed** (run 14) | same shape as 0.6.3. Tagged 2026-09-05; runs 15 and 16 both answered E409 |
| 1.0.0 | `eac50d8` | ✅ v1.0.0 | assumed (GitHub Packages, unverified from this checkout); **not** on registry.npmjs.org — `npm view` answered 404 on 2026-09-28 | "Bump to 1.0.0 for npm publication". The bump commit forgot this row, so `releases.test.ts` was red. `origin`'s `v1.0.0` points at `1a8aba6`, a commit this checkout does not hold, while a local tag of the same name points at `eac50d8` — two tags, one name; read `git ls-remote --tags origin` before trusting either. The 1.0.0 tree now carries four fixes our own interleaving audit found behind the green suite, so the publish that finally lands on npmjs will have them: `post`/`postTransfer` re-assert the `Minor` brand at runtime (a JSON body can no longer hash a NaN, a fraction or a string into a chain); the reference `InMemoryLedgerStore.appendAll` guards the chain head, so two concurrent appends cannot both land and fork it (invariant I-9, one head per chain); and a transfer from an identity to itself is refused (`SELF_TRANSFER`) rather than forking the chain and minting. The `invariants/1` harness from spec-kit is vendored and drives these under concurrency with a mutation check each |

**Confirmed 2026-09-05.** Pushing v0.6.3 and v0.8.0 fired the tag flow, and both
runs reached `npm publish` and stopped at **E409 Cannot publish over existing
version** — with `GITHUB_TOKEN`, on a clean runner. That is the registry
stating that both versions are present, and it also settles the access
question the other way: the token reaches the registry perfectly well. No
package access list needed changing, and none was changed.

"assumed" means the tag exists and no failure is recorded — not independently
re-verified against the registry from this checkout, which cannot read the
private GitHub Packages feed offline. "landed" is stronger and is measured: the
`npm publish` step reports success in that run's log, and for 0.8.0 a later
dispatch was refused with E409 for a version that already exists.

## The fix — done

The workflow bug is fixed (the mirror writes where npm reads, sets the scoped
registry, and can no longer fail a release; the tag step keys on the publish
step's own conclusion). The provenance gap is closed: `v0.6.3` and `v0.8.0`
were pushed on 2026-09-05 and each names a release that actually landed.

Every version this package has ever declared now has either a tag or a
recorded reason for not having one. The next release tags itself.

**Since 2026-09-28 the public npm registry is the target, not a mirror.**
`publishConfig` and `publish.yml` point at `registry.npmjs.org`; the workflow
refuses to run without **`NPM_TOKEN`** (publish rights on `@flashylabs`)
rather than landing anywhere else. GitHub Packages, which requires a token
even for a public package, keeps the versions above and receives no new ones.
Nothing is on the public registry yet — README, "Publishing".

## Adding a release

Bump `package.json`, add a row here, then dispatch `Publish`. The row is not
optional: `tests/releases.test.ts` fails if `package.json`'s version has no row,
which is the check that turns "published a version nobody wrote down" from a
silent gap into a red build.
