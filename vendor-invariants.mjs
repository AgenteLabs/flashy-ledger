// invariants/1 — the harness every money or authority component proves itself with.
//
// An external audit of this estate found six behavioural defects, and our own
// audit of the settlement path found five more, and every one of the eleven
// had the same shape: a guarantee that held for one operation at a time and
// broke for a PAIR — two authorizations executing at once, two locks reserving
// the same balance, a release landing after the midnight the reservation was
// booked before. Each component had a test suite; none had a test that ran
// two things together. This file is that test, written once.
//
// It is vendored byte-identically into each component as
// `vendor-invariants.mjs` (never edited there; a drift test compares each copy
// to this one and reports UNKNOWN, never passed, when this project is absent).
// Dependency-free: node: builtins only, and nothing here imports anything.
//
// Four pieces:
//
//   property()      — a seeded, property-based runner: random command
//                     sequences against a fresh system, invariants checked
//                     after every command, the failing sequence SHRUNK to a
//                     minimal one and reported with its seed so it replays.
//   interleave()    — the pair runner: every ordered pair of operations, run
//                     one after the other, the other way round, concurrently
//                     in both start orders, and — when the component exposes a
//                     clock — across a clock boundary. Invariants are checked
//                     after every schedule, with the settled results in hand
//                     so "exactly one succeeded" is a thing a check can say.
//   expectViolation — the mutation check: hands the harness a deliberately
//                     broken variant and insists the harness catches it. A
//                     harness that has never failed has proved nothing.
//   checkInvariantsDoc / cli — the INVARIANTS.md contract: every guarantee
//                     numbered I-1.., each with Claim / Why / Enforced by /
//                     Proved by, and every `› *cited test*` present in the
//                     suite. `node vendor-invariants.mjs check <dir>` is the
//                     command a CI step runs.

export const KIT = 'invariants/1'

// ── seeded randomness ───────────────────────────────────────────────────────
// A failing run is worth nothing unless it replays, so every run is a seed.
// LCG (Numerical Recipes constants), the same generator spec-kit's fuzz uses.
export function rng(seed = 20261010) {
  let s = seed >>> 0
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  return {
    seed,
    next,
    int: (n) => Math.floor(next() * n),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    bool: (p = 0.5) => next() < p,
  }
}

export class InvariantViolation extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'InvariantViolation'
    Object.assign(this, details)
  }
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v.filter(Boolean) : [String(v)])

/** Run `invariants(system, ctx)`; a thrown error is a violation too, never a crash of the harness. */
async function violations(invariants, system, ctx) {
  try { return asList(await invariants(system, ctx)) } catch (err) { return [`invariant check threw: ${err?.message ?? err}`] }
}

// ── property(): random sequences, shrunk ────────────────────────────────────
//
//   await property({
//     setup:      async () => makeSystem(),             // a FRESH system per run
//     commands:   [{ name: 'lock', gen: (r) => ({ amount: r.int(100) }), run: (sys, a) => sys.lock(a) }, …],
//     invariants: (sys, { applied }) => [ ...reasons it is wrong, or [] ],
//     tick:       async (sys) => sys.clock.advance(1),  // optional: a clock-boundary command the runner mixes in
//     runs: 200, maxLen: 12, seed: 7,
//   })
//
// A command may throw: a refusal is a legitimate outcome, so it is recorded
// (`applied[i].error`) and the invariants are still checked. Only an invariant
// returning a reason fails the run. On failure the sequence is shrunk by
// delta debugging — drop halves, then quarters, then single commands, replaying
// from a fresh setup each time — and the MINIMAL failing sequence is thrown
// with its seed, so the component's test can pin it as a regression.
export async function property({ setup, commands, invariants, tick, runs = 200, maxLen = 12, seed = 20261010 }) {
  if (typeof setup !== 'function') throw new TypeError('property: setup must be a function returning a fresh system')
  if (!Array.isArray(commands) || commands.length === 0) throw new TypeError('property: commands must be a non-empty array')
  if (typeof invariants !== 'function') throw new TypeError('property: invariants must be a function')
  const all = tick ? [...commands, { name: 'tick', gen: () => ({}), run: (sys) => tick(sys) }] : commands
  const r = rng(seed)

  const replay = async (seq) => {
    const sys = await setup()
    const applied = []
    for (const step of seq) {
      const cmd = all.find((c) => c.name === step.name)
      let result, error
      try { result = await cmd.run(sys, step.args) } catch (err) { error = err?.message ?? String(err) }
      applied.push({ name: step.name, args: step.args, result, error })
      const v = await violations(invariants, sys, { applied, step: applied.length - 1 })
      if (v.length) return { failed: true, at: applied.length - 1, violations: v, applied }
    }
    return { failed: false, applied }
  }

  let totalCommands = 0
  for (let run = 0; run < runs; run++) {
    const len = 1 + r.int(maxLen)
    const seq = []
    for (let i = 0; i < len; i++) {
      const cmd = r.pick(all)
      seq.push({ name: cmd.name, args: cmd.gen ? await cmd.gen(r, seq) : {} })
    }
    const outcome = await replay(seq)
    totalCommands += outcome.applied.length
    if (!outcome.failed) continue
    const failing = seq.slice(0, outcome.at + 1)
    const minimal = await shrink(failing, async (s) => (await replay(s)).failed)
    const final = await replay(minimal)
    throw new InvariantViolation(
      `invariant violated after ${minimal.length} command(s) (seed ${seed}, run ${run}):\n` +
        minimal.map((s, i) => `  ${i + 1}. ${s.name} ${JSON.stringify(s.args)}${final.applied[i]?.error ? `  → refused: ${final.applied[i].error}` : ''}`).join('\n') +
        `\n  violations: ${final.violations.join('; ')}`,
      { seed, run, sequence: minimal, violations: final.violations, applied: final.applied },
    )
  }
  return { kit: KIT, seed, runs, commands: totalCommands }
}

/** Delta debugging: the smallest subsequence for which `fails` still holds. */
export async function shrink(seq, fails) {
  let cur = seq
  let n = 2
  while (cur.length >= 2) {
    const size = Math.ceil(cur.length / n)
    let reduced = false
    for (let i = 0; i < cur.length; i += size) {
      const candidate = [...cur.slice(0, i), ...cur.slice(i + size)]
      if (candidate.length && (await fails(candidate))) { cur = candidate; n = Math.max(n - 1, 2); reduced = true; break }
    }
    if (!reduced) {
      if (n >= cur.length) break
      n = Math.min(n * 2, cur.length)
    }
  }
  return cur
}

// ── interleave(): every pair, every schedule ────────────────────────────────
//
//   await interleave({
//     setup:      async () => makeSystem(),              // a FRESH system per schedule
//     ops:        [{ name: 'execute', run: (sys) => sys.execute(auth) }, …],
//     invariants: (sys, { results, schedule }) => [...],  // results: settled outcomes in op order
//     tick:       async (sys) => sys.clock.advance(1),   // optional: enables the clock-boundary schedules
//     pairs:      'all' | 'distinct' | [['a','b'], …],   // default 'all': every ordered pair, self-pairs included
//   })
//
// Schedules per pair (a, b):
//   a;b      sequential            b;a      the other order
//   a||b     started together      b||a     the other start order
//   a|y|b    a started, one macrotask yielded, then b — lets a's first await land before b begins
//   a;T;b    a, then the clock advances, then b     (only when `tick` is given)
//   a||T||b  a and b started together with the clock advancing between them (only when `tick` is given)
//
// A rejected op is a refusal, not a failure: it is handed to the invariants as
// { ok: false, error }. Only an invariant returning a reason fails a schedule.
// Every failing schedule is collected and thrown together, so one run reports
// the whole shape of the defect rather than the first corner of it.
export async function interleave({ setup, ops, invariants, tick, pairs = 'all' }) {
  if (typeof setup !== 'function') throw new TypeError('interleave: setup must be a function returning a fresh system')
  if (!Array.isArray(ops) || ops.length === 0) throw new TypeError('interleave: ops must be a non-empty array')
  if (typeof invariants !== 'function') throw new TypeError('interleave: invariants must be a function')
  const byName = Object.fromEntries(ops.map((o) => [o.name, o]))
  let pairList
  if (Array.isArray(pairs)) pairList = pairs.map(([a, b]) => [byName[a], byName[b]])
  else pairList = ops.flatMap((a) => ops.filter((b) => pairs === 'all' || b !== a).map((b) => [a, b]))
  for (const [a, b] of pairList) if (!a || !b) throw new TypeError('interleave: a named pair does not match an op')

  const settle = (p) => Promise.resolve().then(() => p).then((value) => ({ ok: true, value }), (err) => ({ ok: false, error: err?.message ?? String(err) }))
  const yieldMacrotask = () => new Promise((res) => setTimeout(res, 0))

  const schedules = [
    { id: 'a;b', run: async (sys, a, b) => [await settle(a.run(sys)), await settle(b.run(sys))] },
    { id: 'b;a', run: async (sys, a, b) => { const rb = await settle(b.run(sys)); const ra = await settle(a.run(sys)); return [ra, rb] } },
    { id: 'a||b', run: (sys, a, b) => Promise.all([settle(a.run(sys)), settle(b.run(sys))]) },
    { id: 'b||a', run: async (sys, a, b) => { const pb = settle(b.run(sys)); const pa = settle(a.run(sys)); return [await pa, await pb] } },
    { id: 'a|y|b', run: async (sys, a, b) => { const pa = settle(a.run(sys)); await yieldMacrotask(); const pb = settle(b.run(sys)); return [await pa, await pb] } },
  ]
  if (tick) {
    schedules.push(
      { id: 'a;T;b', run: async (sys, a, b) => { const ra = await settle(a.run(sys)); await tick(sys); return [ra, await settle(b.run(sys))] } },
      { id: 'a||T||b', run: async (sys, a, b) => { const pa = settle(a.run(sys)); await tick(sys); const pb = settle(b.run(sys)); return [await pa, await pb] } },
    )
  }

  const failures = []
  let count = 0
  for (const [a, b] of pairList) {
    for (const sched of schedules) {
      const sys = await setup()
      let results
      try { results = await sched.run(sys, a, b) } catch (err) { results = [{ ok: false, error: `schedule threw: ${err?.message ?? err}` }] }
      count++
      const label = sched.id.split(/([ab])/).map((t) => (t === 'a' ? a.name : t === 'b' ? b.name : t)).join('')
      const v = await violations(invariants, sys, { results, schedule: label, a: a.name, b: b.name, pattern: sched.id })
      if (v.length) failures.push({ schedule: label, pattern: sched.id, results, violations: v })
    }
  }
  if (failures.length) {
    throw new InvariantViolation(
      `${failures.length} of ${count} schedule(s) violate an invariant:\n` +
        failures.map((f) => `  ${f.schedule}: ${f.violations.join('; ')}  [results ${JSON.stringify(f.results)}]`).join('\n'),
      { failures, schedules: count },
    )
  }
  return { kit: KIT, pairs: pairList.length, schedules: count }
}

// ── the mutation check ──────────────────────────────────────────────────────
// `await expectViolation(() => interleave({ …broken system… }))` — passes only
// when the harness refuses the broken variant. A component's suite carries one
// per invariant, so "the harness is wired" and "the harness can see" are both
// things a green run means.
export async function expectViolation(fn, { match } = {}) {
  let err
  try { await fn() } catch (e) { err = e }
  if (!err) throw new Error('expectViolation: the harness accepted a variant it was meant to refuse — it has proved nothing')
  if (!(err instanceof InvariantViolation)) throw new Error(`expectViolation: the harness crashed instead of refusing: ${err?.message ?? err}`)
  if (match && !match.test(err.message)) throw new Error(`expectViolation: refused for the wrong reason — expected ${match}, got:\n${err.message}`)
  return err
}

// ── the INVARIANTS.md contract ──────────────────────────────────────────────
// A guarantee with no test behind it is a preference. The document that an
// auditor reads is also the one that drifts, so it is checked: headings
// `## I-n · name` numbered contiguously from I-1, each section carrying
// **Claim.** **Why.** **Enforced by.** **Proved by.**, and every citation
// written `› *test name*` present verbatim in the suite's source.
export function checkInvariantsDoc(markdown, testSource) {
  const problems = []
  if (typeof markdown !== 'string' || !markdown.trim()) return { valid: false, invariants: [], citations: [], problems: ['INVARIANTS.md is empty or missing'] }
  const invariants = [...markdown.matchAll(/^## (I-\d+) · (.+)$/gm)].map((m) => ({ id: m[1], name: m[2].trim() }))
  if (!invariants.length) problems.push('no `## I-n · name` headings')
  invariants.forEach((inv, i) => { if (inv.id !== `I-${i + 1}`) problems.push(`${inv.id} breaks the numbering (expected I-${i + 1})`) })
  for (const inv of invariants) {
    const section = markdown.split(`## ${inv.id} ·`)[1]?.split(/\n## /)[0] ?? ''
    for (const h of ['**Claim.**', '**Why.**', '**Enforced by.**', '**Proved by.**']) if (!section.includes(h)) problems.push(`${inv.id} (${inv.name}) is missing ${h}`)
    if (!/›\s*\*[^*]+\*/.test(section)) problems.push(`${inv.id} (${inv.name}) cites no test (write › *the test name*)`)
  }
  const citations = [...markdown.matchAll(/›\s*\*([^*]+)\*/g)].map((m) => m[1].trim()).filter(Boolean)
  const source = typeof testSource === 'string' ? testSource : ''
  for (const c of citations) if (!source.includes(c)) problems.push(`cites a test that does not exist: "${c}"`)
  return { valid: problems.length === 0, invariants, citations, problems }
}

// ── the CLI ─────────────────────────────────────────────────────────────────
//   node vendor-invariants.mjs check <dir>     exit 0 when INVARIANTS.md holds, 1 otherwise, 2 on usage
// Finds INVARIANTS.md at the root or under docs/, and reads every *.test.* file
// under test/, tests/, src/ (bounded walk, node_modules skipped).
export async function cli(argv = process.argv.slice(2)) {
  const [cmd, dir] = argv
  if (cmd !== 'check' || !dir) { console.error(`usage: node vendor-invariants.mjs check <dir>   (${KIT})`); return 2 }
  const fs = await import('node:fs')
  const path = await import('node:path')
  const root = path.resolve(dir)
  const docPath = ['INVARIANTS.md', path.join('docs', 'INVARIANTS.md')].map((p) => path.join(root, p)).find((p) => fs.existsSync(p))
  if (!docPath) { console.error(`${root}: no INVARIANTS.md at the root or under docs/`); return 1 }
  const sources = []
  const walk = (d, depth) => {
    if (depth > 6) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.(test|spec)\.(m?[jt]s|tsx?)$/.test(e.name)) sources.push(fs.readFileSync(p, 'utf8'))
    }
  }
  walk(root, 0)
  const r = checkInvariantsDoc(fs.readFileSync(docPath, 'utf8'), sources.join('\n'))
  if (r.valid) { console.log(`ok — ${r.invariants.length} invariant(s), ${r.citations.length} citation(s) found in ${sources.length} test file(s)`); return 0 }
  for (const p of r.problems) console.error(`✗ ${p}`)
  return 1
}

if (typeof process !== 'undefined' && process.argv[1] && /vendor-invariants\.mjs$/.test(process.argv[1])) {
  cli().then((code) => { process.exitCode = code })
}
