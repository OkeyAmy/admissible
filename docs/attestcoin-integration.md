# How Admissible uses the Attestcoin Protocol

This document is the technical write-up mandated by the BUIDL CTC 2026 Fall submission
rules ("technical documentation detailing your setup and explaining how the project uses
the Attestcoin Protocol"). It covers the setup, the integration surface, the design
decisions behind them, the three protocol gotchas we handle explicitly, and the measured
numbers.

Every network fact stated here was verified live against CC3 testnet and the Attestcoin
prover service on **2026-09-10**.

---

## 0. Summary in one paragraph

Admissible is an Attestcoin Smart Contract (ASC) that reads the Ethereum Attestation
Service. A user pastes an EAS attestation UID. From that UID Admissible resolves the
Ethereum transaction that created it, waits for Attestcoin's attestors to witness that
block onto Creditcoin, requests a Merkle inclusion proof plus a continuity proof from the
Proof Builder, then hands both to `AttestationRegistry.submit(...)` on Creditcoin, which
in turn invokes the inherited `ASCBase.execute(...)`. `ASCBase` passes the proof to the
**BlockProver precompile at `0x…0FD2`**, which checks it synchronously at native speed
inside the same transaction. Admissible then decodes the proven transaction's receipt logs
and its raw calldata, and writes one registry entry per attestation. From that point
onward any Creditcoin contract can call `isValid(chainKey, uid)` and receive a boolean
backed by an Ethereum-mainnet proof — no oracle, no bridge, no re-signing.

Here is the part the tutorials skip: **the Ethereum transaction under proof was sent to a
contract we neither own nor deployed** — the canonical EAS deployment — by a stranger who
has never heard of Creditcoin.

---

## 1. Setup

### 1.1 Network and endpoints

| | |
|---|---|
| Creditcoin RPC | `https://rpc.cc3-testnet.creditcoin.network` |
| Chain ID | `102031` (`0x18e8f`) |
| Native token | CTC |
| ChainInfo precompile | `0x0000000000000000000000000000000000000fd3` |
| BlockProver precompile | `0x0000000000000000000000000000000000000FD2` |
| Proof Builder API | `https://proof-gen-api.cc3-testnet.creditcoin.network` |
| Explorer | `https://creditcoin-testnet.blockscout.com` (account/contract pages: `/address/{addr}`; transactions: `/tx/{hash}`) |
| ASC dashboard | `https://dashboard.cc3-testnet.creditcoin.network/` |

`https://prover.cc3-testnet.creditcoin.network` points at the same Proof Builder
service. The docs and the SDK examples cannot agree on which hostname to use, but both
work regardless.

### 1.2 Pinned dependencies

| Package | Version | Why pinned |
|---|---|---|
| `@gluwa/asc-contracts` | `0.2.1` | Provides `ASCBase.sol`, `EvmV1Decoder.sol`, `INativeQueryVerifier.sol`. |
| `@gluwa/usc-sdk` | `0.18.0` | The official client. The readability docs page self-describes as "pending replacement", so the version is pinned rather than floated. |
| `ethers` | `^6.15.0` | Hard peer dependency of the SDK. No viem anywhere in this repo. |

Solidity `^0.8.28`, Foundry 1.7.1, Node 22, pnpm 11 workspaces.

`.npmrc` sets `node-linker=hoisted` on purpose. `foundry.toml` remaps
`@gluwa/asc-contracts/=node_modules/@gluwa/asc-contracts/`, so a flat, npm-like
`node_modules` layout is precisely what keeps Foundry resolving the organizer's contracts
unchanged. Out of context the setting can look odd; leave it in place.

Two more `foundry.toml` compiler settings are worth explaining rather than sitting as
mysterious flags:

- **`via_ir = true`.** The registry's `submit` entrypoint forwards a full Attestcoin proof
  bundle — nine arguments, three of them dynamic — into the inherited `ASCBase.execute`.
  Legacy codegen runs out of stack slots doing that; `via_ir` is the compiler's own
  recommended fix.
- **`evm_version = "london"`.** CC3 is a Substrate/Frontier EVM whose block headers carry no
  `mixHash`/`prevrandao`, so a post-merge target makes local simulation fail header
  validation. `london` also keeps `PUSH0`, `MCOPY` and `TSTORE` out of the compiled
  bytecode, none of which a Frontier-based chain is guaranteed to implement.

### 1.3 Source chains

Admissible uses **both** chainkeys that CC3 testnet attests, binding each one to the
canonical EAS deployment on that chain:

| chainKey | Chain | Canonical EAS contract | Role in this project |
|---|---|---|---|
| **1** | Ethereum Sepolia | `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` | Volume. Many attestations per minute; also where the revocation demo runs. |
| **3** | Ethereum **Mainnet** | `0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587` | Credibility. Real third-party issuers, real production attestations. |

Measured on 2026-09-10: mainnet attestation lag **42 blocks (~8 minutes)** behind head;
attested heights at check were chainKey 1 = `11,676,170` and chainKey 3 = `25,948,260`.
Sepolia enforces a **32-block reorg-protection window** — the Proof Builder returns
`{"code":"BlockNotOnSourceChain"}` for anything newer, which is a *retryable* condition,
not a failure.

Including chainKey 3 is itself a deliberate choice. Proving Ethereum **mainnet** is what
guarantees the demo attestation is something we could not have manufactured.

### 1.4 One-command liveness check

```bash
curl https://proof-gen-api.cc3-testnet.creditcoin.network/api/v1/attested-height/3
# -> {"attestedHeight":25948260}
```

If a number comes back, the whole readability pipeline is up.

---

## 2. The pipeline, end to end

```
  Ethereum (mainnet chainKey 3, or Sepolia chainKey 1)
  │
  │  A stranger calls EAS.attest() or EAS.multiAttest().
  │  EAS emits Attested(recipient, attester, uid, schemaUID).
  │  Nothing about this transaction was created for Creditcoin.
  ▼
  Attestcoin attestors
  │  attest the Ethereum block header onto Creditcoin.
  │  Observable via ChainInfo precompile 0x…0fd3 and
  │  GET /api/v1/attested-height/{chainKey}.
  ▼
  Proof Builder  (proof-gen-api.cc3-testnet.creditcoin.network)
  │  GET /api/v1/proof-by-tx/{chainKey}/{txHash}
  │  returns  { txBytes, merkleProof{root, siblings[]},
  │             continuityProof{lowerEndpointDigest, roots[]} }
  │  merkleProof   = the tx is in that block
  │  continuityProof = that block descends from an attested header
  ▼
  Creditcoin — AttestationRegistry.submit(action, chainKey, blockHeight, …)
  │  external, permissionless. Records chainKey context, then calls
  │  the inherited ASCBase.execute(...):
  │  ASCBase._computeQueryId → dedupe
  │  ASCBase._verifyProof   → BlockProver precompile 0x…0FD2
  │                           verifyAndEmit(), SYNCHRONOUS, native speed,
  │                           inside this very transaction. No callback,
  │                           no oracle round trip, no waiting block.
  ▼
  AttestationRegistry._processAndEmitEvent  (our business logic)
  │  EvmV1Decoder.getTransactionType / isValidTransactionType
  │  EvmV1Decoder.decodeReceiptFields      → require(receiptStatus == 1)
  │  EvmV1Decoder.getLogsByEventSignature  → every Attested log
  │  require(log.address_ == easAddress[chainKey])   ← security core
  │  EvmV1Decoder.decodeCommonTxFields     → raw FOREIGN calldata
  ▼
  registry[chainKey][uid] = MirroredAttestation{…}
  │
  ▼
  Any Creditcoin contract:  IAdmissibleRegistry(reg).isValid(3, uid)
```

The revocation path runs the identical pipeline with `action = 1`, only it matches on the
`Revoked` topic instead, flipping `revoked = true` and setting `revokedAt`.

---

## 3. How Admissible uses `ASCBase`

### 3.1 What `ASCBase` actually enforces

Before designing anything we read `@gluwa/asc-contracts@0.2.1`'s
`contracts/readability/ASCBase.sol` in full (113 lines), because the whole project rests
on one question: *does the framework allow you to prove a transaction sent to a contract
you do not own?*

```solidity
abstract contract ASCBase {
    INativeQueryVerifier public immutable VERIFIER;   // precompile 0x…0FD2
    mapping(bytes32 => bool) public processedQueries;

    function execute(
        uint8 action, uint64 chainKey, uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot, INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest, bytes32[] calldata continuityRoots
    ) external returns (bool success) {
        bytes32 queryId = _computeQueryId(chainKey, blockHeight, merkleRoot, siblings);
        require(!processedQueries[queryId], "Query already processed");
        require(_verifyProof(...), "Proof of inclusion verification failed");
        processedQueries[queryId] = true;
        _processAndEmitEvent(action, queryId, encodedTransaction);
        return true;
    }
}
```

The answer is yes, and it is worth stating the reason with care:

**`execute` is `external` and permissionless. There is no owner, no allowlist, no
registered source contract, and no check anywhere in the base class on what address the
proven transaction was sent to.** Its only jobs are verifying the proof, deduping, and
dispatching.

That observation is the load-bearing element of the entire design. It would be easy to
read the official `loan` example and walk away thinking the framework demands registration
of a source contract you own — the example contains `registerSourceLoanContract` and an
`ASCLoanManagerSourceBinding` test. **That is application-level logic the example adds,
not a base-class constraint.** Admissible adopts the same *pattern* — a mapping from
chainKey to an expected source address, asserted inside our own handler — but aims it at
the canonical EAS deployment rather than at a contract we deployed that morning.

Two consequences we rely on:

1. **Anyone can submit a mirror.** The Admissible worker holds no privileged role. A
   judge can submit a mirror themselves from their own key, against our deployed
   registry, without asking us. That is a genuine permissionlessness property and it is
   part of the demo.
2. **We inherit the framework's replay protection for free**, and it has a shape that
   turns out to be an evidence multiplier — see §5.3.

### 3.2 What Admissible implements

`AttestationRegistry` extends `ASCBase` and implements the single required hook. The
shape comes from `ASCMinter.sol` and `ASCLoanManager.sol` in the organizer's examples
repo:

```solidity
contract AttestationRegistry is ASCBase, IAdmissibleRegistry {

    // action discriminator passed through ASCBase.execute(uint8 action, …)
    uint8 constant ACTION_MIRROR = 0;   // decode Attested logs
    uint8 constant ACTION_REVOKE = 1;   // decode Revoked  logs

    function _processAndEmitEvent(
        uint8 action, bytes32 queryId, bytes memory encodedTransaction
    ) internal override {
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        require(EvmV1Decoder.isValidTransactionType(txType), "Unsupported tx type");

        EvmV1Decoder.ReceiptFields memory receipt =
            EvmV1Decoder.decodeReceiptFields(encodedTransaction);

        // GOTCHA 1 — the precompile does NOT check this. See §5.1.
        require(receipt.receiptStatus == 1, "Admissible: source transaction did not succeed");

        if (action == ACTION_MIRROR) _mirror(queryId, encodedTransaction, receipt);
        else if (action == ACTION_REVOKE) _revoke(queryId, receipt);
        else revert("Unknown action");
    }
}
```

The `action` dispatch reuses the same enum pattern the examples employ. Admissible leans
on it to carry two genuinely different semantics — a fact becoming true, and a fact
ceasing to be true — over a single proof pipeline.

#### Why there is a `submit` wrapper around `execute`

This is the single most important design decision in the contract, and it springs from a
constraint, not a preference.

`ASCBase._processAndEmitEvent` receives `(action, queryId, encodedTransaction)` — and
**not `chainKey`**. Yet the registry needs `chainKey` for the security check that matters
most: choosing which canonical EAS address the log emitter must be required to equal
(§5.2).

The obvious fix — overriding `execute` to accept and forward `chainKey` — is not
available. Read `ASCBase.execute`'s declaration verbatim from
`@gluwa/asc-contracts@0.2.1`:

```solidity
function execute(
    uint8 action, uint64 chainKey, uint64 blockHeight,
    bytes calldata encodedTransaction,
    bytes32 merkleRoot, INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
    bytes32 lowerEndpointDigest, bytes32[] calldata continuityRoots
) external returns (bool success) { … }
```

**It is `external`, and it is not `virtual`.** Solidity will not let a derived contract
override a non-`virtual` function — full stop. No override path exists here, at any skill
level.

The solution is a thin wrapper that records what `execute` will not carry forward, then
**self-calls the inherited `execute`** to do the actual work:

```solidity
function submit(
    uint8 action, uint64 chainKey, uint64 blockHeight, bytes32 sourceTxHash,
    bytes calldata encodedTransaction,
    INativeQueryVerifier.MerkleProof calldata merkleProof,
    INativeQueryVerifier.ContinuityProof calldata continuityProof
) external returns (bool success) {
    require(chainKey != 0, "Admissible: chainKey must be non-zero");
    require(easAddress[chainKey] != address(0), "Admissible: unsupported chainKey");
    _pendingChainKey = chainKey;  /* … */
    success = this.execute(action, chainKey, blockHeight, encodedTransaction,
                           merkleProof.root, merkleProof.siblings,
                           continuityProof.lowerEndpointDigest, continuityProof.roots);
    _pendingChainKey = 0;         /* … cleared */
}
```

It ferries the chainKey context across the `ASCBase` call boundary in a private storage
slot (`_pendingChainKey`, alongside `_pendingBlockHeight` and `_pendingSourceTxHash`),
which `_processAndEmitEvent` reads back and `submit` zeroes afterward — ordinary storage,
not EIP-1153 transient storage, since `evm_version = "london"` (§1.2) rules that out.
This keeps the design honest in two ways:

1. **Proof verification, `queryId` derivation, and the `processedQueries` dedupe map are
   untouched — they remain entirely `ASCBase`'s.** `submit` neither re-implements nor
   shadows any of the base class's security logic; it merely carries context the base
   class's signature leaves no room for. The self-call runs the *real* `execute`, not a
   copy of it.
2. **Calling `execute` directly reverts** with `"Admissible: call submit(), not
   execute()"`, covered by `test_RevertWhen_ExecuteIsCalledDirectly`, and this check fires
   **before any state is written** — a proof submitted with no chainKey context is
   rejected outright rather than processed with a missing or default EAS address.

`submit` is `external` and permissionless, exactly as `execute` is. The wrapper adds
context, not authorisation: a judge can still call it directly from their own key.
It also takes `merkleProof` and `continuityProof` as structs, matching the Proof Builder's
response shape verbatim rather than making callers flatten it.

#### One stored field is not proven, and says so

`sourceTxHash` is **submitter-supplied display metadata and is not verified on chain.**
The prover's `txBytes` is an ABI re-encoding rather than the original RLP, and the decoder
exposes type-specific fields only for transaction types 0 and 2, so the original Ethereum
transaction hash cannot be re-derived on chain for every type.

The *proven* identity of a source transaction is the `queryId` —
`keccak(chainKey, blockHeight, txIndex)` — which is emitted in every event and is what
`ASCBase` dedupes on. `uid`, `schemaUid`, `attester` and `recipient` all come out of the
proven receipt logs and are verified.

This is documented rather than buried because a spoofed `sourceTxHash` is exactly what the
independent check catches: it surfaces immediately as a FAIL in the
`admissible verify` field-by-field diff against easscan.

### 3.3 The frozen consumer interface

The point of the registry is that other people read it. That interface is frozen:

```solidity
struct MirroredAttestation {
    uint64  chainKey;      // 1 = Sepolia, 3 = Ethereum Mainnet
    bytes32 uid;
    bytes32 schemaUid;
    address attester;
    address recipient;
    uint64  sourceBlock;
    bytes32 sourceTxHash;
    uint64  mirroredAt;
    bool    revoked;
    uint64  revokedAt;
    bool    exists;
}

interface IAdmissibleRegistry {
    function attestationOf(uint64 chainKey, bytes32 uid) external view returns (MirroredAttestation memory);
    function isValid(uint64 chainKey, bytes32 uid) external view returns (bool);
    function isValidFrom(uint64 chainKey, bytes32 uid, address attester, bytes32 schemaUid) external view returns (bool);
    function totalMirrored() external view returns (uint256);
    function totalRevoked() external view returns (uint256);
    function easAddress(uint64 chainKey) external view returns (address);
}
```

A consuming contract needs three lines:

```solidity
IAdmissibleRegistry reg = IAdmissibleRegistry(ADMISSIBLE_REGISTRY);
require(reg.isValidFrom(3, uid, COINBASE_VERIFICATIONS_ATTESTER, KYC_SCHEMA),
        "no valid Ethereum credential");
```

There is the whole integration cost for a downstream Creditcoin dApp. All of the
Attestcoin plumbing — proof builder, precompile, decoder, replay protection — sits behind
the registry, paid for once.

---

## 4. The centrepiece: decoding foreign calldata

This is the part of the integration that goes past the documented happy path, and it is
deliberate.

### 4.1 What the docs recommend, and why they are right

The Attestcoin readability documentation is explicit about how to build an ASC:

- *"ASC-enabled dApps should have a single source chain contract."*
- *"Use unique events for each kind of readability query."*
- *"Avoid using common events like `Transfer`."*

That guidance is correct. A bespoke event on a contract you control is unambiguous,
cheap to decode, and impossible to spoof by accident.

It also carries a consequence: **an ASC built that way can only read transactions that
were created for Attestcoin.** You deploy a source contract on Ethereum, you emit your own
event, and then you have to get a user to go and do something new on Ethereum to generate
it. The cross-chain fact you prove is a fact you manufactured.

### 4.2 What Admissible does instead

Admissible reads the Ethereum that already exists.

The EAS deployment is fixed, canonical, and not ours. Its event is a "common event" in
exactly the sense the docs warn about — thousands of unrelated issuers emit it. So
instead of relying on event uniqueness for safety, Admissible pins the **emitter address**
per chainKey (§5.2) and then decodes as much of the real payload as the decoder allows.

`EvmV1Decoder` makes this possible because of one member of one struct:

```solidity
struct CommonTxFields {
    uint64  nonce;
    uint64  gasLimit;
    address from;
    bool    toIsNull;
    address to;
    uint256 value;
    bytes   data;        // ← raw calldata of a FOREIGN contract call
}

function decodeCommonTxFields(bytes memory chunk) returns (CommonTxFields memory);
function decodeReceiptFields(bytes memory chunk) returns (ReceiptFields memory);
function getLogsByEventSignature(ReceiptFields memory r, bytes32 sig) returns (LogEntry[] memory);
```

`CommonTxFields.data` is the raw calldata of a call to a contract nobody in this
hackathon controls. Inside Solidity, on Creditcoin, we can look at its first four bytes
and branch:

| Selector | EAS function | Note |
|---|---|---|
| `0xf17325e7` | `attest(...)` | single attestation |
| `0x44adc90e` | `multiAttest(...)` | **most real mainnet volume is this** |
| `0x46926267` | `revoke(...)` | |
| `0x4cb7e9e5` | `multiRevoke(...)` | |

Separately, `to` yields the original Ethereum transaction's destination address, which we
can compare against the canonical EAS deployment as a second, independent check on top of
the per-log emitter assertion.

Confirmed against real proven `txBytes` from three Ethereum **mainnet** EAS transactions
on 2026-09-10: the bytes contain the EAS mainnet address `0xa1207f…ce587`, the
`multiAttest` selector `0x44adc90e`, and the `Attested` topic0
`0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35` — the last of which
reproduces exactly what `cast sig-event` computes for the EAS signature, which is what
validates the whole topic table below.

### 4.3 Events decoded

| Event | topic0 |
|---|---|
| `Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)` | `0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35` |
| `Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)` | `0xf930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615` |
| `RevokedOffchain(address indexed revoker, bytes32 indexed data, uint64 indexed timestamp)` | `0x92a1f7a41a7c585a8b09e25b195e225b1d43248daca46b0faf9e0792777a2229` |

Topic layout for both `Attested` and `Revoked`: `topics[0]` = signature,
`topics[1]` = recipient, `topics[2]` = attester, `topics[3]` = schemaUID, and
`data` = the 32-byte `uid`. Note that the UID — the primary key of the entire EAS —
is in the **non-indexed** data field, so it can only be recovered by decoding the log
body, not by topic filtering.

### 4.4 Two layers, both shipped, honestly labelled

Log decoding and calldata decoding are separate capabilities with different risk
profiles, and this document keeps them distinct rather than blurring them:

- **Layer 1 — `Attested` / `Revoked` log decoding.** Yields
  `(uid, recipient, attester, schemaUID)` — enough for existence, issuer, subject and
  schema semantics, which is what `isValid` and `isValidFrom` need. This is what the
  frozen `MirroredAttestation` struct stores and what every published receipt exercises.
- **Layer 2 — `CommonTxFields.data` calldata decoding.** Yields the full attestation
  request payload: `expirationTime`, `revocable`, `refUID`, and the schema-encoded `data`
  blob — fields the `Attested` event does **not** carry at all.

**Layer 2 status: shipped, and decoded completely at both nesting levels of
`multiAttest`.** `EASReader.decodeAttestCalldata` (`contracts/src/EASReader.sol`) branches
on the selector and `abi.decode`s the proven calldata against the exact struct EAS itself
defines for that selector — not a best-effort partial parse:

```solidity
/// @dev BOTH selectors are decoded completely — including the doubly-nested dynamic
///      arrays of multiAttest. This is exact rather than best-effort because the selector
///      itself pins the ABI: 0x44adc90e IS the keccak of the canonical signature we
///      decode against, so any calldata that starts with it and decodes without
///      reverting had exactly this shape on Ethereum. multiAttest results are flattened
///      in EAS's own iteration order — request 0's datas, then request 1's datas, and so
///      on — which is the same order EAS emits its Attested logs in, so index i here
///      pairs with Attested log i.
function decodeAttestCalldata(bytes memory txData)
    internal pure returns (AttestationPayload[] memory payloads, bool ok);
```

This locks down both `attest`'s flat struct and `multiAttest`'s
`AttestationRequest[] → AttestationRequestData[]` nesting — reproduced from the same four
EAS selectors (`0xf17325e7`, `0x44adc90e`, `0x46926267`, `0x4cb7e9e5`) that `cast sig`
verified against the live chain.

**Where the recovered payload goes.** The frozen `MirroredAttestation` struct (SPEC.md
§7b) has no room for the extra fields, so `AttestationRegistry` emits them on a dedicated
event instead of widening the frozen struct:

```solidity
event AttestationPayloadRecovered(
    uint64 indexed chainKey, bytes32 indexed uid,
    bytes32 refUID, uint64 expirationTime, bool revocable, bytes data
);
```

**Guarded by try/catch, degrading rather than blocking.** `_mirror` calls
`decodeAttestCalldata` through `this.decodeForeignCalldata(...)` inside a `try/catch`
(`AttestationRegistry._tryRecoverPayloads`). If the proven transaction went to a
router, multicall, or relayer instead of directly to EAS — so `txData` is the wrapper's
calldata, not EAS's — decoding fails cleanly and the mirror still succeeds on Layer 1
alone. A malformed or truncated argument region behind a *recognised* selector would make
`abi.decode` revert; the `try/catch` turns that into "logs only" too, rather than reverting
the whole submission.

**What is honestly not decoded.** `attestByDelegation` and `multiAttestByDelegation` are
not decoded — their selectors are simply unrecognised and `decodeAttestCalldata` returns
`(empty, false)` for them, exactly as it does for a router-wrapped call. This is asserted
by a test (`test_AttestByDelegationSelectorIsNotDecoded` in
`contracts/test/EASReader.t.sol`) rather than left as a silent gap, specifically so nobody
mistakes silence for coverage.

Both layers are real uses of `EvmV1Decoder` on a third-party production contract. Layer 1
alone already exceeds what the official examples do, because the examples decode events
from contracts the example authors deployed. Layer 2 goes further: it recovers fields the
mirrored event never carried, from calldata sent to a contract nobody in this hackathon
controls.

---

## 5. The three gotchas, and how each is handled

These are the details that separate a working ASC from one that looks like it works.

### 5.1 The BlockProver precompile does not validate transaction success

The Attestcoin docs state it directly: *"the block prover precompile does not validate
if a transaction was successful."* The proof proves **inclusion**, not **outcome**. A
transaction that reverted is still genuinely in the block and will produce a perfectly
valid Merkle proof.

For Admissible, missing this would mean a reverted `attest()` call mirrors an attestation
that does not exist on Ethereum.

**Handled:** `require(receipt.receiptStatus == 1)` in `_processAndEmitEvent`, before any
log is read, for both actions.

**Proven handled:** remove that line and `test_RevertWhen_SourceReceiptStatusIsZero` and
`test_RevertWhen_FailedReceiptIsRevoked` fail. See §5.4.

This omission is common enough in the wild that another entrant in this hackathon
(`kasbsquall/thirdcheck`) is a static analyzer built specifically to lint for it.

### 5.2 The emitter address must be asserted per chainKey

This is the security core of the design, and it is a direct consequence of reading a
common event instead of a bespoke one.

`Attested` is not ours. Anyone can deploy a contract on Sepolia that emits a byte-identical
`Attested` log with any `uid`, `attester` and `schemaUID` they like, get it into a block,
and produce a completely valid Attestcoin proof for it. Without an emitter check, that
attacker writes arbitrary entries into the Admissible registry and every downstream
consumer of `isValid` is compromised.

**Handled, two ways:**

```solidity
// per log, inside the loop
require(log.address_ == canonicalEas, "EASReader: log emitter is not canonical EAS");
```

- `easAddress` is a `chainKey → address` mapping set at deployment:
  `1 → 0xC2679fBD37d54388Ce493F1DB75320D236e1815e`,
  `3 → 0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587`. It is exposed publicly as
  `easAddress(uint64)` so anyone can check what the registry trusts.
- The registry is keyed on **`(chainKey, uid)`**, never `uid` alone. Mainnet and Sepolia
  are different EAS contracts with independent UID spaces; collapsing them would let a
  Sepolia attestation satisfy a mainnet check. This had to be settled before the storage
  layout was written.

**Proven handled:** remove the emitter assertion and four tests fail —
`test_RevertWhen_AttestedLogComesFromASpoofedEas`,
`test_RevertWhen_SpoofedEmitterIsPreviewed`,
`test_RevertWhen_SpoofedLogIsMixedWithARealOne`, and
`test_RevertWhen_SepoliaEasLogIsSubmittedAsMainnet`. The last of those is the
chainKey-binding case: a genuine Sepolia EAS log submitted as though it were mainnet. See
§5.4.

### 5.3 Dedupe is per transaction, not per attestation

`ASCBase._computeQueryId` hashes `(chainKey, blockHeight, txIndex)`, where `txIndex` comes
from `VERIFIER.calculateTxIndex(merkleProof)`:

```solidity
assembly {
    let ptr := mload(0x40)
    mstore(ptr, chainKey)
    mstore(add(ptr, 32), shl(192, blockHeight))
    mstore(add(ptr, 40), txIndex)
    queryId := keccak256(ptr, 72)
}
```

The unit of replay protection is therefore **one Ethereum transaction**, not one
attestation. And most real mainnet EAS volume is `multiAttest` — one transaction carrying
many attestations.

The failure mode is silent: a handler that reads `logs[0]` and returns compiles, passes a
single-attestation test, marks the query processed, and then **permanently** drops every
other attestation in that transaction, because the queryId can never be replayed.

**Handled:** `_processAndEmitEvent` iterates *every* matching log in the receipt and
writes N registry entries from one `execute` call.

This is also the reason the evidence file records both `queryId` and `batchIndex`: so a
reader can derive the attestation count and the Creditcoin transaction count
independently, and we can report *"N attestations in M on-chain submissions"* rather
than conflating the two.

---

### 5.4 Proving the guards are actually load-bearing

The three gotchas above are the ones every ASC has to get right, and each is handled by a
`require` that is easy to write and easy to write *vacuously*. A test suite that passes
does not by itself show that the guards do anything — the tests might assert nothing, or
exercise a path the guard never touches.

So the guards were removed and the suite re-run.

The mutation itself was run against `AttestationRegistry.t.sol`, the suite that contains
every test naming these two guards. The wider suite (`CredentialGatedPool.t.sol`,
`EASReader.t.sol`) is unaffected by either guard and is reported separately below for
context.

```
baseline                  41 tests, 41 passed, 0 failed     (AttestationRegistry.t.sol)
guards removed            41 tests, 35 passed, 6 failed     (AttestationRegistry.t.sol)
guards restored           41 tests, 41 passed, 0 failed     (AttestationRegistry.t.sol)

full suite, guards in     78 tests, 78 passed, 0 failed, 0 skipped   (3 suites: 41 + 23 + 14)
```

Removed for the mutation run:

```solidity
// AttestationRegistry.sol
require(receipt.receiptStatus == 1, "Admissible: source transaction did not succeed");

// EASReader.sol
require(log.address_ == canonicalEas, "EASReader: log emitter is not canonical EAS");
```

The six failures, and the gotcha each one defends:

| Failing test | Gotcha |
|---|---|
| `test_RevertWhen_SourceReceiptStatusIsZero` | §5.1 — the precompile does not validate transaction success |
| `test_RevertWhen_FailedReceiptIsRevoked` | §5.1, on the revocation action |
| `test_RevertWhen_AttestedLogComesFromASpoofedEas` | §5.2 — emitter must be the canonical EAS |
| `test_RevertWhen_SpoofedEmitterIsPreviewed` | §5.2, on the read-only preview path |
| `test_RevertWhen_SpoofedLogIsMixedWithARealOne` | §5.2, combined with §5.3's N-entry loop |
| `test_RevertWhen_SepoliaEasLogIsSubmittedAsMainnet` | §5.2 — the emitter is checked *per chainKey* |

Both guards were removed in the same run, so the count of six is for the pair; the test
names indicate which guard each targets.

Three of these are worth reading in full:

- **`test_RevertWhen_SpoofedLogIsMixedWithARealOne`** places a spoofed log in the same
  receipt as a genuine one. This is the attack that an implementation reading only
  `logs[0]`, or checking the emitter only once, waves straight through. It is where §5.2
  and §5.3 interact: you must check *every* log, not the first, and not just some.
- **`test_RevertWhen_SepoliaEasLogIsSubmittedAsMainnet`** submits a genuine Sepolia EAS
  log under chainKey 3. Nothing is forged; the log is entirely real. It must still be
  rejected, because Sepolia attestations cost nothing to create and mainnet checks must
  not be satisfiable with them.
- **`test_RevertWhen_FailedReceiptIsRevoked`** covers the receipt-status guard on the
  *revocation* path, not just the mirror path. A reverted `revoke()` marking an
  attestation invalid is a denial-of-service against a legitimate credential holder — the
  inverse failure to the one §5.1 usually gets described as.

The full procedure and raw `forge test` output are in `contracts/MUTATION-CHECK.md`, and
the mutation is reproducible: delete the two lines, run `forge test`, restore them.

## 6. Off-chain integration: the SDK surface

Admissible's TypeScript layer is a thin wrapper over `@gluwa/usc-sdk@0.18.0`. The full
API reference is in [sdk](./sdk.md); this section covers only the Attestcoin calls that
matter.

```ts
import { chainInfo, proofProvider } from '@gluwa/usc-sdk';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(CREDITCOIN_RPC);
const info     = new chainInfo.PrecompileChainInfoProvider(provider);   // 0x…0fd3
const builder  = new proofProvider.service.ProofBuilder(chainKey, PROVER_URL);

// 1. is the Ethereum block attested onto Creditcoin yet?
await builder.waitUntilHeightAttested(chainKey, blockNumber);

// 2. inclusion proof + continuity proof
const proof = await builder.getProof(txHash);

// 3. up to 10 proofs, within a 1000-block range
const batch = await builder.getBatchProof([tx1, tx2 /* … */]);

// 4. submit — the registry's submit(...) wrapper records chainKey, then calls the
//    inherited ASCBase.execute internally. BlockProver verifies synchronously inside
//    this transaction. Calling execute() directly (skipping submit) reverts — see §3.2.
await registry.submit(
  ACTION_MIRROR, chainKey, proof.headerNumber, sourceTxHash, proof.txBytes,
  { root: proof.merkleProof.root, siblings: proof.merkleProof.siblings },
  { lowerEndpointDigest: proof.continuityProof.lowerEndpointDigest, roots: proof.continuityProof.roots }
);
```

Four protocol details encoded here that are easy to get wrong:

1. **Use `ProofBuilder.waitUntilHeightAttested`, not the ChainInfo one.** The SDK's own
   docs mark `PrecompileChainInfoProvider.waitUntilHeightAttested` as *"a legacy
   implementation"*. The Proof Builder maintains its own ingestion cache that lags
   on-chain attestation, so the on-chain height can say "attested" while the prover
   still 404s. Waiting on the prover's view is the correct barrier.
2. **`BlockNotOnSourceChain` is retryable, not fatal.** It means *too recent* — inside
   the source chain's reorg-protection window (32 blocks on Sepolia) — not *wrong*. The
   worker backs off and retries; it does not log a failure.
3. **`getProof` returns the proof object directly**, not wrapped in `{success, data}`.
4. **Batch limits are hard:** max 10 proofs, within a 1000-block range. The bench is
   designed around that unit rather than discovering it at runtime.

The mirror progress callback surfaces the protocol's own stages to the user, because the
point of the UI is that you watch Attestcoin work:

```ts
type MirrorStage =
  | 'resolving'            // UID → source tx (easscan GraphQL)
  | 'awaiting-attestation' // Attestcoin attestors, live height counter on screen
  | 'building-proof'       // Proof Builder: roots + siblings rendered
  | 'submitting'           // Creditcoin tx in flight → BlockProver 0x…0FD2
  | 'mirrored' | 'failed';
```

Attested height, continuity-root count, Merkle-sibling count and the precompile address
are all rendered on screen. The user is not using an app that happens to have Attestcoin
in the backend; they are watching an Ethereum fact get proven.

### 6.1 Failure handling worth naming

- **Large transactions.** Transactions above ~500 KB may not be provable. One real
  mainnet EAS transaction already measured 16,193 bytes and some `multiAttest` batches
  are much larger. The worker logs the failure to the receipts file and continues rather
  than crashing.
- **Failures are published.** `receipts/mirrors.jsonl` records one line per *attempt*,
  including failures. A receipts file containing only successes is less credible, not
  more.

---

## 7. Measured performance and cost

### 7.1 Pre-build feasibility probe (2026-09-10, before any product code)

Raw output is committed at `prebuild-evidence/scale_probe.json` in the repository,
generated by `prebuild-evidence/probe.py`. All eleven transactions are real Ethereum
**mainnet** EAS transactions written by third parties.

| Measurement | Result |
|---|---|
| Mainnet EAS attestations proof-generated | **11 / 11 succeeded, 0 failed** |
| Proof latency | **median 3.56 s, p95 7.30 s** (min 1.31 s, max 7.30 s) |
| Continuity proof size | min 12 / median 32 / max 94 roots |
| Est. on-chain verify cost | **3.2 – 5.0 × 10⁻⁵ CTC** |
| Attestcoin lag behind mainnet head | **42 blocks (~8 min)** |
| Historical reach | a transaction ~10,600 blocks back needed only **22** continuity roots |

That last row matters for anyone sizing an Attestcoin integration: continuity proof size
does not grow linearly with age the way the worst case suggests. The documented
worst case (24 h / 1000 hashes) is not the common case — proving history is cheap.

### 7.2 Cost model

The docs' formula, which the estimates above use:

```
CTC ≈ 2.3e-5 + 2.9e-7 × continuityRoots
```

Applied to the measured root counts: 32 roots → `3.23e-5` CTC, 94 roots → `5.03e-5` CTC.
The documented ceiling for a maximum decode is `0.0375` CTC.

### 7.3 Deployed bytecode diffed against source

The bytecode actually deployed at `0xA972422a821F622bcC1a72d0B19242F1ae2C6047`
(`AttestationRegistry`) and `0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6`
(`CredentialGatedPool`) was diffed against a local `forge build` of this repository. The
only differences are the compiler's `immutable` placeholders, and each is the value it
should be:

| Contract | Differing positions | Value |
|---|---|---|
| `AttestationRegistry` | 3 | `0fd2` — the `VERIFIER` (BlockProver) precompile address |
| `CredentialGatedPool` | 5 | `a972422a…6047` — the `AttestationRegistry` address |

Every other byte matches. This is the same check `forge verify-contract` performs against
a block explorer; it is stated here explicitly because unverified deployed bytecode is a
common gap in hackathon submissions.

### 7.4 Measured on-chain results

**Attestations mirrored: 386.** Read live from the registry, the only number that counts
attestations mirrored by any submitter, not just this project's own bench run —
`execute()` is permissionless (§2):

```bash
cast call 0xA972422a821F622bcC1a72d0B19242F1ae2C6047 "totalMirrored()(uint256)" \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network
```

Read at `2026-09-11T11:34:49Z`. `receipts/summary.json`, if present, is a snapshot
generated mid-run (its own `generatedAt` field records when) and will read lower than this
— both the bench and the mirror worker keep submitting after any snapshot is taken.
Re-run the `cast call` above rather than trusting a number printed in this document once
it is more than a few minutes old.

The submission-level detail below is computed directly from `receipts/mirrors.jsonl`
(943 rows) as of the same timestamp. One row is logged per *attestation*, so a
`multiAttest` submission writes several rows sharing one `queryId`; cost, gas and latency
are submission-level fields repeated on every such row, so they are deduplicated **by
`queryId`** below rather than summed per row — reproduction script in
[verify §"Reading the receipts file"](./verify.md). This file captures only what this
project's own bench script submitted; a second, independent process (`relayer/`,
`receipts/relayer.jsonl`, 9 rows, 3 successful submissions) also mirrors permissionlessly
and accounts for part of the gap between the 348 attestations logged below and the
registry's 386 — the remainder is submissions made in the minutes between snapshot and
live read.

| Measurement | Result |
|---|---|
| Attestations mirrored (this file's rows) | **348** |
| On-chain submissions (distinct `queryId`) | **173** |
| Attestations per submission (mean) | **2.01** |
| chainKey 3 (mainnet) / chainKey 1 (Sepolia) split, by submission | **122 / 51** |
| Proof latency, median / p95 (per submission) | **5.18 s / 11.22 s** |
| Submit latency, median / p95 (per submission) | **10.73 s / 19.96 s** |
| Total CTC spent | **0.068070323 CTC** across 173 submissions |
| Already-mirrored (skipped, idempotent, no CTC spent) | **201** |
| Failed rows (logged, not hidden) | **394** — two distinct causes, see below |

**On the 394 failed rows.** They are not one category:

- **283 rows: `dedupe check failed`.** The bench and the relayer are separate,
  independently-scheduled processes; they sometimes race to submit the same `queryId`
  (`ASCBase` dedupes on `keccak(chainKey, blockHeight, txIndex)`, §2). The registry
  correctly rejects the second submitter and no CTC is spent. This is the replay
  protection working as designed — the same guarantee that stops a `queryId` from ever
  writing an attestation twice — not a defect, and not filtered out of the count because a
  receipts file that hides its own dedupe collisions would be less credible, not more.
- **110 rows: `transaction execution reverted`.** These are genuine failures,
  concentrated in just **4** distinct `queryId`s, all chainKey 1 (Sepolia). Two repeat a
  previously-identified cause: one Sepolia source transaction with an outsized proof
  (776 continuity roots, sourceBlock 9,653,225) and a related one (778 roots, sourceBlock
  9,653,223) — both far outside the 12–94 root range measured in the pre-build probe. The
  other two `queryId`s (44 and 74 continuity roots — ordinary proof sizes) also reverted;
  none of the four carries a `creditcoinTxHash` or `gasUsed`, meaning in every case the
  revert was caught before a transaction was mined — consistent with the error's own
  `action="sendTransaction"` field, i.e. a send-time simulation failure rather than a
  mined-and-failed transaction. Worth stating this precisely: conflating "rows" with
  "submissions" in a failure count would be the same mistake §5.3 spends a full section
  warning against for successes — 110 rows is 4 underlying incidents, not 110 independent
  ones.
- **1 row** has an empty `error` string: a logged failure whose specific cause was not
  captured in the message. Left in the count rather than dropped.

Proof **generation** is free; only **submission** costs CTC. The receipts file keeps them
as distinct fields because they have different cost profiles and different failure modes,
and a reader must not assume every row is a Creditcoin transaction. These numbers will
grow as the bench continues running; re-derive them from the file, and re-read
`totalMirrored` live, rather than trusting this table if it is stale.

---

## 8. Scope boundaries, stated plainly

**Attestcoin writability is not live.** The documentation describes the write path as
"undergoing 3rd party testing and audits". Admissible is therefore **read-only,
Ethereum → Creditcoin, by design**. Nothing in this project writes back to Ethereum and
nothing in the demo implies it does. When writability ships, the natural extension is
publishing Creditcoin repayment history back to Ethereum as EAS attestations — the same
pipeline in reverse — but that is roadmap, not a claim.

**The Proof Builder is a hosted service, and that is a centralization point.** It sits in
a protocol whose pitch is the removal of centralized oracle operators, so it deserves to
be named rather than glossed over. The seam already exists: `@gluwa/usc-sdk` ships
**`RawProofBuilder`**, which computes proofs offline against the same interface as the
hosted `ProofBuilder`. Admissible's SDK isolates proof acquisition behind one function for
exactly this reason — swapping in `RawProofBuilder` is a constructor change, not a
rewrite. Building and operating a self-hosted proof builder is a multi-week project and
was cut from a three-day build, deliberately, not overlooked.

**The revocation demonstration uses a self-issued attestation.** A sweep of 15,000 recent
Sepolia blocks found **zero** `Revoked` events, and easscan returns only a handful ever —
revocations are genuinely rare in the wild. The revocation demo therefore uses an
attestation issued from a key we control on Sepolia, disclosed as such. It is **not** a
third-party revocation and is not presented as one. Every other proof in this project is
of a transaction we did not create.

What has actually happened, on chain, as of this writing:

| Step | Status |
|---|---|
| Schema registered on Sepolia `SchemaRegistry` (`0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0`), schema string `"bool admissibleDemoVerified2026"`, resolver `address(0)`, `revocable: true` | done — tx `0x7f62d7cd45cf20b32de4a83b031b7e18f2d691363e122765e64314b5df5a6052`, schema UID `0xd7a630e8afc8591dbfbadd9435caa4602405228a3ee190bad35172aa32636faa` |
| Attestation issued — recipient = attester = `0xA5B3d738FB24C880a2BB1Bc4Ec65475489889714` (self-issued) | done — tx `0x8771a1dd1c69d7758ce9fb753534e89a2e2548a50502b475f06e05a6a17a5720`, block 11,681,621, UID `0x751a62300a8db56f65a5cc0f94fa3892ba814070262c007a2d76f1e3c960196a` |
| Revoke on Sepolia, then prove and mirror the `Revoked` event onto the registry | pending — `totalRevoked()` read `0` at `2026-09-11T11:34:49Z` |

```bash
cast call 0xA972422a821F622bcC1a72d0B19242F1ae2C6047 "totalRevoked()(uint256)" \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network
```

Until that command reads above zero, the fair description is **a mechanism implemented and
tested**, not a completed live demonstration. The revoke path (§3, `action = 1`) runs the
identical proof pipeline as a mirror — same `execute()` entrypoint, same BlockProver
verification, decoding `Revoked` instead of `Attested` and flipping `revoked = true` — and
two of the mutation-checked security tests target it directly:
`test_RevertWhen_SourceReceiptStatusIsZero` and `test_RevertWhen_FailedReceiptIsRevoked`
(`contracts/MUTATION-CHECK.md`, §6 above).

**Mainnet supplies credibility, Sepolia supplies volume.** Mainnet EAS throughput is low
— the last 60 attestations on easscan collapsed to only 11 unique transactions. The
receipts file labels each mirror with its chainKey rather than blurring the two.

**One queryId processes one action.** `ASCBase` retires a `queryId` the moment `execute`
succeeds for it, and the action (`Mirror` vs. `Revoke`) is chosen by the caller, not
inferred from the proof. A source transaction that happened to contain both an `Attested`
log and a `Revoked` log could therefore only ever be processed under one action — the
other event type in that same transaction would be unreachable, because the query can
never be resubmitted. In practice this does not bite: EAS's `attest`/`multiAttest` and
`revoke`/`multiRevoke` are disjoint calls, so a real transaction carries one event type,
never both. The limit is stated here because the frozen action discriminator (SPEC.md §7b)
is worth defending rather than silently working around.

**`attestByDelegation` and `multiAttestByDelegation` are not decoded.** Layer 2 recognises
only the four direct-call selectors (§4.3). An attestation created through EAS's
delegation flow still mirrors correctly from its `Attested` log — Layer 1 does not care
how the transaction was constructed — but `AttestationPayloadRecovered` is not emitted for
it. This is asserted by `test_AttestByDelegationSelectorIsNotDecoded`, which checks that
the decoder returns `false` rather than fabricating a payload.

---

## 9. Where the Attestcoin integration lives in this repo

| Path | What it does with Attestcoin |
|---|---|
| `contracts/src/AttestationRegistry.sol` | Extends `ASCBase`. Implements `_processAndEmitEvent`, action dispatch, receipt-status check, N-entry loop. |
| `contracts/src/EASReader.sol` | Uses `EvmV1Decoder` to decode receipt logs and `CommonTxFields.data` from the canonical EAS contract; emitter assertion. |
| `contracts/src/IAdmissibleRegistry.sol` | The consumer-facing interface. Contains no Attestcoin types — the protocol is fully behind it. |
| `contracts/test/` | Foundry tests using fixtures captured from **real** proofs, not synthetic bytes. |
| `packages/sdk/src/mirror.ts` | `ProofBuilder`, `waitUntilHeightAttested`, `getProof`, `getBatchProof`, submission, progress callbacks. |
| `packages/sdk/src/verify.ts` | Reads registry state over public RPC and diffs against easscan. Powers `npx admissible verify`. |
| `worker/` | Long-running mirror worker across both chainkeys. Structure adapted from the organizer's `bridge-offchain-worker`. |
| `bench/` | Volume runner producing `receipts/mirrors.jsonl`. Batches within the 10-proof / 1000-block limits. |
| `web/` | Renders the five protocol stages live, with attested height, root counts and precompile addresses on screen. |

---

## 10. Reproducing the integration

```bash
# 1. the protocol is live
curl https://proof-gen-api.cc3-testnet.creditcoin.network/api/v1/attested-height/3

# 2. pull a real proof for a real mainnet EAS transaction from the probe set
curl -s https://proof-gen-api.cc3-testnet.creditcoin.network/api/v1/proof-by-tx/3/\
0xa579af8e43e78c884ce7b67f6753a96c67bf2ded055552806bb284df0e87b7d1 | head -c 400

# 3. read what Admissible stored on Creditcoin, with no Admissible code involved
cast call <REGISTRY_ADDRESS> "attestationOf(uint64,bytes32)" 3 0x<EAS_UID> \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network

# 4. read what the registry trusts as canonical EAS for chainKey 3
cast call <REGISTRY_ADDRESS> "easAddress(uint64)" 3 \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network
```

Step 3 is the important one. It goes through a public RPC to a public contract and
touches nothing we control except the contract itself, whose source is in this repo and
whose trusted-EAS mapping step 4 prints back to you.

For the full independent-verification procedure, including the cross-check against
easscan, see [verify](./verify.md). For getting a first attestation mirrored yourself,
see [quickstart](./quickstart.md).

---

## 11. Attribution

- **`@gluwa/asc-contracts@0.2.1`** and **`@gluwa/usc-sdk@0.18.0`** — Gluwa / Creditcoin.
  `ASCBase`, `EvmV1Decoder`, `INativeQueryVerifier` and the entire Attestcoin client are
  the organizer's work, used as intended.
- **`github.com/gluwa/attestcoin-protocol-examples`** — the organizer's official examples
  repo. `AttestationRegistry.sol`'s structure follows `bridge/contracts/sol/ASCMinter.sol`
  and `ASCLoanManager.sol`; `worker/`'s loop structure follows
  `bridge/bridge-offchain-worker/worker.ts`. The full provenance table is in the
  repository README.
- **Ethereum Attestation Service** — MIT licensed. Admissible reads its canonical
  deployments and reuses its event and selector definitions. No EAS code is vendored.
- Admissible itself is MIT licensed; see `LICENSE` in the repository root.

Per the organizer's request, this document says **"Attestcoin Protocol"** throughout.
`usc-sdk` appears only where it is the literal npm package name.