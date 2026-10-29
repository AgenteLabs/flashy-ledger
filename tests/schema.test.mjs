// The wire shapes in schema/ agree with the TypeScript types, and real entries
// validate against them. That is five schemas: the Entry and the Asset, and the
// three documents of the Merkle snapshot (a snapshot row, a commitment, an
// inclusion proof).
//
// Dependency-free on purpose: `node --test tests/schema.test.mjs` needs no
// install, so the check that the published JSON Schema matches what the code
// produces can run anywhere the repository can be read. The validator below
// is a structural subset of JSON Schema draft 2020-12 — exactly the keywords
// the schemas use, and nothing more — not a general implementation. A
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
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const json = (...p) => JSON.parse(read(...p))

const ENTRY = json('schema', 'entry.json')
const ASSET = json('schema', 'asset.json')
const SNAPSHOT_ROW = json('schema', 'snapshot-entry.json')
const COMMITMENT = json('schema', 'commitment.json')
const INCLUSION = json('schema', 'inclusion-proof.json')

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
  if (actual === 'array' && schema.items !== undefined) {
    value.forEach((item, i) => out.push(...problems(item, schema.items, root, `${path}[${i}]`)))
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
    merkle: merkleFixtures(api),
  }
}

/**
 * A five-entry snapshot, so the tree has an odd node at two levels and the
 * proofs have more than one length, plus a one-entry snapshot whose proof is
 * the empty path. Built through the real toJsonl, commit and inclusionProof.
 */
function merkleFixtures(api) {
  const row = (id, amountMinor) => ({
    id, asset: 'flashy-gold', type: 'issuance', source: 'quest_completion',
    amountMinor, recordedAt: '2026-09-28T03:41:00Z',
  })
  const snapshot = [row('gl_3', '1000'), row('gl_1', '-250'), row('gl_5', '12500'), row('gl_2', '1'), row('gl_4', '0')]
  const lone = [row('gl_1', '700')]
  const jsonl = api.toJsonl(snapshot)
  return {
    snapshot,
    jsonl,
    rows: jsonl.trimEnd().split('\n').map((line) => JSON.parse(line)),
    commitment: wire(api.commit(snapshot, '2026-09-28', 'flashy-gold')),
    proofs: snapshot.map((e) => wire(api.inclusionProof(snapshot, e.id))),
    loneProof: wire(api.inclusionProof(lone, 'gl_1')),
    loneCommitment: wire(api.commit(lone, '2026-09-28', 'flashy-gold')),
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
    merkle: handWrittenMerkle(),
  }
}

/** Shapes only: the digests are not real, so the root is not recomputed from them. */
function handWrittenMerkle() {
  const hex = (n) => `0x${n.toString(16).padStart(64, '0')}`
  const rows = [
    { id: 'gl_1', asset: 'flashy-gold', type: 'issuance', source: 'quest_completion', amount_minor: '-250', recorded_at: '2026-09-28T03:41:00Z' },
    { id: 'gl_2', asset: 'flashy-gold', type: 'issuance', source: 'quest_completion', amount_minor: '1', recorded_at: '2026-09-28T03:41:00Z' },
  ]
  const proof = {
    entryId: 'gl_1', leaf: hex(1),
    path: [{ sibling: hex(2), side: 'right' }],
    root: hex(3),
  }
  return {
    rows,
    commitment: { date: '2026-09-28', root: hex(3), entryCount: 2, datasetSha256: hex(4), outstandingMinor: '-249', asset: 'flashy-gold' },
    proofs: [proof],
    loneProof: { entryId: 'gl_1', leaf: hex(1), path: [], root: hex(1) },
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

// ---------------------------------------------------------------------------
// The Merkle snapshot: a row, a commitment, an inclusion proof.
//
// src/domain/merkle.ts calls itself a specification a reader can rebuild "in a
// language we did not choose", and these are the shapes of what that reader is
// handed. Positive cases only against the code: the schemas state the form a
// producer must write, and commit() does not enforce it (it sums with BigInt()
// and hashes the raw string), so nothing here asserts that commit() refuses a
// malformed amount. The refusals below are the schemas' own.

const sha256 = (...parts) => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}
const hex0x = (buf) => `0x${buf.toString('hex')}`
const UNKNOWN_DIST = 'UNKNOWN: dist/ is not built (npm run build); the hand-written fixtures only show the shapes'

test('the Merkle schemas declare draft 2020-12 and refuse unknown keys; a snapshot row allows no x- key at all', () => {
  for (const [name, schema] of [['snapshot-entry', SNAPSHOT_ROW], ['commitment', COMMITMENT], ['inclusion-proof', INCLUSION]]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name)
    assert.equal(schema.additionalProperties, false, `${name}: unknown keys must be refused`)
  }
  // The two documents may carry extensions; the row may not, because
  // datasetSha256 is the digest of the bytes toJsonl() writes, and toJsonl()
  // writes exactly six keys.
  assert.ok('^x-' in COMMITMENT.patternProperties, 'commitment: x- keys must be allowed')
  assert.ok('^x-' in INCLUSION.patternProperties, 'inclusion-proof: x- keys must be allowed')
  assert.equal(SNAPSHOT_ROW.patternProperties, undefined, 'snapshot-entry: an x- key would break the dataset digest')
})

test('every row toJsonl() writes validates, and carries exactly the keys the schema requires', (t) => {
  t.diagnostic(FIXTURES.built ? 'rows from toJsonl() over five snapshot entries' : UNKNOWN_DIST)
  const { rows } = FIXTURES.merkle
  assert.ok(rows.length >= 2)
  for (const row of rows) {
    assertValid(row, SNAPSHOT_ROW, `row ${row.id}`)
    assert.deepEqual(Object.keys(row).sort(), [...SNAPSHOT_ROW.required].sort(), `row ${row.id}: keys`)
    assert.deepEqual(Object.keys(row).sort(), Object.keys(SNAPSHOT_ROW.properties).sort(), `row ${row.id}: declared keys`)
  }
})

test('a real commit() validates, and its keys are the ones the schema requires', (t) => {
  t.diagnostic(FIXTURES.built ? 'commit() over five entries and over one' : UNKNOWN_DIST)
  const commitments = [FIXTURES.merkle.commitment, FIXTURES.merkle.loneCommitment].filter(Boolean)
  assert.ok(commitments.length >= 1)
  for (const commitment of commitments) {
    assertValid(commitment, COMMITMENT, 'commitment')
    assert.deepEqual(Object.keys(commitment).sort(), [...COMMITMENT.required].sort())
  }
})

test('every inclusion proof inclusionProof() returns validates, whatever the shape of the tree', (t) => {
  t.diagnostic(FIXTURES.built ? 'a proof for each of five entries, and the empty path of a one-entry tree' : UNKNOWN_DIST)
  const proofs = [...FIXTURES.merkle.proofs, FIXTURES.merkle.loneProof]
  for (const proof of proofs) {
    assertValid(proof, INCLUSION, `proof ${proof.entryId}`)
    assert.deepEqual(Object.keys(proof).sort(), [...INCLUSION.required].sort())
  }
  assert.deepEqual(FIXTURES.merkle.loneProof.path, [], 'a one-entry tree has an empty path')
  if (FIXTURES.built) {
    const lengths = new Set(FIXTURES.merkle.proofs.map((p) => p.path.length))
    assert.ok(lengths.size >= 2, 'an odd node is promoted, so proof lengths differ across the five entries')
  }
})

test('the side enum is the ProofStep union in src/domain/merkle.ts, verbatim', () => {
  const src = read('src', 'domain', 'merkle.ts')
  const field = /export interface ProofStep \{[\s\S]*?readonly side: ([^\n]+)\n/.exec(src)
  assert.ok(field, 'src/domain/merkle.ts no longer declares ProofStep.side')
  const sides = [...field[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  assert.ok(sides.length > 0)
  assert.deepEqual(INCLUSION.$defs.step.properties.side.enum, sides)
})

test('what the schemas say about the bytes is true: the dataset digest, the count, the total and the proofs recompute from the rows', (t) => {
  if (!FIXTURES.built) return t.skip(UNKNOWN_DIST)
  const { rows, jsonl, commitment, proofs } = FIXTURES.merkle

  assert.equal(commitment.datasetSha256, hex0x(sha256(jsonl)), 'datasetSha256 is the sha256 of the file bytes')
  assert.equal(commitment.entryCount, rows.length)
  assert.equal(commitment.outstandingMinor, rows.reduce((sum, r) => sum + BigInt(r.amount_minor), 0n).toString())
  assert.deepEqual(rows.map((r) => r.id), [...rows.map((r) => r.id)].sort(), 'rows are sorted by id')

  // The documented encoding, rebuilt here from node:crypto and nothing else.
  const leaf = (r) => sha256(Buffer.from([0x00]), Buffer.from([r.id, r.asset, r.type, r.source, r.amount_minor, r.recorded_at].join('|'), 'utf8'))
  for (const proof of proofs) {
    const row = rows.find((r) => r.id === proof.entryId)
    assert.equal(proof.leaf, hex0x(leaf(row)), `${proof.entryId}: leaf`)
    let acc = leaf(row)
    for (const step of proof.path) {
      const sibling = Buffer.from(step.sibling.slice(2), 'hex')
      acc = step.side === 'right'
        ? sha256(Buffer.from([0x01]), acc, sibling)
        : sha256(Buffer.from([0x01]), sibling, acc)
    }
    assert.equal(hex0x(acc), proof.root, `${proof.entryId}: the path reaches the root`)
    assert.equal(proof.root, commitment.root, `${proof.entryId}: the proof's root is the commitment's`)
  }
})

test('the order the snapshot schema states is the order sortEntries() uses: UTF-16 code units, which is not the order of the UTF-8 bytes', async (t) => {
  // The description is what a reader in another language rebuilds a root from, so
  // what it claims about the order is held to the code, not to a header comment.
  // It once said "compared byte-wise", which sortEntries() does not do.
  const prose = `${SNAPSHOT_ROW.description} ${SNAPSHOT_ROW.properties.id.description}`
  assert.doesNotMatch(SNAPSHOT_ROW.description, /compared byte-wise/, 'the retired claim is back')
  assert.match(prose, /UTF-16 code units/)
  assert.match(COMMITMENT.properties.root.description, /UTF-16 code units/, 'commitment: the root description points at the same order')

  const supplementary = '\u{10000}'
  const bmp = '�'
  const hexBytes = (s) => Buffer.from(s, 'utf8').toString('hex').match(/../g).join(' ')
  assert.ok(SNAPSHOT_ROW.description.includes(`U+10000 (UTF-8 ${hexBytes(supplementary)}) sorts before U+FFFD (${hexBytes(bmp)}) here`),
    'the worked example in the description names the real UTF-8 bytes of both characters')
  assert.equal(Buffer.compare(Buffer.from(supplementary, 'utf8'), Buffer.from(bmp, 'utf8')), 1, 'the bytes order them the other way round')

  if (!FIXTURES.built) return t.diagnostic(`${UNKNOWN_DIST}; only the prose was checked`)
  const api = await import(join(ROOT, 'dist', 'index.js'))
  const row = (id) => ({ id, asset: 'flashy-gold', type: 'issuance', source: 'quest_completion', amountMinor: '1000', recordedAt: '2026-09-28T03:41:00Z' })
  assert.deepEqual(api.sortEntries([row(bmp), row(supplementary)]).map((e) => e.id), [supplementary, bmp],
    'sortEntries() puts U+10000 before U+FFFD, as the description says')
  const [first] = api.toJsonl([row(bmp), row(supplementary)]).split('\n')
  assert.equal(JSON.parse(first).id, supplementary, 'the snapshot file follows the same order')
})

test('a snapshot row is refused for an extra key, a numeric or formatted amount, or a malformed time', () => {
  const [row] = FIXTURES.merkle.rows
  assertRefused({ ...row, 'x-trace': 'abc' }, SNAPSHOT_ROW, 'an x- key on a row', /x-trace: unknown key refused/)
  assertRefused({ ...row, amount: '5' }, SNAPSHOT_ROW, 'the camelCase name from the TypeScript type', /amount: unknown key refused/)
  assertRefused({ ...row, amount_minor: 1000 }, SNAPSHOT_ROW, 'a numeric amount', /amount_minor: expected string/)
  for (const bad of ['', '1,000', '12.50', '+5', '-0', '007', ' 5', '0x10', '1e3']) {
    assertRefused({ ...row, amount_minor: bad }, SNAPSHOT_ROW, `amount_minor ${JSON.stringify(bad)}`, /amount_minor: .* does not match/)
  }
  for (const good of ['0', '5', '-5', '12500', '-9007199254740993']) {
    assertValid({ ...row, amount_minor: good }, SNAPSHOT_ROW, `amount_minor ${good}`)
  }
  for (const bad of ['2026-09-28T03:41:00.000Z', '2026-09-28T03:41:00+00:00', '2026-09-28 03:41:00Z', '28/09/2026']) {
    assertRefused({ ...row, recorded_at: bad }, SNAPSHOT_ROW, `recorded_at ${bad}`, /recorded_at: .* does not match/)
  }
  const { id, ...noId } = row
  void id
  assertRefused(noId, SNAPSHOT_ROW, 'a row with no id', /missing required "id"/)
})

test('a digest is refused unless it is 0x and 64 lower-case hexadecimal characters', () => {
  const { commitment, proofs } = FIXTURES.merkle
  const [proof] = proofs
  const digest = commitment.root
  const bare = digest.slice(2)
  for (const bad of [bare, `0x${'AB'.repeat(32)}`, digest.slice(0, -2), `${digest}00`, `0x${'g'.repeat(64)}`, '']) {
    assertRefused({ ...commitment, root: bad }, COMMITMENT, `root ${JSON.stringify(bad)}`, /root: .* does not match/)
    assertRefused({ ...proof, leaf: bad }, INCLUSION, `leaf ${JSON.stringify(bad)}`, /leaf: .* does not match/)
  }
  assertRefused({ ...commitment, datasetSha256: bare }, COMMITMENT, 'a digest without its 0x', /datasetSha256: .* does not match/)
  // The Entry hash is the other way round: no prefix at all.
  assertRefused({ ...FIXTURES.entries[0], hash: digest }, ENTRY, 'an Entry hash with a 0x', /hash: .* does not match/)
})

test('a commitment is refused for no entries, a fractional total or an extra key; an x- key is accepted', () => {
  const { commitment } = FIXTURES.merkle
  assertRefused({ ...commitment, entryCount: 0 }, COMMITMENT, 'an empty set (commit() returns null for one)', /entryCount: 0 < minimum 1/)
  assertRefused({ ...commitment, entryCount: 2.5 }, COMMITMENT, 'a fractional count', /entryCount: expected integer/)
  assertRefused({ ...commitment, outstandingMinor: 249 }, COMMITMENT, 'a numeric total', /outstandingMinor: expected string/)
  assertRefused({ ...commitment, outstandingMinor: '-249.5' }, COMMITMENT, 'a fractional total', /outstandingMinor: .* does not match/)
  assertRefused({ ...commitment, anchoredAt: 'block 1' }, COMMITMENT, 'an unknown key', /anchoredAt: unknown key refused/)
  assertValid({ ...commitment, 'x-anchor': 'block 1' }, COMMITMENT, 'x- key on a commitment')
  const { root, ...noRoot } = commitment
  void root
  assertRefused(noRoot, COMMITMENT, 'a commitment with no root', /missing required "root"/)
})

test('a proof step is refused for any side but left or right, or for a missing sibling', () => {
  const proof = FIXTURES.merkle.proofs.find((p) => p.path.length > 0)
  assert.ok(proof, 'at least one proof has a step')
  const [step, ...rest] = proof.path
  assertValid({ ...proof, path: [{ ...step, side: 'left' }, ...rest] }, INCLUSION, 'a left step')
  assertValid({ ...proof, path: [{ ...step, side: 'right' }, ...rest] }, INCLUSION, 'a right step')
  assertRefused({ ...proof, path: [{ ...step, side: 'up' }, ...rest] }, INCLUSION, 'an invented side', /path\[0\]\.side: "up" is not one of/)
  assertRefused({ ...proof, path: [{ side: step.side }, ...rest] }, INCLUSION, 'a step with no sibling', /path\[0\]: missing required "sibling"/)
  assertRefused({ ...proof, path: [{ ...step, depth: 1 }, ...rest] }, INCLUSION, 'an unknown key in a step', /path\[0\]\.depth: unknown key refused/)
  assertRefused({ ...proof, path: 'none' }, INCLUSION, 'a path that is not an array', /path: expected array/)
})
