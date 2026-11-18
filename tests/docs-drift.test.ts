import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The prose that describes this package, held to the package.
 *
 * `invariants.test.ts` keeps docs/INVARIANTS.md honest about the suite and
 * `releases.test.ts` keeps RELEASES.md honest about package.json. Nothing held
 * the README or the CHANGELOG, which is how two things came to be said that the
 * tree contradicts:
 *
 *  - README told readers "Six guarantees" are numbered in docs/INVARIANTS.md,
 *    which numbers more than six.
 *  - CHANGELOG stopped at 0.8.0 while package.json declared 1.0.0, so the one
 *    place a consumer looks for "what changed" omitted the release that added
 *    the runtime Minor check, the chain-head guard and SELF_TRANSFER.
 *
 * Every figure below is derived from the tree. None is typed here.
 */

const root = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')

const WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
}

describe('README: the invariants', () => {
  it('states no count of the numbered invariants other than the number docs/INVARIANTS.md actually numbers', () => {
    const numbered = [...read('docs', 'INVARIANTS.md').matchAll(/^## I-\d+ · /gm)].length
    expect(numbered, 'docs/INVARIANTS.md numbers no invariants').toBeGreaterThan(0)

    const paragraphs = read('README.md').split(/\n\s*\n/).filter((p) => p.includes('INVARIANTS.md'))
    expect(paragraphs.length, 'README no longer points at docs/INVARIANTS.md').toBeGreaterThan(0)

    for (const paragraph of paragraphs) {
      for (const match of paragraph.matchAll(/\b(\d+|[A-Za-z]+) (?:guarantees|invariants)\b/g)) {
        const claimed = /^\d+$/.test(match[1] ?? '') ? Number(match[1]) : WORDS[(match[1] ?? '').toLowerCase()]
        if (claimed === undefined) continue
        expect(claimed, `README says "${match[0]}" but docs/INVARIANTS.md numbers ${numbered}`).toBe(numbered)
      }
    }
  })
})

describe('CHANGELOG', () => {
  it('has a section for the version package.json declares', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string }
    const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]`, 'm')
    expect(heading.test(read('CHANGELOG.md')), `CHANGELOG.md has no "## [${version}]" section`).toBe(true)
  })

  it('has a section for every version RELEASES.md records, so no release goes unexplained', () => {
    const recorded = [...read('RELEASES.md').matchAll(/^\|\s*(\d+\.\d+\.\d+)\s*\|/gm)].map((m) => m[1] ?? '')
    expect(recorded.length, 'RELEASES.md records no versions').toBeGreaterThan(0)

    const changelog = read('CHANGELOG.md')
    const missing = recorded.filter(
      (v) => !new RegExp(`^## \\[${v.replaceAll('.', '\\.')}\\]`, 'm').test(changelog),
    )
    expect(missing, `CHANGELOG.md has no section for: ${missing.join(', ')}`).toEqual([])
  })
})
