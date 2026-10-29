import { describe, expect, it } from 'vitest'
import { interleave, property, expectViolation, type Rng, type Settled } from '../vendor-invariants.mjs'
import {
  InMemoryLedgerStore,
  balanceOf,
  fromDecimal,
  post,
  postTransfer,
  reverse,
  verifyChain,
  type AccountRef,
  type AppendResult,
  type Asset,
  type Entry,
  type HistoryRef,
  type LedgerState,
  type LedgerStore,
  type ProposedEntry,
  type TransactionalLedgerStore,
} from '../src/index.js'

/**
 * invariants/1 over the ledger: the guarantees in docs/INVARIANTS.md that are
 * about PAIRS of writes, run under every schedule the vendored harness knows
 * and under random command sequences, with the pre-fix reference store handed
 * to the harness so a green run means the harness can see.
 *
 * `conformance.test.ts` proves one-head and idempotency once each, in the
 * order the test chose. The defect this file exists for (I-9) was two appends
 * that both read the same head and both landed — a guarantee production had by
 * unique index and the executable specification did not. The question asked
 * after every schedule and every command is the same: does the stored state
 * equal the fold over the entries, does the chain verify, and is any balance
 * below zero that nothing allowed to be.
 */

const GOLD: Asset = { id: 'asset_fg', slug: 'flashy-gold', symbol: 'FG', decimals: 2, class: 'REWARD_CURRENCY', tenantId: 'flashy' }
const AT = new Date('2026-08-13T12:00:00Z')
const TENANT = 'flashy'
const ref = (identityId: string): AccountRef => ({ tenantId: TENANT, identityId, assetId: GOLD.id })

const command = (identityId: string, amount: number, key: string, allowNegative = false) => ({
  tenantId: TENANT,
  identityId,
  asset: GOLD,
  amount: fromDecimal(amount, GOLD.decimals),
  kind: amount < 0 ? ('SPEND' as const) : ('EARN' as const),
  source: { type: 'test' },
  idempotencyKey: key,
  occurredAt: AT,
  allowNegative,
})

/** Read state, post, append — the one path every write takes, as a caller takes it. */
async function write(store: LedgerStore, identityId: string, amount: number, key: string): Promise<AppendResult> {
  const state = await store.readState(ref(identityId))
  return store.append(post(state, command(identityId, amount, key)))
}

/** The checks every schedule and every run ends with: one identity's books. */
async function booksHold(store: LedgerStore, ids: readonly string[]): Promise<string[]> {
  const problems: string[] = []
  for (const id of ids) {
    const entries = await store.readEntries(ref(id))
    const state = await store.readState(ref(id))
    const fold = balanceOf(entries)
    if (state.balance !== fold) problems.push(`${id}: stored balance ${state.balance} is not the fold ${fold}`)
    const head = entries.at(-1)
    if ((head?.hash ?? null) !== state.headHash) problems.push(`${id}: stored head is not the last entry`)
    const verdict = verifyChain(entries)
    if (!verdict.valid) problems.push(`${id}: chain ${verdict.problems.join('; ')}`)
    for (const e of entries) {
      if (e.balanceAfter < 0 && e.kind !== 'REVERSAL') problems.push(`${id}: ${e.idempotencyKey} left the balance at ${e.balanceAfter} and nothing allowed negative`)
    }
  }
  return problems
}

const settledCount = (results: Settled[]): number =>
  results.filter((r) => r.ok && !(r.value as AppendResult).deduplicated).length

/**
 * The store the executable specification WAS before 1.0.x: dedup by key, no
 * notion of a chain head, so two appends that both read the same head both
 * land. `dedup: false` forgets the key index too, the shape of a store that
 * never built its unique index. A test fixture, not a port implementation
 * anybody should copy.
 */
class PreFixMemoryStore implements TransactionalLedgerStore {
  private readonly entries: Entry[] = []
  private readonly byKey = new Map<string, Entry>()
  private sequence = 0
  constructor(private readonly dedup = true) {}

  async append(proposed: ProposedEntry): Promise<AppendResult> {
    const [result] = await this.appendAll([proposed])
    if (!result) throw new Error('no result')
    return result
  }
  appendAll(proposed: readonly ProposedEntry[]): Promise<readonly AppendResult[]> {
    const results: AppendResult[] = []
    for (const candidate of proposed) {
      const key = `${candidate.tenantId}\u0000${candidate.idempotencyKey}`
      const existing = this.dedup ? this.byKey.get(key) : undefined
      if (existing) { results.push({ entry: existing, deduplicated: true }); continue }
      const entry: Entry = { ...candidate, id: `entry_${++this.sequence}` }
      this.entries.push(entry)
      this.byKey.set(key, entry)
      results.push({ entry, deduplicated: false })
    }
    return Promise.resolve(results)
  }
  readState({ tenantId, identityId, assetId }: AccountRef): Promise<LedgerState> {
    const head = this.entries.filter((e) => e.tenantId === tenantId && e.identityId === identityId && e.assetId === assetId).at(-1)
    return Promise.resolve({ balance: head?.balanceAfter ?? fromDecimal(0, 0), headHash: head?.hash ?? null })
  }
  readEntries({ tenantId, identityId, assetId }: HistoryRef): Promise<readonly Entry[]> {
    return Promise.resolve(this.entries.filter((e) => e.tenantId === tenantId && e.identityId === identityId && (assetId === undefined || e.assetId === assetId)))
  }
  findByIdempotencyKey(tenantId: string, key: string): Promise<Entry | null> {
    return Promise.resolve(this.byKey.get(`${tenantId}\u0000${key}`) ?? null)
  }
}

// ── I-6 / I-9 · one head per chain, under every schedule ────────────────────

const ID = 'id_race'
async function funded(store: TransactionalLedgerStore): Promise<TransactionalLedgerStore> {
  await write(store, ID, 100, `${ID}:fund`)
  return store
}
const headOps = [
  { name: 'debitAll_a', run: (store: LedgerStore) => write(store, ID, -100, `${ID}:a`) },
  { name: 'debitAll_b', run: (store: LedgerStore) => write(store, ID, -100, `${ID}:b`) },
  { name: 'credit', run: (store: LedgerStore) => write(store, ID, 10, `${ID}:c`) },
]
async function oneHead(store: LedgerStore, { results }: { results: Settled[] }): Promise<string[]> {
  const problems = await booksHold(store, [ID])
  const entries = await store.readEntries(ref(ID))
  const debits = entries.filter((e) => e.kind === 'SPEND').length
  if (debits > 1) problems.push(`${debits} debits of the whole balance landed`)
  // Every append reported settled is on the record, and nothing else is.
  if (settledCount(results) !== entries.length - 1) problems.push(`${settledCount(results)} reported settled, ${entries.length - 1} on the record beyond the funding`)
  return problems
}

describe('I-9 · One head per chain — under interleaving', () => {
  it('two debits of the whole balance and a credit, every ordered pair, every schedule: exactly one of the debits lands, the chain verifies, and the stored state is the fold', async () => {
    const r = await interleave<TransactionalLedgerStore>({ setup: () => funded(new InMemoryLedgerStore()), ops: headOps, invariants: oneHead })
    expect(r.pairs).toBe(9)
    expect(r.schedules).toBe(45)
  })

  it('refuses the pre-fix reference store, whose appendAll ignores the head, on exactly the two started-together schedules', async () => {
    const err = await expectViolation(
      () => interleave<TransactionalLedgerStore>({ setup: () => funded(new PreFixMemoryStore()), ops: headOps, invariants: oneHead, pairs: [['debitAll_a', 'debitAll_b']] }),
      { match: /is not the fold|chain/ },
    )
    // a;b and b;a: the second read sees balance 0 and post() refuses. a|y|b: a
    // lands within the yielded macrotask. Only the two started-together
    // schedules hand both appends the same head — and the pre-fix store lands both.
    expect((err.failures ?? []).map((f) => f.pattern).sort()).toEqual(['a||b', 'b||a'])
  })
})

// ── I-4 · idempotent writes, under every schedule ───────────────────────────

const REPLAY_KEY = 'quest:q_9:id_replay'
const replayOps = [
  { name: 'replay_a', run: (store: LedgerStore) => write(store, 'id_replay', 25, REPLAY_KEY) },
  { name: 'replay_b', run: (store: LedgerStore) => write(store, 'id_replay', 25, REPLAY_KEY) },
]
async function writtenOnce(store: LedgerStore, { results }: { results: Settled[] }): Promise<string[]> {
  const problems = await booksHold(store, ['id_replay'])
  const entries = await store.readEntries(ref('id_replay'))
  if (entries.length !== 1) problems.push(`${entries.length} entries carry one idempotency key`)
  const first = entries[0]
  for (const r of results) {
    if (!r.ok) { problems.push(`a replay was refused: ${r.error}`); continue }
    const { entry } = r.value as AppendResult
    if (first && entry.hash !== first.hash) problems.push('a replay returned an entry other than the original')
  }
  if (settledCount(results) !== 1) problems.push(`${settledCount(results)} of ${results.length} writes reported as new`)
  return problems
}

describe('I-4 · Idempotent writes — under interleaving', () => {
  it('the same key appended twice, under every schedule: one entry on the record, both callers handed it, exactly one reported as new', async () => {
    const r = await interleave<TransactionalLedgerStore>({ setup: () => new InMemoryLedgerStore(), ops: replayOps, invariants: writtenOnce })
    expect(r.schedules).toBe(20)
  })

  it('refuses a store that forgot its key index: the replay lands twice on every schedule', async () => {
    const err = await expectViolation(
      () => interleave<TransactionalLedgerStore>({ setup: () => new PreFixMemoryStore(false), ops: replayOps, invariants: writtenOnce }),
      { match: /2 entries carry one idempotency key/ },
    )
    expect(err.failures?.length).toBe(20)
  })
})

// ── property: post / postTransfer / reverse over two identities ─────────────

const IDS = ['id_p', 'id_q'] as const
type Id = (typeof IDS)[number]
interface World {
  store: TransactionalLedgerStore
  n: number
  lastProposed: ProposedEntry | null
  /** A state a caller read earlier and may post against without re-reading. */
  stale: Partial<Record<Id, LedgerState>>
}
const key = (w: World, p: string): string => `${p}:${++w.n}`
const otherOf = (id: Id): Id => (id === 'id_p' ? 'id_q' : 'id_p')

const commands = [
  {
    name: 'credit',
    gen: (r: Rng) => ({ who: r.pick(IDS), amount: 1 + r.int(50) }),
    run: async (w: World, { who, amount }: { who: Id; amount: number }) => {
      const proposed = post(await w.store.readState(ref(who)), command(who, amount, key(w, 'credit')))
      w.lastProposed = proposed
      return w.store.append(proposed)
    },
  },
  {
    name: 'debit',
    gen: (r: Rng) => ({ who: r.pick(IDS), amount: 1 + r.int(60) }),
    run: async (w: World, { who, amount }: { who: Id; amount: number }) => {
      const proposed = post(await w.store.readState(ref(who)), command(who, -amount, key(w, 'debit')))
      w.lastProposed = proposed
      return w.store.append(proposed)
    },
  },
  {
    name: 'transfer',
    gen: (r: Rng) => ({ from: r.pick(IDS), amount: 1 + r.int(40) }),
    run: async (w: World, { from, amount }: { from: Id; amount: number }) => {
      const to = otherOf(from)
      const [fromState, toState] = await Promise.all([w.store.readState(ref(from)), w.store.readState(ref(to))])
      const pair = postTransfer({ state: fromState, identityId: from }, { state: toState, identityId: to }, {
        tenantId: TENANT, asset: GOLD, amount: fromDecimal(amount, GOLD.decimals), source: { type: 'test', id: 'xfer' }, idempotencyKey: key(w, 'xfer'), occurredAt: AT,
      })
      return w.store.appendAll(pair)
    },
  },
  {
    name: 'reverse',
    gen: (r: Rng) => ({ who: r.pick(IDS) }),
    run: async (w: World, { who }: { who: Id }) => {
      const latest = (await w.store.readEntries(ref(who))).at(-1)
      if (!latest) return 'nothing to reverse'
      return w.store.append(reverse(await w.store.readState(ref(who)), latest, 'property run', AT))
    },
  },
  {
    name: 'replay',
    gen: () => ({}),
    run: (w: World) => (w.lastProposed ? w.store.append(w.lastProposed) : 'nothing to replay'),
  },
  {
    name: 'captureState',
    gen: (r: Rng) => ({ who: r.pick(IDS) }),
    run: async (w: World, { who }: { who: Id }) => { w.stale[who] = await w.store.readState(ref(who)) },
  },
  {
    // A caller that read state earlier and did not re-read: the port's §4 case.
    // The fixed store refuses it once the head has moved; the caller re-reads
    // and retries. A store that lands it has forked the chain.
    name: 'postStale',
    gen: (r: Rng) => ({ who: r.pick(IDS), amount: 1 + r.int(50) }),
    run: (w: World, { who, amount }: { who: Id; amount: number }) => {
      const state = w.stale[who]
      if (!state) return 'no state captured'
      return w.store.append(post(state, command(who, amount, key(w, 'stale'))))
    },
  },
]
const everyBookHolds = (w: World): Promise<string[]> => booksHold(w.store, IDS)
const freshWorld = (store: TransactionalLedgerStore) => (): World => ({ store, n: 0, lastProposed: null, stale: {} })

describe('I-1, I-4, I-5, I-9 · random sequences of post, postTransfer, reverse, replay and a write against a stale head', () => {
  it('every stored balance is the fold over its entries, every chain verifies, every head is the last entry, and no balance goes negative except by a reversal', async () => {
    const r = await property<World>({
      setup: () => freshWorld(new InMemoryLedgerStore())(),
      commands,
      invariants: everyBookHolds,
      runs: 200, maxLen: 14, seed: 20261010,
    })
    expect(r.runs).toBe(200)
    expect(r.commands).toBeGreaterThan(200 * 4)
  })

  it('refuses the pre-fix reference store under the same sequences — a write against a stale head lands, and shrinks to capture, write, stale write', async () => {
    // A sequential run never proposes two keys against one head by itself —
    // that is what interleave() is for, above. What it CAN do is hold a state
    // a caller read earlier and post against it after the head has moved. The
    // fixed store refuses that with "chain head moved"; the pre-fix store
    // appends it, the chain forks, and the stored balance parts from the fold.
    const err = await expectViolation(
      () => property<World>({ setup: () => freshWorld(new PreFixMemoryStore())(), commands, invariants: everyBookHolds, runs: 200, maxLen: 14, seed: 20261010 }),
      { match: /is not the fold|chain|stored head/ },
    )
    const names = (err.sequence ?? []).map((s) => s.name)
    expect(names).toHaveLength(3)
    expect(names[0]).toBe('captureState')
    expect(names[2]).toBe('postStale')
  })
})
