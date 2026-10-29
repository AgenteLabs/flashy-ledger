// The Entry hash, as a corpus a stranger can run in another language.
//
// schema/entry.json says `hash` is "sha256 over the hashed fields in the fixed
// order hashEntry() defines" and stops there. docs/entry-hash.md states the
// order, the separator (a NUL byte, which git treats as binary and every editor
// renders as a space) and the encoding of a null previousHash and an absent
// source id. schema/entry-hash-vectors.json is the same statement as data: twelve
// strings, one separator, one digest, computed outside this codebase.
//
// This test holds the corpus to four things independently, so none of them can
// be reconciled by regenerating the others:
//   1. the digest is sha256 of the documented preimage (node:crypto, not the code)
//   2. the preimage is what the documented field list says the entry's fields are
//   3. the field list is the one in docs/entry-hash.md, in the same order
//   4. the built package's hashEntry() agrees — UNKNOWN, never passed, when
//      dist/ has not been built
//
// Dependency-free, like schema.test.mjs: `node --test` needs no install.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS = JSON.parse(readFileSync(join(ROOT, 'schema', 'entry-hash-vectors.json'), 'utf8'))
const ENTRY_SCHEMA = JSON.parse(readFileSync(join(ROOT, 'schema', 'entry.json'), 'utf8'))
const DOC = readFileSync(join(ROOT, 'docs', 'entry-hash.md'), 'utf8')
const NUL = '\u0000'

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** The documented layout, rebuilt from a wire-shaped entry. */
const preimageOf = (e) => [
  e.previousHash ?? '',
  e.tenantId,
  e.identityId,
  e.assetId,
  String(e.amount),
  String(e.balanceBefore),
  String(e.balanceAfter),
  e.kind,
  e.source.type,
  e.source.id ?? '',
  e.idempotencyKey,
  new Date(e.occurredAt).toISOString(),
]

/** The field column of the table in docs/entry-hash.md, in the order it lists them. */
const docFields = [...DOC.matchAll(/^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1])

/** A dotted path into a wire entry, written as the preimage writes it. */
const render = (entry, path) => {
  const value = path.split('.').reduce((o, key) => o?.[key], entry)
  if (path === 'occurredAt') return new Date(value).toISOString()
  return value === null || value === undefined ? '' : String(value)
}

test('docs/entry-hash.md, the corpus and the preimage name the same twelve fields in the same order', () => {
  assert.equal(docFields.length, 12, 'the table in docs/entry-hash.md lists twelve fields')
  assert.deepEqual(CORPUS.fields.map((f) => f.split(' ')[0]), docFields)
  for (const vector of CORPUS.vectors) {
    assert.deepEqual(docFields.map((path) => render(vector.entry, path)), vector.preimage, vector.name)
  }
})

test('the corpus declares a U+0000 separator and twelve fields', () => {
  assert.equal(CORPUS.separator, 'U+0000')
  assert.equal(CORPUS.fields.length, 12)
  assert.ok(CORPUS.vectors.length >= 3, 'a corpus of fewer than three vectors cannot show null, negative and non-ASCII handling')
})

for (const vector of CORPUS.vectors) {
  test(`${vector.name}: the digest is sha256 of the twelve strings joined by NUL`, () => {
    assert.equal(vector.preimage.length, 12)
    assert.match(vector.hash, /^[0-9a-f]{64}$/)
    assert.equal(sha256(vector.preimage.join(NUL)), vector.hash)
  })

  test(`${vector.name}: the preimage is the entry's own fields in the documented order`, () => {
    assert.deepEqual(preimageOf(vector.entry), vector.preimage)
  })

  test(`${vector.name}: the entry uses only keys schema/entry.json knows`, () => {
    for (const key of Object.keys(vector.entry)) {
      assert.ok(key in ENTRY_SCHEMA.properties, `"${key}" is not an Entry property`)
    }
    assert.ok(vector.entry.source.type, 'source.type is required by the schema')
  })

  test(`${vector.name}: the built hashEntry() reproduces it`, async (t) => {
    const dist = join(ROOT, 'dist', 'index.js')
    if (!existsSync(dist)) return t.skip('UNKNOWN: dist/ is not built (npm run build)')
    const { hashEntry } = await import(pathToFileURL(dist).href)
    assert.equal(hashEntry({ ...vector.entry, occurredAt: new Date(vector.entry.occurredAt) }), vector.hash)
  })
}

test('a different separator does not reproduce any vector', () => {
  for (const vector of CORPUS.vectors) {
    for (const wrong of [' ', '|', ',', '\n', '']) {
      assert.notEqual(sha256(vector.preimage.join(wrong)), vector.hash, `separator ${JSON.stringify(wrong)}`)
    }
  }
})
