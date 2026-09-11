# Registry reference

`AttestationRegistry` is the durable artifact of this project. It is an Attestcoin Smart
Contract that stores Ethereum attestations proven onto Creditcoin, and it is the surface
every other contract reads.

## Deployment

| | |
|---|---|
| Network | Creditcoin CC3 testnet |
| Chain ID | `102031` (`0x18e8f`) |
| RPC | `https://rpc.cc3-testnet.creditcoin.network` |
| Explorer | `https://creditcoin-testnet.blockscout.com` (account/contract pages: `/address/{addr}`; transactions: `/tx/{hash}`) |
| `AttestationRegistry` | **`0xA972422a821F622bcC1a72d0B19242F1ae2C6047`** |
| `CredentialGatedPool` | `0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6` |
| `EASReader` | a `library` with `internal` functions — inlined into the registry bytecode, not separately deployed |
| Registry deploy tx | `0xda62e5f110d4d4caaa129e732b484b932b5c31dd3c488eafa1cdeb2b7c5e52fc` |
| Deployed at | block `5465943`, 2026-09-10 |

Machine-readable source of truth: `contracts/deployments.json`. ABIs are committed at
`contracts/abi/`.

**The mirroring path has no owner gate.** `submit` (and the `execute` it calls
internally) is `external` and permissionless — anyone can mirror an attestation,
including you, without asking us. Nothing about *writing an attestation record* requires
our involvement.

The contract does have a narrow owner role, unrelated to mirroring: `owner` can call
`setEasAddress(chainKey, address)` to register the canonical EAS address for a *new*
source chainKey (chainKeys 1 and 3 are pre-seeded at deployment and do not need this),
and `transferOwnership(address)`. The owner cannot write, forge, or revoke a
`MirroredAttestation` — that state changes only through a proof the BlockProver precompile
accepts. Deployer and initial owner: `0xA5B3d738FB24C880a2BB1Bc4Ec65475489889714`.

## The record

```solidity
struct MirroredAttestation {
    uint64  chainKey;      // 1 = Ethereum Sepolia, 3 = Ethereum Mainnet
    bytes32 uid;           // the EAS attestation UID
    bytes32 schemaUid;     // the EAS schema it was written against
    address attester;      // who signed it, on Ethereum
    address recipient;     // who it is about
    uint64  sourceBlock;   // the Ethereum block it was written in
    bytes32 sourceTxHash;  // the Ethereum transaction that created it
    uint64  mirroredAt;    // Creditcoin block.timestamp when mirrored
    bool    revoked;
    uint64  revokedAt;     // 0 if not revoked
    bool    exists;        // false = never mirrored
}
```

`sourceBlock` and `sourceTxHash` are stored so any entry can be traced back to Ethereum
and checked against a source we do not control. That is what makes
[verification](./verify.md) possible.

### Why `(chainKey, uid)` and not `uid`

Mainnet and Sepolia run different EAS contracts with independent UID spaces. Two
attestations on two chains can share a UID and mean entirely different things. Keying on
`uid` alone would let a Sepolia attestation — which anyone can write, for free, in
seconds — satisfy a check intended for Ethereum mainnet. Every function below therefore
takes `chainKey` first.

## Read functions

### `isValid`

```solidity
function isValid(uint64 chainKey, bytes32 uid) external view returns (bool);
```

True only if the attestation has been mirrored **and** has not been revoked. This is the
function most consuming contracts call.

### `isValidFrom`

```solidity
function isValidFrom(
    uint64 chainKey, bytes32 uid, address attester, bytes32 schemaUid
) external view returns (bool);
```

`isValid`, plus the attester and schema must match. Prefer this over `isValid` in
production. `isValid` only tells you *someone* attested *something* about this UID;
`isValidFrom` tells you the issuer you trust wrote the schema you meant. An attestation
from an unknown attester against an unknown schema is not a credential.

### `attestationOf`

```solidity
function attestationOf(uint64 chainKey, bytes32 uid)
    external view returns (MirroredAttestation memory);
```

The full record. `exists == false` means never mirrored — check that before trusting any
other field, since an unmirrored UID returns a zeroed struct.

### `easAddress`

```solidity
function easAddress(uint64 chainKey) external view returns (address);
```

The canonical EAS deployment this registry accepts logs from, for that chainKey. It is
public precisely so you can audit what the registry trusts:

| chainKey | Expected |
|---|---|
| 1 | `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` |
| 3 | `0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587` |

Every `Attested` and `Revoked` log is checked against this before it is stored. Without
that check anyone could deploy a fake EAS clone, emit a byte-identical event, obtain a
perfectly valid Attestcoin proof for it, and write whatever they liked into the registry.
It is the security core of the design.

### `totalMirrored` and `totalRevoked`

```solidity
function totalMirrored() external view returns (uint256);
function totalRevoked()  external view returns (uint256);
```

Counters across both chainkeys, for the stats surface.

## Events

```solidity
event AttestationMirrored(
    uint64 indexed chainKey, bytes32 indexed uid, bytes32 indexed schemaUid,
    address attester, address recipient, uint64 sourceBlock, bytes32 queryId
);

event AttestationRevoked(
    uint64 indexed chainKey, bytes32 indexed uid, uint64 revokedAt, bytes32 queryId
);

/// Emitted only when the source transaction called EAS directly and the calldata decoded
/// cleanly — see "Depth: recovered payload fields" below. Absent for log-only mirrors.
event AttestationPayloadRecovered(
    uint64 indexed chainKey, bytes32 indexed uid,
    bytes32 refUID, uint64 expirationTime, bool revocable, bytes data
);
```

`queryId` is `ASCBase`'s `keccak(chainKey, blockHeight, txIndex)` — the Attestcoin
replay-protection key. Several `AttestationMirrored` events sharing one `queryId` came
from one `multiAttest` transaction and one `submit` call, which is why the receipts file
records `queryId` alongside `batchIndex`: attestation count and transaction count are
different numbers and both should be derivable.

### Depth: recovered payload fields

`MirroredAttestation` is a frozen struct (SPEC.md §7b) and has no room for
`expirationTime`, `revocable`, or `refUID` — fields the `Attested` event itself does not
carry. The registry recovers them anyway, from the proven transaction's raw calldata
(`EvmV1Decoder.CommonTxFields.data`), decoding both the `attest` and `multiAttest`
selectors completely, including `multiAttest`'s nested per-request arrays. Recovery runs
behind a `try/catch`: if the source transaction went through a router or multicall instead
of calling EAS directly, decoding fails cleanly and `AttestationPayloadRecovered` is simply
not emitted for that entry — the `Attested`-log mirror still succeeds. Full mechanism in
[the integration doc §4](./attestcoin-integration.md).

## Write path

The entrypoint is `submit`, not `execute`:

```solidity
function submit(
    uint8 action,
    uint64 chainKey,
    uint64 blockHeight,
    bytes32 sourceTxHash,
    bytes calldata encodedTransaction,
    INativeQueryVerifier.MerkleProof calldata merkleProof,
    INativeQueryVerifier.ContinuityProof calldata continuityProof
) external returns (bool success);
```

Selector `0xb560a741` — independently reproducible:

```bash
cast sig "submit(uint8,uint64,uint64,bytes32,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))"
```

Action discriminator:

| `action` | Meaning |
|---|---|
| `0` | Mirror — decode `Attested` logs |
| `1` | Revoke — decode `Revoked` logs |

`merkleProof` and `continuityProof` are passed exactly as the Proof Builder returns them,
which is why they are structs here rather than the flattened argument list `ASCBase` uses.

`submit` is `external` and permissionless — no owner, no allowlist. It records `chainKey`,
`blockHeight` and `sourceTxHash`, then calls the inherited `ASCBase.execute(...)`, which
verifies the proof through the BlockProver precompile and dispatches to the registry's
handler. The wrapper exists because `ASCBase`'s `_processAndEmitEvent` hook does not
receive `chainKey`, and the registry needs it to select the canonical EAS address.

**Calling `execute` directly reverts** with `"Admissible: call submit(), not execute()"`,
because the chainKey context would be missing. This is covered by
`test_RevertWhen_ExecuteIsCalledDirectly`. Permissionlessness is unaffected — `submit` is
just as open as `execute` was.

The registry never takes anyone's word for anything. The only path to writing state is a
proof that the BlockProver precompile at `0x…0FD2` accepts. See
[the integration doc](./attestcoin-integration.md) for the full pipeline.

### One field is not proven: `sourceTxHash`

Worth stating plainly, because this project's whole claim is that you should check things.

`sourceTxHash` is **display metadata supplied by the submitter and is not verified on
chain.** The prover's `txBytes` is an ABI re-encoding rather than the original RLP, and the
decoder exposes type-specific fields only for transaction types 0 and 2, so the original
Ethereum transaction hash cannot be re-derived on chain for all types.

The *proven* identity of a source transaction is the `queryId`,
`keccak(chainKey, blockHeight, txIndex)`, which is emitted in every event and is what
`ASCBase` dedupes on. Everything else in the record — `uid`, `schemaUid`, `attester`,
`recipient` — comes out of the proven receipt logs and is verified.

A wrong or spoofed `sourceTxHash` is not silently trusted: it surfaces immediately as a
FAIL in the `admissible verify` field-by-field diff against easscan, which is exactly the
check [verify](./verify.md) asks a judge to run.

## Querying with `cast`

```bash
RPC=https://rpc.cc3-testnet.creditcoin.network
REG=0xA972422a821F622bcC1a72d0B19242F1ae2C6047
UID=0x<EAS_UID>

# is it valid right now? (chainKey 3 = Ethereum mainnet)
cast call $REG "isValid(uint64,bytes32)" 3 $UID --rpc-url $RPC

# from the issuer and schema you actually trust
cast call $REG "isValidFrom(uint64,bytes32,address,bytes32)" 3 $UID $ISSUER $SCHEMA \
  --rpc-url $RPC

# the full record, decoded
cast call $REG "attestationOf(uint64,bytes32)" 3 $UID --rpc-url $RPC

# what does this registry trust as EAS on mainnet?
cast call $REG "easAddress(uint64)" 3 --rpc-url $RPC

# totals
cast call $REG "totalMirrored()" --rpc-url $RPC
cast call $REG "totalRevoked()"  --rpc-url $RPC
```

With ethers instead:

```ts
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://rpc.cc3-testnet.creditcoin.network');
const registry = new ethers.Contract(REGISTRY_ADDRESS, [
  'function isValid(uint64,bytes32) view returns (bool)',
  'function attestationOf(uint64,bytes32) view returns (tuple(uint64,bytes32,bytes32,address,address,uint64,bytes32,uint64,bool,uint64,bool))'
], provider);

console.log(await registry.isValid(3, uid));
```

## Gas and cost

Per the Attestcoin cost model `CTC ≈ 2.3e-5 + 2.9e-7 × continuityRoots`, and the
continuity-root counts measured in the pre-build probe (12–94 roots across 11 real
mainnet transactions), a verification costs roughly **3.2 – 5.0 × 10⁻⁵ CTC**. The
documented ceiling for a maximum decode is `0.0375` CTC.

Reads are free. Measured on-chain submission costs are in the evidence table in the
repository README.
