import { describe, expect, it } from 'vitest'
import {
  InMemoryLedgerStore,
  minor,
  post,
  reverse,
  verifyChain,
  type Asset,
  type Entry,
} from '../src/index.js'

/**
 * `reverse()` is the only way to undo an entry, so what it does when it meets a
 * store is the whole of the correction story.
 *
 * Its one existing test never touches a store, which is why three mutations
 * survived the whole suite:
 *
 *  - keying the reversal like its original. The store reads a repeated key as a
 *    REPLAY of the original, returns `deduplicated: true`, and writes nothing —
 *    the correction is silently never made.
 *  - dropping `allowNegative`. A reversal is needed precisely when the credited
 *    funds have since been spent, and without the allowance it fails with
 *    INSUFFICIENT_BALANCE at exactly that moment. The conformance harness
 *    already treats REVERSAL as the one kind that may go below zero.
 *  - dropping the original's id from the source, which severs the audit link
 *    from the correction back to the mistake.
 */

const TENANT = 'flashy'
const IDENTITY = 'identity_1'
const EARNED_AT = new Date('2026-08-12T00:00:00.000Z')
const REVERSED_AT = new Date('2026-08-13T09:30:00.000Z')

const gold: Asset = {
  id: 'asset_fg',
  slug: 'flashy-gold',
  symbol: 'FG',
  decimals: 2,
  class: 'REWARD_CURRENCY',
  tenantId: TENANT,
}

const ref = { tenantId: TENANT, identityId: IDENTITY, assetId: gold.id }

async function earn(store: InMemoryLedgerStore, amount: number, key: string): Promise<Entry> {
  const state = await store.readState(ref)
  const { entry, deduplicated } = await store.append(
    post(state, {
      tenantId: TENANT,
      identityId: IDENTITY,
      asset: gold,
      amount: minor(amount),
      kind: amount >= 0 ? 'EARN' : 'SPEND',
      source: { type: 'quest', id: key },
      idempotencyKey: key,
      occurredAt: EARNED_AT,
    }),
  )
  expect(deduplicated).toBe(false)
  return entry
}

async function reverseInto(store: InMemoryLedgerStore, original: Entry, reason = 'duplicate award') {
  const state = await store.readState(ref)
  return store.append(reverse(state, original, reason, REVERSED_AT))
}

describe('reverse(): through a store', () => {
  it('lands as a new entry, not a replay of the original, and returns the balance to where it began', async () => {
    const store = new InMemoryLedgerStore()
    const original = await earn(store, 10000, 'quest:q_1')

    const { entry, deduplicated } = await reverseInto(store, original)

    expect(deduplicated).toBe(false)
    expect(entry.id).not.toBe(original.id)
    expect(store.size).toBe(2)
    expect((await store.readState(ref)).balance).toBe(0)
    expect(verifyChain(await store.readEntries(ref)).valid).toBe(true)
  })

  it('keys the reversal `reversal:<original key>`', async () => {
    const store = new InMemoryLedgerStore()
    const original = await earn(store, 10000, 'quest:q_1')

    const { entry } = await reverseInto(store, original)

    expect(entry.idempotencyKey).toBe('reversal:quest:q_1')
    expect(entry.idempotencyKey).not.toBe(original.idempotencyKey)
    expect(await store.findByIdempotencyKey(TENANT, 'reversal:quest:q_1')).toEqual(entry)
  })

  it('reverses a debit by crediting it back', async () => {
    const store = new InMemoryLedgerStore()
    await earn(store, 10000, 'quest:q_1')
    const spend = await earn(store, -4000, 'spend:s_1')
    expect((await store.readState(ref)).balance).toBe(6000)

    const { entry } = await reverseInto(store, spend, 'refund')

    expect(entry.amount).toBe(4000)
    expect(entry.kind).toBe('REVERSAL')
    expect((await store.readState(ref)).balance).toBe(10000)
  })

  it('still reverses once the credited funds have been spent, taking the balance below zero', async () => {
    const store = new InMemoryLedgerStore()
    const original = await earn(store, 10000, 'quest:q_1')
    await earn(store, -10000, 'spend:s_1')
    expect((await store.readState(ref)).balance).toBe(0)

    // Correcting an award after it was spent is the case reversal exists for.
    // It must record the debt, not refuse to.
    const { entry, deduplicated } = await reverseInto(store, original)

    expect(deduplicated).toBe(false)
    expect(entry.kind).toBe('REVERSAL')
    expect(entry.amount).toBe(-10000)
    expect(entry.balanceBefore).toBe(0)
    expect(entry.balanceAfter).toBe(-10000)
    expect((await store.readState(ref)).balance).toBe(-10000)
    expect(verifyChain(await store.readEntries(ref)).valid).toBe(true)
  })

  it('lands once when the same original is reversed twice, with state re-read each time', async () => {
    const store = new InMemoryLedgerStore()
    const original = await earn(store, 10000, 'quest:q_1')

    const first = await reverseInto(store, original)
    const second = await reverseInto(store, original, 'a second attempt, same original')

    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(second.entry.id).toBe(first.entry.id)
    expect(store.size).toBe(2)
    expect((await store.readState(ref)).balance).toBe(0)
  })
})

describe('reverse(): the entry it proposes', () => {
  it('carries the original’s tenant, identity and asset, and points its source at the original', async () => {
    const store = new InMemoryLedgerStore()
    const original = await earn(store, 10000, 'quest:q_1')

    const proposed = reverse(await store.readState(ref), original, 'duplicate award', REVERSED_AT)

    expect(proposed.tenantId).toBe(original.tenantId)
    expect(proposed.identityId).toBe(original.identityId)
    expect(proposed.assetId).toBe(original.assetId)
    expect(proposed.kind).toBe('REVERSAL')
    expect(proposed.source).toEqual({
      type: 'reversal',
      id: original.id,
      description: 'duplicate award',
    })
    expect(proposed.occurredAt).toBe(REVERSED_AT)
  })

  it('chains onto the head it was given, not onto the original', async () => {
    const store = new InMemoryLedgerStore()
    const original = await earn(store, 10000, 'quest:q_1')
    const later = await earn(store, 500, 'quest:q_2')

    const proposed = reverse(await store.readState(ref), original, 'duplicate award', REVERSED_AT)

    expect(proposed.previousHash).toBe(later.hash)
    expect(proposed.balanceBefore).toBe(10500)
    expect(proposed.balanceAfter).toBe(500)
  })
})
