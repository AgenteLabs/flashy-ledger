import { describe, it, expect } from 'vitest'
import * as pkg from '../src/index.js'
import { WRITABLE_STORE_CLASSES, isWritableStoreClass } from './adapters.catalog.js'

/**
 * The conformance population is the package's population — derived, not trusted.
 *
 * `conformance.test.ts` proves every adapter it is pointed at behaves like the
 * reference. This proves it is pointed at every adapter there is. The gap it
 * closes is the one this estate has hit before from the other side: a suite
 * whose worth is silently decided by a hand-kept list that stopped matching
 * what the package actually ships. A new writable `LedgerStore` exported without
 * a catalog entry would ship with no conformance behind it and nothing red;
 * this fails the build instead.
 *
 * It reads the real module exports, so it cannot drift from them, and it
 * recognises a writable store by structure (an `append` method), so the
 * read-only `GoldLedgerReader` is excluded by the same fact that makes it
 * read-only rather than by a name on a list.
 */

/** Every exported value that is a writable store class, by export name. */
const exportedWritable = Object.entries(pkg)
  .filter(([, value]) => isWritableStoreClass(value))
  .map(([name, value]) => ({ name, value }))

describe('adapter coverage', () => {
  it('finds the writable stores it is meant to be guarding', () => {
    // Vacuity guard: a green check over an empty export set would read exactly
    // like a clean one, which is the failure this whole file exists to prevent.
    expect(exportedWritable.length).toBeGreaterThan(0)
  })

  it('catalogs exactly the writable stores the package exports — no more, no fewer', () => {
    const exported = new Set(exportedWritable.map((e) => e.value as unknown))
    const cataloged = new Set<unknown>(WRITABLE_STORE_CLASSES)

    const missing = [...exported].filter((c) => !cataloged.has(c))
    const stale = [...cataloged].filter((c) => !exported.has(c))

    expect(
      missing,
      'a writable LedgerStore is exported but not in tests/adapters.catalog.ts, so conformance never runs against it',
    ).toEqual([])
    expect(
      stale,
      'the catalog lists a class the package no longer exports as a writable store',
    ).toEqual([])
  })

  it('excludes the read-only reader by structure, not by an allowlist', () => {
    // GoldLedgerReader is a real export and deliberately not a LedgerStore: it
    // has no append, so it is neither detected as writable nor cataloged, and
    // the exclusion needs no special-case.
    expect('GoldLedgerReader' in pkg).toBe(true)
    expect(isWritableStoreClass((pkg as Record<string, unknown>).GoldLedgerReader)).toBe(false)
    expect(exportedWritable.map((e) => e.name)).not.toContain('GoldLedgerReader')
  })
})
