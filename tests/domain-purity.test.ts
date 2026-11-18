import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

/**
 * The domain is pure, and purity is a dependency rule as much as a runtime one.
 *
 * The README and the roadmap both rest the whole package on one sentence: the
 * domain reads no database, calls no clock, and generates no randomness, which
 * is the entire reason the ledger can move onto a chain without its rules
 * changing. eslint already guards the runtime half for `src/domain/**` — `Date`,
 * `Date.now` and `Math.random` are restricted there.
 *
 * It does NOT guard the other half: which way the dependency arrow points. A
 * domain module that did `import { MongoLedgerStore } from '../adapters/mongo.js'`
 * or `import { readFileSync } from 'node:fs'` would pass lint, typecheck and
 * every existing test, and the seam the architecture is built on — the domain
 * never knowing where entries are kept — would be broken silently, in exactly
 * the direction that makes a chain migration a research project again.
 *
 * So this reads the real import graph of `src/domain/**`, with the compiler's
 * own preprocessor rather than a regex (a regex reads `import` inside a comment
 * or a string the same as a real one), and asserts the arrow only ever points
 * at other domain modules or the one deterministic builtin the hashes need.
 * It is structure, not prose: it resolves specifiers, it does not grep for a
 * rule's name.
 */

const DOMAIN_DIR = resolve('src/domain')

/** Every .ts file under src/domain, recursively. */
function domainFiles(dir: string = DOMAIN_DIR): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...domainFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Import specifiers, type-only imports included, read by the compiler not a regex. */
function importsOf(file: string): string[] {
  const pre = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
  return pre.importedFiles.map((i) => i.fileName)
}

/** The one builtin the domain is allowed: sha256 hashing is deterministic and pure. */
const ALLOWED_BUILTINS = new Set(['node:crypto'])

const files = domainFiles()

describe('domain purity', () => {
  it('finds the domain modules it is meant to be guarding', () => {
    // A walk that resolved nothing would pass every assertion below vacuously —
    // a green check over an empty set reads exactly like a clean one.
    expect(files.length).toBeGreaterThan(5)
  })

  it('imports no adapter and no port, so storage never leaks upward', () => {
    const violations: string[] = []
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith('.')) continue
        const target = resolve(dirname(file), spec)
        const within = relative(DOMAIN_DIR, target)
        if (within.startsWith('..')) {
          violations.push(`${relative(DOMAIN_DIR, file)} imports '${spec}' — outside the domain`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('imports no I/O builtin, only deterministic node:crypto', () => {
    const violations: string[] = []
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith('node:') && !ALLOWED_BUILTINS.has(spec)) {
          violations.push(`${relative(DOMAIN_DIR, file)} imports '${spec}' — a builtin the pure domain may not reach for`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('takes no third-party dependency', () => {
    const violations: string[] = []
    for (const file of files) {
      for (const spec of importsOf(file)) {
        const isRelative = spec.startsWith('.')
        const isBuiltin = spec.startsWith('node:')
        if (!isRelative && !isBuiltin) {
          violations.push(`${relative(DOMAIN_DIR, file)} imports '${spec}' — a third-party package the domain must not depend on`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
