# SDK reference

`@admissible/sdk` — mirror an Ethereum attestation onto Creditcoin, read it back, and
verify it against an independent source. A thin layer over `@gluwa/usc-sdk@0.18.0` and
`ethers` v6.

The SDK is a **functional API**. There is no client class to construct; every function
takes its configuration as an optional last argument and falls back to public defaults.

## Install

```bash
pnpm add @admissible/sdk     # npm install / yarn add work too — it is a normal package
```

Peer dependency: `ethers@^6.15.0`. Do not add viem alongside it — `@gluwa/usc-sdk` has a
hard dependency on ethers v6.

The CLI is available without installing anything:

```bash
npx admissible verify 0x<EAS_UID>
```

## Configuration

There is no configuration step. Every endpoint defaults to the public ones, so read
operations work with no `.env`, no API key and no local state — that property is what
makes `verify` the judge's command.

Options are per-call overrides:

| Option | Used by | Default |
|---|---|---|
| `registryAddress` | all registry reads and writes | the deployed CC3 testnet registry |
| `creditcoinRpc` | all registry reads and writes | `https://rpc.cc3-testnet.creditcoin.network` |
| `proverUrl` | `mirror*` | `https://proof-gen-api.cc3-testnet.creditcoin.network` |
| `easscanUrl` | `verify`, `eas`, `mirror*` | `easscan.org` / `sepolia.easscan.org` by chainKey |
| `sourceRpc` | `verify`, `mirror*` | the public Ethereum node for that chainKey |
| `signer` | `mirror*` only | an `ethers` Signer, falling back to `PRIVATE_KEY` in env |

Only `mirror*` submits a transaction and spends CTC. `resolve`, `verify`, `isValid` and
the `eas` helpers are reads.

## Types

```ts
export type ChainKey = 1 | 3;   // 1 = Ethereum Sepolia, 3 = Ethereum Mainnet

export interface MirroredAttestation {
  chainKey: ChainKey;
  uid: string;
  schemaUid: string;
  attester: string;
  recipient: string;
  sourceBlock: number;
  sourceTxHash: string;
  mirroredAt: number;
  revoked: boolean;
  revokedAt: number;
  exists: boolean;
}

export type MirrorStage =
  | 'resolving'             // UID → source tx via easscan
  | 'awaiting-attestation'  // waiting for Attestcoin to attest the block
  | 'building-proof'        // Proof Builder
  | 'submitting'            // Creditcoin tx in flight
  | 'mirrored'
  | 'failed';

export interface MirrorProgress {
  stage: MirrorStage;
  attestedHeight?: number;
  targetBlock?: number;
  continuityRoots?: number;
  merkleSiblings?: number;
  creditcoinTxHash?: string;
  error?: string;
}
```

`MirroredAttestation` mirrors the on-chain struct field for field. Everything is keyed on
`(chainKey, uid)`, never `uid` alone — mainnet and Sepolia are different EAS deployments
with independent UID spaces.

## `mirror`

Proves one Ethereum attestation onto Creditcoin.

```ts
mirror(uid: string, chainKey: ChainKey, opts?: MirrorOptions): Promise<MirrorResult>
```

```ts
interface MirrorOptions {
  onProgress?: (p: MirrorProgress) => void;
  action?: RegistryAction;          // 0 = Mirror (Attested), 1 = Revoke (Revoked)
  signer?: Signer;                  // falls back to PRIVATE_KEY in env
  registryAddress?: string;
  creditcoinRpc?: string;
  proverUrl?: string;
  sourceRpc?: string;
  easscanUrl?: string;
  attestationTimeoutMs?: number;    // max wait for the source block. Default 20 min.
  skipDedupeCheck?: boolean;        // skip the on-chain processedQueries pre-check
  sourceTxHash?: string;            // explicit source tx; skips the easscan resolve
  gasLimit?: bigint;
}

interface MirrorResult {
  status: 'mirrored' | 'already-mirrored' | 'failed';
  easUid: string;
  sourceChainKey: ChainKey;
  sourceTxHash: string | null;
  sourceBlock: number | null;
  continuityRoots: number | null;
  merkleSiblings: number | null;
  queryId: string | null;
  batchIndex: number;
  creditcoinTxHash: string | null;
  gasUsed: string | null;
  ctcCost: string | null;
  proofLatencyMs: number | null;      // prover service. Free — no CTC spent here.
  submitLatencyMs: number | null;     // submitting + mining. This costs CTC.
  attestationWaitMs: number | null;   // waiting for Attestcoin to attest the block
  attestationsWritten: number | null; // events in the receipt — often > 1
  error: string | null;
  timestamp: string;
}
```

```ts
import { mirror } from '@admissible/sdk';

const result = await mirror('0x<EAS_UID>', 3, {
  onProgress: (p) => {
    switch (p.stage) {
      case 'resolving':
        console.log('resolving UID → Ethereum transaction'); break;
      case 'awaiting-attestation':
        console.log(`attested height ${p.attestedHeight} / need ${p.targetBlock}`); break;
      case 'building-proof':
        console.log(`proof: ${p.continuityRoots} roots, ${p.merkleSiblings} siblings`); break;
      case 'submitting':
        console.log('BlockProver 0x…0FD2 verifying'); break;
      case 'mirrored':
        console.log(`done: ${p.creditcoinTxHash}`); break;
      case 'failed':
        console.error(p.error); break;
    }
  }
});
```

`MirrorResult` is shaped to be written straight to `receipts/mirrors.jsonl` — one line per
attempt, `status: 'failed'` included. Note that it **never throws for an expected
failure**; it returns `status: 'failed'` with `error` set, so a bench run does not abort
partway.

Behaviour worth knowing:

- **`attestationWaitMs` can dominate.** Attestcoin's mainnet lag was measured at 42 blocks
  (~8 minutes); Sepolia enforces a 32-block reorg-protection window. The SDK waits on
  `ProofBuilder.waitUntilHeightAttested`, not the ChainInfo equivalent, which the SDK's own
  docs mark as a legacy implementation — the Proof Builder keeps its own ingestion cache
  that lags on-chain attestation, so the on-chain height can report "attested" while the
  prover still returns nothing.
- **`BlockNotOnSourceChain` is retried, not raised.** It means *too recent*, not *wrong*.
- **`attestationsWritten` is often greater than 1.** If the source transaction was a
  `multiAttest` — where most real mainnet EAS volume is — every attestation in it is
  written, because `ASCBase` dedupes per transaction, not per UID.
- **`status: 'already-mirrored'`** means the query was already processed. Nothing is
  resubmitted and no CTC is spent.
- The three latency fields are kept separate on purpose: proof generation is free, waiting
  is free, and only submission costs CTC.

## `mirrorRevocation`, `mirrorTransaction`, `mirrorBatch`

```ts
mirrorRevocation(uid: string, chainKey: ChainKey, opts?: MirrorOptions): Promise<MirrorResult>
mirrorTransaction(txHash: string, chainKey: ChainKey, opts?: MirrorOptions): Promise<MirrorResult>
mirrorBatch(txHashes: string[], chainKey: ChainKey, opts?: MirrorBatchOptions): Promise<MirrorBatchResult>
```

`mirrorRevocation` is `mirror` with `action = 1`, proving the `Revoked` event and flipping
the registry entry.

`mirrorTransaction` skips UID resolution and mirrors every attestation in a known
transaction — the efficient path when you already know the transaction hash.

`mirrorBatch` submits several transactions' proofs together, within the protocol's two
hard limits: **at most 10 proofs per submission**, all **within a 1000-block range**.

## `mirrorSchema`

Mirrors an entire EAS schema's recent attestations, grouped into batched submissions.

```ts
mirrorSchema(
  schemaUid: string,
  chainKey: ChainKey,                 // required, positional
  opts?: MirrorSchemaOptions
): Promise<MirrorSchemaResult>

interface MirrorSchemaOptions extends MirrorBatchOptions {
  limit?: number;         // how many recent attestations to consider. Default 100.
  skipExisting?: boolean; // skip UIDs already in the registry. Default true.
  onProgress?: (p: MirrorProgress) => void;
  onBatchProgress?: (p: BatchProgress) => void;
}

interface MirrorSchemaResult {
  schemaUid: string;
  chainKey: ChainKey;
  considered: number;    // attestations easscan returned for this schema
  skipped: number;       // already in the registry before this run
  transactions: number;  // distinct source transactions actually submitted
  attestations: number;  // attestations covered by those transactions
}

interface BatchProgress {
  batchIndex: number;
  batchCount: number;
  stage: MirrorProgress['stage'] | 'batch-proof';
  txCount: number;
  fromBlock?: number;
  toBlock?: number;
  continuityRoots?: number;
  creditcoinTxHash?: string;
  error?: string;
}
```

```ts
import { mirrorSchema } from '@admissible/sdk';

const r = await mirrorSchema('0x<SCHEMA_UID>', 1, {
  limit: 200,
  onBatchProgress: (p) =>
    console.log(`batch ${p.batchIndex + 1}/${p.batchCount}: ${p.stage}`)
});

console.log(`${r.attestations} attestations in ${r.transactions} transactions`);
```

`skipExisting` defaults to true, which makes the run **resumable** — it checks whether each
source transaction's query has already been processed and skips it, so re-running after an
interruption does not resubmit or waste CTC.

`attestations` and `transactions` are deliberately separate, and `transactions` is usually
much the smaller — one `multiAttest` transaction is a single query carrying many
attestations. `mirrorSchema` groups by source transaction *first*, because that grouping is
what makes batching efficient. Report the pair as *"N attestations in M on-chain
submissions"* rather than conflating them.

One protocol subtlety, verified live: the BlockProver precompile accepts a shared
continuity proof only through its **batch** verification path. With a shared proof spanning
blocks 25925431–25925820, `verifySingle` returns true at the lower endpoint and reverts
with "Merkle root mismatch" at the higher one, while `verifyBatch` returns true for both.
A shared proof therefore cannot be split across separate `execute()` calls.

The `/batch` page in the web app is this function with `onBatchProgress` rendered.

## Reading the registry

```ts
resolve(chainKey: ChainKey, uid: string, opts?: ResolveOptions): Promise<MirroredAttestation>
resolveOrNull(chainKey: ChainKey, uid: string, opts?: ResolveOptions): Promise<MirroredAttestation | null>
isValid(chainKey: ChainKey, uid: string, opts?: ResolveOptions): Promise<boolean>
isValidFrom(chainKey: ChainKey, uid: string, attester: string, schemaUid: string, opts?: ResolveOptions): Promise<boolean>
totals(opts?: ResolveOptions): Promise<RegistryTotals>
isQueryProcessed(chainKey: ChainKey, block: number, txIndex: number, opts?): Promise<{ processed: boolean }>
filterUnmirrored(...): Promise<...>
emptyRecord(chainKey: ChainKey, uid: string): MirroredAttestation
```

Note the argument order: these take **`chainKey` first**, unlike `mirror` and `verify`
which take the UID first.

```ts
import { resolve, isValid } from '@admissible/sdk';

const a = await resolve(3, '0x<EAS_UID>');
if (a.exists && !a.revoked) {
  console.log(`attested by ${a.attester} in Ethereum block ${a.sourceBlock}`);
}
```

`resolve` always returns a record — check `exists` before trusting any other field, since
an unmirrored UID returns a zeroed struct. `resolveOrNull` returns `null` instead.

`filterUnmirrored` and `isQueryProcessed` are what make the worker and bench idempotent
across restarts.

## `verify`

The independent cross-check, and the one the CLI exposes. Reads the registry over the
public Creditcoin RPC, fetches the same UID from easscan, and diffs them.

```ts
verify(uid: string, chainKey?: ChainKey, opts?: VerifyOptions): Promise<VerifyReport>

interface VerifyReport {
  uid: string;
  chainKey: ChainKey;
  outcome: 'PASS' | 'FAIL';
  mirrored: boolean;      // false when the registry has no record
  foundOnEas: boolean;    // false when easscan has no record
  registryAddress: string;
  registry: MirroredAttestation | null;
  eas: ResolvedUid | null;
  rows: DiffRow[];
  failures: string[];     // reasons the report failed. Empty on PASS.
  notes: string[];
}

interface DiffRow {
  field: string;
  registry: string;
  easscan: string;
  match: boolean;
  informational?: boolean;  // shown, but does not decide PASS/FAIL
}
```

```ts
import { verify } from '@admissible/sdk';

const r = await verify('0x<EAS_UID>');
for (const row of r.rows) {
  console.log(`${row.match ? 'ok  ' : 'FAIL'} ${row.field}: ${row.registry} / ${row.easscan}`);
}
console.log(r.outcome);
```

`chainKey` is optional — omitted, it is inferred by looking the UID up on both chains.

The two sides are genuinely independent: one is Creditcoin state written through an
Attestcoin proof, the other is an Ethereum indexer we have no control over. See
[verify](./verify.md) for why that matters and how to run the same check with no
Admissible code at all.

`isAdmissible(uid, chainKey?)` is the boolean shorthand when you only need PASS/FAIL.

## `eas`

easscan GraphQL access, for discovery.

```ts
resolveUid(uid: string, chainKey: ChainKey, opts?: EasOptions): Promise<ResolvedUid | null>
listBySchema(schemaUid: string, chainKey: ChainKey, limit: number, opts?): Promise<...>
parseUid(input: string): string   // accepts a bare UID or an easscan.org URL
easscanLink(uid: string, chainKey: ChainKey): string
```

Endpoints: `https://easscan.org/graphql` (mainnet) and
`https://sepolia.easscan.org/graphql` (Sepolia). Both live and unauthenticated.

easscan is used for **discovery and cross-checking only**. Nothing it returns is ever an
input to on-chain state — that comes exclusively from the Attestcoin proof.

## Attestcoin helpers

```ts
attestedHeight(chainKey: ChainKey, opts?): Promise<number>          // prover service
onchainAttestedHeight(chainKey: ChainKey, opts?): Promise<number>   // ChainInfo precompile 0x…0fd3
```

Both are exposed because they can disagree: the prover's ingestion cache lags on-chain
attestation. `mirror` waits on the prover's view, which is the correct barrier.

## CLI

```bash
npx admissible verify <uid> [--chain 1|3]     # the judge's command
npx admissible mirror <uid> [--chain 1|3]     # mirror one attestation, live
npx admissible status                         # attested heights, registry, balance
npx admissible help
```

`verify` and `status` need no API key, no `.env` and no local state; every endpoint
defaults to a public one and the environment is only ever an override. `mirror` needs
`PRIVATE_KEY` and testnet CTC.

Every command accepts an `easscan.org/attestation/view/0x…` URL in place of a bare UID.

Schema-wide mirroring is a library function rather than a CLI verb — call `mirrorSchema`,
or use the `/batch` page in the web app.

## Consuming the registry from Solidity

The registry is the durable artifact. This is the whole integration cost for a Creditcoin
dApp — no Attestcoin types, no proof handling, no worker.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAdmissibleRegistry, MirroredAttestation} from "@admissible/contracts/IAdmissibleRegistry.sol";

contract CredentialGated {
    IAdmissibleRegistry public constant REGISTRY = IAdmissibleRegistry(0xA972422a821F622bcC1a72d0B19242F1ae2C6047);

    bytes32 public constant KYC_SCHEMA     = 0x...;  // an EAS schema UID on Ethereum
    address public constant TRUSTED_ISSUER = 0x...;  // the attester you accept

    /// @dev chainKey 3 = Ethereum mainnet, 1 = Sepolia.
    function borrow(bytes32 uid, uint256 amount) external {
        require(
            REGISTRY.isValidFrom(3, uid, TRUSTED_ISSUER, KYC_SCHEMA),
            "no valid Ethereum credential"
        );

        MirroredAttestation memory a = REGISTRY.attestationOf(3, uid);
        require(a.recipient == msg.sender, "credential is not yours");

        // ... lend
    }
}
```

`isValidFrom` returns true only if the attestation is mirrored, not revoked, and its
attester and schema match. The `recipient` check is separate and necessary: UIDs are
public, so without it a borrower could present a stranger's credential.

If the attestation is later revoked on Ethereum and that revocation is mirrored, this call
starts returning false — no redeployment, no migration.

Every read function is documented in [registry](./registry.md).
