# @admissible/sdk

Ethereum attestations, admissible on Creditcoin.

Mirror any [Ethereum Attestation Service](https://attest.org) attestation into a
Creditcoin smart contract through the [Attestcoin
Protocol](https://creditcoin.org): no oracle, no bridge, no new signature. The
attestation is proved — by verifying the real Ethereum transaction that wrote
it, via a Merkle proof and a continuity proof checked synchronously on-chain
by Creditcoin's BlockProver precompile — not re-asserted by a trusted party.

Full project docs, contracts, and the web app: [github.com/OkeyAmy/admissible](https://github.com/OkeyAmy/admissible).

## Install

```bash
npm install @admissible/sdk
```

## CLI

No install needed — the CLI needs no API key and no local state:

```bash
npx admissible verify 0x<EAS_UID>     # diff registry state against easscan, PASS/FAIL
npx admissible mirror 0x<EAS_UID>     # prove an Ethereum attestation onto Creditcoin
npx admissible status                 # attested heights, registry, balance
```

`verify` reads the mirrored record straight from the Creditcoin registry over
the public RPC, fetches the same UID from `easscan.org/graphql`, and prints a
field-by-field diff. No trust in this package required — every field is
independently re-derived from the two public sources.

## Library

```ts
import { mirror, resolve, verify } from '@admissible/sdk';

// Resolve a UID to its source Ethereum transaction, no signer needed.
const resolved = await resolve('0x<EAS_UID>', { chainKey: 3 });

// Mirror it: builds the Attestcoin proof and submits AttestationRegistry.submit(...).
const result = await mirror('0x<EAS_UID>', { chainKey: 3, privateKey: process.env.PRIVATE_KEY });

// Verify a mirrored attestation against easscan.
const report = await verify('0x<EAS_UID>');
```

See [`docs/quickstart.md`](https://github.com/OkeyAmy/admissible/blob/main/docs/quickstart.md)
in the main repo for `mirrorSchema` (batch mirroring an entire EAS schema) and
the full API surface.

## Why this is safe to depend on

- **Every network endpoint is a verified, baked-in default** (`CREDITCOIN_RPC`,
  `PROVER_URL`, the EAS contract addresses per chain) — not read from `.env` at
  runtime. `npx admissible verify` has to work for a judge or a stranger with
  no config file and no key; the defaults are the source of truth.
- **The registry is keyed `(chainKey, uid)`**, never `uid` alone — a mainnet
  UID and a Sepolia UID can collide, and the two EAS deployments are different
  contracts.
- **The on-chain contract asserts the log emitter is the canonical EAS
  address** for that chain, so a spoofed EAS clone can't inject fake
  attestations into the registry this package reads from.

## License

MIT
