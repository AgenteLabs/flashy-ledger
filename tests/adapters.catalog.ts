import { InMemoryLedgerStore, MongoLedgerStore, type LedgerStore } from '../src/index.js'

/**
 * The writable-adapter population, declared once.
 *
 * `LedgerStore` is the seam the whole migration story rests on, and the
 * conformance suite's worth is exactly the set of adapters it is pointed at — a
 * guarantee proven against the in-memory reference and no one else is a
 * guarantee about the reference, not about the adapter a network actually runs.
 * This estate has paid for the other shape of that mistake (`pulse.yml` ran for
 * nine days over a population of zero and reported success), and the lesson it
 * wrote down is the one applied here: **the population is derived, never
 * hand-kept beside the thing it measures.**
 *
 * So this is the single list of every *writable* `LedgerStore` the package
 * ships. `tests/conformance.test.ts` builds its harnesses from it, so the suite
 * runs exactly these classes; `tests/adapter-coverage.test.ts` checks it against
 * the package's real exports, so a new adapter that is exported and not listed
 * here — or listed and not exported — fails the build rather than shipping with
 * no conformance behind it.
 *
 * Read-only adapters are deliberately absent. `GoldLedgerReader` is not a
 * `LedgerStore` (it has no `append`), so it cannot be asked to satisfy a
 * suite about writes, and the coverage guard excludes it by that same
 * structural fact rather than by a name on an allowlist.
 */
export type WritableStoreClass = new (...args: never[]) => LedgerStore

export const WRITABLE_STORE_CLASSES: readonly WritableStoreClass[] = [
  InMemoryLedgerStore,
  MongoLedgerStore,
]

/** The structural mark of a writable store: an `append` method on the prototype. */
export function isWritableStoreClass(value: unknown): value is WritableStoreClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { append?: unknown } }).prototype?.append === 'function'
  )
}
