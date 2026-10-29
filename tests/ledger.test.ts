import { describe, expect, it } from 'vitest'
import {
  InMemoryLedgerStore,
  LedgerError,
  PrecisionError,
  add,
  assetRegistry,
  balanceOf,
  balancesByAsset,
  fromDecimal,
  isNegative,
  isTransactional,
  isZero,
  minor,
  negate,
  post,
  postTransfer,
  reverse,
  stateFrom,
  toDecimal,
  verifyChain,
  verifyEntry,
  type Asset,
  type Entry,
  type LedgerState,
  type Minor,
} from '../src/index.js'

const gold: Asset = {
  id: 'asset_fg',
  slug: 'flashy-gold',
  symbol: 'FG',
  decimals: 2,
  class: 'REWARD_CURRENCY',
  tenantId: 'flashy',
}

const wheat: Asset = {
  id: 'asset_wht',
  slug: 'wheat',
  symbol: 'WHT',
  decimals: 0,
  class: 'COMMODITY_UNIT',
  tenantId: 'flashy',
}

const AT = new Date('2026-08-12T00:00:00.000Z')
const EMPTY: LedgerState = { balance: minor(0), headHash: null }

function command(over: Partial<Parameters<typeof post>[1]> = {}) {
  return {
    tenantId: 'flashy',
    identityId: 'identity_1',
    asset: gold,
    amount: minor(2500),
    kind: 'EARN' as const,
    source: { type: 'quest', id: 'q_1' },
    idempotencyKey: 'quest:q_1',
    occurredAt: AT,
    ...over,
  }
}

describe('money', () => {
  it('parses decimals at the asset precision', () => {
    expect(fromDecimal(12.34, 2)).toBe(1234)
    expect(fromDecimal(5, 0)).toBe(5)
    expect(toDecimal(minor(1234), 2)).toBe(12.34)
  })

  it('rejects precision the asset cannot hold rather than rounding it', () => {
    // Rounding here would invent or destroy a member's value silently.
    expect(() => fromDecimal(1.234, 2)).toThrow(PrecisionError)
    expect(() => fromDecimal(0.5, 0)).toThrow(PrecisionError)
  })

  it('rejects non-finite and non-integer values', () => {
    expect(() => fromDecimal(Number.NaN, 2)).toThrow(PrecisionError)
    expect(() => fromDecimal(Number.POSITIVE_INFINITY, 2)).toThrow(PrecisionError)
    expect(() => minor(1.5)).toThrow(PrecisionError)
  })

  it('adds exactly where floating point would not', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In minor units it is exact.
    const total = add(fromDecimal(0.1, 2), fromDecimal(0.2, 2))
    expect(toDecimal(total, 2)).toBe(0.3)
  })

  it('refuses amounts beyond exact integer range', () => {
    expect(() => minor(Number.MAX_SAFE_INTEGER + 2)).toThrow(PrecisionError)
  })
})

describe('post', () => {
  it('credits and records its own movement', () => {
    const entry = post(EMPTY, command())

    expect(entry.amount).toBe(2500)
    expect(entry.balanceBefore).toBe(0)
    expect(entry.balanceAfter).toBe(2500)
    expect(entry.previousHash).toBeNull()
  })

  it('debits with a negative amount, one convention throughout', () => {
    const state: LedgerState = { balance: minor(2500), headHash: 'abc' }
    const entry = post(state, command({ amount: minor(-1000), kind: 'SPEND' }))

    expect(entry.amount).toBe(-1000)
    expect(entry.balanceAfter).toBe(1500)
    // The invariant AMS violated in 185 production rows.
    expect(Math.sign(entry.amount)).toBe(Math.sign(entry.balanceAfter - entry.balanceBefore))
  })

  it('refuses a debit past zero', () => {
    const state: LedgerState = { balance: minor(500), headHash: null }
    expect(() => post(state, command({ amount: minor(-900), kind: 'SPEND' }))).toThrow(LedgerError)
  })

  it('permits going negative only when asked', () => {
    const state: LedgerState = { balance: minor(500), headHash: null }
    const entry = post(state, command({ amount: minor(-900), kind: 'SPEND', allowNegative: true }))
    expect(entry.balanceAfter).toBe(-400)
  })

  it('refuses an entry that records nothing', () => {
    expect(() => post(EMPTY, command({ amount: minor(0) }))).toThrow(LedgerError)
  })

  it('refuses to post without an idempotency key', () => {
    expect(() => post(EMPTY, command({ idempotencyKey: '' }))).toThrow(LedgerError)
  })

  it('is pure: the same inputs always produce the same hash', () => {
    expect(post(EMPTY, command()).hash).toBe(post(EMPTY, command()).hash)
  })

  it('re-asserts the Minor brand at runtime, so a JSON body cannot hash a NaN, a fraction or a string into a chain', () => {
    // The brand only exists at compile time. These are what a JavaScript
    // caller actually hands in, and each one used to be posted: undefined
    // became a NaN balance, 0.5 a fractional holding, "500" a string
    // concatenated onto the balance.
    const state: LedgerState = { balance: minor(1000), headHash: 'abc' }
    for (const amount of [undefined, Number.NaN, 0.5, '500', -0.5] as unknown as Minor[]) {
      expect(() => post(state, command({ amount, kind: 'SPEND' }))).toThrow(PrecisionError)
    }
  })
})

describe('hash chain', () => {
  it('links each entry to the one before it', () => {
    const first = post(EMPTY, command())
    const second = post(
      { balance: first.balanceAfter, headHash: first.hash },
      command({ amount: minor(500), idempotencyKey: 'quest:q_2' }),
    )

    expect(second.previousHash).toBe(first.hash)
    expect(verifyChain(withIds([first, second])).valid).toBe(true)
  })

  it('detects an entry edited after the fact', () => {
    const entry = { ...post(EMPTY, command()), id: 'e1' }
    const tampered: Entry = { ...entry, amount: minor(999_999) }

    expect(verifyEntry(entry)).toBe(true)
    expect(verifyEntry(tampered)).toBe(false)
  })

  it('detects a removed entry by the break it leaves in the chain', () => {
    const a = post(EMPTY, command())
    const b = post({ balance: a.balanceAfter, headHash: a.hash }, command({ idempotencyKey: 'k2' }))
    const c = post({ balance: b.balanceAfter, headHash: b.hash }, command({ idempotencyKey: 'k3' }))

    // Excise the middle entry, as an attacker or a bad migration would.
    const verdict = verifyChain(withIds([a, c]))

    expect(verdict.valid).toBe(false)
    expect(verdict.problems.join(' ')).toMatch(/previousHash|opens at/)
  })
})

describe('transfers', () => {
  it('produces a matched debit and credit, never a bare balance edit', () => {
    const sender = { state: { balance: minor(1000), headHash: null }, identityId: 'a' }
    const recipient = { state: { balance: minor(0), headHash: null }, identityId: 'b' }

    const [debit, credit] = postTransfer(sender, recipient, {
      tenantId: 'flashy',
      asset: gold,
      amount: minor(250),
      source: { type: 'gift' },
      idempotencyKey: 'gift:g_1',
      occurredAt: AT,
    })

    expect(debit.amount).toBe(-250)
    expect(credit.amount).toBe(250)
    // The pair nets to zero: a transfer moves value, it does not create it.
    expect(debit.amount + credit.amount).toBe(0)
    expect(debit.idempotencyKey).not.toBe(credit.idempotencyKey)
  })

  it('refuses a transfer from an identity to itself, which would fork its chain and mint the amount', () => {
    // Both legs are posted against one state. With 100 held, a self-transfer
    // of 50 produced a debit to 50 and a credit to 150 on the same head — and
    // a store that did not refuse the fork read the balance as 150.
    const me = { state: { balance: minor(10000), headHash: 'h' }, identityId: 'a' }

    expect(() =>
      postTransfer(me, { ...me }, {
        tenantId: 'flashy',
        asset: gold,
        amount: minor(5000),
        source: { type: 'gift' },
        idempotencyKey: 'gift:self',
        occurredAt: AT,
      }),
    ).toThrow(expect.objectContaining({ code: 'SELF_TRANSFER' }))
  })

  it('re-asserts the Minor brand on a transfer amount before either leg is posted', () => {
    const sender = { state: { balance: minor(1000), headHash: null }, identityId: 'a' }
    const recipient = { state: { balance: minor(0), headHash: null }, identityId: 'b' }

    expect(() =>
      postTransfer(sender, recipient, {
        tenantId: 'flashy',
        asset: gold,
        amount: '500' as unknown as Minor,
        source: { type: 'gift' },
        idempotencyKey: 'gift:string',
        occurredAt: AT,
      }),
    ).toThrow(PrecisionError)
  })

  it('refuses a transfer the sender cannot fund', () => {
    const sender = { state: { balance: minor(100), headHash: null }, identityId: 'a' }
    const recipient = { state: { balance: minor(0), headHash: null }, identityId: 'b' }

    expect(() =>
      postTransfer(sender, recipient, {
        tenantId: 'flashy',
        asset: gold,
        amount: minor(500),
        source: { type: 'gift' },
        idempotencyKey: 'gift:g_2',
        occurredAt: AT,
      }),
    ).toThrow(LedgerError)
  })
})

describe('reversal', () => {
  it('undoes by mirroring, never by editing history', () => {
    const original: Entry = { ...post(EMPTY, command()), id: 'e1' }
    const state: LedgerState = { balance: original.balanceAfter, headHash: original.hash }

    const undo = reverse(state, original, 'duplicate award', AT)

    expect(undo.amount).toBe(-original.amount)
    expect(undo.kind).toBe('REVERSAL')
    expect(undo.balanceAfter).toBe(0)
    expect(undo.previousHash).toBe(original.hash)
  })
})

describe('balances are folds', () => {
  it('derives a balance from entries alone', () => {
    const entries = withIds([
      post(EMPTY, command()),
      post({ balance: minor(2500), headHash: 'h' }, command({ amount: minor(-500), idempotencyKey: 'k2' })),
    ])

    expect(balanceOf(entries)).toBe(2000)
    expect(stateFrom(entries).balance).toBe(2000)
  })

  it('keeps assets separate on one identity', () => {
    const goldEntry = { ...post(EMPTY, command()), id: 'e1' }
    const wheatEntry = {
      ...post(EMPTY, command({ asset: wheat, amount: minor(7), idempotencyKey: 'harvest:1' })),
      id: 'e2',
    }

    const byAsset = balancesByAsset([goldEntry, wheatEntry])

    expect(byAsset.get(gold.id)).toBe(2500)
    expect(byAsset.get(wheat.id)).toBe(7)
  })
})

describe('store conformance', () => {
  it('appends and reads back state', async () => {
    const store = new InMemoryLedgerStore()
    const state = await store.readState({ tenantId: 'flashy', identityId: 'identity_1', assetId: gold.id })

    const { deduplicated } = await store.append(post(state, command()))

    expect(deduplicated).toBe(false)
    expect((await store.readState({ tenantId: 'flashy', identityId: 'identity_1', assetId: gold.id })).balance).toBe(2500)
  })

  it('returns the original entry when a key is replayed', async () => {
    const store = new InMemoryLedgerStore()
    const entry = post(EMPTY, command())

    const first = await store.append(entry)
    const second = await store.append(entry)

    expect(second.deduplicated).toBe(true)
    expect(second.entry.id).toBe(first.entry.id)
    expect(store.size).toBe(1)
  })

  it('commits both legs of a transfer or neither', async () => {
    const store = new InMemoryLedgerStore()
    await store.append(post(EMPTY, command({ identityId: 'a' })))

    const [debit, credit] = postTransfer(
      { state: await store.readState({ tenantId: 'flashy', identityId: 'a', assetId: gold.id }), identityId: 'a' },
      { state: await store.readState({ tenantId: 'flashy', identityId: 'b', assetId: gold.id }), identityId: 'b' },
      {
        tenantId: 'flashy',
        asset: gold,
        amount: minor(1000),
        source: { type: 'gift' },
        idempotencyKey: 'gift:g_3',
        occurredAt: AT,
      },
    )
    await store.appendAll([debit, credit])

    expect((await store.readState({ tenantId: 'flashy', identityId: 'a', assetId: gold.id })).balance).toBe(1500)
    expect((await store.readState({ tenantId: 'flashy', identityId: 'b', assetId: gold.id })).balance).toBe(1000)
  })

  it('keeps a verifiable chain across many appends', async () => {
    const store = new InMemoryLedgerStore()

    for (let i = 0; i < 25; i++) {
      const state = await store.readState({ tenantId: 'flashy', identityId: 'identity_1', assetId: gold.id })
      await store.append(post(state, command({ amount: minor(100), idempotencyKey: `k${i}` })))
    }

    const entries = await store.readEntries({ tenantId: 'flashy', identityId: 'identity_1', assetId: gold.id })
    expect(entries).toHaveLength(25)
    expect(balanceOf(entries)).toBe(2500)
    expect(verifyChain(entries).valid).toBe(true)
  })
})

/** Attach ids the way a store would, so chain helpers can be exercised. */
function withIds(entries: readonly Omit<Entry, 'id'>[]): Entry[] {
  return entries.map((e, i) => ({ ...e, id: `e${i + 1}` }))
}

describe('supporting surface', () => {
  it('indexes an asset registry by id', () => {
    const registry = assetRegistry([gold, wheat])
    expect(registry.get(gold.id)?.symbol).toBe('FG')
    expect(registry.get(wheat.id)?.decimals).toBe(0)
    expect(registry.get('missing')).toBeUndefined()
  })

  it('identifies a store that can commit atomically', () => {
    expect(isTransactional(new InMemoryLedgerStore())).toBe(true)
    const readOnly = {
      append: async () => { throw new Error('no') },
      readState: async () => EMPTY,
      readEntries: async () => [],
      findByIdempotencyKey: async () => null,
    }
    expect(isTransactional(readOnly)).toBe(false)
  })

  it('negates and classifies amounts', () => {
    expect(negate(minor(250))).toBe(-250)
    expect(negate(minor(-250))).toBe(250)
    expect(isNegative(minor(-1))).toBe(true)
    expect(isNegative(minor(0))).toBe(false)
    expect(isZero(minor(0))).toBe(true)
  })

  it('refuses a sum beyond exact integer range', () => {
    expect(() => add(minor(Number.MAX_SAFE_INTEGER), minor(Number.MAX_SAFE_INTEGER))).toThrow(
      PrecisionError,
    )
  })

  it('treats an identity with no history as empty', () => {
    expect(stateFrom([])).toEqual({ balance: 0, headHash: null })
    expect(balanceOf([])).toBe(0)
  })

  it('reads every asset for an identity when none is named', async () => {
    const store = new InMemoryLedgerStore()
    await store.append(post(EMPTY, command()))
    await store.append(post(EMPTY, command({ asset: wheat, amount: minor(3), idempotencyKey: 'w1' })))

    expect(await store.readEntries({ tenantId: 'flashy', identityId: 'identity_1' })).toHaveLength(2)
    expect(await store.readEntries({ tenantId: 'flashy', identityId: 'identity_1', assetId: wheat.id })).toHaveLength(1)
  })

  it('finds an entry by idempotency key, or reports none', async () => {
    const store = new InMemoryLedgerStore()
    await store.append(post(EMPTY, command()))

    expect(await store.findByIdempotencyKey('flashy', 'quest:q_1')).not.toBeNull()
    expect(await store.findByIdempotencyKey('flashy', 'never-posted')).toBeNull()
  })

  it('reports an entry whose amount contradicts its own balances', () => {
    const sound = { ...post(EMPTY, command()), id: 'e1' }
    // Rewrite the closing balance without touching the amount.
    const unsound: Entry = { ...sound, balanceAfter: minor(9999) }

    const verdict = verifyChain([unsound])
    expect(verdict.valid).toBe(false)
    expect(verdict.problems.join(' ')).toMatch(/does not account for/)
  })
})
