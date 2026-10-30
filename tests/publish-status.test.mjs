// scripts/check-publish-status.mjs answers roadmap step 4 ("move the ledger
// from a vendored copy to a published, versioned dependency") honestly: is
// package.json's declared version actually on the registry, under the exact
// commit it claims to be. This file pins the PURE classification logic
// against fixtures — no network call happens here. The live registry fetch
// only runs when the script is executed directly
// (`node scripts/check-publish-status.mjs`), never on import, so this suite
// stays dependency-free and deterministic like every other `node --test`
// file in this repository.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyPublishState,
  compareSemver,
  compareTarball,
  parseSemver,
} from '../scripts/check-publish-status.mjs'

// ---------------------------------------------------------------------------
// parseSemver / compareSemver

test('parseSemver reads the leading major.minor.patch and throws on anything else', () => {
  assert.deepEqual(parseSemver('1.0.1'), [1, 0, 1])
  assert.deepEqual(parseSemver('1.0.1-ledger'), [1, 0, 1]) // a pre-release tag is not a reason to refuse the numeric part
  assert.throws(() => parseSemver('not-a-version'))
  assert.throws(() => parseSemver('v1.0.1')) // the leading "v" belongs to the git tag, never to a semver string
})

test('compareSemver orders by major, then minor, then patch', () => {
  assert.equal(compareSemver('1.0.1', '1.0.1'), 0)
  assert.ok(compareSemver('1.0.0', '1.0.1') < 0)
  assert.ok(compareSemver('1.0.1', '1.0.0') > 0)
  assert.ok(compareSemver('0.8.0', '1.0.0') < 0)
  assert.ok(compareSemver('2.0.0', '1.9.9') > 0)
})

// ---------------------------------------------------------------------------
// classifyPublishState — the fixture is a slice of the REAL document this
// script measured against registry.npmjs.org on 2026-10-30, trimmed to the
// fields the classifier reads.

const REAL_1_0_1_REGISTRY_DOC = {
  'dist-tags': { latest: '1.0.1' },
  time: { '1.0.1': '2026-10-26T12:51:10.512Z' },
  versions: {
    '0.0.0-stage': { gitHead: undefined, dist: { shasum: 'c370e84b0ee77a9bd785a26b5b325fdf0b341e4e' } },
    '1.0.1': {
      gitHead: '4a0d3a648f2c1cae79b8ed841f9dde77f2404872',
      dist: {
        shasum: 'af6c34c7ed895ae8dc2876804adab30943d7cff1',
        integrity: 'sha512-Nljur2Ab7S9WwxPmnbKQ38pyjyRlvOp1P/I/CA+3HyygqvqJBP8nnKCScPCFWYLAoRGANo0S79DJUL1UdCtD+g==',
        fileCount: 89,
        unpackedSize: 325356,
      },
    },
  },
}

test('reports published-current when the registry already has the declared version', () => {
  const result = classifyPublishState({
    pkgVersion: '1.0.1',
    registryResult: { ok: true, data: REAL_1_0_1_REGISTRY_DOC },
  })
  assert.equal(result.status, 'published-current')
  assert.equal(result.gitHead, '4a0d3a648f2c1cae79b8ed841f9dde77f2404872')
  assert.equal(result.publishedAt, '2026-10-26T12:51:10.512Z')
  assert.deepEqual(result.dist, REAL_1_0_1_REGISTRY_DOC.versions['1.0.1'].dist)
})

test('reports published-current even when the registry has moved further ahead than package.json', () => {
  // package.json declares 1.0.1, but a later release has since landed. The
  // version this checkout cares about is still on the registry, so this is
  // not a blocker — it is a reason to bump, not a publish failure.
  const doc = {
    'dist-tags': { latest: '1.0.2' },
    time: { '1.0.1': '2026-10-26T12:51:10.512Z', '1.0.2': '2026-10-28T00:00:00.000Z' },
    versions: {
      '1.0.1': REAL_1_0_1_REGISTRY_DOC.versions['1.0.1'],
      '1.0.2': { gitHead: 'deadbeef', dist: { shasum: 'x' } },
    },
  }
  const result = classifyPublishState({ pkgVersion: '1.0.1', registryResult: { ok: true, data: doc } })
  assert.equal(result.status, 'published-current')
  assert.equal(result.registryLatest, '1.0.2')
})

test('reports published-stale when package.json has moved past what the registry actually has — the "prepared, not yet published" shape the roadmap anticipated', () => {
  const doc = {
    'dist-tags': { latest: '0.8.0' },
    time: {},
    versions: { '0.8.0': { gitHead: 'e52704b', dist: { shasum: 'y' } } },
  }
  const result = classifyPublishState({ pkgVersion: '1.0.1', registryResult: { ok: true, data: doc } })
  assert.equal(result.status, 'published-stale')
  assert.match(result.detail, /0\.8\.0/)
  assert.match(result.detail, /1\.0\.1/)
})

test('reports published-stale when the latest dist-tag is ahead but the declared version itself was skipped', () => {
  // A version can exist in neither `versions` nor be `latest` — e.g. it was
  // never published and a later version shipped instead. That must not read
  // as "published" just because something newer is on the registry.
  const doc = {
    'dist-tags': { latest: '1.0.2' },
    time: {},
    versions: { '1.0.2': { gitHead: 'deadbeef', dist: { shasum: 'z' } } },
  }
  const result = classifyPublishState({ pkgVersion: '1.0.1', registryResult: { ok: true, data: doc } })
  assert.equal(result.status, 'published-stale')
})

test('reports not-found verbatim — nothing under this name has ever published', () => {
  const result = classifyPublishState({
    pkgVersion: '1.0.1',
    registryResult: { ok: false, reason: 'not-found' },
  })
  assert.equal(result.status, 'not-found')
})

test('reports unreachable, never not-found or published, when the fetch itself failed', () => {
  // The whole point: a network failure is a fact about the network, never
  // folded into a claim about whether the package is published. Mirrors the
  // estate's "unread is not zero" rule for every other collector here.
  for (const detail of ['timed out', 'ECONNRESET', 'HTTP 503']) {
    const result = classifyPublishState({
      pkgVersion: '1.0.1',
      registryResult: { ok: false, reason: 'unreachable', detail },
    })
    assert.equal(result.status, 'unreachable')
    assert.equal(result.detail, detail)
  }
})

test('reports unreachable, not published-stale, when the registry answers with no dist-tags', () => {
  // A 200 with a body that is not a real registry document is the same kind
  // of "learned nothing" as a network failure, not evidence of absence.
  const result = classifyPublishState({
    pkgVersion: '1.0.1',
    registryResult: { ok: true, data: { versions: {} } },
  })
  assert.equal(result.status, 'unreachable')
})

// ---------------------------------------------------------------------------
// compareTarball

test('compareTarball matches when every shared field agrees — the real 2026-10-30 measurement', () => {
  // This is the exact local `npm pack --dry-run --json` entry this script
  // produced from a clean checkout of commit 4a0d3a6, before any file in
  // this working tree was edited — reproduced here as a fixture so the
  // comparison logic itself is pinned without needing a live rebuild.
  const localPack = {
    shasum: 'af6c34c7ed895ae8dc2876804adab30943d7cff1',
    integrity: 'sha512-Nljur2Ab7S9WwxPmnbKQ38pyjyRlvOp1P/I/CA+3HyygqvqJBP8nnKCScPCFWYLAoRGANo0S79DJUL1UdCtD+g==',
    unpackedSize: 325356,
    files: Array.from({ length: 89 }),
  }
  const result = compareTarball(localPack, REAL_1_0_1_REGISTRY_DOC.versions['1.0.1'].dist)
  assert.equal(result.match, true)
  assert.deepEqual(result.mismatches, [])
})

test('compareTarball names which field disagrees, instead of a bare mismatch', () => {
  const localPack = { shasum: 'different', integrity: 'same', files: [1, 2] }
  const registryDist = { shasum: 'af6c34c', integrity: 'same', fileCount: 2 }
  const result = compareTarball(localPack, registryDist)
  assert.equal(result.match, false)
  assert.deepEqual(result.mismatches, ['shasum'])
})

test('compareTarball falls back to files.length when the local pack result has no fileCount', () => {
  const localPack = { files: [1, 2, 3] }
  const registryDist = { fileCount: 4 }
  const result = compareTarball(localPack, registryDist)
  assert.equal(result.match, false)
  assert.deepEqual(result.mismatches, ['fileCount'])
})

test('compareTarball reports null, not false, when there is nothing to compare against', () => {
  const result = compareTarball({ shasum: 'x' }, null)
  assert.equal(result.match, null)
})
