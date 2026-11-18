import { isTransferable, type Asset } from './asset.js'
import type { Entry, EntryKind, EntrySource, HashableEntry } from './entry.js'
import { hashEntry } from './entry.js'
import { add, isZero, isNegative, minor, negate, type Minor } from './money.js'
import {
  assetNotTransferable,
  insufficientBalance,
  missingIdempotencyKey,
  selfTransfer,
  zeroAmount,
} from './errors.js'
import { assertOpaqueIdentity } from './identity.js'

/**
 * The decision function at the centre of the ledger.
 *
 * Deliberately pure: it reads no database, writes nothing, and calls no clock.
 * Given the current state and a command it returns the entry that should exist,
 * or throws. Persistence is somebody else's job (see ports/store.ts).
 *
 * That purity is the whole reason this package can move onto different storage,
 * including a chain, without its rules changing. It is also why the rules can be
 * tested exhaustively with no database anywhere in sight.
 */
export interface PostCommand {
  readonly tenantId: string
  readonly identityId: string
  readonly asset: Asset
  /** Signed, in minor units. Positive credits, negative debits. */
  readonly amount: Minor
  readonly kind: EntryKind
  readonly source: EntrySource
  readonly idempotencyKey: string
  readonly occurredAt: Date
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Permit the balance to go below zero. Off unless the flow allows debt. */
  readonly allowNegative?: boolean
}

export interface LedgerState {
  readonly balance: Minor
  /** Hash of this identity's most recent entry, or null if they have none. */
  readonly headHash: string | null
}

/** The entry a command should produce, before storage assigns it an id. */
export type ProposedEntry = Omit<Entry, 'id'>

export function post(state: LedgerState, command: PostCommand): ProposedEntry {
  if (!command.idempotencyKey) throw missingIdempotencyKey()
  // Before anything is hashed. An identity that names a person cannot be taken
  // back out of a chain, so the only place to stop it is on the way in.
  assertOpaqueIdentity(command.identityId)
  // The Minor brand is a compile-time promise. A JavaScript caller — or a JSON
  // body — can hand in undefined, 0.5 or "500", and each one would be hashed
  // into a chain: NaN balances, a fractional holding, or a string concatenated
  // onto a number. The brand is re-asserted at runtime, on the one path every
  // entry takes.
  minor(command.amount)
  if (isZero(command.amount)) throw zeroAmount()

  const balanceAfter = add(state.balance, command.amount)

  if (isNegative(balanceAfter) && command.allowNegative !== true) {
    throw insufficientBalance(state.balance, command.amount)
  }

  const hashable: HashableEntry = {
    tenantId: command.tenantId,
    identityId: command.identityId,
    assetId: command.asset.id,
    amount: command.amount,
    balanceBefore: state.balance,
    balanceAfter,
    kind: command.kind,
    source: command.source,
    idempotencyKey: command.idempotencyKey,
    occurredAt: command.occurredAt,
    previousHash: state.headHash,
    metadata: command.metadata,
  }

  return { ...hashable, hash: hashEntry(hashable) }
}

export interface TransferParty {
  readonly state: LedgerState
  readonly identityId: string
}

export type TransferCommand = Omit<PostCommand, 'identityId' | 'kind' | 'amount'> & {
  /** Positive. The direction is expressed by which party is which. */
  readonly amount: Minor
}

/**
 * A transfer is two entries, not one balance edit: the sender's debit and the
 * recipient's credit, sharing a derived idempotency key.
 *
 * Modelling it this way is what stops peer-to-peer movement disappearing from
 * the books. In the AMS reconciliation, gifts and tips moved both wallets while
 * writing no entry on either side, which is why 61 code paths there are
 * invisible to the ledger.
 */
export function postTransfer(
  from: TransferParty,
  to: TransferParty,
  command: TransferCommand,
): readonly [ProposedEntry, ProposedEntry] {
  minor(command.amount)
  if (isNegative(command.amount) || isZero(command.amount)) {
    throw zeroAmount()
  }

  // Both legs would be posted against the same state and chain onto the same
  // head: a fork, which the store refuses, or — if it did not — a credit of
  // the full amount on top of an unchanged balance. There is nothing to move.
  if (from.identityId === to.identityId) throw selfTransfer(from.identityId)

  // Some assets record who earned something rather than who holds it. Moving
  // one is not a transfer, it is a forgery — and the rule belongs here, where
  // no product can forget it, rather than in each product's review checklist.
  if (!isTransferable(command.asset)) {
    throw assetNotTransferable(command.asset.slug, command.asset.class)
  }

  const debit = post(from.state, {
    ...command,
    identityId: from.identityId,
    amount: negate(command.amount),
    kind: 'TRANSFER_OUT',
    idempotencyKey: `${command.idempotencyKey}:out`,
  })

  const credit = post(to.state, {
    ...command,
    identityId: to.identityId,
    amount: command.amount,
    kind: 'TRANSFER_IN',
    idempotencyKey: `${command.idempotencyKey}:in`,
  })

  return [debit, credit]
}

/**
 * The only way to undo an entry: post its mirror image. History is never
 * rewritten, so the correction is as auditable as the mistake.
 */
export function reverse(
  state: LedgerState,
  original: Entry,
  reason: string,
  occurredAt: Date,
): ProposedEntry {
  return post(state, {
    tenantId: original.tenantId,
    identityId: original.identityId,
    asset: { id: original.assetId } as Asset,
    amount: negate(original.amount),
    kind: 'REVERSAL',
    source: { type: 'reversal', id: original.id, description: reason },
    idempotencyKey: `reversal:${original.idempotencyKey}`,
    occurredAt,
    allowNegative: true,
  })
}
