import { describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { GoldLedgerReader } from '../src/index.js'

/**
 * Tenant isolation for the read-only reader.
 *
 * Invariant I-6 says every read is scoped to one tenant, and proves it by running
 * the conformance suite against every writable store. `GoldLedgerReader` is not a
 * `LedgerStore` and is excluded from that population by structure (it has no
 * `append`), so nothing runs I-6 against it — and it is the adapter pointed at
 * the live money collection. Every query it makes names a tenant, but no test
 * would notice one that stopped: `gold-ledger.test.ts` holds a single tenant, so
 * a filter without `tenantId` returns exactly the same rows.
 *
 * These cases put two tenants in one collection with the SAME customer id, the
 * SAME asset id and the SAME idempotency key — the collision I-6 was written for
 * — and ask each reader method for one of them.
 */

interface FakeDoc {
  _id: string
  publicId: string
  tenantId: string
  customerId: string
  assetId: string
  entryType: string
  amount: number
  balanceBefore: number
  balanceAfter: number
  sourceType: string
  sourceId?: string | null
  idempotencyKey: string
  createdAt: Date
}

/** Enough of the driver for the reader: equality filters, sort-by-position, limit. */
function fakeDb(entries: FakeDoc[]): Db {
  const matching = (f: Record<string, unknown>) =>
    entries.filter((e) => Object.entries(f).every(([k, v]) => (e as unknown as Record<string, unknown>)[k] === v))

  const cursor = (rows: FakeDoc[]) => ({
    sort: () => cursor(rows),
    limit: (n: number) => cursor(rows.slice(0, n)),
    toArray: async () => rows,
  })

  return {
    collection: () => ({
      findOne: async (f: Record<string, unknown>, opts?: { sort?: Record<string, number> }) => {
        const rows = matching(f)
        const newest = opts?.sort ? Object.values(opts.sort)[0] === -1 : false
        return (newest ? rows[rows.length - 1] : rows[0]) ?? null
      },
      find: (f: Record<string, unknown>) => cursor(matching(f)),
    }),
  } as unknown as Db
}

function doc(over: Partial<FakeDoc>): FakeDoc {
  return {
    _id: 'e',
    publicId: 'pub',
    tenantId: 'flashy',
    customerId: 'cust1',
    assetId: 'asset_fg',
    entryType: 'EARN_QUEST',
    amount: 10,
    balanceBefore: 0,
    balanceAfter: 10,
    sourceType: 'quest',
    idempotencyKey: 'quest:7',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  }
}

/** flashy holds 10 and acme holds 99, under identical customer, asset and key. */
const BOOKS = [
  doc({ _id: 'f1', tenantId: 'flashy', amount: 10, balanceAfter: 10 }),
  doc({ _id: 'a1', tenantId: 'acme', amount: 99, balanceAfter: 99 }),
]

const ref = (tenantId: string) => ({ tenantId, identityId: 'cust1', assetId: 'asset_fg' })

describe('GoldLedgerReader: two tenants, one customer id, one idempotency key', () => {
  const reader = new GoldLedgerReader(fakeDb(BOOKS))

  it('findByIdempotencyKey returns the asked tenant’s entry and never the other’s', async () => {
    expect((await reader.findByIdempotencyKey('flashy', 'quest:7'))?.amount).toBe(1000)
    expect((await reader.findByIdempotencyKey('acme', 'quest:7'))?.amount).toBe(9900)
  })

  it('findByIdempotencyKey reports a tenant with no such key as absent, not as another tenant’s entry', async () => {
    expect(await reader.findByIdempotencyKey('nobody', 'quest:7')).toBeNull()
  })

  it('readState reports the asked tenant’s balance, and an empty one for a stranger', async () => {
    expect((await reader.readState(ref('flashy'))).balance).toBe(1000)
    expect((await reader.readState(ref('acme'))).balance).toBe(9900)
    expect(await reader.readState(ref('nobody'))).toEqual({ balance: 0, headHash: null })
  })

  it('readEntries returns only the asked tenant’s entries, and stamps each with that tenant', async () => {
    const flashy = await reader.readEntries(ref('flashy'))
    expect(flashy.map((e) => e.amount)).toEqual([1000])
    expect(flashy.every((e) => e.tenantId === 'flashy')).toBe(true)
    expect(await reader.readEntries(ref('nobody'))).toEqual([])
  })

  it('readRecentEntries returns only the asked tenant’s entries', async () => {
    const acme = await reader.readRecentEntries(ref('acme'))
    expect(acme.map((e) => e.amount)).toEqual([9900])
    expect(acme.every((e) => e.tenantId === 'acme')).toBe(true)
  })
})

describe('GoldLedgerReader: history without an asset filter', () => {
  const reader = new GoldLedgerReader(
    fakeDb([
      doc({ _id: 'g1', assetId: 'asset_fg', amount: 10 }),
      doc({ _id: 'w1', assetId: 'asset_wht', amount: 3, idempotencyKey: 'harvest:1' }),
      doc({ _id: 'x1', tenantId: 'acme', assetId: 'asset_fg', amount: 50, idempotencyKey: 'other:1' }),
    ]),
  )

  it('returns every asset the identity holds in that tenant, and nothing from another tenant', async () => {
    const all = await reader.readEntries({ tenantId: 'flashy', identityId: 'cust1' })
    expect(all.map((e) => e.assetId).sort()).toEqual(['asset_fg', 'asset_wht'])
  })

  it('narrows to one asset when one is named', async () => {
    const one = await reader.readEntries({ tenantId: 'flashy', identityId: 'cust1', assetId: 'asset_wht' })
    expect(one.map((e) => e.assetId)).toEqual(['asset_wht'])
  })
})

describe('GoldLedgerReader.readRecentEntries: the page size', () => {
  const many = Array.from({ length: 80 }, (_, i) => doc({ _id: `e${i}`, idempotencyKey: `k${i}` }))
  const reader = new GoldLedgerReader(fakeDb(many))

  it('defaults to fifty, so an API response is bounded unless the caller asks for more', async () => {
    expect(await reader.readRecentEntries(ref('flashy'))).toHaveLength(50)
  })
})
