import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `vendor-invariants.mjs` is a byte-identical copy of the invariants/1 harness
 * in spec-kit. A copy does not fail when it falls behind — it disagrees,
 * silently, about whichever schedule or check canon has just added — so the
 * copy is pinned to canon when spec-kit is checked out beside this repository,
 * and reported UNKNOWN (a skip) rather than passed when it is not. A check that
 * cannot see its source has learned nothing.
 *
 * Refresh with: cp ../spec-kit/vendor-invariants.mjs vendor-invariants.mjs
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDORED = join(ROOT, 'vendor-invariants.mjs')
const CANON = join(ROOT, '..', 'spec-kit', 'vendor-invariants.mjs')

describe('the vendored invariants/1 harness', () => {
  it('exists at the repository root and imports node: builtins only', () => {
    expect(existsSync(VENDORED)).toBe(true)
    const src = readFileSync(VENDORED, 'utf8')
    const imports = [...src.matchAll(/import\((['"])([^'"]+)\1\)|^import .* from (['"])([^'"]+)\3/gm)].map((m) => m[2] ?? m[4])
    expect(imports.sort()).toEqual(['node:fs', 'node:path'])
  })

  it('is byte-identical to spec-kit/vendor-invariants.mjs — UNKNOWN, never passed, when canon is absent', (ctx) => {
    if (!existsSync(CANON)) ctx.skip('UNKNOWN: spec-kit is not checked out beside this repository')
    expect(readFileSync(VENDORED, 'utf8')).toBe(readFileSync(CANON, 'utf8'))
  })
})
