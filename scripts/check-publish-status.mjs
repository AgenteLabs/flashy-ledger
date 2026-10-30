#!/usr/bin/env node
// Answers one question honestly: is the version package.json declares
// actually on the public npm registry, under the exact commit it claims to
// be — never typed, always measured.
//
//   node scripts/check-publish-status.mjs [--json]
//
// This is read-only. It never publishes and never needs NPM_TOKEN: a GET to
// registry.npmjs.org is the same request any stranger's browser can make.
// `npm view` does the same lookup through local npm config, which can be
// pointed at a different registry by a stray .npmrc; this script talks to
// `registry.npmjs.org` directly over `node:https`, so what it reports cannot
// be an artifact of this machine's configuration.
//
// Roadmap step 4 (round-2 boardroom synthesis, "Flashy Financial
// infrastructure"): "move the ledger from a vendored copy to a published,
// versioned dependency." On 2026-10-30 this script found the publish had
// ALREADY landed — @flashyos/ledger@1.0.1, 2026-10-26T12:51:10.512Z,
// gitHead 4a0d3a648f2c1cae79b8ed841f9dde77f2404872, the exact commit the
// `v1.0.1` tag names — four days before anyone checked. See RELEASES.md and
// README.md, "Publishing". Nothing here claims that result; it is what a
// run of this script measured. The one thing that never changes is the
// discipline the estate already uses for a collector that cannot reach the
// network (`flashyos`, "Unread is not zero"): a fetch that fails is reported
// as UNREACHABLE, never folded into "not published" — those are different
// facts and need different responses.
//
// Dependency-free on purpose, like every other script in `scripts/`: no
// import outside `node:` builtins, so this runs before `npm install` and
// cannot itself be the thing that silently stops running.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Parses "1.2.3" into a comparable tuple. Throws on anything else — a
 * malformed version is a bug to surface, not a value to silently coerce. */
export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  if (!m) throw new Error(`not a semver: ${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** -1, 0 or 1, the way Array#sort wants it. */
export function compareSemver(a, b) {
  const [am, ai, ap] = parseSemver(a)
  const [bm, bi, bp] = parseSemver(b)
  return am - bm || ai - bi || ap - bp
}

/**
 * Classifies what a registry response says against what package.json
 * declares, without ever treating "could not ask" as "no".
 *
 * `registryResult` is one of:
 *   { ok: true, data }               — the registry answered with a document
 *   { ok: false, reason: 'not-found' }    — a genuine 404: this name has
 *                                           never published anything
 *   { ok: false, reason: 'unreachable', detail } — the network, a proxy, or
 *                                           the runner refused the request;
 *                                           says nothing about the registry
 *
 * Returns one of four statuses, each a different fact that wants a different
 * response:
 *   'not-found'         — nothing under this name has ever been published
 *   'unreachable'        — unknown; the fetch itself failed
 *   'published-current'  — the registry's latest version is (at least) what
 *                           package.json declares
 *   'published-stale'    — package.json has moved past what the registry
 *                           has actually landed; THIS is the "prepared, not
 *                           yet published" shape the roadmap anticipated
 */
export function classifyPublishState({ pkgVersion, registryResult }) {
  if (!registryResult.ok) {
    return { status: registryResult.reason, detail: registryResult.detail ?? null }
  }
  const data = registryResult.data
  const latest = data['dist-tags']?.latest
  if (!latest) {
    return { status: 'unreachable', detail: 'registry document has no dist-tags.latest' }
  }
  const cmp = compareSemver(latest, pkgVersion)
  if (cmp < 0) {
    return {
      status: 'published-stale',
      detail: `registry's newest published version is ${latest}; package.json declares ${pkgVersion}`,
      registryLatest: latest,
    }
  }
  // cmp >= 0: the version package.json declares is on the registry (exactly,
  // or the registry has since moved further ahead than this checkout has).
  const exact = data.versions?.[pkgVersion]
  if (!exact) {
    return {
      status: 'published-stale',
      detail: `registry's latest (${latest}) is ahead of ${pkgVersion}, but ${pkgVersion} itself was never published — a version was skipped`,
      registryLatest: latest,
    }
  }
  return {
    status: 'published-current',
    detail: `registry has ${pkgVersion}` + (latest !== pkgVersion ? ` (registry's newest is ${latest})` : ''),
    registryLatest: latest,
    gitHead: exact.gitHead ?? null,
    publishedAt: data.time?.[pkgVersion] ?? null,
    dist: exact.dist ?? null,
  }
}

/**
 * Compares what a local `npm pack --dry-run --json` of a given commit would
 * produce against the registry's recorded `dist` for a version. Only
 * meaningful when BOTH come from the exact same commit — a rebuild of a
 * later commit will differ for reasons that have nothing to do with whether
 * the publish is real (a later edit to README.md changes the tarball's
 * hash; it does not un-publish 1.0.1).
 *
 * `localPack` is one entry of `npm pack --dry-run --json`'s array
 * (`shasum`, `integrity`, `unpackedSize`, `files: [...]`); `registryDist` is
 * a version's `dist` object from the registry document (`shasum`,
 * `integrity`, `unpackedSize`, `fileCount`).
 */
export function compareTarball(localPack, registryDist) {
  if (!registryDist) return { match: null, reason: 'no registry dist to compare against' }
  const localFileCount = localPack.fileCount ?? localPack.files?.length
  const mismatches = []
  for (const field of ['shasum', 'integrity', 'unpackedSize']) {
    if (localPack[field] !== undefined && registryDist[field] !== undefined
      && localPack[field] !== registryDist[field]) mismatches.push(field)
  }
  if (localFileCount !== undefined && registryDist.fileCount !== undefined
    && localFileCount !== registryDist.fileCount) {
    mismatches.push('fileCount')
  }
  return { match: mismatches.length === 0, mismatches }
}

/** GET https://registry.npmjs.org/<name>, bypassing any local npm config. */
function fetchRegistry(name, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${name}`,
      { headers: { accept: 'application/json' }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode === 404) {
          res.resume()
          resolve({ ok: false, reason: 'not-found' })
          return
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume()
          resolve({ ok: false, reason: 'unreachable', detail: `HTTP ${res.statusCode}` })
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try {
            resolve({ ok: true, data: JSON.parse(body) })
          } catch (err) {
            resolve({ ok: false, reason: 'unreachable', detail: `malformed JSON: ${err.message}` })
          }
        })
      },
    )
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'unreachable', detail: 'timed out' }) })
    req.on('error', (err) => resolve({ ok: false, reason: 'unreachable', detail: err.message }))
  })
}

/** Best-effort local git lookup. Never fatal — a missing tag or missing git
 * binary is reported as null, not thrown, because this script's whole job is
 * to degrade to "unknown" rather than to crash past a real answer. */
function tryGit(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function main() {
  const asJson = process.argv.includes('--json')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const registryResult = await fetchRegistry(pkg.name)
  const classification = classifyPublishState({ pkgVersion: pkg.version, registryResult })

  const tagSha = tryGit(['rev-parse', `v${pkg.version}`])
  const headAncestry = tagSha ? tryGit(['merge-base', '--is-ancestor', tagSha, 'HEAD']) : null
  const tagIsOnHead = tagSha !== null && headAncestry !== null

  let local = null
  const built = existsSync(join(ROOT, 'dist', 'index.js')) && existsSync(join(ROOT, 'dist-cjs', 'index.js'))
  if (built && classification.dist) {
    try {
      const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })
      const [info] = JSON.parse(out.slice(out.indexOf('[')))
      local = compareTarball(info, classification.dist)
    } catch (err) {
      local = { match: null, reason: `npm pack failed: ${err.message}` }
    }
  }

  const report = {
    package: pkg.name,
    declaredVersion: pkg.version,
    status: classification.status,
    detail: classification.detail,
    registryLatest: classification.registryLatest ?? null,
    publishedAt: classification.publishedAt ?? null,
    gitHeadOnRegistry: classification.gitHead ?? null,
    localTagSha: tagSha,
    gitHeadMatchesTag: classification.gitHead && tagSha ? classification.gitHead === tagSha : null,
    tagIsOnCurrentHead: tagIsOnHead,
    tarballComparison: local,
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`\n  ${report.package}@${report.declaredVersion} — ${report.status}`)
    console.log(`  ${report.detail}`)
    if (report.publishedAt) console.log(`  published: ${report.publishedAt}`)
    if (report.gitHeadOnRegistry) {
      console.log(`  registry gitHead: ${report.gitHeadOnRegistry}`)
      console.log(`  tags as v${report.declaredVersion}: ${report.localTagSha ?? '(no local tag)'}`)
      console.log(`  gitHead matches tag: ${report.gitHeadMatchesTag}`)
    }
    if (report.tarballComparison) {
      console.log(`  local rebuild matches published tarball: ${report.tarballComparison.match}`)
    }
    console.log('')
  }

  // Exit non-zero only on a status that is actually bad news. 'unreachable'
  // is deliberately exit 0 — see the file header: a network failure is not
  // a finding about publication, so it must not fail a CI step that happens
  // to run this for its own interest.
  process.exit(classification.status === 'not-found' ? 1 : 0)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
