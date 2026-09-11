# Quickstart

From a clean machine to a mirrored Ethereum attestation on Creditcoin, and then to
verifying it without trusting us.

## The judge's one command

If you only run one thing, run this. It needs no API key, no install, and no local state.

```bash
npx admissible verify 0x<EAS_UID>
```

It reads the mirrored record from the Creditcoin registry over the public RPC, fetches
the same UID from `easscan.org/graphql`, and prints a field-by-field diff plus PASS/FAIL.

A UID that is already mirrored, ready to paste — a real Ethereum mainnet EAS attestation
mirrored during this project's own bench run, checked live against the registry and
easscan while writing this document:

```bash
npx admissible verify 0xf816583fdd1d59500a5abf035afd62d4b57af18d71221117cfcce47030ca2d05
```

If you would rather not run our code at all, skip to [verify](./verify.md), which does
the whole check with `cast` and `curl`.

## Requirements

| | |
|---|---|
| Node | 22+ |
| pnpm | 11 — pinned via `packageManager` in `package.json` |
| Foundry | for the contracts only |
| Testnet CTC | only if you want to submit mirrors yourself |

Use pnpm, not npm. The workspace is defined by `pnpm-workspace.yaml` and `pnpm-lock.yaml`
is the committed lockfile; running `npm install` would resurrect a `package-lock.json` and
fight it.

You do **not** need CTC to read the registry, to generate proofs, or to run
`npx admissible verify`. Proof generation through the Attestcoin Proof Builder is free;
only on-chain submission costs CTC.

## Install

```bash
git clone https://github.com/OkeyAmy/admissible
cd admissible
pnpm install
cp .env.example .env
```

## Configure

`.env` ships with every endpoint pre-filled. Only two fields need your attention.

```bash
CREDITCOIN_RPC=https://rpc.cc3-testnet.creditcoin.network
CREDITCOIN_CHAIN_ID=102031
PROVER_URL=https://proof-gen-api.cc3-testnet.creditcoin.network
CHAIN_INFO_PRECOMPILE=0x0000000000000000000000000000000000000fd3
BLOCK_PROVER_PRECOMPILE=0x0000000000000000000000000000000000000FD2

EAS_SEPOLIA=0xC2679fBD37d54388Ce493F1DB75320D236e1815e
EAS_MAINNET=0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587
SEPOLIA_RPC=https://ethereum-sepolia-rpc.publicnode.com
MAINNET_RPC=https://ethereum-rpc.publicnode.com
EASSCAN_MAINNET=https://easscan.org/graphql
EASSCAN_SEPOLIA=https://sepolia.easscan.org/graphql

PRIVATE_KEY=          # ← testnet only. Never a key holding real funds.
REGISTRY_ADDRESS=     # ← the deployed AttestationRegistry
```

`REGISTRY_ADDRESS` for the deployed CC3 testnet instance:

```
0xA972422a821F622bcC1a72d0B19242F1ae2C6047
```

(`CredentialGatedPool` is at `0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6`.) Source of
truth: `contracts/deployments.json`.

## Check the protocol is live

Before anything else:

```bash
curl https://proof-gen-api.cc3-testnet.creditcoin.network/api/v1/attested-height/3
```

```json
{"attestedHeight":25948260}
```

If that returns a number, Attestcoin's readability pipeline is up and the rest of this
page will work. `3` is Ethereum mainnet; use `1` for Sepolia.

## Find an attestation to mirror

Any EAS UID works. To pick a recent real one from Ethereum mainnet:

```bash
curl -s https://easscan.org/graphql -H 'content-type: application/json' \
  -d '{"query":"{attestations(take:5, orderBy:{time:desc}){id txid time attester recipient schemaId revoked}}"}'
```

`id` is the UID. `txid` is the Ethereum transaction that created it. Or paste an
`easscan.org/attestation/view/0x…` URL straight into the CLI — it parses the UID out.

Note the Attestcoin lag when picking: mainnet attestation runs about **42 blocks
(~8 minutes)** behind head, and Sepolia enforces a **32-block reorg-protection window**.
An attestation written in the last few minutes is not provable yet. This is normal; the
SDK waits it out rather than failing.

## Mirror it

```bash
npx admissible mirror 0x<EAS_UID>
```

Five stages print as they happen. They are the Attestcoin Protocol, in order:

| Stage | What is happening |
|---|---|
| `resolving` | UID → source Ethereum transaction and block, via easscan GraphQL |
| `awaiting-attestation` | Waiting for Attestcoin attestors to attest that block onto Creditcoin |
| `building-proof` | Proof Builder returns a Merkle inclusion proof and a continuity proof |
| `submitting` | `submit(...)` on Creditcoin, which calls the inherited `ASCBase.execute`; BlockProver `0x…0FD2` verifies synchronously |
| `mirrored` | Registry entry written; a Creditcoin transaction hash is returned |

Expect on the order of seconds for proof generation — the pre-build probe measured
median 3.56 s and p95 7.30 s across 11 real mainnet transactions — plus however long the
block still needs to become attested.

If the attestation was created by a `multiAttest` transaction, which is where most real
mainnet EAS volume is, this single submission mirrors **every** attestation in that
transaction, not just yours. See [the integration doc](./attestcoin-integration.md) for
why.

## Mirror a whole schema

One UID at a time is the demo. Bootstrapping a credential set is the real use.

Schema-wide mirroring is a library function, not a CLI verb. Use the `/batch` page in the
web app, or call it directly:

```ts
import { mirrorSchema } from '@admissible/sdk';

const r = await mirrorSchema('0x<SCHEMA_UID>', 1, { limit: 200 });
console.log(`${r.attestations} attestations in ${r.transactions} transactions`);
```

This pulls that schema's recent attestations from easscan, groups them **by source
transaction first** — one `multiAttest` transaction carries many attestations and costs one
query — and submits them in batches respecting the protocol's two hard limits: **at most 10
proofs per submission**, all **within a 1000-block range**.

It is resumable. `skipExisting` defaults to true, so anything already in the registry is
skipped and re-running after an interruption wastes no CTC.

It reports two different counts, deliberately: `attestations` and `transactions`. The
second is normally much smaller, because one `multiAttest` transaction is a single query
carrying many attestations. Never conflate them. This project's own aggregate figures —
computed directly from `receipts/mirrors.jsonl` — are in the README's evidence section and
in [docs/attestcoin-integration.md §7.4](./attestcoin-integration.md), not here.

## Verify it

```bash
npx admissible verify 0x<EAS_UID>
```

The command reads two independent sources — the Creditcoin registry and easscan — and
diffs them field by field. Nothing about the result depends on our claims. Details and
the no-CLI version: [verify](./verify.md).

## Consume it from a contract

The whole point of the registry is that other contracts read it.

```solidity
import {IAdmissibleRegistry} from "@admissible/contracts/IAdmissibleRegistry.sol";

contract MyCreditcoinDapp {
    IAdmissibleRegistry constant REG = IAdmissibleRegistry(0xA972422a821F622bcC1a72d0B19242F1ae2C6047);

    function borrow(bytes32 uid) external {
        // chainKey 3 = Ethereum mainnet
        require(REG.isValidFrom(3, uid, TRUSTED_ISSUER, KYC_SCHEMA), "no credential");
        // ...
    }
}
```

`isValidFrom` returns true only if the attestation was mirrored, is not revoked, and its
attester and schema match. Full surface: [registry](./registry.md).

## Run the rest

```bash
forge build && forge test     # contracts — 78 tests, 3 suites, fixtures captured from real proofs
pnpm -F web dev               # the paste-a-UID app
pnpm -F worker start          # the long-running mirror worker, both chainkeys
pnpm -F bench bench           # volume runner → receipts/mirrors.jsonl
pnpm -r build                 # build every workspace package
```

## Where to go next

- [Attestcoin integration](./attestcoin-integration.md) — how the protocol is used, in
  depth. This is the main technical document.
- [Architecture](./architecture.md) — the system in parts.
- [SDK reference](./sdk.md) — the full API.
- [Verification](./verify.md) — checking the claims without us.
