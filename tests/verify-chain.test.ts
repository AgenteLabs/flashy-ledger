import { describe, expect, it } from 'vitest'
import { hashEntry, minor, verifyChain, type Entry, type HashableEntry } from '../src/index.js'

/**
 * `verifyChain()` is what an auditor runs, and it makes five separate claims.
 *
 * Every existing test that reaches it either hands it a sound chain or breaks
 * it in a way that trips two rules at once, and asserts the verdict with a
 * pattern that either rule satisfies (`/previousHash|opens at/`). Deleting the
 * previous-hash link check, or the balance-continuity check, or the rule that a
 * chain must start from nothing, therefore left the suite green: the auditor's
 * tool silently stopped looking for that failure.
 *
 * So each case here breaks exactly ONE rule. Entries are re-sealed with
 * `hashEntry()` after the fault is introduced, which keeps the content hash
 * honest and means the only thing wrong with the chain is the thing under test.
 * Each case asserts the complete list of problems, not a pattern.
 */

const AT = new Date('2026-08-12T00:00:00.000Z')

/** The id and hash a store would give an entry, over a base that is sound. */
function seal(id: string, over: Partial<HashableEntry>): Entry {
  const hashable: HashableEntry = {
    tenantId: 'flashy',
    identityId: 'identity_1',
    assetId: 'asset_fg',
    amount: minor(100),
    balanceBefore: minor(0),
    balanceAfter: minor(100),
    kind: 'EARN',
    source: { type: 'quest', id },
    idempotencyKey: `quest:${id}`,
    occurredAt: AT,
    previousHash: null,
    ...over,
  }
  return { ...hashable, id, hash: hashEntry(hashable) }
}

/** Three entries, 0 -> 100 -> 200 -> 300, each chained onto the last. */
function soundChain(): [Entry, Entry, Entry] {
  const e1 = seal('e1', {})
  const e2 = seal('e2', { balanceBefore: minor(100), balanceAfter: minor(200), previousHash: e1.hash })
  const e3 = seal('e3', { balanceBefore: minor(200), balanceAfter: minor(300), previousHash: e2.hash })
  return [e1, e2, e3]
}

describe('verifyChain: a sound chain', () => {
  it('is valid, with no problems listed', () => {
    expect(verifyChain(soundChain())).toEqual({ valid: true, problems: [] })
  })

  it('treats an identity with no history as valid rather than as a failure', () => {
    expect(verifyChain([])).toEqual({ valid: true, problems: [] })
  })
})

describe('verifyChain: each rule on its own', () => {
  it('content: an edit to a hashed field that was not re-sealed is the only problem reported', () => {
    const [e1, e2, e3] = soundChain()
    // idempotencyKey is hashed but takes no part in the balance arithmetic, so
    // this fault cannot trip any other rule. The stored hash is left in place,
    // which is what keeps e3's link to e2 intact.
    const edited: Entry = { ...e2, idempotencyKey: 'quest:forged' }

    expect(verifyChain([e1, edited, e3]).problems).toEqual(['e2: content does not match its hash'])
  })

  it('link: an entry that does not chain onto its predecessor is the only problem reported', () => {
    const [e1, e2] = soundChain()
    // e3 is re-sealed pointing at e1, skipping e2. Its balances still open where
    // e2 closed, so the link is the one thing wrong.
    const skipped = seal('e3', { balanceBefore: minor(200), balanceAfter: minor(300), previousHash: e1.hash })

    expect(verifyChain([e1, e2, skipped]).problems).toEqual([`e3: previousHash does not follow ${e2.hash}`])
  })

  it('continuity: an entry that opens at a different balance than its predecessor closed at is the only problem reported', () => {
    const [e1, e2] = soundChain()
    // Correctly linked and internally consistent (250 + 100 = 350), but 50 minor
    // units appeared between e2 closing at 200 and e3 opening at 250.
    const gap = seal('e3', { balanceBefore: minor(250), balanceAfter: minor(350), previousHash: e2.hash })

    expect(verifyChain([e1, e2, gap]).problems).toEqual([
      'e3: opens at 250 but the previous entry closed at 200',
    ])
  })

  it('start: a chain whose first entry names a predecessor has lost its beginning', () => {
    const [, e2, e3] = soundChain()
    // History trimmed from the front: e2 still carries the hash of an entry that
    // is no longer here. There is no previous entry to compare balances with, so
    // the previous-hash rule is the only thing that can notice.
    expect(verifyChain([e2, e3]).problems).toEqual(['e2: previousHash does not follow the start of the chain'])
  })

  it('arithmetic: an entry whose amount does not account for its own movement is the only problem reported', () => {
    const [e1, e2] = soundChain()
    // Re-sealed so the hash is honest: 200 + 100 is not 350.
    const unsound = seal('e3', { balanceBefore: minor(200), balanceAfter: minor(350), previousHash: e2.hash })

    expect(verifyChain([e1, e2, unsound]).problems).toEqual([
      'e3: amount does not account for its own balance movement',
    ])
  })
})

describe('verifyChain: what it reports', () => {
  it('lists every fault, in chain order, rather than stopping at the first', () => {
    const [e1, e2] = soundChain()
    const editedSecond: Entry = { ...e2, idempotencyKey: 'quest:forged' }
    const gapThird = seal('e3', { balanceBefore: minor(250), balanceAfter: minor(350), previousHash: e2.hash })

    expect(verifyChain([e1, editedSecond, gapThird]).problems).toEqual([
      'e2: content does not match its hash',
      'e3: opens at 250 but the previous entry closed at 200',
    ])
  })

  it('refuses a chain presented out of order, and names the entry that no longer follows', () => {
    const [e1, e2, e3] = soundChain()
    const verdict = verifyChain([e1, e3, e2])

    expect(verdict.valid).toBe(false)
    expect(verdict.problems.some((p) => p.startsWith('e3: previousHash does not follow'))).toBe(true)
  })
})
