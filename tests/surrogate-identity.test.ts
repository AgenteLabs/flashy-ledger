import { describe, expect, it } from 'vitest'
import { LedgerError, looksLikeNaturalKey, surrogateIdentity } from '../src/index.js'

/**
 * A surrogate is only an identity if it is the SAME identity next year.
 *
 * `surrogateIdentity(value, tenantSalt)` is the fix the natural-key refusal
 * hands to every caller, so the digest it returns is hashed into append-only
 * chains and used as the key to read them back. Change the separator, the order
 * of the two inputs, or the hash, and the same person at the same tenant gets a
 * different identity: their old chain is orphaned and a new one starts at zero.
 * Nothing throws and nothing is lost from the database; the money is simply no
 * longer reachable under the identity the caller now derives.
 *
 * The existing tests prove the function is stable *within a run* and differs per
 * tenant, which any deterministic function satisfies. They cannot see the bytes.
 * These vectors were computed OUTSIDE this codebase (Python hashlib:
 * sha256(f"{salt} {value}")), with the separator an ASCII space, so a change to
 * the format cannot be reconciled by regenerating a snapshot.
 *
 * Fixtures are fictional: example.org is reserved for documentation.
 */

const SALT = 'tenant-salt-for-tests-0001'
const OTHER_SALT = 'another-tenant-salt-0002'

describe('surrogateIdentity: the bytes are the contract', () => {
  it('derives sha256 of `<salt> <value>` to a vector computed outside this codebase', () => {
    expect(surrogateIdentity('ada@example.org', SALT)).toBe(
      'b67637be5da0628a8d5f3056a402a190dcb62399543415829d8cd4126a372f73',
    )
  })

  it('hashes a non-ASCII value as UTF-8', () => {
    expect(surrogateIdentity('zoë@example.org', SALT)).toBe(
      '26c73a27401ce80dbe9a28f93536d0a4a10229f90090b2afe72aa3e94cdbc052',
    )
  })

  it('matches a second tenant vector, so the salt is part of the preimage and not decoration', () => {
    expect(surrogateIdentity('ada@example.org', OTHER_SALT)).toBe(
      '2633577a72a07cf921183030da34e9a07fc23239fd40ba330af14023fc961ee6',
    )
  })

  it('returns 64 lower-case hex characters, which the natural-key guard leaves alone', () => {
    const derived = surrogateIdentity('ada@example.org', SALT)
    expect(derived).toMatch(/^[0-9a-f]{64}$/)
    expect(looksLikeNaturalKey(derived)).toBeNull()
  })
})

describe('surrogateIdentity: the salt floor', () => {
  it('refuses a 15-character salt and accepts a 16-character one', () => {
    // The stated floor is 16. A salt shorter than that makes this a lookup
    // table, and "at least 16" must mean 16, not 15.
    expect(() => surrogateIdentity('ada@example.org', 'a'.repeat(15))).toThrow(LedgerError)
    expect(() => surrogateIdentity('ada@example.org', 'a'.repeat(16))).not.toThrow()
  })

  it('names the natural-key code, so a caller switching on it handles the refusal', () => {
    try {
      surrogateIdentity('ada@example.org', 'short')
      expect.unreachable('a short salt must be refused')
    } catch (error) {
      expect((error as LedgerError).code).toBe('NATURAL_KEY_IDENTITY')
    }
  })
})
