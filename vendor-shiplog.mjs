#!/usr/bin/env node
// A shiplog for a repository that has no package.json.
//
// This is the plug-and-play surface, and it is the one that decides whether
// `shipped/1` is a standard or a thing one estate does. Two of the
// repositories here are dependency-free static builders and the portfolio
// companies most likely to adopt this are the least likely to want an npm
// install to do it. So: copy this file in, run it with node, get a sealed,
// valid fragment derived from the history the repository already has.
//
//   node vendor-shiplog.mjs emit [--since 2026-01-01] [--rev origin/main] [--out F] [--rederive]
//   node vendor-shiplog.mjs verify <fragment.json>
//
// Configure once in .shiplog/config.json:
//   {
//     "source": "repo/my-repo",
//     "org": "org/my-org",
//     "assertedBy": "agent/my-ci",
//     "defaultAuthor": "person/me",
//     "authors": { "bot@example.com": "agent/my-bot" },
//     "prBase": "https://github.com/me/my-repo/pull/",
//     "branch": "main",
//     "serve": "public/.well-known/shiplog.json",
//     "serveDevlog": "public/.well-known/devlog.fragment.json"
//   }
//
// `branch` is the branch the *workflow* runs on. The log itself is always
// derived from HEAD unless `rev` says otherwise — see revOf.
//
// Every `emit` also writes `DEVLOG.md` and `devlog.fragment.json` — a
// human-readable changelog, derived from the same commits, filtered by its
// own (stricter) rule. See devlog.ts / the `devlog/1` section of SPEC.md.
// Unlike the ship log, a devlog has no `visibility` tier: it publishes by
// default, because it exists only to be read. `commitBase` (or a `prBase`
// shaped like a GitHub pull URL, from which one is derived for free) is
// where each entry's `ref` points; `serveDevlog` is where the same
// unfiltered fragment is also written, exactly like `serve` does for the
// ship log.
//
// `serve` is the path the repository actually publishes from — the difference
// between a fragment that is committed and a fragment that is *reachable*. The
// estate learned this the expensive way with its directory fragments: they
// lived at the repository root, where a Next app serves nothing, so the
// federated merge could not be assembled by anyone without a git checkout,
// which defeats the entire point of federating it.
//
// ── Two things it does not do ───────────────────────────────────────────────
//
// It does not publish. Every entry lands `private`; making the log public is a
// decision somebody takes by editing `visibility`, not a side effect of running
// a script for the first time over a decade of branch names.
//
// It reads `--first-parent`, so an entry is a *merge to the deploy branch*
// rather than every commit. A log of every keystroke is technically accurate
// and unreadable, and it turns a velocity chart into a measure of typing.
//
// `vendor.test.ts` asserts this file's canonicalisation, digest and kind
// mapping match the TypeScript package. A vendored copy that seals *almost*
// the same way produces entries that fail verification for everyone else,
// which is the worst possible failure for a record whose point is being
// checkable.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SHIPPED_VERSION = '1'
export const SHIP_KINDS = ['feature', 'fix', 'security', 'perf', 'docs', 'infra', 'spec', 'release', 'other']

// ── Sealing: byte-identical to @flashyos/verify's canonicalStringify ────────

export function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value))
}
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeysDeep(value[k])]))
  return value
}
export const hashPayload = (canonical) => createHash('sha256').update(canonical, 'utf8').digest('hex')

export function canonicalEntry(entry) {
  const { digest: _ignored, ...sealed } = entry
  return canonicalStringify(sealed)
}
export const seal = (entry) => ({ ...entry, digest: hashPayload(canonicalEntry(entry)) })
export function verifyEntry(entry) {
  const recomputed = hashPayload(canonicalEntry(entry))
  return { id: entry.id, ok: recomputed === entry.digest, claimed: entry.digest, recomputed }
}

// ── Deriving ────────────────────────────────────────────────────────────────

const PREFIX_KINDS = {
  feat: 'feature', feature: 'feature',
  fix: 'fix', bugfix: 'fix', hotfix: 'fix',
  security: 'security', sec: 'security',
  perf: 'perf', performance: 'perf',
  docs: 'docs', doc: 'docs',
  ci: 'infra', build: 'infra', chore: 'infra', infra: 'infra', deps: 'infra', refactor: 'infra', test: 'infra',
  spec: 'spec', rfc: 'spec',
  release: 'release',
}
const HEADER_RE = /^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$/i
const CLOSES_RE = /(?:closes|closed|fixes|backlog:)\s+(backlog\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)/gi
const PR_RE = /#(\d+)/
const INTEGRATION_MERGE_RE = /^merge (remote-tracking )?branch\b/i
const PR_MERGE_RE = /^merge pull request #\d+/i

// A merge of another branch into this line is not a ship. Sixty-five of this
// estate's first five hundred entries were these, and a reader scanning a
// changelog does not want "Merge branch 'main'" thirty times.
export const isIntegrationMerge = (subject) => INTEGRATION_MERGE_RE.test((subject ?? '').trim())
export const isPullRequestMerge = (subject) => PR_MERGE_RE.test((subject ?? '').trim())

// `Phase 3: gate mesh reporting`, `XP-7: the public Hunter Record page`. The
// verb that says what happened is on the far side of the colon. Capped so a
// sentence containing a colon is not mistaken for a prefix.
export const withoutPrefix = (subject) => {
  const m = /^[^:]{1,28}:\s*(.+)$/.exec((subject ?? '').trim())
  return m ? m[1] : (subject ?? '').trim()
}

// The one mechanism that involves no reading between lines: the author says so.
export function parseKindTrailer(body) {
  const m = /^[ \t]*kind:[ \t]*([a-z]+)[ \t]*$/im.exec(body ?? '')
  const kind = m?.[1]?.toLowerCase()
  return kind && SHIP_KINDS.includes(kind) ? kind : undefined
}

// Opt-in, and that is the point: a repository that declares no lexicon still
// gets `other`, because reading a convention nobody declared is guessing.
// Ambiguous verbs sit in infra — the safe direction for an unknown is the
// column nobody quotes.
export const IMPERATIVE_LEXICON = {
  feature: 'add publish serve build give advertise join emit declare introduce create ship launch enable expose offer open adopt record show render surface teach let count answer ask send anchor fold bring merge take land start seed scaffold port promote unify consolidate stand match catch close reject refuse deny report state audit review'.split(' '),
  fix: 'fix stop repair correct prevent unbreak resolve restore guard back revert'.split(' '),
  docs: 'document write explain describe clarify note spell say recommend brief'.split(' '),
  infra: 'update bump pin move rename remove delete refactor split extract tidy drop migrate upgrade gate link point align sync make put wire carry name replace switch keep hold set use run retire require derive reconcile scope harden turn rebuild rearchitect return redeploy trigger commit route repoint absorb shuffle rank exit prune trim tighten raise lower skip allow accept rewrite revise refresh rework initial'.split(' '),
  spec: 'specify define standardise standardize'.split(' '),
  release: 'release cut tag version'.split(' '),
}

export function buildLexicon(declared) {
  const out = new Map()
  for (const [kind, verbs] of Object.entries(declared ?? {})) {
    if (!SHIP_KINDS.includes(kind)) continue
    for (const verb of verbs) {
      const clean = String(verb).trim().toLowerCase()
      if (clean && !out.has(clean)) out.set(clean, kind)
    }
  }
  return out
}

const leadingVerb = (text) => (text ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? ''

export function parseSubject(subject, lexicon) {
  const trimmed = (subject ?? '').trim()
  const match = HEADER_RE.exec(trimmed)

  if (match) {
    const [, type, scope, bang, rest] = match
    const known = PREFIX_KINDS[type.toLowerCase()]
    if (known) {
      const scoped = scope?.slice(1, -1).toLowerCase()
      return {
        kind: scoped && PREFIX_KINDS[scoped] === 'release' ? 'release' : known,
        title: rest.trim(),
        breaking: bang === '!',
      }
    }
  }

  if (lexicon?.size) {
    for (const candidate of [trimmed, withoutPrefix(trimmed)]) {
      const kind = lexicon.get(leadingVerb(candidate))
      if (kind) return { kind, title: trimmed, breaking: false }
    }
  }

  return { kind: 'other', title: trimmed, breaking: false }
}

export function parseCloses(message) {
  return [...new Set([...(message ?? '').matchAll(CLOSES_RE)].map((m) => m[1]))]
}

export function parseGitLog(raw) {
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((record) => {
    const [sha, at, authorEmail, subject, body = ''] = record.split('\x1f')
    const coAuthorEmails = [...body.matchAll(/co-authored-by:[^<]*<([^>]+)>/gi)].map((m) => m[1])
    const commit = { sha, at, authorEmail, subject: subject ?? '' }
    if (body.trim()) commit.body = body.trim()
    if (coAuthorEmails.length) commit.coAuthorEmails = coAuthorEmails
    return commit
  }).filter((c) => c.sha && c.at)
}

/**
 * An address that belongs to a machine rather than a person.
 *
 * A fixed list and one convention, deliberately: `[bot]@` is GitHub's own
 * marker, and the local parts below are the identities CI actually commits
 * under — including `shiplog` and `backlog`, which are the two workflows this
 * format installs and which would otherwise file their own refresh commits
 * under a person.
 *
 * Not a heuristic. Matching on something looser — the domain, a `bot` prefix —
 * would file people under `agent/` on the strength of their email provider,
 * which is the same error pointed the other way. An address this does not
 * recognise is reported as unmapped and attributed to nobody in particular;
 * the fix is a line in `authors`, which is the author saying so.
 */
export const UNATTRIBUTED_AGENT = 'agent/unattributed'

const MACHINE_LOCAL_PARTS = new Set([
  'actions', 'github-actions', 'dependabot', 'renovate', 'shiplog', 'backlog', 'intent', 'notary', 'liveness',
  'pulse', 'delivery', 'directory', 'ritual',
])

export function isMachineAddress(email) {
  const address = String(email).toLowerCase().trim()
  if (address === 'noreply@anthropic.com') return true
  if (address.includes('[bot]@')) return true
  return MACHINE_LOCAL_PARTS.has(address.split('@')[0])
}

/**
 * Third-party bots whose address names a single app, so canon names them.
 *
 * `agent/unattributed` is right for a machine address nobody has named and
 * wrong for one that can only be a single app: Dependabot merges had sealed as
 * unattributed in four repositories by 2026-10-19, and each holds that set to a
 * frozen list. A closed list of two, in GitHub's own two address shapes —
 * `<name>[bot]@users.noreply.github.com` and the same with the app's numeric id
 * in front. Anchored both ends, so look-alikes such as `fake-dependabot[bot]@…`
 * or `dependabot[bot]@evil.example` do not match. The address is what a commit
 * CLAIMS: a git author email is self-asserted and canon does not verify it.
 * `github-actions[bot]` is deliberately absent: the estate's author register
 * says mapping it to an agent would inflate the agent share.
 *
 * Null means canon has no opinion; the caller falls through to the machine rule.
 */
export const CANON_BOT_AGENTS = Object.freeze(['dependabot', 'renovate'])
const CANON_BOT_RE = new RegExp(`^(?:\\d+\\+)?(${CANON_BOT_AGENTS.join('|')})\\[bot\\]@users\\.noreply\\.github\\.com$`)

export function canonBotAgent(email) {
  const match = CANON_BOT_RE.exec(String(email).toLowerCase().trim())
  return match ? `agent/${match[1]}` : null
}


/**
 * A commit this format's own workflows made, refreshing a file they generate.
 *
 * The log was recording its own bookkeeping as things that shipped: three
 * entries in flashy-ledger reading "shipped/1: refresh the log". A generated
 * file being regenerated is not work, and counting it inflates both the entry
 * count and the agent share — the two numbers this record exists to make
 * honest. Anchored to the subjects the emitted workflows commit under, with
 * room for the suffixes those subjects have since grown — ", and the
 * checkpoint over it" when a checkpoint rides along, and the "[skip ci]"
 * deploy-budget marker. The first version anchored on `$` exactly, and the
 * day the checkpoint suffix appeared every refresh commit in the estate
 * started sealing as a shipped entry under agent/unattributed. The lookahead
 * keeps the old guarantee: a subject that merely continues the phrase
 * ("refresh the logic") is a person's commit and is kept.
 *
 * Every format that emits a refresh commit is listed here, and adding one to
 * the estate without adding it here is the mistake this has now made three
 * times: the subject grew ", and the checkpoint over it", then the "[skip ci]"
 * deploy-budget marker, and then `directory/1` gained a workflow of its own on
 * 2026-09-01 whose refresh commits would have sealed as work in sixteen
 * repositories. A list, so the omission is visible in a diff.
 */
const BOOKKEEPING_SUBJECTS = [
  'shipped/1: refresh the log',
  'backlog/1: refresh the fragment',
  'directory/1: refresh the fragment',
  'delivery/1: what the fetch found',
  // intent/1 is backlog/1 extracted into IntentMesh; its emitted workflow
  // refreshes under this subject. Listed BEFORE any estate repository adopts
  // it, because the last two entries here were added after their commits had
  // already sealed as work.
  'intent/1: refresh the fragment',
  // ritual/1's Daily Office. Listed BEFORE ritual.yml's first run, because the
  // last three entries here were each added only after their commits had
  // sealed as work under agent/unattributed.
  'ritual/1: observe the office',
  // pulse/1's daily reading. Listed BEFORE pulse.yml's first run, for the same
  // reason as the two entries above it — and this one would inflate exactly
  // the numbers it exists to keep honest, since a condition series that seals
  // its own collection as work reports the estate shipping every time it
  // measures itself.
  'pulse/1: read the estate',
  // notary/1's fan-in. flashy-network's notary.yml folds every source's
  // fragment into the served log a few times a day and commits the result.
  // Listed here before the next fold rather than after — the same reason as
  // the four entries above, and the same reason each of those had to be added
  // late. Nothing in THIS repository commits it, which is why it belongs here
  // and not in AUTOMATION_SUBJECTS: that list is pinned to flashyos's own
  // workflows by an exact-set assertion, and `intent/1` is the precedent for a
  // subject a sibling repository writes.
  'notary/1: fold source fragments into the log',
]
// The lookahead keeps the old guarantee: a subject that merely CONTINUES the
// phrase ("refresh the logic") is a person's commit and is kept. Anything the
// subject grows AFTER a word boundary — a suffix, a marker — is bookkeeping.
const BOOKKEEPING_RE = new RegExp(
  `^(${BOOKKEEPING_SUBJECTS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![a-z])`,
)

/**
 * Dated subjects flashyos's own scheduled jobs commit under.
 *
 * A different shape from BOOKKEEPING_SUBJECTS — a prefix and a date rather
 * than a format id, pinned to flashyos's own workflows by an exact-set
 * assertion in tools/shiplog-attribution.test.mjs there. A vendored copy
 * missing this filtered nothing for these five and let their scheduled
 * refresh commits seal as shipped work under agent/unattributed, discovered
 * while wiring up devlog/1 on 2026-09-22.
 */
const AUTOMATION_SUBJECTS = [
  'Adoption signal: ', // adoption-signal.yml
  'Registry: re-verified ', // registry.yml
  'Estate graph: reassembled ', // graph.yml
  'Estate record: merged ', // estate-record.yml
  'scoreboard: the estate, read ', // scoreboard.yml
]
// Anchored on the date, so a person writing "Estate record: merged, finally"
// is still a person. What identifies these is the prefix AND the stamp.
const AUTOMATION_RE = new RegExp(
  `^(${AUTOMATION_SUBJECTS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})20\\d\\d-\\d\\d-\\d\\d\\b`,
)

export const isOwnBookkeeping = (subject) => {
  const s = (subject ?? '').trim()
  return BOOKKEEPING_RE.test(s) || AUTOMATION_RE.test(s)
}

export function fromCommits(commits, options) {
  const repoSlug = options.repo.replace(/^repo\//, '')
  const asserted = options.asserted ?? new Date().toISOString().slice(0, 10)
  const authors = options.authors ?? {}
  const unmapped = new Set()
  const lexicon = options.lexicon
    ? buildLexicon(options.lexicon === 'imperative' ? IMPERATIVE_LEXICON : options.lexicon)
    : undefined
  const declaredKinds = options.kinds ?? {}
  const badKinds = new Map()
  const held = options.held ?? {}
  const nodeFor = (email) => {
    const mapped = authors[email.toLowerCase()]
    if (mapped) return mapped
    // Canon resolves a recognised bot, so there is nothing for the repository
    // to fix and the address is not reported as unmapped. `authors` was
    // consulted first and still wins.
    const bot = canonBotAgent(email)
    if (bot) return bot
    unmapped.add(email)
    // `defaultAuthor` is a fallback for a *person* whose address is not in the
    // table yet. An address that is plainly a machine's must never reach it.
    //
    // This estate ran with `authors: {}` and a `defaultAuthor` of
    // `person/michael`, and the log came back 116 entries, 0 by an agent, 116
    // by a person — while 95 of the 107 commits behind it were authored by
    // `noreply@anthropic.com`. The emitter did print "2 unmapped authors", and
    // a warning that the run then contradicts is not a guard.
    //
    // Human/agent attribution is the number this whole record exists to make
    // checkable. Getting it wrong in the safe direction — an unnamed agent —
    // costs a config entry. Getting it wrong the other way credits a person
    // with work they did not do, in a document built to be cited.
    return isMachineAddress(email) ? UNATTRIBUTED_AGENT : options.defaultAuthor
  }

  const shipped = options.keepIntegrationMerges
    ? commits
    : commits.filter((c) => !isIntegrationMerge(c.subject) && !isOwnBookkeeping(c.subject))

  const entries = shipped.map((commit) => {
    const message = `${commit.subject}\n${commit.body ?? ''}`
    const inferred = parseSubject(commit.subject, lexicon)
    // Precedence, most authoritative first: a person's recorded decision, the
    // author's own trailer, then what can be read off the subject.
    const overridden = declaredKinds[commit.sha] ?? declaredKinds[commit.sha.slice(0, 12)]
    // A recorded decision that names a kind this format does not have was
    // silently ignored, which is the worst outcome available: somebody went to
    // the trouble of deciding and the log carried `other` anyway, with nothing
    // saying so. Now it is reported. The file is a person's judgement and a
    // typo in it must not read as an absence of judgement.
    if (overridden !== undefined && !SHIP_KINDS.includes(overridden)) {
      badKinds.set(commit.sha.slice(0, 12), overridden)
    }
    const declared = SHIP_KINDS.includes(overridden) ? overridden : undefined
    const kind = declared ?? parseKindTrailer(commit.body) ?? inferred.kind
    const { title, breaking } = inferred
    const by = [...new Set([commit.authorEmail, ...(commit.coAuthorEmails ?? [])].filter(Boolean).map(nodeFor))]
    const entry = {
      id: `ship/${repoSlug}/${commit.sha.slice(0, 12).toLowerCase()}`,
      repo: options.repo,
      at: commit.at,
      kind,
      title: (breaking ? `${title} (breaking)` : title).slice(0, 140),
      by: by.length ? by : [options.defaultAuthor],
      asserted,
      assertedBy: options.assertedBy,
      // A repository publishes; an entry may still be held back.
      //
      // `visibility` is one field and it turns a whole log public. That is the
      // right shape for the decision — but it is not the only decision. An
      // entry can describe a security gap that is still open: this estate has
      // one saying which file in which repository carried a live signing
      // secret, that the secret is in git history on two repositories, and
      // that it has not been rotated. Publishing the log publishes the
      // exploitation route.
      //
      // So `.shiplog/held.json` lists shas that stay private whatever the
      // repository default is. Held rather than deleted: the entry is still in
      // the repository's own full record, still sealed, still countable. What
      // changes is only whether a stranger can read it.
      visibility: held[commit.sha] || held[commit.sha.slice(0, 12)] ? 'private' : (options.visibility ?? 'private'),
    }
    const detail = (commit.body ?? '').trim()
    if (detail) entry.detail = detail.slice(0, 2000)
    const refs = { commit: commit.sha.toLowerCase() }
    const pr = options.prBase ? PR_RE.exec(commit.subject) : null
    if (pr) refs.pr = `${options.prBase}${pr[1]}`
    entry.refs = refs
    const closes = parseCloses(message)
    if (closes.length) entry.closes = closes
    return seal(entry)
  })

  return { entries, unmapped: [...unmapped].sort(), badKinds: [...badKinds] }
}

// ── devlog/1 — the human-readable half, alongside shipped/1 ─────────────────
//
// See src/devlog.ts for the full account. This must derive byte-identical
// entries to that module — src/devlog.test.ts differentials this copy against
// it the same way vendor.test.ts already differentials the ship derivation.
//
// "Devlog" and "changelog" name the same artifact here — see packages/shiplog/
// SPEC.md's `devlog/1` section before building a second thing under the other
// name.

export const DEVLOG_VERSION = '1'
export const DEVLOG_ENTRY_ID_RE = /^devlog\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
const SKIP_MARKER_RE = /\[(skip ci|vercel skip)\]/i
const MAX_SUMMARY = 280

// A devlog has no attribution field to file a machine's commit under, so —
// unlike a ship entry, which keeps a bot's commit under agent/unattributed —
// isDevlogWorthy drops it outright: a bot regenerating a fragment is not a
// "notable shipped change" worth a prose line.
export function isDevlogWorthy(commit) {
  if (isIntegrationMerge(commit.subject)) return false
  if (isOwnBookkeeping(commit.subject)) return false
  if (SKIP_MARKER_RE.test(commit.subject ?? '')) return false
  if (isMachineAddress(commit.authorEmail)) return false
  return true
}

export function summaryFromSubject(subject) {
  const { title } = parseSubject(subject)
  const trimmed = (title || subject || '').trim()
  if (!trimmed) return trimmed
  const capitalised = trimmed[0].toUpperCase() + trimmed.slice(1)
  return capitalised.length > MAX_SUMMARY ? capitalised.slice(0, MAX_SUMMARY) : capitalised
}

// `prBase` is already `https://github.com/<org>/<repo>/pull/` in every
// .shiplog/config.json in the estate; swapping `pull` for `commit` gets a
// devlog ref for free, with no new configuration, on a GitHub-hosted adopter.
export function commitBaseFrom(config) {
  if (config.commitBase) return config.commitBase
  const match = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/$/.exec(config.prBase ?? '')
  return match ? `${match[1]}/commit/` : undefined
}

export function devlogEntriesFromCommits(commits, options) {
  const repoSlug = options.repo.replace(/^repo\//, '')
  const held = options.held ?? {}
  return commits
    .filter((c) => isDevlogWorthy(c) && !held[c.sha] && !held[c.sha.slice(0, 12)])
    .map((commit) => {
      const sha = commit.sha.toLowerCase()
      const short = sha.slice(0, 12)
      const ref = options.commitBase ? `${options.commitBase}${sha}` : `${options.repo}#${short}`
      return {
        id: `devlog/${repoSlug}/${short}`,
        at: commit.at,
        summary: summaryFromSubject(commit.subject),
        commitSha: sha,
        ref,
      }
    })
    .filter((e) => e.summary.length > 0)
}

export const byDevlogRecency = (a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? 1 : -1)

// The same union rule as mergeEntries: an id already present is kept as it
// stands, and only genuinely new ids are added.
export function mergeDevlogEntries(existing, derived) {
  const byId = new Map()
  for (const entry of derived) byId.set(entry.id, entry)
  for (const entry of existing) byId.set(entry.id, entry)
  return [...byId.values()].sort(byDevlogRecency)
}

export const devlogFragmentOf = (config, entries, generated = new Date().toISOString()) => ({
  devlog: DEVLOG_VERSION, source: config.source, org: config.org, generated, entries,
})

export function renderDevlogMarkdown(entries, options = {}) {
  const title = options.title ?? 'Devlog'
  const sorted = [...entries].sort(byDevlogRecency)
  const lines = [
    `# ${title}`,
    '',
    '_This is the changelog. "Devlog" and "changelog" name the same document here —_',
    '_see `devlog/1` in `packages/shiplog/SPEC.md` if that reads like it needs reconciling._',
    '',
  ]
  if (!sorted.length) {
    lines.push('Nothing shipped yet.', '')
    return lines.join('\n')
  }
  let day = ''
  for (const entry of sorted) {
    const d = entry.at.slice(0, 10)
    if (d !== day) {
      if (day) lines.push('') // a blank line between one day's list and the next heading
      day = d
      lines.push(`## ${day}`, '')
    }
    lines.push(`- ${entry.summary} ([\`${entry.commitSha.slice(0, 12)}\`](${entry.ref}))`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Where else this fragment has to land to be reachable over https.
 *
 * A string or a list, and never the file we just wrote — a `serve` that points
 * at the root output would truncate it to empty on some filesystems and read
 * as "the emitter deleted my changelog".
 */
/**
 * The public tier, and only it.
 *
 * `partner` is deliberately excluded from anything served without
 * authentication: a partner-tier entry behind no gate is a public entry with a
 * misleading label. The package's `view()` grants partner to a *partner*, and
 * an unauthenticated fetch is not one.
 */
/**
 * The public projection, with the hold applied a second time.
 *
 * `visibility` is inside an entry's digest, so an entry sealed public stays
 * sealed public — re-deriving it to change that is the restatement
 * append-only forbids. Applying the hold only at derivation therefore left
 * `.shiplog/held.json` unable to do the one job it most urgently has:
 * retracting something already served. So it applies here as well, and the
 * entry keeps its seal, its digest and its place in the record while simply
 * ceasing to be handed out.
 *
 * The sha is read from the entry, or resolved from the id where an entry
 * carries none — an id's last segment is the sha, and a hold that silently
 * missed those entries would look exactly like a hold that worked.
 */
export const publicView = (entries, held = {}) =>
  entries.filter((e) => {
    if (e?.visibility !== 'public') return false
    const sha = e.sha || String(e.id ?? '').split('/').pop() || ''
    // Same rule as derivation, stated the same way: a full sha or the
    // twelve-character form `held.json` is written in.
    return !(held[sha] || held[sha.slice(0, 12)])
  })

export function servedPathsFor(declared, out) {
  if (!declared) return []
  const list = Array.isArray(declared) ? declared : [declared]
  return list
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => p.trim())
    .filter((p) => join(p) !== join(out))
}

export function servedPaths(config, out) {
  return servedPathsFor(config?.serve, out)
}

export const fragmentOf = (config, entries, generated = new Date().toISOString()) => ({
  shipped: SHIPPED_VERSION, source: config.source, org: config.org, generated, entries,
})

/**
 * Config shape → derivation options.
 *
 * The config calls it `source` because that is the *fragment's* field; the
 * derivation calls it `repo` because that is the *entry's*. Exported and
 * tested rather than inlined in the CLI, because inlining it is exactly how
 * this shipped broken the first time: every pure function had a test, the one
 * line joining them to the config had none, and the failure was an
 * undefined-property crash on the first real run.
 */
export const deriveOptionsFrom = (config) => ({ ...config, repo: config.source })

// ── CLI ─────────────────────────────────────────────────────────────────────

const CONFIG = '.shiplog/config.json'
// sha → kind, for the third of real history that is a noun phrase with no verb
// to read. A person decides once and it is written down here.
const KINDS = '.shiplog/kinds.json'
// Shas held private regardless of the repository's `visibility`. Values are the
// reason, so the file says why rather than just listing hashes somebody must
// then go and reconstruct.
const HELD = '.shiplog/held.json'
const FORMAT = '%H%x1f%aI%x1f%aE%x1f%s%x1f%b%x1e'

/**
 * Which revision the log is derived from.
 *
 * `HEAD`, and not `config.branch`. Those are two different things that were
 * briefly one: `branch` is the branch the *workflow* runs on — the remote's
 * default branch — and a checkout on a feature branch, or a clone that never
 * created a local `main`, does not have it. Reading HEAD is right in both
 * places: locally it is what you have checked out, and in CI the checkout
 * action has already put you on the branch that triggered the run.
 *
 * `rev` exists for the one case that is neither: deriving a log for a branch
 * you are not on.
 */
/**
 * The existing entries plus any newly derived ones, newest first.
 *
 * An entry that is already in the fragment wins over a freshly derived one of
 * the same id. They should be identical; if they are not, the sealed one is the
 * record and the new one is a re-derivation under different config — and a
 * regeneration is not the place to silently restate history.
 */
export function mergeEntries(existing, derived) {
  const byId = new Map()
  for (const entry of derived) byId.set(entry.id, entry)
  for (const entry of existing) byId.set(entry.id, entry)
  return [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

export const revOf = (config) => config?.rev ?? 'HEAD'

export function readGitLog({ rev = 'HEAD', since } = {}) {
  const args = ['log', '--first-parent', `--pretty=format:${FORMAT}`, rev]
  if (since) args.push(`--since=${since}`)
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function run(argv) {
  const command = argv[0] ?? 'emit'
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }

  if (command === 'verify') {
    const path = argv[1] ?? '.shiplog/../shiplog.fragment.json'
    const fragment = JSON.parse(readFileSync(path, 'utf8'))
    const broken = (fragment.entries ?? []).map(verifyEntry).filter((c) => !c.ok)
    for (const c of broken) console.error(`✗ ${c.id} claims ${c.claimed.slice(0, 12)}… hashes to ${c.recomputed.slice(0, 12)}…`)
    console.log(broken.length ? `${broken.length} broken seal(s)` : `ok — ${fragment.entries.length} seals recomputed`)
    process.exit(broken.length ? 1 : 0)
  }

  if (!existsSync(CONFIG)) throw new Error(`${CONFIG} is missing — see the header of this file for its shape`)
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
  // `--rev` overrides what the log is derived from. CI never needs it — a
  // runner checks out the default branch and `HEAD` is the right answer — but
  // a person correcting a fragment from a feature branch does, because their
  // own first-parent line is not the trunk's and deriving from it would file
  // the branch's shape as the repository's history.
  const raw = readGitLog({ rev: flag('rev') ?? revOf(config), since: flag('since') })
  // A recorded human decision per commit, for the ones nothing can read.
  const kinds = existsSync(KINDS) ? JSON.parse(readFileSync(KINDS, 'utf8')) : {}
  const held = existsSync(HELD) ? JSON.parse(readFileSync(HELD, 'utf8')) : {}
  const derived = fromCommits(parseGitLog(raw), { ...deriveOptionsFrom(config), kinds, held })
  const { unmapped, badKinds } = derived
  const out = flag('out') ?? 'shiplog.fragment.json'

  // Sealed and never decays — which has to survive a regeneration, or it is a
  // sentence rather than a property.
  //
  // The log is derived with `--first-parent`, so it tells the trunk's story
  // rather than every commit. The consequence nobody saw coming: a commit that
  // is first-parent while you are on a branch stops being first-parent the
  // moment that branch is merged. Emit again and it is simply gone. Running
  // this in flashyos on 2026-08-30 took the fragment from 84 entries to 102 by
  // adding 32 and *deleting 14* whose commits were still perfectly reachable.
  //
  // So an emit is a union, not a replacement. Entries already in the fragment
  // are kept byte-for-byte — they are sealed, and re-deriving one would
  // recompute a digest that is not ours to recompute — and only genuinely new
  // ids are added. The result is append-only for the same reason the
  // Directory's assertions are: a record of the past that a later commit can
  // quietly shorten is not evidence of anything.
  // `--rederive` discards what is there and takes the derivation as it stands.
  //
  // There has to be a way to correct a derivation that was wrong — this
  // estate's first log filed 95 agent-authored commits under a person, and
  // append-only would otherwise have made that permanent. But it is a stated
  // act, never something a scheduled run does on its own: CI runs plain `emit`,
  // and plain `emit` cannot shorten or restate the record. Correct before you
  // publish; after publication a re-derivation is a revision somebody else has
  // already cited.
  const rederive = argv.includes('--rederive')
  const kept = !rederive && existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')).entries ?? []) : []
  const entries = mergeEntries(kept, derived.entries)
  const added = entries.length - kept.length

  writeFileSync(out, `${JSON.stringify(fragmentOf(config, entries), null, 2)}\n`)
  const how = rederive ? ' (re-derived — previous entries discarded)' : kept.length ? ` (${added} new, ${kept.length} kept)` : ''
  console.log(`${entries.length} entries → ${out}${how}`)

  // The served copy is the PUBLIC PROJECTION and never the full record.
  // Written rather than copied by a workflow, so there is one implementation,
  // the two cannot be one commit apart, and the filtering is not a step
  // somebody can forget. A `serve` path carrying private entries is a
  // disclosure with a URL.
  //
  // Derived entries land private unless `visibility` says otherwise in the
  // config, so a repository that adopts this and changes nothing else
  // publishes an empty log. That is the intended first state: publishing is a
  // decision somebody takes, not a side effect of running a script over a
  // decade of branch names.
  const open = publicView(entries, held)
  for (const path of servedPaths(config, out)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(fragmentOf(config, open), null, 2)}\n`)
    console.log(`${' '.repeat(String(entries.length).length)}  → ${path} (served, ${open.length} public of ${entries.length})`)
  }
  // devlog/1 — the human-readable half, derived from the SAME parsed commits
  // (not the ship-filtered `shipped` list above: isDevlogWorthy applies its
  // own, stricter rule — see devlogEntriesFromCommits). Unlike shipped/1, a
  // devlog publishes by default: it exists only to be read on this
  // property's own site, so there is no `visibility` tier to opt into. The
  // one redaction it honours is the same `.shiplog/held.json` shipped/1
  // already reads, so a commit held for naming a live credential is held out
  // of both records at once.
  const commitBase = commitBaseFrom(config)
  const devlogDerived = devlogEntriesFromCommits(parseGitLog(raw), { repo: config.source, commitBase, held })
  const devlogOut = flag('devlog-out') ?? 'devlog.fragment.json'
  const devlogKept = !rederive && existsSync(devlogOut) ? (JSON.parse(readFileSync(devlogOut, 'utf8')).entries ?? []) : []
  const devlogEntries = mergeDevlogEntries(devlogKept, devlogDerived)
  const devlogAdded = devlogEntries.length - devlogKept.length

  writeFileSync(devlogOut, `${JSON.stringify(devlogFragmentOf(config, devlogEntries), null, 2)}\n`)
  const devlogHow = rederive ? ' (re-derived — previous entries discarded)' : devlogKept.length ? ` (${devlogAdded} new, ${devlogKept.length} kept)` : ''
  console.log(`${devlogEntries.length} devlog entries → ${devlogOut}${devlogHow}`)

  const devlogMdOut = flag('devlog-md-out') ?? 'DEVLOG.md'
  writeFileSync(devlogMdOut, renderDevlogMarkdown(devlogEntries, { title: config.devlogTitle }))
  console.log(`${' '.repeat(String(devlogEntries.length).length)}  → ${devlogMdOut}`)

  // Served the same way shiplog.json is: a distinct config key, because a
  // devlog and a ship log usually do not want to land at the same well-known
  // path, and because a devlog has no private tier to filter on the way
  // through — the served copy IS the full devlog.fragment.json.
  for (const path of servedPathsFor(config.serveDevlog, devlogOut)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(devlogFragmentOf(config, devlogEntries), null, 2)}\n`)
    console.log(`${' '.repeat(String(devlogEntries.length).length)}  → ${path} (served, ${devlogEntries.length} of ${devlogEntries.length})`)
  }

  if (badKinds?.length) {
    console.log(`\n${badKinds.length} recorded decision${badKinds.length === 1 ? '' : 's'} in ${KINDS} name${badKinds.length === 1 ? 's' : ''} a kind this format does not have:`)
    for (const [sha, kind] of badKinds) console.log(`  ${sha}  "${kind}"`)
    console.log(`  valid: ${SHIP_KINDS.join(', ')}`)
    console.log('  these were ignored, and the entries stayed `other`')
  }
  if (unmapped.length) {
    console.log(`\n${unmapped.length} unmapped author${unmapped.length === 1 ? '' : 's'} — add these to config.authors:`)
    for (const email of unmapped) console.log(`  ${email}`)
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try { run(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exit(1) }
}
