// A systematic sweep, not five one-off checks.
//
// `tests/schema.test.mjs` already asserts `additionalProperties: false` on
// each of the five schema documents' TOP-LEVEL shape, by name, one file at a
// time — entry.json, asset.json, snapshot-entry.json, commitment.json,
// inclusion-proof.json. That caught nothing drifting today, but it would not
// catch a SIXTH schema file landing tomorrow with the gap the AAO charter
// schema had (`additionalProperties: true`, closed only after somebody
// noticed): nothing walks `schema/` itself, and nothing descends into a
// schema's own nested object shapes.
//
// Roadmap step 5 (round-2 boardroom synthesis, "Flashy Financial
// infrastructure"): "systematically check whether the same admission gap
// recurs elsewhere... check every schema file in these repos, not just the
// named payload shapes." This is that check for flashy-ledger: it walks
// EVERY schema/*.json document that declares `$schema` (skipping
// `entry-hash-vectors.json`, which is conformance data, not a schema) and
// every object-shaped node inside it — including nested `$defs` and
// `properties` the five per-file tests above do not name — and fails if any
// of them admits an unknown key without a documented reason.
//
// The sweep found exactly one node that is open on purpose:
// `entry.json#/properties/metadata`, deliberately `type: object` with no
// `additionalProperties` restriction, because it is free-form caller data
// that `hashEntry()` never reads — the one field in the wire format this
// package does not interpret at all. That is not the AAO charter's gap (an
// unsupported field silently admitted into something the rules DO read); it
// is a documented design choice, and ALLOWED_OPEN below is the one place
// that choice is written down and tested, so widening it is a decision, not
// a drift.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_DIR = join(ROOT, 'schema')

/**
 * Every node in a schema document that admits an unknown key without a
 * recorded reason, as `"<file>#<json-pointer>"` strings.
 *
 * Walks the composition keywords these schemas actually use
 * (`properties`, `patternProperties`, `$defs`, `items`, `oneOf`). A node
 * "is an object schema" when it says `type: "object"`, or when it carries
 * `properties`/`patternProperties` and no `type` at all (2020-12 lets a
 * schema with no `type` validate an object via `properties` alone — the
 * same rule `tests/schema.test.mjs`'s own structural validator honours).
 */
export function openObjectNodes(doc, file) {
  const open = []
  const visit = (node, pointer) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    const looksLikeObject = node.type === 'object'
      || (node.type === undefined && ('properties' in node || 'patternProperties' in node))
    if (looksLikeObject && node.additionalProperties !== false) {
      open.push(`${file}#${pointer}`)
    }
    for (const key of ['properties', 'patternProperties', '$defs']) {
      for (const [childKey, child] of Object.entries(node[key] ?? {})) {
        visit(child, `${pointer}/${key}/${childKey}`)
      }
    }
    if (node.items) visit(node.items, `${pointer}/items`)
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      for (const [i, child] of (node[key] ?? []).entries()) visit(child, `${pointer}/${key}/${i}`)
    }
  }
  visit(doc, '')
  return open
}

/**
 * The one node this sweep allows to stay open, and why. Widening this list
 * is a decision about the wire format, not a test fixup — say why in the
 * same breath you add a row.
 */
const ALLOWED_OPEN = {
  'entry.json#/properties/metadata': 'Free-form caller data. Explicitly excluded from the hash '
    + '(docs/entry-hash.md, schema/entry.json\'s own description): hashEntry() never reads it, so an '
    + 'unknown key here cannot be smuggled into anything a rule evaluates — unlike the AAO charter gap, '
    + 'where an unsupported field was silently admitted into something the rules DID read.',
}

const schemaFiles = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, doc: JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8')) }))
  .filter(({ doc }) => typeof doc.$schema === 'string') // excludes entry-hash-vectors.json — data, not a schema

test('the sweep actually walks schema/ — a vacuous sweep is worse than none', () => {
  // Guards the guard: if schema/ ever ends up empty, or every file in it
  // stops declaring $schema, the loop below would pass having checked
  // nothing. Five is today's count (entry, asset, snapshot-entry,
  // commitment, inclusion-proof); the floor is "more than zero", not a
  // number that has to be bumped every time a schema is added.
  assert.ok(schemaFiles.length > 0, 'no schema/*.json file declares $schema — the sweep below checked nothing')
})

for (const { file, doc } of schemaFiles) {
  test(`${file}: every object-shaped node either refuses an unknown key or is named in ALLOWED_OPEN with a reason`, () => {
    const open = openObjectNodes(doc, file)
    const unexplained = open.filter((pointer) => !(pointer in ALLOWED_OPEN))
    assert.deepEqual(
      unexplained,
      [],
      `${file} admits an unknown key at: ${unexplained.join(', ')} — ` +
        'either close it with additionalProperties: false (and a patternProperties "^x-" allowance ' +
        'if extensions should stay possible), or add it to ALLOWED_OPEN above with a reason.',
    )
  })
}

test('ALLOWED_OPEN names a node that actually exists and is actually open — an allowlist entry for nothing found is a promise with no debt behind it', () => {
  const allOpen = new Set(schemaFiles.flatMap(({ file, doc }) => openObjectNodes(doc, file)))
  for (const pointer of Object.keys(ALLOWED_OPEN)) {
    assert.ok(allOpen.has(pointer), `ALLOWED_OPEN names "${pointer}", but no schema node at that pointer is actually open`)
  }
})

test('every ALLOWED_OPEN reason is long enough to say WHY, not just THAT', () => {
  for (const [pointer, reason] of Object.entries(ALLOWED_OPEN)) {
    assert.ok(reason.length >= 60, `${pointer}: reason is only ${reason.length} characters — say why this is safe to leave open`)
  }
})
