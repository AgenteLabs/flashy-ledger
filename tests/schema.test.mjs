// The wire shapes in schema/ agree with the TypeScript types, and real entries
// validate against them.
//
// Dependency-free on purpose: `node --test tests/schema.test.mjs` needs no
// install, so the check that the published JSON Schema matches what the code
// produces can run anywhere the repository can be read. The validator below
// is a structural subset of JSON Schema draft 2020-12 — exactly the keywords
// the two schemas use, and nothing more — not a general implementation. A
// consumer should validate with a real one; this file proves the schemas are
// worth handing them.
//
// Fixtures come from the ledger's own constructors when `dist/` has been
// built (npm ci runs `prepare`, which builds), so the shapes are what
// post() and InMemoryLedgerStore actually emit after a JSON round trip. On a
// checkout with no build the same cases run against hand-written fixtures,
// and the test says so rather than passing silently on nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const json = (...p) => JSON.parse(read(...p))

const ENTRY = json('schema', 'entry.json')
const ASSET = json('schema', 'asset.json')

// ---------------------------------------------------------------------------
// A minimal draft 2020-12 structural check.

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function resolveRef(schema, root) {
  if (!schema.$ref) return schema
  assert.ok(schema.$ref.startsWith('#/'), `only local refs are supported: ${schema.$ref}`)
  let target = root
  for (const part of schema.$ref.slice(2).split('/')) target = target[part]
  assert.ok(target, `dangling $ref ${schema.$ref}`)
  // Sibling keywords beside a $ref apply too (2020-12 semantics).
  const { $ref, ...siblings } = schema
  void $ref
  return { ...resolveRef(target, root), ...siblings }
}

/** Every problem with `value` against `schema`, as strings. Empty means valid. */
export function problems(value, schemaIn, root = schemaIn, path = '$') {
  const schema = resolveRef(schemaIn, root)
  const out = []
  const actual = typeOf(value)

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    const ok = allowed.some((t) =>
      t === 'integer' ? actual === 'number' && Number.isInteger(value) : t === actual,
    )
    if (!ok) out.push(`${path}: expected ${allowed.join('|')}, got ${actual}${actual === 'number' ? ` (${value})` : ''}`)
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    out.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`)
  }
  if (schema.const !== undefined && value !== schema.const) {
    out.push(`${path}: expected const ${JSON.stringify(schema.const)}`)
  }
  if (schema.not !== undefined && problems(value, schema.not, root, path).length === 0) {
    out.push(`${path}: matched a forbidden shape (${JSON.stringify(schema.not)})`)
  }
  if (schema.oneOf !== undefined) {
    const passing = schema.oneOf.filter((s) => problems(value, s, root, path).length === 0).length
    if (passing !== 1) out.push(`${path}: oneOf matched ${passing} branches, expected exactly 1`)
  }
  if (actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: ${value} < minimum ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: ${value} > maximum ${schema.maximum}`)
  }
  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(`${path}: "${value}" does not match ${schema.pattern}`)
    if (schema.format === 'date-time' && !(DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)))) {
      out.push(`${path}: "${value}" is not an RFC 3339 date-time`)
    }
  }
  if (actual === 'object') {
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!(key in value)) out.push(`${path}: missing required "${key}"`)
    }
    const patterns = Object.entries(schema.patternProperties ?? {}).map(([p, s]) => [new RegExp(p), s])
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`
      let matched = false
      if (key in props) {
        matched = true
        out.push(...problems(child, props[key], root, childPath))
      }
      for (const [re, s] of patterns) {
        if (re.test(key)) {
          matched = true
          out.push(...problems(child, s, root, childPath))
        }
      }
      if (!matched) {
        if (schema.additionalProperties === false) out.push(`${childPath}: unknown key refused`)
        else if (typeof schema.additionalProperties === 'object') out.push(...problems(child, schema.additionalProperties, root, childPath))
      }
    }
  }
  return out
}

const assertValid = (value, schema, label) => {
  const found = problems(value, schema)
  assert.deepEqual(found, [], `${label} should validate:\n  ${found.join('\n  ')}`)
}
const assertRefused = (value, schema, label, why) => {
  const found = problems(value, schema)
  assert.ok(found.length > 0, `${label} should be refused`)
  if (why) assert.ok(found.some((p) => why.test(p)), `${label}: refused, but not for the right reason:\n  ${found.join('\n  ')}`)
}

// ---------------------------------------------------------------------------
// Fixtures: from the built package when it is there, otherwise by hand.

const wire = (v) => JSON.parse(JSON.stringify(v))

async function fixtures() {
  const dist = join(ROOT, 'dist', 'index.js')
  if (!existsSync(dist)) return { built: false, ...handWritten() }

  const api = await import(dist)
  const gold = api.materialize(api.FLASHY_GOLD, { id: 'asset_fg', tenantId: 'flashy' })
  const wheat = api.materialize(api.WHEAT, { id: 'asset_wht', tenantId: 'flashy' })
  const store = new api.InMemoryLedgerStore()
  const ref = { tenantId: 'flashy', identityId: 'identity_1', assetId: gold.id }
  const at = new Date('2026-09-28T12:00:00.000Z')

  const earn = api.post(await store.readState(ref), {
    tenantId: 'flashy', identityId: 'identity_1', asset: gold,
    amount: api.fromDecimal(25, gold.decimals), kind: 'EARN',
    source: { type: 'quest', id: 'q_9' },
    idempotencyKey: 'quest:q_9:identity_1', occurredAt: at,
  })
  const { entry: first } = await store.append(earn)

  const spend = api.post(await store.readState(ref), {
    tenantId: 'flashy', identityId: 'identity_1', asset: gold,
    amount: api.fromDecimal(-5, gold.decimals), kind: 'SPEND',
    source: { type: 'shop', id: 'order_1', description: 'a hat' },
    idempotencyKey: 'shop:order_1', occurredAt: at,
    metadata: { note: 'anything, not hashed' },
  })
  const { entry: second } = await store.append(spend)

  const [debit, credit] = api.postTransfer(
    { state: await store.readState(ref), identityId: 'identity_1' },
    { state: await store.readState({ ...ref, identityId: 'identity_2' }), identityId: 'identity_2' },
    { tenantId: 'flashy', asset: gold, amount: api.fromDecimal(5, gold.decimals),
      source: { type: 'gift' }, idempotencyKey: 'gift:g_1', occurredAt: at },
  )
  const [{ entry: out }, { entry: into }] = await store.appendAll([debit, credit])

  return {
    built: true,
    entries: [first, second, out, into].map(wire),
    assets: [gold, wheat].map(wire),
  }
}

function handWritten() {
  const hash = (n) => n.toString(16).padStart(64, '0')
  const base = {
    tenantId: 'flashy', identityId: 'identity_1', assetId: 'asset_fg',
    occurredAt: '2026-09-28T12:00:00.000Z',
  }
  return {
    entries: [
      { ...base, id: 'entry_1', amount: 2500, balanceBefore: 0, balanceAfter: 2500, kind: 'EARN',
        source: { type: 'quest', id: 'q_9' }, idempotencyKey: 'quest:q_9:identity_1',
        previousHash: null, hash: hash(1) },
      { ...base, id: 'entry_2', amount: -500, balanceBefore: 2500, balanceAfter: 2000, kind: 'SPEND',
        source: { type: 'shop', id: 'order_1', description: 'a hat' }, idempotencyKey: 'shop:order_1',
        previousHash: hash(1), hash: hash(2), metadata: { note: 'anything, not hashed' } },
    ],
    assets: [
      { id: 'asset_fg', slug: 'flashy-gold', symbol: 'FG', decimals: 2, class: 'REWARD_CURRENCY', tenantId: 'flashy' },
      { id: 'asset_wht', slug: 'wheat', symbol: 'WHT', decimals: 0, class: 'COMMODITY_UNIT', tenantId: 'flashy' },
    ],
  }
}

const FIXTURES = await fixtures()

// ---------------------------------------------------------------------------

test('both schemas declare draft 2020-12 and refuse unknown keys unless x- prefixed', () => {
  for (const [name, schema] of [['entry', ENTRY], ['asset', ASSET]]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name)
    assert.equal(schema.additionalProperties, false, `${name}: unknown keys must be refused`)
    assert.ok(schema.patternProperties && '^x-' in schema.patternProperties, `${name}: x- keys must be allowed`)
  }
})

test('the kind enum is the EntryKind union in src/domain/entry.ts, verbatim', () => {
  const src = read('src', 'domain', 'entry.ts')
  const block = src.split('export type EntryKind =')[1].split('\n\n')[0]
  const kinds = [...block.matchAll(/^\s*\|\s*'([A-Z_]+)'/gm)].map((m) => m[1])
  assert.ok(kinds.length > 0)
  assert.deepEqual(ENTRY.properties.kind.enum, kinds)
})

test('the class enum is the AssetClass union in src/domain/asset.ts, verbatim', () => {
  const src = read('src', 'domain', 'asset.ts')
  const block = src.split('export type AssetClass =')[1].split(';')[0]
  const classes = [...block.matchAll(/^\s*\|\s*'([A-Z_]+)'/gm)].map((m) => m[1])
  assert.ok(classes.length > 0)
  assert.deepEqual(ASSET.properties.class.enum, classes)
})

test('the asset patterns and decimal bound are the ones defineAsset() enforces', () => {
  const src = read('src', 'domain', 'registry.ts')
  const constant = (name) => {
    const m = new RegExp(`const ${name} = (.+)$`, 'm').exec(src)
    assert.ok(m, `src/domain/registry.ts no longer declares ${name}`)
    return m[1].trim()
  }
  assert.equal(`/${ASSET.properties.slug.pattern}/`, constant('SLUG_PATTERN'))
  assert.equal(`/${ASSET.properties.symbol.pattern}/`, constant('SYMBOL_PATTERN'))
  assert.equal(String(ASSET.properties.decimals.maximum), constant('MAX_DECIMALS'))
  assert.equal(ASSET.properties.decimals.minimum, 0)
})

test('Minor amounts are integers within the exact range minor() accepts', () => {
  const minor = ENTRY.$defs.minor
  assert.equal(minor.type, 'integer')
  assert.equal(minor.maximum, Number.MAX_SAFE_INTEGER)
  assert.equal(minor.minimum, Number.MIN_SAFE_INTEGER)
  for (const field of ['amount', 'balanceBefore', 'balanceAfter']) {
    assert.equal(ENTRY.properties[field].$ref, '#/$defs/minor', field)
  }
})

test('every entry the ledger produces validates on the wire', (t) => {
  t.diagnostic(FIXTURES.built
    ? `fixtures built by post()/postTransfer() through InMemoryLedgerStore (${FIXTURES.entries.length} entries)`
    : 'dist/ is not built — validating hand-written fixtures; run `npm ci` (or `npm run build`) to use the real constructors')
  assert.ok(FIXTURES.entries.length >= 2)
  for (const entry of FIXTURES.entries) assertValid(entry, ENTRY, entry.id)
  // The chain's own arithmetic, so a fixture that validates is also coherent.
  for (const entry of FIXTURES.entries) {
    assert.equal(entry.balanceBefore + entry.amount, entry.balanceAfter, `${entry.id}: balance arithmetic`)
  }
  assert.equal(FIXTURES.entries[0].previousHash, null, 'the first entry for an identity has no predecessor')
  assert.equal(FIXTURES.entries[1].previousHash, FIXTURES.entries[0].hash, 'the second chains onto the first')
})

test('every asset validates, materialised or by hand', () => {
  assert.ok(FIXTURES.assets.length >= 2)
  for (const asset of FIXTURES.assets) assertValid(asset, ASSET, asset.slug)
})

test('a fractional amount is refused — floats never cross the wire', () => {
  const [entry] = FIXTURES.entries
  assertRefused({ ...entry, amount: 25.5 }, ENTRY, 'float amount', /amount: expected integer/)
  assertRefused({ ...entry, balanceAfter: 2500.000001 }, ENTRY, 'float balance', /balanceAfter: expected integer/)
  assertRefused({ ...entry, amount: '2500' }, ENTRY, 'string amount', /amount: expected integer/)
  assertRefused({ ...entry, amount: Number.MAX_SAFE_INTEGER + 2 }, ENTRY, 'unsafe integer', /maximum/)
})

test('a zero amount is refused, as post() refuses it', () => {
  const [entry] = FIXTURES.entries
  assertRefused({ ...entry, amount: 0 }, ENTRY, 'zero amount', /amount: matched a forbidden shape/)
})

test('an unknown key is refused; an x- key is accepted', () => {
  const [entry] = FIXTURES.entries
  assertRefused({ ...entry, balance: 2500 }, ENTRY, 'a stray authoritative balance column', /balance: unknown key refused/)
  assertValid({ ...entry, 'x-trace': 'abc' }, ENTRY, 'x- extension key')
  assertRefused({ ...entry, source: { ...entry.source, channel: 'web' } }, ENTRY, 'unknown key in source', /source\.channel: unknown key/)
  assertValid({ ...entry, source: { ...entry.source, 'x-channel': 'web' } }, ENTRY, 'x- key in source')
  const [asset] = FIXTURES.assets
  assertRefused({ ...asset, rate: 1.5 }, ASSET, 'a conversion rate on an asset', /rate: unknown key refused/)
  assertValid({ ...asset, 'x-icon': 'coin' }, ASSET, 'x- key on an asset')
})

test('the hash fields and the timestamp are shaped, not just present', () => {
  const [entry] = FIXTURES.entries
  assertRefused({ ...entry, hash: 'not-a-digest' }, ENTRY, 'malformed hash', /hash: "not-a-digest" does not match/)
  assertRefused({ ...entry, previousHash: '' }, ENTRY, 'empty previousHash', /previousHash: oneOf matched 0/)
  assertValid({ ...entry, previousHash: null }, ENTRY, 'null previousHash')
  assertRefused({ ...entry, occurredAt: 1759060800000 }, ENTRY, 'epoch millis', /occurredAt: expected string/)
  assertRefused({ ...entry, occurredAt: '28/09/2026' }, ENTRY, 'a local date string', /not an RFC 3339 date-time/)
  assertRefused({ ...entry, kind: 'BONUS' }, ENTRY, 'an invented kind', /kind: "BONUS" is not one of/)
  const { hash, ...noHash } = entry
  void hash
  assertRefused(noHash, ENTRY, 'entry with no hash', /missing required "hash"/)
})

test('an asset with a slug in the id field is still an asset — the guard for that is materialize(), not the schema', () => {
  // Stated so nobody reads the schema as the whole defence. The schema
  // refuses shapes; it cannot know a string is the wrong string.
  const [asset] = FIXTURES.assets
  assertValid({ ...asset, id: asset.slug }, ASSET, 'slug-valued id')
  assertRefused({ ...asset, id: '' }, ASSET, 'empty id', /id: shorter than 1/)
  assertRefused({ ...asset, decimals: 2.5 }, ASSET, 'fractional decimals', /decimals: expected integer/)
  assertRefused({ ...asset, symbol: 'fg' }, ASSET, 'lower-case symbol', /symbol: "fg" does not match/)
  assertRefused({ ...asset, class: 'TOKEN' }, ASSET, 'unknown class', /class: "TOKEN" is not one of/)
})
