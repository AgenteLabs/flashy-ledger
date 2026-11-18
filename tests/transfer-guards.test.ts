import { describe, expect, it } from 'vitest'
import {
  InMemoryLedgerStore,
  LedgerError,
  minor,
  post,
  postTransfer,
  type Asset,
  type LedgerState,
  type TransferParty,
} from '../src/index.js'

/**
 * The guards on `postTransfer`, and the exact strings its legs are keyed by.
 *
 * A transfer is the one command that touches two identities, so it is the one
 * place a sign error moves value OUT of somebody who never asked. Before this
 * file, deleting the negative-amount guard left the whole suite green: with a
 * negative amount the "debit" leg became a credit to the sender and the
 * "credit" leg debited the recipient, who had consented to nothing. Nothing
 * sent a negative transfer, so nothing noticed.
 *
 * The leg keys are asserted as exact strings rather than `not.toBe`: replay
 * safety and every downstream consumer depend on `:out` and `:in` being what
 * they are, and a rename is a silent break for anything that already stored a
 * key.
 */

const TENANT = 'flashy'
const AT = new Date('2026-08-12T00:00:00.000Z')

const gold: Asset = {
  id: 'asset_fg',
  slug: 'flashy-gold',
  symbol: 'FG',
  decimals: 2,
  class: 'REWARD_CURRENCY',
  tenantId: TENANT,
}

const EMPTY: LedgerState = { balance: minor(0), headHash: null }

function party(identityId: string, balance: number, headHash: string | null = null): TransferParty {
  return { identityId, state: { balance: minor(balance), headHash } }
}

function transferCommand(over: Partial<Parameters<typeof postTransfer>[2]> = {}) {
  return {
    tenantId: TENANT,
    asset: gold,
    amount: minor(250),
    source: { type: 'gift' },
    idempotencyKey: 'gift:g_1',
    occurredAt: AT,
    ...over,
  }
}

/** Run a transfer that must be refused, and hand back what it threw. */
function refusal(from: TransferParty, to: TransferParty, over: Parameters<typeof transferCommand>[0]) {
  try {
    postTransfer(from, to, transferCommand(over))
  } catch (err) {
    return err
  }
  throw new Error('expected the transfer to be refused, but it returned legs')
}

async function stateOf(store: InMemoryLedgerStore, identityId: string): Promise<LedgerState> {
  return store.readState({ tenantId: TENANT, identityId, assetId: gold.id })
}

describe('postTransfer: the amount guard', () => {
  it('refuses a negative amount, which would debit a recipient who never consented', () => {
    // Both parties hold funds, so the only thing standing between this call and
    // a pair of legs is the guard itself. Without it the "debit" leg credits
    // the sender and the "credit" leg takes 250 from the recipient.
    const err = refusal(party('alice', 1000), party('bob', 1000), { amount: minor(-250) })

    expect(err).toBeInstanceOf(LedgerError)
    // The code the guard raises today. The message talks about zero, which is
    // misleading for a negative amount; the code is what a caller switches on.
    expect(err).toHaveProperty('code', 'ZERO_AMOUNT')
  })

  it('refuses a negative amount whatever the recipient holds, and never returns a leg', () => {
    for (const recipientBalance of [0, 1000]) {
      let legs: unknown
      let thrown: unknown
      try {
        legs = postTransfer(party('alice', 1000), party('bob', recipientBalance), transferCommand({ amount: minor(-1) }))
      } catch (err) {
        thrown = err
      }
      expect(legs, `recipient holding ${recipientBalance}`).toBeUndefined()
      expect(thrown, `recipient holding ${recipientBalance}`).toHaveProperty('code', 'ZERO_AMOUNT')
    }
  })

  it('refuses a zero amount', () => {
    const err = refusal(party('alice', 1000), party('bob', 0), { amount: minor(0) })

    expect(err).toBeInstanceOf(LedgerError)
    expect(err).toHaveProperty('code', 'ZERO_AMOUNT')
  })

  it('accepts the smallest positive amount, so the guard is not wider than it claims', () => {
    const [debit, credit] = postTransfer(party('alice', 1), party('bob', 0), transferCommand({ amount: minor(1) }))

    expect(debit.amount).toBe(-1)
    expect(credit.amount).toBe(1)
  })
})

describe('postTransfer: self transfer', () => {
  it('is refused with SELF_TRANSFER before any leg is built', () => {
    // A balance of zero means that if the guard did not fire first, building
    // the debit leg would throw INSUFFICIENT_BALANCE instead. Seeing
    // SELF_TRANSFER therefore shows the refusal comes before either leg.
    const me = party('alice', 0)
    const err = refusal(me, { ...me }, { amount: minor(5000), idempotencyKey: 'gift:self' })

    expect(err).toBeInstanceOf(LedgerError)
    expect(err).toHaveProperty('code', 'SELF_TRANSFER')
  })

  it('is refused for a funded identity too, and names the identity', () => {
    const me = party('alice', 10000, 'head')
    const err = refusal(me, { ...me }, { amount: minor(5000) })

    expect(err).toHaveProperty('code', 'SELF_TRANSFER')
    expect((err as LedgerError).message).toContain('alice')
  })
})

describe('postTransfer: the legs', () => {
  it('keys the legs exactly `<key>:out` and `<key>:in`, debit first', () => {
    const legs = postTransfer(
      party('alice', 1000),
      party('bob', 0),
      transferCommand({ idempotencyKey: 'gift:g_77' }),
    )

    expect(legs).toHaveLength(2)
    const [debit, credit] = legs
    expect(debit.idempotencyKey).toBe('gift:g_77:out')
    expect(debit.identityId).toBe('alice')
    expect(debit.kind).toBe('TRANSFER_OUT')
    expect(debit.amount).toBe(-250)

    expect(credit.idempotencyKey).toBe('gift:g_77:in')
    expect(credit.identityId).toBe('bob')
    expect(credit.kind).toBe('TRANSFER_IN')
    expect(credit.amount).toBe(250)
  })

  it('builds each leg on its own party, from that party’s balance and chain head', () => {
    const [debit, credit] = postTransfer(
      party('alice', 1000, 'alice-head'),
      party('bob', 40, 'bob-head'),
      transferCommand(),
    )

    expect(debit.previousHash).toBe('alice-head')
    expect(debit.balanceBefore).toBe(1000)
    expect(debit.balanceAfter).toBe(750)

    expect(credit.previousHash).toBe('bob-head')
    expect(credit.balanceBefore).toBe(40)
    expect(credit.balanceAfter).toBe(290)
  })
})

describe('postTransfer: replay through a store', () => {
  it('returns both legs deduplicated and leaves both balances unchanged', async () => {
    const store = new InMemoryLedgerStore()
    await store.append(
      post(EMPTY, {
        tenantId: TENANT,
        identityId: 'alice',
        asset: gold,
        amount: minor(1000),
        kind: 'EARN',
        source: { type: 'quest', id: 'q_1' },
        idempotencyKey: 'quest:q_1',
        occurredAt: AT,
      }),
    )

    const transfer = async () =>
      postTransfer(
        { identityId: 'alice', state: await stateOf(store, 'alice') },
        { identityId: 'bob', state: await stateOf(store, 'bob') },
        transferCommand({ idempotencyKey: 'gift:g_9' }),
      )

    const first = await store.appendAll(await transfer())
    expect(first.map((r) => r.deduplicated)).toEqual([false, false])
    expect((await stateOf(store, 'alice')).balance).toBe(750)
    expect((await stateOf(store, 'bob')).balance).toBe(250)
    const sizeAfterFirst = store.size

    // Retry the same transfer with state re-read AFTER the first one landed, so
    // the replay is built on the new heads — the realistic shape of a retry.
    const replay = await store.appendAll(await transfer())

    expect(replay).toHaveLength(2)
    expect(replay.map((r) => r.deduplicated)).toEqual([true, true])
    expect(replay.map((r) => r.entry.id)).toEqual(first.map((r) => r.entry.id))
    expect(replay.map((r) => r.entry.idempotencyKey)).toEqual(['gift:g_9:out', 'gift:g_9:in'])

    expect(store.size).toBe(sizeAfterFirst)
    expect((await stateOf(store, 'alice')).balance).toBe(750)
    expect((await stateOf(store, 'bob')).balance).toBe(250)
  })
})
