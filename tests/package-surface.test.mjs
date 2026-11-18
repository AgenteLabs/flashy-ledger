// What `npm pack` ships is a different artefact from what vitest runs.
//
// Every TypeScript test imports ../src, so none of them touches the two build
// outputs a consumer actually installs: dist/ (ESM, with types) and dist-cjs/
// (CommonJS, for a consumer such as ClaimYour.Gold that is not ESM). The CJS
// build only loads because scripts/stamp-cjs.mjs drops a `{"type":"commonjs"}`
// package.json into dist-cjs/ — without it Node reads the output as ESM (the
// root declares "type": "module") and require() dies with "exports is not
// defined", which looks like a bug in the package rather than the build.
//
// Dependency-free on purpose, like schema.test.mjs: `node --test` needs no
// install. When dist/ has not been built it says UNKNOWN and skips — a check
// that cannot see the build output has learned nothing, and must not pass.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const built = existsSync(join(ROOT, 'dist', 'index.js')) && existsSync(join(ROOT, 'dist-cjs', 'index.js'))
const UNKNOWN = 'UNKNOWN: dist/ and dist-cjs/ are not built (npm run build)'

test('every target in the package exports map exists in the build', (t) => {
  if (!built) return t.skip(UNKNOWN)
  const entry = pkg.exports['.']
  for (const condition of ['types', 'import', 'require']) {
    assert.ok(entry[condition], `exports["."] declares no "${condition}" condition`)
    assert.ok(existsSync(join(ROOT, entry[condition])), `exports["."].${condition} -> ${entry[condition]} does not exist`)
  }
  // The legacy fields older tooling reads must agree with the map.
  assert.equal(pkg.main, entry.require)
  assert.equal(pkg.types, entry.types)
  assert.equal(pkg.module, entry.import)
})

test('the published files include both build directories', () => {
  assert.ok(pkg.files.includes('dist'), '"files" omits dist')
  assert.ok(pkg.files.includes('dist-cjs'), '"files" omits dist-cjs')
})

test('dist-cjs is marked CommonJS, which is the only reason require() can load it', (t) => {
  if (!built) return t.skip(UNKNOWN)
  const marker = JSON.parse(readFileSync(join(ROOT, 'dist-cjs', 'package.json'), 'utf8'))
  assert.deepEqual(marker, { type: 'commonjs' })
})

test('require() of the CommonJS entry exposes exactly the names the ESM entry does', async (t) => {
  if (!built) return t.skip(UNKNOWN)
  const require = createRequire(import.meta.url)
  const cjs = require(join(ROOT, pkg.exports['.'].require))
  const esm = await import(pathToFileURL(join(ROOT, pkg.exports['.'].import)).href)

  const names = (o) => Object.keys(o).filter((k) => k !== '__esModule' && k !== 'default').sort()
  assert.ok(names(esm).length > 0, 'the ESM build exports nothing')
  assert.deepEqual(names(cjs), names(esm), 'the CommonJS and ESM builds export different names')
})

test('the two builds hash an entry identically, so a CJS consumer and an ESM consumer share one chain', async (t) => {
  if (!built) return t.skip(UNKNOWN)
  const require = createRequire(import.meta.url)
  const cjs = require(join(ROOT, pkg.exports['.'].require))
  const esm = await import(pathToFileURL(join(ROOT, pkg.exports['.'].import)).href)

  const entry = {
    tenantId: 'flashy',
    identityId: 'identity_1',
    assetId: 'asset_fg',
    amount: 2500,
    balanceBefore: 0,
    balanceAfter: 2500,
    kind: 'EARN',
    source: { type: 'quest', id: 'q_1' },
    idempotencyKey: 'quest:q_1',
    occurredAt: new Date('2026-08-12T00:00:00.000Z'),
    previousHash: null,
  }
  assert.equal(cjs.hashEntry(entry), esm.hashEntry(entry))
  // And it is the vector computed outside this codebase (python hashlib), not
  // merely two builds agreeing with each other.
  assert.equal(esm.hashEntry(entry), '45170c1d3a85e9df66337c08fa17f517e8b7d6a67f103332cdbb9fe259509bae')
})
