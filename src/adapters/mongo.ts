import type { Collection, Db, MongoClient, ObjectId, OptionalId } from 'mongodb'
import type { Entry, EntryKind, EntrySource } from '../domain/entry.js'
import type { LedgerState, ProposedEntry } from '../domain/post.js'
import { PrecisionError, ZERO, minor } from '../domain/money.js'
import type {
  AccountRef,
  AppendResult,
  HistoryRef,
  TransactionalLedgerStore,
} from '../ports/store.js'
import {
  readSource,
  resolveFields,
  writeSource,
  type FieldMap,
  type ResolvedFieldMap,
} from './field-map.js'

/**
 * MongoDB implementation of the store port.
 *
 * The domain decides what an entry should be; this decides where it lives and,
 * critically, what the database itself refuses to allow. Three guarantees the
 * port demands are enforced by indexes rather than by code here, because code
 * in this file runs once per process and an index runs on every write from
 * every process forever:
 *
 *   1. `(tenantId, idempotencyKey)` is unique. A replay cannot become a second
 *      entry even if two processes race the same key at the same instant — and
 *      the tenant is part of the key, so two networks deriving the same key
 *      from similar source events do not deduplicate against each other.
 *   2. `(tenantId, identityId, assetId, previousHash)` is unique. This is what
 *      stops two concurrent appends both building on the same chain head — the
 *      second one violates the index and is retried against the new head rather
 *      than silently forking history.
 *   3. Nothing updates or deletes. There is no code path in this class that
 *      issues either, matching the port's requirement that entries are
 *      immutable.
 *
 * ON AMOUNTS
 * ──────────
 * Minor units are whole numbers. They are written as decimal strings by
 * default, and as numbers when the field map says `amountEncoding: 'number'`
 * (a collection being adopted whose readers already expect a number); see
 * `encodeAmount`.
 *
 * Reading is looser than writing. A stored amount goes through `Number()` in
 * `decodeAmount` and then through `minor()`, so what is accepted is whatever
 * `Number()` turns into a safe integer, not only what this adapter wrote:
 *
 *   - A number or numeric string whose `Number()` value is a whole number no
 *     larger in magnitude than `Number.MAX_SAFE_INTEGER` is accepted. That
 *     includes `' 5 '` (read as 5), `'1e3'` (1000) and `'0x10'` (16).
 *   - `null`, `''` and a whitespace-only string are accepted and read as 0.
 *   - `PrecisionError` is thrown for a stored value that `Number()` parses to a
 *     non-whole double (`12.5`), to NaN or an infinity, to a whole number
 *     beyond `Number.MAX_SAFE_INTEGER` (`'9007199254740993'`), and for a field
 *     that is absent (`undefined`).
 *   - A fraction too small for a double to hold is not caught: `Number()` has
 *     already rounded `'12.0000000000000001'` to exactly 12 by the time the
 *     whole-number check runs, so it is read as 12 rather than refused.
 *
 * The string encoding does not widen the range, which is the domain's: a value
 * beyond `Number.MAX_SAFE_INTEGER` cannot be read back by this adapter. The
 * domain never sees a Mongo type and this file never does arithmetic.
 */

/** The document shape. Deliberately explicit rather than inferred from Entry. */
interface EntryDoc {
  _id?: ObjectId
  tenantId: string
  identityId: string
  assetId: string
  /** Stored as a string: minor units are integers that can outgrow a double. */
  amount: string
  balanceBefore: string
  balanceAfter: string
  kind: EntryKind
  source: EntrySource
  idempotencyKey: string
  occurredAt: Date
  previousHash: string | null
  hash: string
  metadata?: Record<string, unknown>
}

const DUPLICATE_KEY = 11000

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number }).code === DUPLICATE_KEY
}

/**
 * Amounts, in the encoding the target collection uses.
 *
 * Strings by default: minor units outgrow a double over a long-lived ledger and
 * BSON has no unbounded integer, so a string is the only lossless choice this
 * package can make for a collection it owns. A collection it is adopting may
 * already be numeric, and writing strings into it would break every reader that
 * has always worked.
 */
function encodeAmount(value: number, fields: ResolvedFieldMap): string | number {
  return fields.amountEncoding === 'number' ? value : String(value)
}

/**
 * Decode an amount, refusing anything that is not already a whole number of
 * minor units.
 *
 * This is the sequencing guard, expressed as code rather than as a paragraph in
 * a migration plan. A collection whose amounts are still decimal majors — 12.5
 * meaning twelve and a half gold — cannot be adopted by converting here: the
 * multiply would be float arithmetic deciding what someone is owed, silently,
 * at the boundary nobody reads. Rows have to be integers first.
 */
function decodeAmount(raw: unknown, field: string, collection: string): number {
  const value = Number(raw)

  if (!Number.isFinite(value)) {
    throw new PrecisionError(
      `${collection}.${field} holds ${String(raw)}, which is not a number.`,
    )
  }

  if (!Number.isInteger(value)) {
    throw new PrecisionError(
      `${collection}.${field} holds ${value}, which is not a whole number of minor units. ` +
        'This collection still stores decimal major units, and converting them here would ' +
        'be float arithmetic deciding a balance. Migrate the column to signed integer ' +
        'minor units before pointing this adapter at it.',
    )
  }

  return value
}

function toDoc(entry: ProposedEntry, fields: ResolvedFieldMap): OptionalId<EntryDoc> {
  return {
    [fields.tenantId]: entry.tenantId,
    [fields.identityId]: entry.identityId,
    [fields.assetId]: entry.assetId,
    [fields.amount]: encodeAmount(entry.amount, fields),
    [fields.balanceBefore]: encodeAmount(entry.balanceBefore, fields),
    [fields.balanceAfter]: encodeAmount(entry.balanceAfter, fields),
    [fields.kind]: entry.kind,
    ...writeSource(entry.source, fields),
    [fields.idempotencyKey]: entry.idempotencyKey,
    [fields.occurredAt]: entry.occurredAt,
    [fields.previousHash]: entry.previousHash,
    [fields.hash]: entry.hash,
    ...(entry.metadata ? { [fields.metadata]: entry.metadata } : {}),
  } as OptionalId<EntryDoc>
}

function fromDoc(doc: EntryDoc, fields: ResolvedFieldMap, collection: string): Entry {
  const raw = doc as unknown as Record<string, unknown>

  return {
    id: String(raw._id),
    tenantId: String(raw[fields.tenantId]),
    identityId: String(raw[fields.identityId]),
    assetId: String(raw[fields.assetId]),
    amount: minor(decodeAmount(raw[fields.amount], fields.amount, collection)),
    balanceBefore: minor(
      decodeAmount(raw[fields.balanceBefore], fields.balanceBefore, collection),
    ),
    balanceAfter: minor(decodeAmount(raw[fields.balanceAfter], fields.balanceAfter, collection)),
    kind: raw[fields.kind] as EntryKind,
    source: readSource(raw, fields),
    idempotencyKey: String(raw[fields.idempotencyKey]),
    occurredAt: raw[fields.occurredAt] as Date,
    previousHash: (raw[fields.previousHash] ?? null) as string | null,
    hash: String(raw[fields.hash]),
    ...(raw[fields.metadata]
      ? { metadata: raw[fields.metadata] as Record<string, unknown> }
      : {}),
  }
}

export interface MongoLedgerStoreOptions {
  /** Collection name. Defaults to `ledger_entries`. */
  collection?: string
  /**
   * Where each field lives, for a collection this package did not design.
   *
   * Omit it and the package's own shape is used. Supply it — `GOLD_LEDGER_FIELDS`
   * is a worked example — and the adapter reads and writes an existing
   * collection in place, which is what makes adopting a live ledger a
   * configuration line rather than a data migration.
   */
  fields?: FieldMap
  /**
   * A client, required only for multi-entry appends. Transfers need two
   * entries to commit together, which needs a session, which needs the client
   * rather than the database handle.
   *
   * Without it, `appendAll` rejects any batch of more than one entry rather
   * than writing a transfer half-way. Failing loudly beats a torn transfer.
   */
  client?: MongoClient
}

export class MongoLedgerStore implements TransactionalLedgerStore {
  private readonly entries: Collection<EntryDoc>
  private readonly client?: MongoClient
  private readonly fields: ResolvedFieldMap
  private readonly collectionName: string

  constructor(db: Db, options: MongoLedgerStoreOptions = {}) {
    this.collectionName = options.collection ?? 'ledger_entries'
    this.entries = db.collection<EntryDoc>(this.collectionName)
    this.client = options.client
    this.fields = resolveFields(options.fields)
  }

  /** The scope every query starts from, in the target collection's own names. */
  private scope(tenantId: string, identityId?: string, assetId?: string) {
    const f = this.fields
    return {
      [f.tenantId]: tenantId,
      ...(identityId === undefined ? {} : { [f.identityId]: identityId }),
      ...(assetId === undefined ? {} : { [f.assetId]: assetId }),
    }
  }

  /**
   * Chain order. `_id` is always the tiebreak, never replaced: two entries
   * written in the same millisecond have no order under a timestamp alone, and
   * a chain with no order is not a chain.
   */
  private order(direction: 1 | -1) {
    const f = this.fields
    return f.order === '_id' ? { _id: direction } : { [f.order]: direction, _id: direction }
  }

  private doc(entry: ProposedEntry) {
    return toDoc(entry, this.fields)
  }

  private entry(doc: EntryDoc): Entry {
    return fromDoc(doc, this.fields, this.collectionName)
  }

  /**
   * Create the indexes the port's guarantees depend on.
   *
   * Call once at startup. Idempotent — Mongo ignores an index that already
   * exists with the same specification.
   */
  async ensureIndexes(): Promise<void> {
    // The pre-0.2 indexes were globally unique rather than tenant-scoped, and a
    // surviving one silently defeats the isolation below: the old
    // `uniq_idempotency` would still reject a second tenant's legitimate write
    // even though the new index permits it. Creating the new ones without
    // removing the old would look like a successful migration and behave like
    // no migration at all, so they are dropped first and by name.
    for (const legacy of ['uniq_idempotency', 'uniq_chain_head', 'chain_order']) {
      try {
        await this.entries.dropIndex(legacy)
      } catch {
        // IndexNotFound. Expected on a fresh collection and on any deployment
        // that has already migrated.
      }
    }

    const f = this.fields

    await this.entries.createIndex(
      { [f.tenantId]: 1, [f.idempotencyKey]: 1 },
      { unique: true, name: 'uniq_tenant_idempotency' },
    )

    // The chain-head guard. Two appends that both read the same head produce
    // the same previousHash, and this index lets exactly one of them land.
    //
    // It does not need to be partial. The first entry of every chain has
    // previousHash null, but identityId and assetId are part of the key — so
    // "one entry with no predecessor" is scoped per chain, which is exactly
    // the constraint wanted, rather than one null across the collection.
    await this.entries.createIndex(
      { [f.tenantId]: 1, [f.identityId]: 1, [f.assetId]: 1, [f.previousHash]: 1 },
      { unique: true, name: 'uniq_tenant_chain_head' },
    )

    // Reading a chain in order, and finding its head, are the two hot paths.
    await this.entries.createIndex(
      { [f.tenantId]: 1, [f.identityId]: 1, [f.assetId]: 1, ...this.order(1) },
      { name: 'tenant_chain_order' },
    )
  }

  async append(proposed: ProposedEntry): Promise<AppendResult> {
    const existing = await this.findByIdempotencyKey(proposed.tenantId, proposed.idempotencyKey)
    if (existing) return { entry: existing, deduplicated: true }

    try {
      const doc = this.doc(proposed)
      const { insertedId } = await this.entries.insertOne(doc)
      return { entry: this.entry({ ...doc, _id: insertedId }), deduplicated: false }
    } catch (err) {
      if (!isDuplicateKey(err)) throw err

      // Lost a race. Either on the key — in which case the winner's entry is
      // the answer and this is a replay — or on the chain head, which is a
      // genuine conflict the caller must retry against the new head.
      const winner = await this.findByIdempotencyKey(proposed.tenantId, proposed.idempotencyKey)
      if (winner) return { entry: winner, deduplicated: true }

      throw new Error(
        `Concurrent append to ${proposed.identityId}/${proposed.assetId}: the chain head moved. Re-read state and retry.`,
        { cause: err },
      )
    }
  }

  /**
   * All or nothing.
   *
   * A transfer's debit and credit must both land or neither, which is the one
   * thing a single-document database cannot give you for free. It requires a
   * session, and therefore a replica set — a standalone mongod will reject the
   * transaction rather than silently write half of it.
   */
  async appendAll(proposed: readonly ProposedEntry[]): Promise<readonly AppendResult[]> {
    if (proposed.length === 0) return []
    if (proposed.length === 1) {
      const first = proposed[0]
      if (!first) throw new Error('appendAll: length is 1 but the entry is missing')
      return [await this.append(first)]
    }

    if (!this.client) {
      throw new Error(
        'MongoLedgerStore.appendAll needs a MongoClient to open a session. ' +
          'Pass { client } to the constructor — without it a multi-entry append ' +
          'cannot be made atomic, and writing part of a transfer is worse than writing none.',
      )
    }

    const session = this.client.startSession()
    try {
      let results: AppendResult[] = []

      await session.withTransaction(async () => {
        // Reset per attempt: withTransaction may retry the callback on a
        // transient error, and results from an aborted attempt are not real.
        results = []

        for (const candidate of proposed) {
          const existing = await this.entries.findOne(
            {
              ...this.scope(candidate.tenantId),
              [this.fields.idempotencyKey]: candidate.idempotencyKey,
            },
            { session },
          )
          if (existing) {
            results.push({ entry: this.entry(existing), deduplicated: true })
            continue
          }

          const doc = this.doc(candidate)
          const { insertedId } = await this.entries.insertOne(doc, { session })
          results.push({
            entry: this.entry({ ...doc, _id: insertedId }),
            deduplicated: false,
          })
        }
      })

      return results
    } finally {
      await session.endSession()
    }
  }

  async readState({ tenantId, identityId, assetId }: AccountRef): Promise<LedgerState> {
    const head = await this.entries.findOne(this.scope(tenantId, identityId, assetId), {
      sort: this.order(-1),
    })

    if (!head) return { balance: ZERO, headHash: null }

    const entry = this.entry(head)
    return { balance: entry.balanceAfter, headHash: entry.hash }
  }

  async readEntries({ tenantId, identityId, assetId }: HistoryRef): Promise<readonly Entry[]> {
    const docs = await this.entries
      .find(this.scope(tenantId, identityId, assetId))
      .sort(this.order(1))
      .toArray()
    return docs.map((doc) => this.entry(doc))
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<Entry | null> {
    const doc = await this.entries.findOne({
      ...this.scope(tenantId),
      [this.fields.idempotencyKey]: key,
    })
    return doc ? this.entry(doc) : null
  }
}
