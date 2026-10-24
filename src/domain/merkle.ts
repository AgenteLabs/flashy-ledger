/**
 * The Merkle tree over a day of ledger entries.
 *
 * This file is a specification as much as an implementation. A reader has to be
 * able to rebuild the same root from the published snapshot, in a language we did
 * not choose, without reading our TypeScript — otherwise the root is a number we
 * assert rather than a number they check, and a proof-of-reserves scheme whose
 * proof only we can compute is a press release with extra steps.
 *
 * ── The encoding ────────────────────────────────────────────────────────────
 *
 *   canonical(entry) = id | asset | type | source | amountMinor | recordedAt
 *                      joined with U+007C, no padding, no whitespace
 *
 *   leaf(entry)      = SHA256( 0x00 || utf8(canonical(entry)) )
 *   node(left,right) = SHA256( 0x01 || left || right )
 *
 * Leaves are sorted by entry id, ascending, byte-wise. Sorting rather than
 * preserving insertion order is what makes the tree reproducible from a snapshot
 * that someone re-serialised or re-ordered.
 *
 * ── Two details that are not incidental ─────────────────────────────────────
 *
 * 1. Domain separation. Leaves are prefixed 0x00 and internal nodes 0x01, so a
 *    leaf digest can never be reinterpreted as an internal node. Without this an
 *    attacker can present an internal node as though it were a leaf and forge an
 *    inclusion proof for an entry that was never in the tree.
 *
 * 2. Odd nodes are promoted, not duplicated. The common shortcut — duplicating
 *    the last node to pad a level to an even width — makes two different leaf
 *    sets produce the same root, which is the flaw behind CVE-2012-2459. A
 *    promoted node carries to the next level unchanged.
 *
 * Amounts are signed integers in minor units, per ADR 0002 in @agenticlabs/ledger.
 * They are never floats here: a tree built over floating-point amounts would not
 * reproduce on a machine with a different rounding mode, which would make the
 * whole exercise worse than not doing it.
 *
 * ── Provenance ──────────────────────────────────────────────────────────────
 *
 * This module is the canonical home of the spec. It was written on
 * flashy-network (src/lib/merkle.ts) and moved here verbatim in 0.8.0 so that
 * the producer (ClaimYour.Gold's nightly anchor) and the verifier
 * (flashynetwork.com) import one implementation instead of maintaining two
 * copies of "the same" hash — which is how a chain silently stops verifying
 * across services. The network keeps a re-export until its next release.
 *
 * One mechanical delta from the original: index reads are guarded for this
 * package's noUncheckedIndexedAccess. Semantics and bytes are identical — the
 * pinned-vector tests prove it.
 */

import { createHash } from 'node:crypto'

export type Hex = string

const LEAF_PREFIX = Buffer.from([0x00])
const NODE_PREFIX = Buffer.from([0x01])

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

/** One row of the snapshot. Amounts are minor units as a decimal string. */
export interface SnapshotEntry {
  readonly id: string
  readonly asset: string
  readonly type: string
  readonly source: string
  /** Signed integer, minor units. Never a float, never a formatted number. */
  readonly amountMinor: string
  /** RFC3339 UTC, seconds precision. */
  readonly recordedAt: string
}

/** The exact bytes that get hashed. Published so it can be reimplemented. */
export function canonical(entry: SnapshotEntry): string {
  return [
    entry.id,
    entry.asset,
    entry.type,
    entry.source,
    entry.amountMinor,
    entry.recordedAt,
  ].join('|')
}

export function leafHash(entry: SnapshotEntry): Buffer {
  return sha256(LEAF_PREFIX, Buffer.from(canonical(entry), 'utf8'))
}

export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right)
}

export function toHex(buf: Buffer): Hex {
  return '0x' + buf.toString('hex')
}

export function fromHex(hex: Hex): Buffer {
  return Buffer.from(hex.replace(/^0x/, ''), 'hex')
}

/** Entries sorted into the canonical order the tree is built in. */
export function sortEntries(entries: readonly SnapshotEntry[]): SnapshotEntry[] {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The root over a set of entries.
 *
 * An empty set has no root. Returning a zero hash instead would give us a
 * publishable-looking commitment to nothing, which is exactly the kind of
 * plausible absence this property refuses everywhere else.
 */
export function merkleRoot(entries: readonly SnapshotEntry[]): Hex | null {
  const leaves = sortEntries(entries).map(leafHash)
  if (leaves.length === 0) return null

  let level = leaves
  while (level.length > 1) {
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = level[i + 1]
      if (left === undefined) break
      // Promoted, not duplicated — see the note at the top of this file.
      if (right === undefined) next.push(left)
      else next.push(nodeHash(left, right))
    }
    level = next
  }
  const root = level[0]
  return root === undefined ? null : toHex(root)
}

export interface ProofStep {
  readonly sibling: Hex
  /** Which side the sibling sits on when recomputing the parent. */
  readonly side: 'left' | 'right'
}

export interface InclusionProof {
  readonly entryId: string
  readonly leaf: Hex
  readonly path: readonly ProofStep[]
  readonly root: Hex
}

/**
 * The path proving one entry is in the tree.
 *
 * This is the half of proof-of-reserves that operators skip and then get taken
 * apart for skipping. A root on a chain says a set was committed to; only this
 * says *your* entry was in that set.
 */
export function inclusionProof(
  entries: readonly SnapshotEntry[],
  entryId: string,
): InclusionProof | null {
  const sorted = sortEntries(entries)
  let index = sorted.findIndex((e) => e.id === entryId)
  const target = sorted[index]
  if (index === -1 || target === undefined) return null

  const leaf = leafHash(target)
  const path: ProofStep[] = []
  let level = sorted.map(leafHash)

  while (level.length > 1) {
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = level[i + 1]
      if (left === undefined) break
      if (right === undefined) {
        next.push(left)
        // A promoted node has no sibling, so it contributes no proof step.
      } else {
        next.push(nodeHash(left, right))
        if (i === index) path.push({ sibling: toHex(right), side: 'right' })
        else if (i + 1 === index) path.push({ sibling: toHex(left), side: 'left' })
      }
    }
    index = Math.floor(index / 2)
    level = next
  }

  const root = level[0]
  if (root === undefined) return null
  return { entryId, leaf: toHex(leaf), path, root: toHex(root) }
}

/**
 * Recompute a root from a leaf and a path.
 *
 * The verifier a reader runs. It never touches our data — it takes the entry
 * they have, the path we gave them, and the root they fetched from a block
 * explorer, and tells them whether those three agree.
 */
export function verifyInclusion(
  entry: SnapshotEntry,
  path: readonly ProofStep[],
  expectedRoot: Hex,
): boolean {
  let acc = leafHash(entry)
  for (const step of path) {
    const sib = fromHex(step.sibling)
    acc = step.side === 'right' ? nodeHash(acc, sib) : nodeHash(sib, acc)
  }
  return toHex(acc).toLowerCase() === expectedRoot.toLowerCase()
}

/** The snapshot file, one canonical JSON object per line. */
export function toJsonl(entries: readonly SnapshotEntry[]): string {
  return (
    sortEntries(entries)
      .map((e) =>
        JSON.stringify({
          id: e.id,
          asset: e.asset,
          type: e.type,
          source: e.source,
          amount_minor: e.amountMinor,
          recorded_at: e.recordedAt,
        }),
      )
      .join('\n') + '\n'
  )
}

export function sha256Hex(text: string): Hex {
  return '0x' + createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/**
 * The liability side, stated separately from the entry stream.
 *
 * Committing only to entries lets a set of entries be published that does not sum
 * to the balances the operator actually owes. The commitment therefore carries
 * the outstanding total, and the invariant is what ties the two together — which
 * is the whole reason a root may not be published without a passing run.
 */
export interface Commitment {
  readonly date: string
  readonly root: Hex
  readonly entryCount: number
  readonly datasetSha256: Hex
  /** Σ of every entry amount, minor units. The outstanding liability. */
  readonly outstandingMinor: string
  readonly asset: string
}

export function commit(
  entries: readonly SnapshotEntry[],
  date: string,
  asset: string,
): Commitment | null {
  const root = merkleRoot(entries)
  if (root === null) return null

  const outstanding = entries.reduce((sum, e) => sum + BigInt(e.amountMinor), 0n)

  return {
    date,
    root,
    entryCount: entries.length,
    datasetSha256: sha256Hex(toJsonl(entries)),
    outstandingMinor: outstanding.toString(),
    asset,
  }
}
