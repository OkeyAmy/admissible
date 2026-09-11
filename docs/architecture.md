# Architecture

Admissible consists of five pieces orbiting a single concept: take an Ethereum attestation,
prove it onto Creditcoin via the Attestcoin Protocol, and record it in a registry that any
Creditcoin contract can query.

## The flow

```
EAS on Ethereum (mainnet or Sepolia)
  │  someone — a stranger — writes an attestation.  Attested(recipient, attester, uid, schemaUID)
  ▼
Attestcoin attestors attest the Ethereum block onto Creditcoin
  │  (chainKey 3 = mainnet, chainKey 1 = Sepolia)
  ▼
Proof Builder service produces (merkleProof, continuityProof) for that transaction
  ▼
AttestationRegistry.submit(...)  on Creditcoin
  │  → ASCBase.execute → BlockProver precompile 0x…0FD2 (synchronous, native speed)
  │  EASReader decodes the receipt logs → every Attested event in the tx
  ▼
Registry stores (chainKey, uid) → MirroredAttestation.  Any Creditcoin contract can now read it.
```

Revocation follows the same path, except it operates on the `Revoked` event and sets `revoked = true`.

## Trust boundaries

It is worth being precise about which parts are trusted, because the answer defines the product.

| Component | Trusted? |
|---|---|
| Attestcoin attestors + BlockProver precompile | Yes — this is the protocol's security model, and the reason Admissible exists rather than an oracle |
| The canonical EAS deployment on Ethereum | Yes — pinned by address per chainKey, checked on chain |
| The Proof Builder service | **No.** It supplies proofs; the precompile verifies them. A malicious builder can withhold a proof but cannot forge one |
| The Admissible worker | **No.** `execute` is permissionless; anyone can submit the same mirror |
| easscan GraphQL | **No.** Used for UID discovery and as an independent cross-check, never as an input to on-chain state |
| This README | **No.** See [verify](./verify.md) |

The sole entity capable of inserting a false entry into the registry is someone who can
forge an Attestcoin proof, or who controls the canonical EAS contract on Ethereum.

## Components

### EASReader — `contracts/src/EASReader.sol`

A reusable Solidity library that understands EAS log structure.

Responsibilities:

- **Assert the emitter.** Each log's `address_` must match the canonical EAS address for
  the relevant chainKey. Without that assertion, an attacker could deploy a fake EAS clone,
  emit a byte-identical `Attested` log, obtain a perfectly valid Attestcoin proof, and
  write arbitrary entries into the registry. This is the security linchpin behind reading a
  common event rather than a bespoke one.
- **Decode `Attested` / `Revoked` logs.** Topic layout: `topics[0]` = signature,
  `topics[1]` = recipient, `topics[2]` = attester, `topics[3]` = schemaUID, `data` = the
  32-byte `uid`. The UID — the primary key of the whole EAS — is *not* indexed, so it can
  only be recovered by decoding the log body.
- **Decode `CommonTxFields.data`** — the raw calldata of a call to a contract we do not
  own — branching on the `attest` (`0xf17325e7`) and `multiAttest` (`0x44adc90e`)
  selectors. Both are decoded **completely**, including `multiAttest`'s doubly-nested
  dynamic arrays, recovering `expirationTime`, `revocable` and `refUID` — fields the
  `Attested` event itself never carries. `attestByDelegation` / `multiAttestByDelegation`
  are deliberately excluded (this is disclosed and asserted by a test). `AttestationRegistry`
  invokes this path inside a `try/catch`, so a router-wrapped transaction degrades to
  logs-only mirroring rather than reverting. Details appear in
  [the integration doc §4](./attestcoin-integration.md).

The event signatures and selectors it depends on are documented in
[the integration doc](./attestcoin-integration.md).

### AttestationRegistry — `contracts/src/AttestationRegistry.sol`

The Attestcoin Smart Contract. It extends `ASCBase` from `@gluwa/asc-contracts@0.2.1`,
whose `execute` is `external` and permissionless with no source-contract binding — which is
what makes proving a stranger's EAS transaction permissible at the framework level.

The structure mirrors `ASCMinter.sol` and `ASCLoanManager.sol` from the organizer's examples
repo:

```solidity
contract AttestationRegistry is ASCBase, IAdmissibleRegistry {
    uint8 constant ACTION_MIRROR = 0;
    uint8 constant ACTION_REVOKE = 1;

    function _processAndEmitEvent(
        uint8 action, bytes32 queryId, bytes memory encodedTransaction
    ) internal override {
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        require(EvmV1Decoder.isValidTransactionType(txType), "Unsupported tx type");

        EvmV1Decoder.ReceiptFields memory receipt =
            EvmV1Decoder.decodeReceiptFields(encodedTransaction);

        // The precompile does NOT check this. Missing it mirrors attestations
        // from transactions that reverted.
        require(receipt.receiptStatus == 1, "Admissible: source transaction did not succeed");

        if (action == ACTION_MIRROR) _mirror(queryId, encodedTransaction, receipt);
        else if (action == ACTION_REVOKE) _revoke(queryId, receipt);
        else revert("Unknown action");
    }
}
```

Two structural decisions proved expensive to change later, so they were resolved up front:

- **Storage is keyed on `(chainKey, uid)`, never `uid` alone.** Mainnet and Sepolia are
  different EAS contracts with independent UID spaces. Collapsing them would let a
  Sepolia attestation satisfy a mainnet check.
- **`_mirror` loops every matching log.** `ASCBase` dedupes on
  `keccak(chainKey, blockHeight, txIndex)` — per *transaction*, not per attestation — so a
  `multiAttest` transaction is one query carrying many attestations. Reading only
  `logs[0]` compiles, passes a single-attestation test, and then permanently drops the
  rest, because the queryId can never be replayed.

### IAdmissibleRegistry — `contracts/src/IAdmissibleRegistry.sol`

The consumer-facing interface, frozen early so the contracts, SDK, worker and web app could
be built in parallel. It contains **no Attestcoin types** — the entire protocol sits behind
it, so a downstream dApp integrates against attestation semantics, not proof plumbing. Full
surface in [registry](./registry.md).

### CredentialGatedPool — `contracts/src/examples/CredentialGatedPool.sol`

A Creditcoin lending pool that extends credit only to addresses holding a valid, non-revoked,
mirrored EAS credential. It is the worked example of the consumer side, and the RWA-track
payoff: an off-chain real-world claim — an identity or compliance attestation issued on
Ethereum — gating on-chain credit on Creditcoin.

It imports `IAdmissibleRegistry` and nothing else from this project. It contains no
Attestcoin types, performs no proof handling, and runs no worker. That is the point: the pool
demonstrates that integrating as a downstream dApp costs one registry read.

The eligibility check is the conjunction of *the credential is valid* and *the credential
is yours*: mirrored, not revoked, from the attester and schema this pool requires, and its
`recipient` matches the caller. The `recipient` check is the one that is easy to omit and
expensive to miss — UIDs are public, so without it any borrower could present a stranger's
credential UID and be approved on someone else's identity.

The pool goes one step further than a bare boolean gate, because "no" alone is not a useful
answer:

```solidity
function presentCredential(bytes32 uid) external;                 // nominate a UID
function eligibilityReason(address who) external view returns (string memory);
function eligibilityStatus(address who) external view returns (Eligibility, uint256 headroom);
```

`Eligibility` is a seven-way enum — `Eligible`, `NotMirrored`, `Revoked`, `WrongAttester`,
`WrongSchema`, `NotRecipient`, `AtBorrowCap` — so the UI (or a judge at the CLI) can say
*why* an address can or cannot borrow, not just whether. `presentCredential` is pure
bookkeeping: it grants nothing, it only lets `eligibilityReason` answer for an address that
has nominated a UID. The pool is deliberately a simplified credit market atop that
gate — interest-free, no liquidation, no collateral, a flat per-borrower cap — because the
point being demonstrated is the credential gate, not a production lending design.

Because the registry reflects revocations, a credential revoked on Ethereum and mirrored
stops satisfying the pool automatically — no redeployment, no migration.

The deployed instance (`0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6`) is configured with a
real, non-wildcard requirement, not the `address(0)` / `bytes32(0)` "any attester, any
schema" default: chainKey 3 (Ethereum mainnet), attester
`0x45C07600825E79e36629537BFcAC64cfB285B5ae`, schema
`0x3969bb076acfb992af54d51274c5c868641ca5344e1aacd0b1f5e4f80ac0822f`, set via
`setCredentialRequirement` (tx `0x53c7d6a028b3f1da4f1cfcd40d7da77390ed87493816c27fe549de5b94c75eea`).
That pair is the most-repeated attester/schema combination found in this project's own
mirrored evidence — it recurs 5 times across a 30-UID sample of mainnet mirrors, each to a
different real recipient, so it is a genuine, recurring third-party credential issuer
rather than a synthetic one chosen for the demo. `eligibilityOf` was checked live against
both branches of the requirement, using UIDs found by querying easscan for attestations
under that attester/schema and confirming each was mirrored (`isValid`) before use:

```bash
# positive — recipient 0xDC5EF2B3f1b716cb62230B705D603944F8262cE9,
# UID 0x574c2482fb029ed3d7dc3cd68e243dc63e4ae2b964d8eac1afe1803b9da6c996
cast call 0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6 \
  "eligibilityOf(address,bytes32)(uint8,string,uint256)" \
  0xDC5EF2B3f1b716cb62230B705D603944F8262cE9 \
  0x574c2482fb029ed3d7dc3cd68e243dc63e4ae2b964d8eac1afe1803b9da6c996 \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network
# -> (0, "Eligible to borrow", 10000000000000000000)

# negative — same recipient, a mirrored UID from a different attester
cast call 0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6 \
  "eligibilityOf(address,bytes32)(uint8,string,uint256)" \
  0xDC5EF2B3f1b716cb62230B705D603944F8262cE9 \
  0xf816583fdd1d59500a5abf035afd62d4b57af18d71221117cfcce47030ca2d05 \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network
# -> (3, "Attestation is from a different attester", 0)
```

The gate discriminates correctly on real data, not only in tests.

### The SDK — `packages/sdk/`

`@admissible/sdk`, a thin TypeScript layer atop `@gluwa/usc-sdk@0.18.0` and `ethers` v6.
Four modules:

| Module | Job |
|---|---|
| `eas.ts` | easscan GraphQL: UID → source transaction, block, and expected field values |
| `mirror.ts` | Wait for attestation → build proof → submit → emit progress. Also `mirrorSchema()`, which mirrors a whole schema across grouped batches |
| `resolve.ts` | Read registry state over the public Creditcoin RPC |
| `verify.ts` | Diff registry state against easscan, produce PASS/FAIL |

`mirror()` accepts an `onProgress` callback that emits five stages — `resolving`,
`awaiting-attestation`, `building-proof`, `submitting`, `mirrored`/`failed` — carrying
attested height, target block, continuity-root count, Merkle-sibling count and the
Creditcoin transaction hash. The web app renders those directly; that callback is what
makes the protocol visible rather than buried in a backend. See [sdk](./sdk.md).

Proof acquisition is isolated behind a single function so the hosted `ProofBuilder` can
be swapped for the SDK's `RawProofBuilder`, which computes proofs offline against the
same interface. That is the decentralization path off the hosted prover.

### The mirror worker — `worker/`

A long-running process. Its structure is adapted from `bridge/bridge-offchain-worker/worker.ts` in
the organizer's examples repo.

- Polls EAS on **both** chainkeys — 1 (Sepolia) and 3 (mainnet).
- Respects Sepolia's 32-block reorg-protection window. The Proof Builder's
  `BlockNotOnSourceChain` response means *too recent*, not *wrong*; the worker backs off
  and retries rather than logging a failure.
- Batches up to **10 proofs within a 1000-block range** — both hard protocol limits.
- Persists progress across restarts and does not resubmit.
- Holds no privileged role. It is a convenience, not an authority: anyone can submit the
  same mirror from their own key.

### The bench — `bench/`

Generates evidence at volume. It pulls UIDs from easscan (Sepolia for throughput, mainnet
for credibility), mirrors each through the SDK, and appends **one line per attempt,
failures included**, to `receipts/mirrors.jsonl`:

```json
{"easUid":"0x…","sourceChainKey":3,"sourceTxHash":"0x…","sourceBlock":25946469,
 "continuityRoots":32,"merkleSiblings":9,"queryId":"0x…","batchIndex":0,
 "creditcoinTxHash":"0x…","gasUsed":"…","ctcCost":"0.0000323",
 "proofLatencyMs":3560,"submitLatencyMs":1180,"status":"mirrored",
 "timestamp":"2026-09-13T…"}
```

Proof generation and on-chain submission are separate fields because their cost profiles
differ — generation is free, submission costs CTC — and their failure modes diverge. A
reader must not assume every row is a Creditcoin transaction. `queryId` and `batchIndex`
are recorded so attestation count and transaction count are both independently derivable.

### The web app — `web/`

Vite + React + TypeScript. One primary action: paste a UID, press Mirror, watch the five
stages. Attested height, continuity-root count, Merkle-sibling count and the precompile
addresses are on screen, not hidden.

A second page, `/batch`, drives `mirrorSchema()`: paste an EAS schema UID and mirror that
schema's recent attestations across grouped submissions, with per-batch progress. It is
where the difference between attestation count and submission count becomes visible —
one `multiAttest` transaction resolving into many registry entries from a single
`execute` call.

The app also serves this documentation set.

## Data model

```solidity
struct MirroredAttestation {
    uint64  chainKey;      // 1 = Sepolia, 3 = Ethereum Mainnet
    bytes32 uid;           // the EAS attestation UID
    bytes32 schemaUid;
    address attester;
    address recipient;
    uint64  sourceBlock;   // Ethereum block the attestation was written in
    bytes32 sourceTxHash;
    uint64  mirroredAt;    // Creditcoin block.timestamp when mirrored
    bool    revoked;
    uint64  revokedAt;     // 0 if not revoked
    bool    exists;
}
```

Both `sourceBlock` and `sourceTxHash` are stored so any entry can be traced back to
Ethereum and independently checked, which is what [verify](./verify.md) does.

## What is deliberately not here

- **No database.** Receipts are JSONL on disk, committed to the repository, so they remain
  inspectable after the demo ends.
- **No write path back to Ethereum.** Attestcoin writability is documented as "undergoing
  3rd party testing and audits". Admissible is read-only, Ethereum → Creditcoin, by design.
- **No self-hosted proof builder.** `RawProofBuilder` is the seam and the SDK is shaped
  for it, but operating one is a multi-week project, cut from a three-day build
  deliberately.
- **No viem.** `@gluwa/usc-sdk` has a hard peer dependency on ethers v6, and running two
  chain clients in one repo is a source of subtle divergence.
