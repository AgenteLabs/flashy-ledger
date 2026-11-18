// File: tests/cross-linking.test.mjs
// Test that README cross-linking is complete and correct

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

test('README has "See also" section with links', () => {
  const readmePath = path.join(rootDir, 'README.md')
  assert.ok(fs.existsSync(readmePath), 'README.md must exist')

  const readme = fs.readFileSync(readmePath, 'utf8')
  const seeAlsoMatch = readme.match(/### See also\n([\s\S]*?)(?=###|$)/)

  assert.ok(seeAlsoMatch, 'README must have "### See also" section')

  const seeAlsoContent = seeAlsoMatch[1]
  const hasLinks = /\[.+\]\(.+\)/.test(seeAlsoContent)

  assert.ok(hasLinks, '"See also" section must contain at least one link')
})

test('All links in "See also" section are valid URLs or relative paths', () => {
  const readmePath = path.join(rootDir, 'README.md')
  const readme = fs.readFileSync(readmePath, 'utf8')
  const seeAlsoMatch = readme.match(/### See also\n([\s\S]*?)(?=###|$)/)

  if (!seeAlsoMatch) return // Skip if no "See also" section

  const seeAlsoContent = seeAlsoMatch[1]
  const linkMatches = [...seeAlsoContent.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]

  // Index 2 is the URL; index 1 is the link text. This read index 1 for as
  // long as nothing ran the file — no npm script did — so every https link
  // in "See also" was judged by its label and the test failed on a correct
  // README the first time `npm run test:standalone` executed it.
  const badLinks = linkMatches.filter(({ 2: url }) => {
    // URLs must be https://, relative paths, or github.com links
    const isValidHttps = url.startsWith('https://')
    const isRelative = url.startsWith('./')
    const isParentRelative = url.startsWith('../')
    const isGitHub = url.includes('github.com')

    return !(isValidHttps || isRelative || isParentRelative || isGitHub)
  })

  assert.equal(
    badLinks.length,
    0,
    `Invalid links found:\n${badLinks.map(m => `  - [${m[1]}](${m[2]})`).join('\n')}`
  )
})

test('flashy.tools is linked from "See also"', () => {
  const readmePath = path.join(rootDir, 'README.md')
  const readme = fs.readFileSync(readmePath, 'utf8')

  const hasFlashyTools = readme.includes('flashy.tools') ||
                         readme.includes('https://flashy.tools')

  assert.ok(
    hasFlashyTools,
    'README must link to https://flashy.tools in "See also" section for discoverability'
  )
})

test('README has exactly one "When to use alone" and one "In the Flashy ecosystem" section', () => {
  const readmePath = path.join(rootDir, 'README.md')
  const readme = fs.readFileSync(readmePath, 'utf8')

  const aloneCount = (readme.match(/### When to use alone/g) || []).length
  const ecosystemCount = (readme.match(/### In the Flashy ecosystem/g) || []).length

  assert.equal(
    aloneCount,
    1,
    'README must have exactly one "### When to use alone" section'
  )

  assert.equal(
    ecosystemCount,
    1,
    'README must have exactly one "### In the Flashy ecosystem" section'
  )
})
