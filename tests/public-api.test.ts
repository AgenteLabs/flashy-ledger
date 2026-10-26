import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'

/**
 * The export surface is the contract.
 *
 * For a library other repositories build on, removing or renaming an export is
 * a breaking change whether or not anyone noticed — and nothing else in this
 * suite fails when one disappears, because every other test imports what it
 * needs by name from the modules rather than from the entry point.
 *
 * This list is deliberately written out rather than derived. A generated
 * snapshot updates itself when someone deletes an export, which is precisely
 * the moment a human should have to look at it and decide whether the major
 * version needs to move.
 */
const RUNTIME_EXPORTS = [
  // money
  'ZERO',
  'add',
  'fromDecimal',
  'isNegative',
  'isZero',
  'minor',
  'negate',
  'toDecimal',
  'PrecisionError',
  // assets
  'assetRegistry',
  'isTransferable',
  // merkle — the anchor spec
  'canonical',
  'commit',
  'fromHex',
  'inclusionProof',
  'leafHash',
  'merkleRoot',
  'nodeHash',
  'sha256Hex',
  'sortEntries',
  'toHex',
  'toJsonl',
  'verifyInclusion',
  // the Flashy asset registry — one declaration per asset, and the only place
  // a consumer should learn what an asset's decimals are. Flashy Gold was
  // declared in four repositories and one of them said 4 instead of 2.
  'CIVILIZATION_COMMODITIES',
  'FLASHY_ASSET_DEFINITIONS',
  'FLASHY_GOLD',
  'FLASHY_WORK_UNIT',
  'IRON',
  'STONE',
  'WHEAT',
  'WOOD',
  'assetDefinition',
  'defineAsset',
  'flashyAssets',
  'materialize',
  // entries
  'hashEntry',
  'verifyChain',
  'verifyEntry',
  // posting
  'post',
  'postTransfer',
  'reverse',
  // experience — added in 0.4.0: the five skills as SKILL_XP assets
  'SKILL_KEYS',
  'skillAsset',
  'skillAssetRegistry',
  'skillAssets',
  'skillForAssetId',
  'xpIdempotencyKey',
  // consumption — added in 0.3.0 for multi-asset builds
  'canConsume',
  'postConsume',
  'shortfalls',
  // folds
  'balanceOf',
  'balancesByAsset',
  'stateFrom',
  // identity — opaque, tenant-scoped, never a natural key
  'NaturalKeyError',
  'assertOpaqueIdentity',
  'looksLikeNaturalKey',
  'surrogateIdentity',
  // errors
  'LedgerError',
  'InsufficientForConsumptionError',
  // ports
  'isTransactional',
  // adopting a collection this package did not design
  'DEFAULT_FIELDS',
  'GOLD_LEDGER_FIELDS',
  'resolveFields',
  // adapters
  'InMemoryLedgerStore',
  'MongoLedgerStore',
  'GoldLedgerReader',
] as const

describe('the public API surface', () => {
  it('exports everything consumers are entitled to import', () => {
    for (const name of RUNTIME_EXPORTS) {
      expect(api, `@flashyos/ledger no longer exports ${name}`).toHaveProperty(name)
    }
  })

  it('exports nothing beyond the documented surface', () => {
    // An accidental export is a commitment nobody decided to make, and it is
    // far cheaper to refuse it here than to remove it after someone depends on it.
    const actual = Object.keys(api).sort()
    const expected = [...RUNTIME_EXPORTS].sort()
    expect(actual).toEqual(expected)
  })

  it('keeps the store constructors constructible', () => {
    expect(typeof api.InMemoryLedgerStore).toBe('function')
    expect(typeof api.MongoLedgerStore).toBe('function')
    expect(typeof api.GoldLedgerReader).toBe('function')
  })

  it('fails closed when a caller uses the pre-0.2 positional signature', async () => {
    // TypeScript stops this at compile time, and the @ts-expect-error below is
    // itself the assertion: if `readState(id, assetId)` ever became valid again,
    // tsc fails on an unused directive.
    //
    // A JavaScript consumer has no such protection, so the runtime behaviour
    // matters too. The named tenant comes back undefined, matches nothing, and
    // the read returns an empty account — it must never fall back to reading
    // across every tenant, which is the direction this could have failed in.
    const store = new api.InMemoryLedgerStore()

    // @ts-expect-error the port has no overload without a tenant
    const state = await store.readState('identity_1', 'asset_fg')

    expect(state.balance).toBe(0)
    expect(state.headHash).toBeNull()
  })
})
