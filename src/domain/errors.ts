/** Every rejection this package can produce, as a type the caller can switch on. */

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export type LedgerErrorCode =
  | 'INSUFFICIENT_BALANCE'
  | 'ZERO_AMOUNT'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'INSUFFICIENT_FOR_CONSUMPTION'
  | 'DUPLICATE_ASSET_IN_COMMAND'
  | 'NATURAL_KEY_IDENTITY'
  | 'ASSET_NOT_TRANSFERABLE'
  | 'SELF_TRANSFER';

export const insufficientBalance = (available: number, requested: number): LedgerError =>
  new LedgerError(
    'INSUFFICIENT_BALANCE',
    `Balance ${available} cannot cover a debit of ${requested}`,
  );

export const zeroAmount = (): LedgerError =>
  new LedgerError('ZERO_AMOUNT', 'An entry of zero records no movement');

export const missingIdempotencyKey = (): LedgerError =>
  new LedgerError(
    'MISSING_IDEMPOTENCY_KEY',
    'Every command needs an idempotency key so retries are safe',
  );

/** One asset a consumption could not cover, and by how much. */
export interface Shortfall {
  readonly assetId: string;
  readonly available: number;
  readonly required: number;
  readonly short: number;
}

/**
 * A consumption that cannot be afforded, reported in full.
 *
 * Every shortfall is listed, not just the first one found. A player told they
 * are short of stone, who gathers stone, and is then told they are short of
 * wood, has been made to discover their own bill one line at a time.
 */
export class InsufficientForConsumptionError extends LedgerError {
  constructor(readonly shortfalls: readonly Shortfall[]) {
    super(
      'INSUFFICIENT_FOR_CONSUMPTION',
      `Cannot consume: ${shortfalls
        .map((s) => `${s.assetId} short by ${s.short} (has ${s.available}, needs ${s.required})`)
        .join('; ')}`,
    );
    this.name = 'InsufficientForConsumptionError';
  }
}

export const duplicateAssetInCommand = (assetId: string): LedgerError =>
  new LedgerError(
    'DUPLICATE_ASSET_IN_COMMAND',
    `Asset ${assetId} appears twice in one consumption. Both costs would be checked ` +
      'against the same balance and both entries would chain onto the same head, ' +
      'forking that asset\'s chain. Sum the costs before calling.',
  );

export const assetNotTransferable = (slug: string, assetClass: string): LedgerError =>
  new LedgerError(
    'ASSET_NOT_TRANSFERABLE',
    `${slug} is ${assetClass} and cannot move between identities`,
  );

export const selfTransfer = (identityId: string): LedgerError =>
  new LedgerError(
    'SELF_TRANSFER',
    `A transfer from ${identityId} to itself moves nothing. Its debit and credit would both ` +
      'chain onto the same head, forking the chain and crediting the sum of both legs.',
  );
