/**
 * @flashyos/ledger — an append-only, multi-asset settlement ledger.
 *
 * The domain is pure and knows nothing about storage. Everything that touches a
 * database sits behind `LedgerStore`, which is the only thing that has to change
 * if the ledger ever moves onto a chain.
 *
 * ```ts
 * const store = new InMemoryLedgerStore()
 * const gold: Asset = { id: 'fg', slug: 'flashy-gold', symbol: 'FG',
 *                       decimals: 2, class: 'REWARD_CURRENCY', tenantId: 'flashy' }
 *
 * const state = await store.readState('identity_1', gold.id)
 * const entry = post(state, {
 *   tenantId: 'flashy', identityId: 'identity_1', asset: gold,
 *   amount: fromDecimal(25, gold.decimals), kind: 'EARN',
 *   source: { type: 'quest', id: 'q_9' },
 *   idempotencyKey: 'quest:q_9:identity_1', occurredAt: new Date(),
 * })
 * await store.append(entry)
 * ```
 */

export type { Asset, AssetClass } from './domain/asset.js'
export { assetRegistry, isTransferable } from './domain/asset.js'

export type { AssetDefinition } from './domain/registry.js'
export {
  FLASHY_ASSET_DEFINITIONS,
  CIVILIZATION_COMMODITIES,
  FLASHY_GOLD,
  FLASHY_WORK_UNIT,
  IRON,
  STONE,
  WHEAT,
  WOOD,
  assetDefinition,
  defineAsset,
  flashyAssets,
  materialize,
} from './domain/registry.js'

export type { Minor } from './domain/money.js'
export {
  ZERO,
  add,
  fromDecimal,
  isNegative,
  isZero,
  minor,
  negate,
  toDecimal,
  PrecisionError,
} from './domain/money.js'

export type { ChainVerdict, Entry, EntryKind, EntrySource, HashableEntry } from './domain/entry.js'
export { hashEntry, verifyChain, verifyEntry } from './domain/entry.js'
export type { SkillKey } from './domain/experience.js'
export {
  SKILL_KEYS,
  skillAsset,
  skillAssetRegistry,
  skillAssets,
  skillForAssetId,
  xpIdempotencyKey,
} from './domain/experience.js'

export type {
  LedgerState,
  PostCommand,
  ProposedEntry,
  TransferCommand,
  TransferParty,
} from './domain/post.js'
export { post, postTransfer, reverse } from './domain/post.js'

export type { ConsumeCommand, ConsumptionCost } from './domain/consume.js'
export { canConsume, postConsume, shortfalls } from './domain/consume.js'

export { balanceOf, balancesByAsset, stateFrom } from './domain/fold.js'

// The Merkle spec: the tree the nightly anchor commits a day of entries to,
// and the proofs a stranger verifies against it. One implementation, shared by
// the producer and the reader — see the provenance note in the module.
export type { Commitment, Hex, InclusionProof, ProofStep, SnapshotEntry } from './domain/merkle.js'
export {
  canonical,
  commit,
  fromHex,
  inclusionProof,
  leafHash,
  merkleRoot,
  nodeHash,
  sha256Hex,
  sortEntries,
  toHex,
  toJsonl,
  verifyInclusion,
} from './domain/merkle.js'

// The identity rule: opaque, tenant-scoped, never a natural key. Enforced in
// post(), so no entry can be written that skips it.
export {
  NaturalKeyError,
  assertOpaqueIdentity,
  looksLikeNaturalKey,
  surrogateIdentity,
} from './domain/identity.js'

export { InsufficientForConsumptionError, LedgerError } from './domain/errors.js'
export type { LedgerErrorCode, Shortfall } from './domain/errors.js'

export type {
  AccountRef,
  AppendResult,
  HistoryRef,
  LedgerStore,
  TransactionalLedgerStore,
} from './ports/store.js'
export { isTransactional } from './ports/store.js'

export { InMemoryLedgerStore } from './adapters/memory.js'
export { MongoLedgerStore } from './adapters/mongo.js'
export type { MongoLedgerStoreOptions } from './adapters/mongo.js'

// Adopting a collection this package did not design: map the field names and
// the adapter reads and writes it in place, rules and all.
export { DEFAULT_FIELDS, GOLD_LEDGER_FIELDS, resolveFields } from './adapters/field-map.js'
export type { FieldMap, ResolvedFieldMap, SplitSource } from './adapters/field-map.js'

// Read-only, and not a LedgerStore. It reads ClaimYour.Gold's existing
// gold_ledger so consumers can query the live ledger through this package's
// types before the format migration happens. Writing stays with postEntry
// while both formats coexist — see the file for why that is enforced by the
// type rather than by convention.
export { GoldLedgerReader } from './adapters/gold-ledger.js'
export type { GoldLedgerStoreOptions } from './adapters/gold-ledger.js'
