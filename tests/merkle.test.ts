import { describe, it, expect } from 'vitest'
import {
  canonical,
  commit,
  inclusionProof,
  leafHash,
  merkleRoot,
  nodeHash,
  sha256Hex,
  sortEntries,
  toHex,
  toJsonl,
  verifyInclusion,
  type SnapshotEntry,
} from '../src/domain/merkle.js'

/**
 * The tree is a published specification, so these tests are less about catching
 * regressions than about pinning the properties a reader is being invited to
 * rely on. Each one corresponds to a way proof-of-reserves schemes have actually
 * been broken.
 */


/** Narrow a nullable, failing the test rather than asserting silently. */
function must<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull()
  expect(value).not.toBeUndefined()
  return value as T
}

interface JsonlRow { id: string; amount_minor: string }
function parseRow(line: string): JsonlRow {
  return JSON.parse(line) as JsonlRow
}

function entry(id: string, amountMinor = '1000'): SnapshotEntry {
  return {
    id,
    asset: 'FG',
    type: 'issuance',
    source: 'quest_completion',
    amountMinor,
    recordedAt: '2026-08-14T03:41:00Z',
  }
}

describe('canonical encoding', () => {
  it('is stable, pipe-joined, and contains every field that matters', () => {
    expect(canonical(entry('gl_1', '12500'))).toBe(
      'gl_1|FG|issuance|quest_completion|12500|2026-08-14T03:41:00Z',
    )
  })

  it('changes when any field changes — no silent collisions', () => {
    const base = canonical(entry('gl_1', '1000'))
    expect(canonical(entry('gl_1', '1001'))).not.toBe(base)
    expect(canonical(entry('gl_2', '1000'))).not.toBe(base)
  })
})

describe('the root', () => {
  it('is deterministic regardless of input order', () => {
    const a = [entry('gl_3'), entry('gl_1'), entry('gl_2')]
    const b = [entry('gl_1'), entry('gl_2'), entry('gl_3')]
    expect(merkleRoot(a)).toBe(merkleRoot(b))
  })

  it('has no root over an empty set', () => {
    // A zero hash here would be a publishable-looking commitment to nothing.
    expect(merkleRoot([])).toBeNull()
  })

  it('changes if a single minor unit changes', () => {
    const before = merkleRoot([entry('gl_1', '1000'), entry('gl_2')])
    const after = merkleRoot([entry('gl_1', '1001'), entry('gl_2')])
    expect(after).not.toBe(before)
  })

  it('separates leaf and node domains', () => {
    // Without the 0x00/0x01 prefixes an internal node digest could be presented
    // as a leaf, forging inclusion for an entry that was never in the tree.
    const l = leafHash(entry('gl_1'))
    const n = nodeHash(l, l)
    expect(toHex(l)).not.toBe(toHex(n))
  })

  it('does not duplicate odd nodes (CVE-2012-2459 shape)', () => {
    // If the last node were duplicated to pad the level, a 3-leaf tree and a
    // 4-leaf tree whose last leaf repeats would collide.
    const three = merkleRoot([entry('gl_1'), entry('gl_2'), entry('gl_3')])
    const padded = merkleRoot([entry('gl_1'), entry('gl_2'), entry('gl_3'), entry('gl_3')])
    expect(three).not.toBe(padded)
  })

  it('handles 1 through 9 leaves without losing an entry', () => {
    for (let n = 1; n <= 9; n++) {
      const set = Array.from({ length: n }, (_, i) => entry(`gl_${i}`))
      const root = merkleRoot(set)
      expect(root, `${n} leaves`).toBeTruthy()
      for (const e of set) {
        const p = inclusionProof(set, e.id)
        expect(p, `${n} leaves, ${e.id}`).not.toBeNull()
        expect(verifyInclusion(e, must(p).path, must(root)), `${n} leaves, ${e.id}`).toBe(true)
      }
    }
  })
})

describe('inclusion proofs', () => {
  const set = [entry('gl_1'), entry('gl_2'), entry('gl_3'), entry('gl_4'), entry('gl_5')]
  const root = must(merkleRoot(set))

  it('verifies for every entry in the set', () => {
    for (const e of set) {
      const p = must(inclusionProof(set, e.id))
      expect(verifyInclusion(e, p.path, root)).toBe(true)
    }
  })

  it('returns null for an entry that is not in the set', () => {
    expect(inclusionProof(set, 'gl_absent')).toBeNull()
  })

  it('fails when the entry is altered', () => {
    const p = must(inclusionProof(set, 'gl_3'))
    const tampered = { ...entry('gl_3'), amountMinor: '999999' }
    expect(verifyInclusion(tampered, p.path, root)).toBe(false)
  })

  it('fails when the path is altered', () => {
    const p = must(inclusionProof(set, 'gl_3'))
    const tampered = p.path.map((s, i) =>
      i === 0 ? { ...s, sibling: toHex(leafHash(entry('gl_evil'))) } : s,
    )
    expect(verifyInclusion(entry('gl_3'), tampered, root)).toBe(false)
  })

  it('fails against a different root', () => {
    const p = must(inclusionProof(set, 'gl_3'))
    const otherRoot = must(merkleRoot([entry('gl_9')]))
    expect(verifyInclusion(entry('gl_3'), p.path, otherRoot)).toBe(false)
  })

  it('a proof from one set does not verify against another set’s root', () => {
    const p = must(inclusionProof(set, 'gl_3'))
    const bigger = must(merkleRoot([...set, entry('gl_6')]))
    expect(verifyInclusion(entry('gl_3'), p.path, bigger)).toBe(false)
  })
})

describe('the jsonl dataset', () => {
  it('is sorted, newline-terminated, one object per line', () => {
    const text = toJsonl([entry('gl_2'), entry('gl_1')])
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(parseRow(must(lines[0])).id).toBe('gl_1')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('publishes amounts as minor-unit strings, never formatted numbers', () => {
    const row = parseRow(toJsonl([entry('gl_1', '12500')]).trim())
    expect(row.amount_minor).toBe('12500')
    expect(typeof row.amount_minor).toBe('string')
  })
})


/**
 * Pinned vectors.
 *
 * The four spec suites above prove properties; these prove BYTES. If any of
 * them fails, the encoding changed — and every root ever published under the
 * old encoding stops verifying. There is no valid reason for these to move,
 * ever; a failure here is a breaking change to a published format, whatever
 * the changelog says.
 */
describe('pinned vectors', () => {
  const vec = (id: string, amountMinor = '1000'): SnapshotEntry => ({
    id,
    asset: 'flashy-gold',
    type: 'EARN',
    source: 'quest',
    amountMinor,
    recordedAt: '2026-08-27T00:00:00Z',
  })

  it('canonical encoding, byte for byte', () => {
    expect(canonical(vec('a'))).toBe('a|flashy-gold|EARN|quest|1000|2026-08-27T00:00:00Z')
  })

  it('the leaf digest', () => {
    expect(toHex(leafHash(vec('a')))).toBe(
      '0x7886bec3a662ecacad0a7b5ca85a612f01878f76c14187db6b9a00931cd1ddd2',
    )
  })

  it('the root over three entries, given unsorted', () => {
    expect(merkleRoot([vec('b', '-250'), vec('a'), vec('c', '12345')])).toBe(
      '0x713045ac438688b5f4ddce8a36ae087754c2d5d5d199453649ac80248357dc7f',
    )
  })
})

describe('sortEntries, commit and sha256Hex', () => {
  it('sortEntries is ascending and does not mutate its input', () => {
    const input = [entry('b'), entry('a')]
    const sorted = sortEntries(input)
    expect(sorted.map((e) => e.id)).toEqual(['a', 'b'])
    expect(input.map((e) => e.id)).toEqual(['b', 'a'])
  })

  // schema/snapshot-entry.json states this order to a reader rebuilding the root
  // in another language, so what it says is pinned here rather than inherited from
  // a comment. `<` compares UTF-16 code units. That is the order of the ids' UTF-8
  // bytes for ids at or below U+FFFF, and not for an id from U+10000 up set against
  // one from U+E000 to U+FFFF — the header of merkle.ts and the 0.8.0 changelog say
  // "byte-wise", which is only true of the first group. Changing this order changes
  // every root a producer has published: a format change, not a fix.
  describe('the order is UTF-16 code units, which is not the order of the UTF-8 bytes', () => {
    const supplementary = '\u{10000}' // UTF-8 f0 90 80 80, UTF-16 d800 dc00
    const bmp = '�' //            UTF-8 ef bf bd,     UTF-16 fffd
    const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8')

    it('puts U+10000 before U+FFFD, the reverse of their bytes', () => {
      expect(utf8(supplementary).toString('hex')).toBe('f0908080')
      expect(utf8(bmp).toString('hex')).toBe('efbfbd')
      expect(Buffer.compare(utf8(supplementary), utf8(bmp))).toBe(1)

      const forward = sortEntries([entry(bmp), entry(supplementary)]).map((e) => e.id)
      const backward = sortEntries([entry(supplementary), entry(bmp)]).map((e) => e.id)
      expect(forward).toEqual([supplementary, bmp])
      expect(backward).toEqual([supplementary, bmp])
    })

    it('carries into the snapshot file and the root, pinned from a hashlib computation', () => {
      const set = [entry(bmp), entry(supplementary)]
      expect(toJsonl(set).trimEnd().split('\n').map((line) => parseRow(line).id)).toEqual([
        supplementary,
        bmp,
      ])
      // SHA256(0x01 || leaf(U+10000 row) || leaf(U+FFFD row)), both rows
      // FG|issuance|quest_completion|1000|2026-08-14T03:41:00Z, computed with
      // Python hashlib outside this codebase. The byte-wise order would give
      // 0x37a98208f7d8d3d334ac199640b04b0f26c27bbe3274130adc6a301f0b32ab14.
      expect(merkleRoot(set)).toBe(
        '0x80c879251a7dc775c78ddbd1ef96d6d052af5d42e235f6b0a20de35797c1bc41',
      )
      expect(merkleRoot([...set].reverse())).toBe(merkleRoot(set))
    })

    it('agrees with the byte order for ids at or below U+FFFF, ASCII included', () => {
      const ids = ['gl_10', 'gl_2', 'GL_1', '', 'é', '߿', 'ࠀ', '', bmp, '￿', 'z']
      const byBytes = [...ids].sort((a, b) => Buffer.compare(utf8(a), utf8(b)))
      expect(sortEntries(ids.map((id) => entry(id))).map((e) => e.id)).toEqual(byBytes)
    })
  })

  it('commit carries the outstanding total and the dataset digest', () => {
    const set = [entry('gl_1', '1000'), entry('gl_2', '-250')]
    const c = must(commit(set, '2026-08-27', 'flashy-gold'))
    expect(c.entryCount).toBe(2)
    expect(c.outstandingMinor).toBe('750')
    expect(c.datasetSha256).toBe(sha256Hex(toJsonl(set)))
    expect(c.root).toBe(must(merkleRoot(set)))
  })

  it('commit over an empty day is null, never a commitment to nothing', () => {
    expect(commit([], '2026-08-27', 'flashy-gold')).toBeNull()
  })
})
