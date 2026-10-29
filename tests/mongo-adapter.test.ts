import { describe, it, expect } from 'vitest'
import { MongoLedgerStore, post, fromDecimal, type Asset, type ProposedEntry } from '../src/index.js'
import type { Db } from 'mongodb'

/**
 * The Mongo adapter's safety edges, tested without a database.
 *
 * The conformance suite proves the adapter behaves like the reference, but it
 * only runs with `MONGO_URL` set and always passes a `{ client }`. That leaves
 * one guarantee with no test anywhere: what the adapter does when it is asked to
 * commit a transfer and was NOT given the client a transaction needs. The port
 * is explicit that a torn transfer is worse than a refused one, so the adapter
 * must refuse — and a refusal is exactly the kind of path that rots unnoticed,
 * because the happy path (a client was passed) is the one every other test
 * exercises.
 *
 * These reach only the code before any collection call, so a fake `Db` whose
 * collection is never touched is enough. They run on every machine, with no
 * infrastructure, which is the point: the safety behaviour should not depend on
 * whether this laptop has a replica set.
 */

const GOLD: Asset = {
  id: 'asset_fg',
  slug: 'flashy-gold',
  symbol: 'FG',
  decimals: 2,
  class: 'REWARD_CURRENCY',
  tenantId: 'flashy',
}

/**
 * A Db whose collection the constructor may hold, but whose methods must never
 * be CALLED — a query or write on a refusal path trips the stub itself. (The
 * constructor does take the collection handle, so the handle exists; it is any
 * read or write THROUGH it that a refusal must not perform.)
 */
function untouchedDb(): Db {
  const used = () => {
    throw new Error('the collection was used — a refusal should never reach the database')
  }
  const collectionStub = new Proxy({}, { get: () => used })
  return { collection: () => collectionStub } as unknown as Db
}

/** Two legs of a transfer, built through the domain so they are real entries. */
function transferPair(): ProposedEntry[] {
  const zero = { balance: fromDecimal(0, GOLD.decimals), headHash: null }
  const debit = post(zero, {
    tenantId: 'flashy',
    identityId: 'alice',
    asset: GOLD,
    amount: fromDecimal(-5, GOLD.decimals),
    kind: 'TRANSFER_OUT',
    source: { type: 'transfer', id: 't_1' },
    idempotencyKey: 'transfer:t_1:alice',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    allowNegative: true,
  })
  const credit = post(zero, {
    tenantId: 'flashy',
    identityId: 'bob',
    asset: GOLD,
    amount: fromDecimal(5, GOLD.decimals),
    kind: 'TRANSFER_IN',
    source: { type: 'transfer', id: 't_1' },
    idempotencyKey: 'transfer:t_1:bob',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
  })
  return [debit, credit]
}

describe('MongoLedgerStore without a client', () => {
  it('refuses a multi-entry append rather than tearing a transfer', async () => {
    // No client means no session means no atomicity. The adapter must reject the
    // batch before writing anything, not write the first leg and discover the
    // problem on the second.
    const store = new MongoLedgerStore(untouchedDb())
    await expect(store.appendAll(transferPair())).rejects.toThrow(/needs a MongoClient/)
  })

  it('names the fix in the refusal, so the caller knows to pass { client }', async () => {
    const store = new MongoLedgerStore(untouchedDb())
    await expect(store.appendAll(transferPair())).rejects.toThrow(/Pass \{ client \}/)
  })

  it('treats an empty batch as a no-op, never a session', async () => {
    // Zero entries need no transaction at all, so this must succeed with no
    // client and without reaching the collection.
    const store = new MongoLedgerStore(untouchedDb())
    expect(await store.appendAll([])).toEqual([])
  })
})
