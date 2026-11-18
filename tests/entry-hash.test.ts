import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  hashEntry,
  minor,
  verifyChain,
  verifyEntry,
  type Entry,
  type HashableEntry,
} from '../src/index.js'

/**
 * The hash input IS the format.
 *
 * Every chain, every Merkle leaf and every anchored root depends on the exact
 * bytes `hashEntry` feeds to sha256: twelve fields, in a fixed order, joined by
 * a NUL byte. Nothing else in the suite pins those bytes, because `post()` and
 * `verifyEntry()` both call `hashEntry` — so any change to the preimage is
 * self-consistent and every other test stays green while every chain ever
 * written stops verifying.
 *
 * Two kinds of evidence here. The golden vectors were computed OUTSIDE this
 * codebase (Python's hashlib, over the same twelve strings joined with U+0000),
 * so a change to the format cannot be reconciled by regenerating a snapshot. The
 * rest rebuild the preimage with node:crypto from the documented layout, which
 * pins the same thing from a second direction and covers the exclusions.
 *
 * The separator is written as the escape '\u0000' and never as a literal byte:
 * editors and diff tools render a NUL as a space, and a hand retype as a space
 * would change every hash this package has ever produced.
 */

const NUL = '\u0000'

const AT = new Date('2026-08-12T00:00:00.000Z')

function base(over: Partial<HashableEntry> = {}): HashableEntry {
  return {
    tenantId: 'flashy',
    identityId: 'identity_1',
    assetId: 'asset_fg',
    amount: minor(2500),
    balanceBefore: minor(0),
    balanceAfter: minor(2500),
    kind: 'EARN',
    source: { type: 'quest', id: 'q_1' },
    idempotencyKey: 'quest:q_1',
    occurredAt: AT,
    previousHash: null,
    ...over,
  }
}

/** The documented layout, rebuilt independently of the source under test. */
function preimage(e: HashableEntry): string {
  return [
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
    e.occurredAt.toISOString(),
  ].join(NUL)
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Golden vector A, from Python: sha256('\x00'.join([...twelve strings...])). */
const GOLDEN_A = '45170c1d3a85e9df66337c08fa17f517e8b7d6a67f103332cdbb9fe259509bae'

/** Golden vector B, from Python: a chained, negative, id-less, millisecond entry. */
const GOLDEN_B = '97498dce3f5ef2d4fde93e3d8f75bf499f3ee469ab8d707da8c7f8937bf0c87f'

const PREV = 'ab'.repeat(32)

function vectorB(): HashableEntry {
  return {
    tenantId: 'tenant_b',
    identityId: 'identity_2',
    assetId: 'asset_wht',
    amount: minor(-7),
    balanceBefore: minor(10),
    balanceAfter: minor(3),
    kind: 'SPEND',
    source: { type: 'game' },
    idempotencyKey: 'spend:s_9',
    occurredAt: new Date('2026-08-12T10:20:30.123Z'),
    previousHash: PREV,
  }
}

describe('hashEntry: the preimage is the format', () => {
  it('hashes the twelve fields, in order, joined by NUL, to a vector computed outside this codebase', () => {
    expect(hashEntry(base())).toBe(GOLDEN_A)
  })

  it('matches a second outside vector: chained, negative, no source id, millisecond precision', () => {
    expect(hashEntry(vectorB())).toBe(GOLDEN_B)
  })

  it('agrees with the preimage rebuilt here from the documented layout', () => {
    expect(hashEntry(base())).toBe(sha256(preimage(base())))
    expect(hashEntry(vectorB())).toBe(sha256(preimage(vectorB())))
  })

  it('joins with a NUL byte and nothing else', () => {
    const entry = base()
    const withNul = sha256(preimage(entry))

    for (const wrong of [' ', '|', ',', '\n', '\t', '']) {
      const lookalike = preimage(entry).split(NUL).join(wrong)
      expect(sha256(lookalike), `separator ${JSON.stringify(wrong)}`).not.toBe(withNul)
      expect(hashEntry(entry), `separator ${JSON.stringify(wrong)}`).not.toBe(sha256(lookalike))
    }
  })

  it('keeps adjacent fields apart, so moving a character across a boundary changes the hash', () => {
    // With no separator at all, ('flashy', 'identity_1') and ('flashyi',
    // 'dentity_1') would hash alike, and one tenant's entry could be
    // re-attributed to another by shifting a character.
    const a = hashEntry(base({ tenantId: 'flashy', identityId: 'identity_1' }))
    const b = hashEntry(base({ tenantId: 'flashyi', identityId: 'dentity_1' }))
    expect(a).not.toBe(b)

    // The same holds for the numeric fields, where the digits would run together.
    const c = hashEntry(base({ amount: minor(12), balanceBefore: minor(3) }))
    const d = hashEntry(base({ amount: minor(1), balanceBefore: minor(23) }))
    expect(c).not.toBe(d)
  })

  it('reads a null previous hash as the empty string, so the first entry of a chain has a defined preimage', () => {
    const first = base({ previousHash: null })
    expect(preimage(first).startsWith(NUL + 'flashy' + NUL)).toBe(true)
    expect(hashEntry(first)).toBe(sha256(preimage(first)))
  })

  it('writes an absent source id as the empty string', () => {
    const noId = base({ source: { type: 'quest' } })
    expect(hashEntry(noId)).toBe(sha256(preimage(noId)))
    // ...which is not the same entry as one that names a source id.
    expect(hashEntry(noId)).not.toBe(hashEntry(base()))
  })

  it('writes the instant as an ISO-8601 UTC string with milliseconds, never epoch milliseconds', () => {
    const e = base({ occurredAt: new Date('2026-08-12T10:20:30.123Z') })
    const iso = sha256(preimage(e))
    const epoch = sha256(preimage(e).replace(e.occurredAt.toISOString(), String(e.occurredAt.getTime())))
    expect(hashEntry(e)).toBe(iso)
    expect(hashEntry(e)).not.toBe(epoch)
  })

  it('hashes two Dates for the same instant alike, however they were constructed', () => {
    const fromIso = new Date('2026-08-12T10:20:30.123Z')
    const fromEpoch = new Date(fromIso.getTime())
    // The same instant written with a different UTC offset.
    const fromOffset = new Date('2026-08-12T12:20:30.123+02:00')

    const h = hashEntry(base({ occurredAt: fromIso }))
    expect(hashEntry(base({ occurredAt: fromEpoch }))).toBe(h)
    expect(hashEntry(base({ occurredAt: fromOffset }))).toBe(h)
  })

  it('distinguishes instants one millisecond apart', () => {
    const a = hashEntry(base({ occurredAt: new Date('2026-08-12T00:00:00.000Z') }))
    const b = hashEntry(base({ occurredAt: new Date('2026-08-12T00:00:00.001Z') }))
    expect(a).not.toBe(b)
  })
})

describe('hashEntry: what is and is not hashed', () => {
  it('changes when any one of the twelve hashed fields changes', () => {
    const reference = hashEntry(base({ previousHash: PREV }))

    const variants: Record<string, HashableEntry> = {
      previousHash: base({ previousHash: 'cd'.repeat(32) }),
      tenantId: base({ previousHash: PREV, tenantId: 'other' }),
      identityId: base({ previousHash: PREV, identityId: 'identity_2' }),
      assetId: base({ previousHash: PREV, assetId: 'asset_wht' }),
      amount: base({ previousHash: PREV, amount: minor(2501) }),
      balanceBefore: base({ previousHash: PREV, balanceBefore: minor(1) }),
      balanceAfter: base({ previousHash: PREV, balanceAfter: minor(2501) }),
      kind: base({ previousHash: PREV, kind: 'ADJUSTMENT' }),
      'source.type': base({ previousHash: PREV, source: { type: 'gift', id: 'q_1' } }),
      'source.id': base({ previousHash: PREV, source: { type: 'quest', id: 'q_2' } }),
      idempotencyKey: base({ previousHash: PREV, idempotencyKey: 'quest:q_2' }),
      occurredAt: base({ previousHash: PREV, occurredAt: new Date('2026-08-13T00:00:00.000Z') }),
    }

    expect(Object.keys(variants)).toHaveLength(12)
    for (const [field, variant] of Object.entries(variants)) {
      expect(hashEntry(variant), field).not.toBe(reference)
    }
    // And no two single-field changes collide with each other either.
    expect(new Set(Object.values(variants).map(hashEntry)).size).toBe(12)
  })

  it('tells tenantId from identityId, so swapping their values is a different entry', () => {
    const a = hashEntry(base({ tenantId: 'alpha', identityId: 'beta' }))
    const b = hashEntry(base({ tenantId: 'beta', identityId: 'alpha' }))
    expect(a).not.toBe(b)
  })

  it('does not hash metadata', () => {
    const plain = hashEntry(base())
    expect(hashEntry(base({ metadata: { note: 'anything' } }))).toBe(plain)
    expect(hashEntry(base({ metadata: { note: 'something else', n: 1 } }))).toBe(plain)
  })

  it('does not hash the source description', () => {
    const plain = hashEntry(base())
    expect(hashEntry(base({ source: { type: 'quest', id: 'q_1', description: 'a reason' } }))).toBe(
      plain,
    )
    expect(hashEntry(base({ source: { type: 'quest', id: 'q_1', description: 'another' } }))).toBe(
      plain,
    )
  })

  it('does not hash keys it does not know about', () => {
    const extra = { ...base(), unrelated: 'x', id: 'entry_9', hash: 'not-part-of-the-preimage' }
    expect(hashEntry(extra)).toBe(GOLDEN_A)
  })

  it('does not hash the entry id: an entry stored under any id still verifies', () => {
    const sealed: Entry = { ...base(), id: 'entry_1', hash: GOLDEN_A }
    expect(verifyEntry(sealed)).toBe(true)
    expect(verifyEntry({ ...sealed, id: 'a-completely-different-id' })).toBe(true)
  })

  it('makes an edit to any hashed field detectable by verifyEntry and verifyChain', () => {
    const sealed: Entry = { ...base(), id: 'entry_1', hash: GOLDEN_A }
    expect(verifyChain([sealed]).valid).toBe(true)

    const edited: Entry = { ...sealed, tenantId: 'someone-else' }
    expect(verifyEntry(edited)).toBe(false)
    const verdict = verifyChain([edited])
    expect(verdict.valid).toBe(false)
    expect(verdict.problems.join(' ')).toMatch(/content does not match its hash/)
  })

  it('does not let an edit to metadata or the source description break verification', () => {
    // The flip side of the exclusions: these are annotations, not evidence.
    const sealed: Entry = {
      ...base({ source: { type: 'quest', id: 'q_1', description: 'original' } }),
      id: 'entry_1',
      hash: GOLDEN_A,
    }
    expect(verifyEntry({ ...sealed, metadata: { added: 'later' } })).toBe(true)
    expect(verifyEntry({ ...sealed, source: { type: 'quest', id: 'q_1', description: 'edited' } })).toBe(
      true,
    )
  })
})
