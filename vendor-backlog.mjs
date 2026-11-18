#!/usr/bin/env node
// A backlog for a repository that has no package.json.
//
// Two of the repositories in this estate are dependency-free static builders,
// and the portfolio companies most likely to adopt `backlog/1` are the ones
// least likely to want an npm install to do it. A standard whose only
// implementation needs a toolchain is a standard those repositories cannot
// adopt, so this file is the whole thing: copy it in, run it with node, get a
// valid fragment.
//
// It enforces the same two rules the package does, because a vendored copy
// that is merely *similar* is how a consent rule becomes advisory:
//
//   filing is private       `file` has no visibility argument
//   expiry is derived       DECAY_DAYS is the only source of an expires
//
// `vendor.test.ts` in this package asserts the constants here match the
// TypeScript ones. A drift fails CI rather than being discovered by whoever
// merges two fragments that disagree.
//
//   node vendor-backlog.mjs file --id build-the-thing --kind task --title "Build the thing" [--owner person/x] [--wants a,b]
//   node vendor-backlog.mjs revise <id> --by person/michael [--wants a,b|none] [--title ...] [--owner person/x|none]
//   node vendor-backlog.mjs promote <id> --by person/michael [--to public] [--note "..."]
//   node vendor-backlog.mjs close <id> --by person/michael [--dropped]
//   node vendor-backlog.mjs emit
//   node vendor-backlog.mjs check [backlog.fragment.json]
//
// State lives in .backlog/items.json; `emit` writes backlog.fragment.json.
// Configure the repo and org once in .backlog/config.json:
//   {
//     "source": "repo/my-repo",
//     "org": "org/my-org",
//     "agent": "agent/my-bot",
//     "serve": "public/.well-known/backlog.json"
//   }
//
// `serve` is the path the repository actually publishes from — the difference
// between a fragment that is committed and a fragment that is *reachable*. The
// estate learned this the expensive way with its directory fragments: they
// lived at the repository root, where a Next app serves nothing, so the
// federated merge could not be assembled by anyone without a git checkout.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const BACKLOG_VERSION = '1'
export const ITEM_KINDS = ['idea', 'task', 'bug', 'blocker', 'decision']
export const ITEM_STATUSES = ['open', 'doing', 'blocked', 'done', 'dropped']
// Declared once and read by both the validator and the writers. They were two
// numbers in one function for months, which is how `file` and `revise` came to
// mint items `check` refuses: an item is an intention, and an intention that
// needs three thousand characters is a document filed in the wrong place.
export const TITLE_MAX = 140
export const DETAIL_MAX = 2000
export const DECAY_DAYS = { idea: 180, task: 90, bug: 30, decision: 30, blocker: 14 }
const DAY = 86_400_000

export const today = (now = new Date()) => now.toISOString().slice(0, 10)

export function expiryFor(kind, asserted) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asserted)) throw new TypeError(`asserted "${asserted}" is not a YYYY-MM-DD date`)
  const days = DECAY_DAYS[kind]
  if (days === undefined) throw new TypeError(`no decay window for kind "${kind}"`)
  const at = Date.parse(`${asserted}T00:00:00Z`)
  if (Number.isNaN(at)) throw new TypeError(`asserted "${asserted}" is not a real date`)
  return new Date(at + days * DAY).toISOString().slice(0, 10)
}

export function normaliseCapabilities(input) {
  if (!input) return undefined
  const out = []
  const seen = new Set()
  for (const raw of input) {
    const clean = String(raw).trim().toLowerCase()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length === 20) break
  }
  return out.length ? out : undefined
}

// ── Checking ────────────────────────────────────────────────────────────────
//
// A local gate that needs no install, covering the rules a hand-edited
// items.json can break — including the two the format exists for. The package
// is authoritative; `vendor.test.ts` asserts the two agree about which
// documents are acceptable across a corpus of valid and forged ones, so this
// being "the quick one" never means "the lenient one".

const ITEM_ID_RE = /^backlog\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
const NODE_ID_RE = /^[a-z]+\/[a-z0-9][a-z0-9._-]*$/
const REPO_RE = /^repo\/[a-z0-9][a-z0-9._-]*$/
const ORG_RE = /^org\/[a-z0-9][a-z0-9._-]*$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const VISIBILITIES = ['public', 'partner', 'private']

const repoOfItem = (id) => {
  const parts = String(id ?? '').split('/')
  return parts.length === 3 ? `repo/${parts[1]}` : undefined
}

/** Every problem in a fragment, as `[code, subject]` pairs. Empty means valid. */
export function checkFragment(fragment) {
  const out = []
  const add = (code, subject) => out.push([code, subject])

  // `intent` is the key since the format became IntentMesh's intent/1; `backlog`
  // is the key it shipped under first and is accepted forever. Either, same version.
  if ((fragment?.intent ?? fragment?.backlog) !== BACKLOG_VERSION) add('bad-version')
  if (!REPO_RE.test(fragment?.source ?? '')) add('bad-fragment-source')
  if (!ORG_RE.test(fragment?.org ?? '')) add('bad-fragment-org')
  if (!fragment?.generated || Number.isNaN(Date.parse(fragment.generated))) add('bad-generated')
  if (!Array.isArray(fragment?.items)) { add('no-items'); return out }

  const seen = new Map()
  for (const item of fragment.items) {
    const at = item?.id ?? '(no id)'
    if (!item || typeof item !== 'object') { add('not-an-item'); continue }

    if (!ITEM_ID_RE.test(item.id ?? '')) add('bad-id', at)
    if (!Number.isInteger(item.rev) || item.rev < 1) add('bad-rev', at)
    if (!ITEM_KINDS.includes(item.kind)) add('bad-kind', at)
    if (!ITEM_STATUSES.includes(item.status)) add('bad-status', at)
    if (!item.title?.trim()) add('no-title', at)
    else if (item.title.length > TITLE_MAX) add('title-too-long', at)
    if (item.detail && item.detail.length > DETAIL_MAX) add('detail-too-long', at)
    if (item.owner !== undefined && !NODE_ID_RE.test(item.owner)) add('bad-owner', at)
    if (!REPO_RE.test(item.source?.repo ?? '')) add('bad-source', at)
    if (item.source?.ref !== undefined && !/^https:\/\//.test(item.source.ref)) add('bad-ref', at)

    if (item.capabilitiesWanted !== undefined) {
      const normalised = normaliseCapabilities(item.capabilitiesWanted)
      if (JSON.stringify(normalised ?? []) !== JSON.stringify(item.capabilitiesWanted))
        add('unnormalised-capabilities', at)
    }

    if (!DATE_RE.test(item.asserted ?? '')) add('bad-asserted', at)
    if (!item.assertedBy || !NODE_ID_RE.test(item.assertedBy)) add('no-asserter', at)
    if (!VISIBILITIES.includes(item.visibility)) add('bad-visibility', at)

    // Expiry is derived. A writer that can nudge its own keeps a dead idea
    // current forever.
    if (DATE_RE.test(item.asserted ?? '') && ITEM_KINDS.includes(item.kind)) {
      if (item.expires !== expiryFor(item.kind, item.asserted)) add('derived-expiry', at)
    } else if (!DATE_RE.test(item.expires ?? '')) add('bad-expires', at)

    // Filed is not published.
    const published = item.visibility === 'public' || item.visibility === 'partner'
    if (published && !item.promoted) add('unpromoted-publication', at)
    if (item.promoted) {
      if (!published) add('promoted-but-private', at)
      if (!DATE_RE.test(item.promoted.at ?? '')) add('bad-promotion-date', at)
      if (!String(item.promoted.by ?? '').startsWith('person/')) add('non-human-promotion', at)
      if (DATE_RE.test(item.promoted.at ?? '') && DATE_RE.test(item.asserted ?? '') && item.promoted.at < item.asserted)
        add('promoted-before-filed', at)
    }

    const owning = repoOfItem(item.id)
    if (owning && owning !== fragment.source) add('foreign-item', at)
    if (item.source?.repo && owning && item.source.repo !== owning) add('source-mismatch', at)
    if (String(item.owner ?? '').startsWith('org/') && item.owner !== fragment.org) add('foreign-owner', at)

    if (item.id) {
      if (seen.get(item.id) === item.rev) add('duplicate-revision', at)
      seen.set(item.id, Math.max(seen.get(item.id) ?? 0, item.rev ?? 0))
    }
  }
  return out
}

// ── State ───────────────────────────────────────────────────────────────────

const DIR = '.backlog'
const ITEMS = join(DIR, 'items.json')
const CONFIG = join(DIR, 'config.json')

const readConfig = () => {
  if (!existsSync(CONFIG)) throw new Error(`${CONFIG} is missing — create it with { "source": "repo/x", "org": "org/x", "agent": "agent/x" }`)
  return JSON.parse(readFileSync(CONFIG, 'utf8'))
}
const readItems = () => (existsSync(ITEMS) ? JSON.parse(readFileSync(ITEMS, 'utf8')) : [])
const writeItems = (items) => { mkdirSync(DIR, { recursive: true }); writeFileSync(ITEMS, `${JSON.stringify(items, null, 2)}\n`) }

// ── Commands ────────────────────────────────────────────────────────────────

// Every rule `checkFragment` enforces on a field, enforced at the moment the
// field is written. The validator had all three and the writers had none, so
// `file` and `revise` could both mint an item `check` refuses — and did:
// two items carried a status the vocabulary has no word for, and two carried a
// detail past the bound, which turned the Backlog workflow red on every run for
// a day with the bad fragment already committed. A writer that can construct
// what the validator refuses moves the failure from the keystroke to a
// scheduled job somebody has stopped reading.
function refuseBadField(status, title, detail) {
  if (status !== undefined && !ITEM_STATUSES.includes(status))
    throw new Error(`status must be one of ${ITEM_STATUSES.join(', ')}, got "${status}"`)
  if (title !== undefined && String(title).trim().length > TITLE_MAX)
    throw new Error(`title is ${String(title).trim().length} characters; the bound is ${TITLE_MAX}`)
  if (detail !== undefined && String(detail).trim().length > DETAIL_MAX)
    throw new Error(`detail is ${String(detail).trim().length} characters; the bound is ${DETAIL_MAX}. An item is an intention — put the evidence where evidence lives and cite it`)
}

/** Always private, always rev 1, expiry always derived. There is no visibility argument. */
export function fileItem(config, { slug, kind, title, detail, owner, wants, ref, asserted = today(), by }) {
  if (!ITEM_KINDS.includes(kind)) throw new Error(`kind must be one of ${ITEM_KINDS.join(', ')}`)
  refuseBadField(undefined, title, detail)
  const repo = config.source.replace(/^repo\//, '')
  const item = {
    id: `backlog/${repo}/${slug}`,
    rev: 1,
    kind,
    status: 'open',
    title: String(title).trim(),
    source: ref ? { repo: config.source, ref } : { repo: config.source },
    assertedBy: by ?? config.agent,
    asserted,
    expires: expiryFor(kind, asserted),
    visibility: 'private',
  }
  if (detail) item.detail = String(detail).trim()
  if (owner) item.owner = owner
  const caps = normaliseCapabilities(wants)
  if (caps) item.capabilitiesWanted = caps
  return item
}

export function promoteItem(item, { by, to = 'partner', note, at = today() }) {
  if (!by?.startsWith('person/')) throw new Error(`promote requires a person/ node id, got "${by}" — agents suggest, humans consent`)
  const promoted = { at, by }
  if (note) promoted.note = String(note).trim()
  return { ...item, rev: item.rev + 1, visibility: to, promoted }
}

export function reviseItem(item, { by, status, title, detail, owner, wants, asserted = today() }) {
  refuseBadField(status, title, detail)
  const next = { ...item, rev: item.rev + 1, assertedBy: by, asserted, expires: expiryFor(item.kind, asserted) }
  if (status) next.status = status
  if (title) next.title = String(title).trim()
  if (detail) next.detail = String(detail).trim()
  // `--owner none` clears it. An item whose owner left is a different fact
  // from one that never had an owner, and there has to be a way to say so.
  if (owner === 'none') delete next.owner
  else if (owner) next.owner = owner
  // What the item wants, which is the only thing a matcher can act on.
  //
  // `file` has taken `--wants` since the beginning and nothing could add them
  // afterwards, so the fifty-three items already filed across the estate could
  // never become matchable — `toRoadmapItem` refuses an item with no
  // `capabilitiesWanted`, and every one of them was filed without any. A
  // format whose central field is write-once-at-creation is a format whose
  // central field is empty.
  if (wants !== undefined) {
    const caps = normaliseCapabilities(wants)
    if (caps) next.capabilitiesWanted = caps
    else delete next.capabilitiesWanted
  }
  return next
}

export function fragmentOf(config, items, generated = new Date().toISOString()) {
  // Both keys while the estate's vendored copies catch up: a reader holding the
  // pre-rename checker requires `backlog`; a reader of the spec reads `intent`.
  // `backlog` leaves the emit once no copy needs it; it never leaves a reader.
  return { intent: BACKLOG_VERSION, backlog: BACKLOG_VERSION, source: config.source, org: config.org, generated, items }
}

/**
 * Where else this fragment has to land to be reachable over https.
 *
 * A string or a list, and never the file we just wrote — a `serve` that points
 * at the root output would truncate it to empty on some filesystems and read
 * as "the emitter deleted my backlog".
 */
/**
 * The public tier, and only it.
 *
 * `partner` is deliberately excluded from anything served without
 * authentication: a partner-tier item behind no gate is a public item with a
 * misleading label. The package's `view()` grants partner to a *partner*, and
 * an unauthenticated fetch is not one.
 */
export const publicView = (items) => items.filter((i) => i?.visibility === 'public')

export function servedPaths(config, out) {
  const declared = config?.serve
  if (!declared) return []
  const list = Array.isArray(declared) ? declared : [declared]
  return list
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => p.trim())
    .filter((p) => join(p) !== join(out))
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function run(argv) {
  const command = argv[0]
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
  const has = (name) => argv.includes(`--${name}`)
  const config = readConfig()
  let items = readItems()

  const find = (id) => {
    const full = id.startsWith('backlog/') ? id : `backlog/${config.source.replace(/^repo\//, '')}/${id}`
    const item = items.find((i) => i.id === full)
    if (!item) throw new Error(`no item ${full}`)
    return item
  }
  const replace = (next) => { items = items.map((i) => (i.id === next.id ? next : i)); writeItems(items) }

  if (command === 'file') {
    const item = fileItem(config, {
      slug: flag('id'), kind: flag('kind') ?? 'task', title: flag('title'), detail: flag('detail'),
      owner: flag('owner'), ref: flag('ref'), by: flag('by'),
      wants: flag('wants')?.split(',').map((s) => s.trim()),
    })
    if (items.some((i) => i.id === item.id)) throw new Error(`${item.id} already exists — revise it instead`)
    items.push(item)
    writeItems(items)
    console.log(`filed ${item.id} (private, expires ${item.expires})`)
    return
  }
  if (command === 'promote') {
    const next = promoteItem(find(argv[1]), { by: flag('by'), to: flag('to') ?? 'partner', note: flag('note') })
    replace(next)
    console.log(`promoted ${next.id} to ${next.visibility} by ${next.promoted.by}`)
    return
  }
  if (command === 'revise') {
    // Everything about an item except its visibility. Promotion is a separate
    // verb because it is a separate decision — `promote` refuses anything but
    // a `person/` id, and folding it in here would give a revision the power
    // to publish.
    const next = reviseItem(find(argv[1]), {
      by: flag('by'), title: flag('title'), detail: flag('detail'), owner: flag('owner'),
      wants: has('wants') ? (flag('wants') === 'none' ? [] : flag('wants').split(',').map((s) => s.trim())) : undefined,
    })
    replace(next)
    console.log(`revised ${next.id} to rev ${next.rev}${next.capabilitiesWanted ? ` wanting ${next.capabilitiesWanted.join(', ')}` : ''}`)
    return
  }
  if (command === 'close') {
    const next = reviseItem(find(argv[1]), { by: flag('by'), status: has('dropped') ? 'dropped' : 'done' })
    replace(next)
    console.log(`${next.status} ${next.id}`)
    return
  }
  if (command === 'check') {
    const path = argv[1] ?? 'backlog.fragment.json'
    const problems = checkFragment(JSON.parse(readFileSync(path, 'utf8')))
    for (const [code, subject] of problems) console.error(`✗ ${subject ?? ''} [${code}]`)
    console.log(problems.length ? `${problems.length} problem(s)` : 'ok')
    process.exit(problems.length ? 1 : 0)
  }
  if (command === 'emit') {
    const out = flag('out') ?? 'backlog.fragment.json'
    // Validate BEFORE writing, never after. `emit` used to write whatever the
    // items file held and report the count as success, so a bad item reached
    // the fragment, the served projection and the commit, and the first thing
    // that said so was `check` in a scheduled job — by which time the invalid
    // record was already what the estate merged. Refusing here puts the failure
    // at the keystroke, in the working tree, where the fix is one revise.
    const fragment = fragmentOf(config, items)
    const problems = checkFragment(fragment)
    if (problems.length) {
      for (const [code, subject] of problems) console.error(`✗ ${subject ?? ''} [${code}]`)
      console.error(`refusing to emit: ${problems.length} problem(s). Fix the items with \`revise\` — hand-editing .backlog/items.json is what put them there.`)
      process.exit(1)
    }
    // The root output is the organisation's own full record — every tier.
    writeFileSync(out, `${JSON.stringify(fragment, null, 2)}\n`)
    console.log(`${items.length} items → ${out}`)

    // The served copy is the PUBLIC PROJECTION and never the full record.
    // Written rather than copied by a workflow, so there is one implementation
    // and the two cannot be one commit apart — and so that the filtering is
    // not a step somebody can forget. A `serve` path carrying private items is
    // a disclosure with a URL, which is the single worst thing this format
    // could do.
    const open = publicView(items)
    for (const path of servedPaths(config, out)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(fragmentOf(config, open), null, 2)}\n`)
      console.log(`${' '.repeat(String(items.length).length)}  → ${path} (served, ${open.length} public of ${items.length})`)
    }
    return
  }
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//   node')).join('\n'))
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try { run(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exit(1) }
}
