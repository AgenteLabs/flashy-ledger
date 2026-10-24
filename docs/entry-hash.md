# The Entry hash

`hash` is the field of an Entry that a reader outside this repository cannot
rebuild from the schema alone. [`schema/entry.json`](../schema/entry.json) says
it is "sha256 over the hashed fields in the fixed order `hashEntry()`
defines" and stops there: the order, the separator and the way each field is
turned into text were written down only in code. This document is that
statement.

If it and `hashEntry` in `src/domain/entry.ts` ever disagree, the code is the
format and this page is wrong. `tests/entry-hash.test.ts` is what says so.

Every chain rests on it. The next entry's `previousHash` is this value, and
`verifyEntry` and `verifyChain` recompute it. `post()` and `verifyEntry()` both
call `hashEntry`, so a change to the preimage would be self-consistent: nothing
inside the package would notice, and every chain already written would stop
verifying.

## The preimage

Twelve strings, in this order:

| # | Field | Rendered as |
|---|---|---|
| 1 | `previousHash` | the hash of the preceding entry for this identity and asset; `null` is the empty string |
| 2 | `tenantId` | as stored |
| 3 | `identityId` | as stored |
| 4 | `assetId` | as stored |
| 5 | `amount` | the integer in base 10, with `-` for a debit and no `+`, no grouping and no exponent |
| 6 | `balanceBefore` | the same |
| 7 | `balanceAfter` | the same |
| 8 | `kind` | one of the names in the `kind` enum of `schema/entry.json` |
| 9 | `source.type` | as stored |
| 10 | `source.id` | as stored; an absent id is the empty string |
| 11 | `idempotencyKey` | as stored |
| 12 | `occurredAt` | `Date.toISOString()` of the instant: UTC, always three fractional digits, always a trailing `Z` |

The twelve strings are joined with a single U+0000 character between each, the
result is encoded as UTF-8, and `hash` is the sha256 of those bytes as 64
lower-case hexadecimal characters. There is no `0x` prefix: the Merkle module
(`src/domain/merkle.ts`) writes its digests with one, joins different fields
with `|` and is a different document.

Three details are where a second implementation goes wrong.

**The instant is hashed, not the string it arrived as.** The same instant
written as `2026-08-12T02:00:00+02:00` and as `2026-08-12T00:00:00.000Z` hashes
alike, because the producer holds a `Date` and renders it with `toISOString()`.
A verifier handed a wire entry has to render in UTC with exactly three digits,
the way the Python below does. A year outside 0000 to 9999 is rendered by
`toISOString()` with a sign and six digits, which neither the schema nor the
reference below handles.

**Strings are hashed exactly as stored.** There is no trimming and no Unicode
normalisation; non-ASCII text is its UTF-8 bytes.

**Null and absent are the empty string, and that is the whole rule.** An
entry whose `source.id` is absent and one whose `source.id` is `""` have the
same preimage, and so do entries whose `previousHash` is `null` and `""` (the
schema refuses the second). It is this rule that gives the first entry of a
chain a defined preimage.

## What is not hashed

`id` is assigned by the store on append, so an entry stored under any id still
verifies. `hash` cannot cover itself. `metadata` and `source.description` are
free-form and are left out on purpose, as is any key `hashEntry` does not know.

The consequence is worth stating plainly: an edit to `metadata` or
`source.description` after the fact is not detected by `verifyEntry` or
`verifyChain`. They are annotations, not evidence. Anything a reader has to be
able to rely on has to travel in a hashed field.

## The separator is not escaped

U+0000 is the separator, and nothing stops a field from containing one.
Measured on 2026-10-20 against this repository's build:

- `hashEntry` gives the same digest for `tenantId: "a\u0000b", identityId: "c"`
  and for `tenantId: "a", identityId: "b\u0000c"`.
- `post()` accepts a U+0000 inside `tenantId`, `identityId`, `source.type`,
  `source.id` and `idempotencyKey`. It refuses none of them.

For an entry whose fields contain no U+0000 the eleven separators are the only
ones in its preimage, so there is one way to read it and no other entry shares
it. The ambiguity exists only between entries that carry the character. A
verifier in another language should treat a U+0000 inside any field as a
malformed entry and not hash it.

Whether `post()` should refuse it is a change to `src/domain/`, which
CODEOWNERS routes to `@FlashyLabs/ledger-owners`, and is not made here.

## A reference in Python

Run under Python 3.11, it reproduces every vector in
[`schema/entry-hash-vectors.json`](../schema/entry-hash-vectors.json):

```python
import hashlib
from datetime import datetime, timezone


def instant(rfc3339: str) -> str:
    """Render an instant the way JavaScript's Date.toISOString() does."""
    dt = datetime.fromisoformat(rfc3339.replace("Z", "+00:00")).astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def entry_hash(e: dict) -> str:
    preimage = [
        e["previousHash"] or "",       # null is the empty string
        e["tenantId"],
        e["identityId"],
        e["assetId"],
        str(e["amount"]),              # a JSON integer; a float here is a malformed entry
        str(e["balanceBefore"]),
        str(e["balanceAfter"]),
        e["kind"],
        e["source"]["type"],
        e["source"].get("id", ""),     # absent is the empty string
        e["idempotencyKey"],
        instant(e["occurredAt"]),
    ]
    return hashlib.sha256("\x00".join(preimage).encode("utf-8")).hexdigest()
```

This is the only second implementation, and it has been run against those
vectors and in no other language.

## Checking an implementation

[`schema/entry-hash-vectors.json`](../schema/entry-hash-vectors.json) is this
page as data: the separator, the field names in the order of the table above,
and a handful of entries, each with the twelve strings it reduces to and the
digest. They cover a null `previousHash`, a negative amount with no source id
and millisecond precision, and non-ASCII text. A second implementation passes
when it reproduces every `hash` from its `entry`.

The digests are pinned, not generated. They were computed with Python's
`hashlib` over the strings joined with `"\x00"`, outside this codebase, because
a corpus written by the code under test could only ever agree with it. To add a
vector, compute its digest the same way and never from `hashEntry`.
`tests/entry-hash-vectors.test.mjs` (`npm run test:standalone`, no install
needed) holds the file to four things separately: each digest is the sha256 of
its strings, computed with `node:crypto`; the strings are what the entry's own
fields give when read in the order of the table above, which the test parses
from this page; the entry uses only keys `schema/entry.json` knows; and the
built `hashEntry()` reproduces the digest. With no build it says UNKNOWN and
skips that last check. It does not pass.

`tests/entry-hash.test.ts` pins the exact bytes `hashEntry` feeds to sha256 from
inside the package. Two of its digests are the first two vectors here. It also
covers each exclusion above and every one of the twelve fields changing the
hash.

## The separator is a literal byte in the source

`src/domain/entry.ts` writes the separator as a literal U+0000 byte in the
argument to `.join`, not as the escape `'\u0000'`. Two things follow.

Git treats the file as binary (`git ls-files --eol src/domain/entry.ts`
reports `i/-text`), so `git diff` prints "Binary files differ" and a pull
request that touches `hashEntry` shows no line diff at all. `git diff --text`
shows the change.

An editor or tool that rewrites the byte as a space, or drops it, changes every
hash this package has ever produced, and nothing in the file looks different.
To confirm the byte survived an edit:

```bash
tr -cd '\000' < src/domain/entry.ts | wc -c
```

That prints the number of NUL bytes in the file. The tests in `tests/` write
the separator as the escape and never as the byte.

Replacing the literal with the escape would give an identical string, identical
hashes and a file that diffs as text; `src/adapters/memory.ts` already writes
its own key separator that way. It has not been done. The file is in
`src/domain/`, and the owners of that directory decide.

## Changing it

The field list, the order, the separator and each rendering above are the
format. Changing any of them invalidates every existing chain and is a breaking
change with a re-hashing plan, never a refactor (see *Status* in the
[README](../README.md#status)).
