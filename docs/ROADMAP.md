# The Flashy Anchor Doctrine — ledger roadmap

This is the canonical, verifiable home for where `@flashyos/ledger` is going.
Every other surface in the estate that describes the ledger's future defers to
this file. It is published in the open because the whole thesis is *verify,
don't trust*: a proof layer that hid its own roadmap would be the one
unforgivable irony.

**Honesty register, applied to ourselves.** Each phase below carries a status.
`LIVE` means it ships in this package today and is checkable with
[`@flashyos/verify`](https://www.npmjs.com/package/@flashyos/verify). `NORTH
STAR` means designed and intended, not built. A term in this document flips
from North Star to live on the same day its code does — never before.

## The one sentence

Every meaningful autonomous action becomes a proof:

```
agent → signed intent → authorization → execution → Flashy Ledger event → proof
```

Orchestration is a commodity — many harnesses do it. A verifiable, immutable,
chain-neutral record that *a specific accountable agent did a specific
authorized thing* is not, and it is what an enterprise agent workforce cannot
ship without. This ledger already seals settlements; the doctrine makes sealing
the point.

## Phase 1 — the proof primitive · FOUNDATION LIVE

The hard half already ships: append-only, content-hashed, chain-verified,
deterministically replayable double-entry, with tenant isolation enforced (not
merely labelled) and the numbered invariants in [`docs/INVARIANTS.md`](./INVARIANTS.md).
Phase 1 completes the primitive around **agents as first-class signers**.

- **Canonical event schema** — one versioned shape for every autonomous action,
  so a 2029 event still parses. *(NORTH STAR)*
- **Agent + organization signatures** — every event carries who signed it (the
  agent key) and under whose authority (the org key). Today an Entry has no
  field for either: a caller can carry such a reference only in `metadata`,
  which is free-form and not part of the hash. This makes them cryptographic.
  *(NORTH STAR)*
- **Signed-intent envelope** — the `intent → authorization → execution` chain
  recorded, so a reader verifies the agent was authorized *before* it acted.
  *(NORTH STAR)*
- **Merkle roots + audit receipts** — every event yields a receipt; every batch
  yields a root. The receipt is what an agent, auditor or counterparty holds.
  *(NORTH STAR)*
- **Key rotation + permissions** — agent identity that survives a rotated key,
  and a permission model over which agent may sign which event class. This
  answers the revocation question in cryptography, not just a database row.
  *(NORTH STAR)*
- **Cross-org event type** — the schema slot Phase 3 fills, reserved now so the
  format never breaks to add it. *(NORTH STAR)*

Every one of these lands under this package's existing build-failing test
discipline: the domain reads no clock and no randomness (lint-enforced), so
signatures and Merkle proofs stay deterministic and replayable.

## Phase 2 — the Flashy Anchor Protocol · NORTH STAR

```
Flashy Ledger events → Merkle tree → root → public blockchain(s)
```

Every N events/minutes, the checkpoint root is written to one or more public
chains. Then a stranger need not trust Flashy that history wasn't quietly
rewritten — the root on Ethereum or Bitcoin is dated, public and immutable, and
any single event proves its membership with a Merkle path. This makes the
ledger *auditable by an adversary*, the only audit that counts.

- **Chain neutrality is the commercial unlock.** FlashyOS must not care whether
  an organization is Ethereum-aligned, Solana-aligned, Avalanche-aligned or
  pure Web2. Anchor the same root to Ethereum + Base + Bitcoin by default; a
  **chain-adapter interface** lets an organization add its own chain. We sell
  proof, not a token.
- **The Anchor Protocol is the named IP** — a small, open, verifiable spec:
  root format, cadence, inclusion-proof format, adapter contract. Open like the
  AAO spec; the network that runs it live is the product.
- **Cost is bounded** — one root per cadence, not one transaction per event.

## Phase 3 — the interorganizational ledger · NORTH STAR · the IP

```
Org A agent → AAO message → Org B agent   ⇒ both ledgers record ⇒ mutually verifiable receipts
```

Each organization keeps its own sovereign ledger, but organizations exchange
**signed AAO messages**, and both sides record the transaction and generate
receipts the other verifies against its own anchored root. Neither org trusts
the other's database; each holds a proof the other cannot forge or repudiate.

This is where Flashy stops being orchestration and becomes a **settlement
protocol between autonomous organizations** — the completion of the mesh's
broadcasts, offers and joint initiatives given a cryptographic, non-repudiable
record. It composes with Phase 2: a cross-org receipt is verifiable because both
ledgers anchor to public roots, so a dispute is resolved by math, not by
whichever party has the better lawyer. It is the enterprise agent
risk-and-clearing answer — counterparty risk as a lookup against settled,
anchored, cross-org work rather than a diligence project.

## Phase 4 — federated validators · LATER · earned by adoption

Only after dozens or hundreds of organizations produce real interorganizational
activity does decentralizing the ledger itself make sense. Then a permissioned
validator set — GDA, Flashy, and independent operators — runs consensus so no
single party, Flashy included, can rewrite history even in principle.

- **Do not invent consensus.** Adopt an established permissioned BFT/PoA
  implementation (e.g. Hyperledger Besu's QBFT/IBFT) rather than recreating the
  network and consensus primitives at enormous engineering and security cost.
- **Sequencing is the discipline.** Federation before real interorg volume is
  decentralization theatre; this phase is *earned* by Phase 3 traffic.
- **The moat by then** is not the consensus — it is the years of anchored,
  cross-org, standardized history a new entrant cannot backfill.

## Why this is not "another L1"

We do not compete for block space against a hundred chains on throughput and
token incentives. We define a category that sits *above* every chain and
monetizes the one thing agents cannot skip: proof they were authorized.
Chain-neutral by doctrine — an enterprise anchors to whatever chain its board
already trusts, and Web2 is fine too.
