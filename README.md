# Admissible

## They already wrote it.

**Ethereum attestations, admissible on Creditcoin.**

Ethereum has millions of attestations — KYC checks, credentials, reputation — locked in
the Ethereum Attestation Service. Admissible makes any of them cryptographically provable
inside a Creditcoin smart contract, using the Attestcoin Protocol, with **no oracle, no
bridge, and no re-signing**.

The attestation in our demo was written by a stranger, on Ethereum mainnet, for reasons
that have nothing to do with this hackathon. You can open easscan.org in another tab and
check it.

**BUIDL CTC 2026 Fall** · Sponsor: Creditcoin / Credit Labs · Track: **RWA**

---

## Deployed on Creditcoin CC3 testnet

| | |
|---|---|
| `AttestationRegistry` | **`0xA972422a821F622bcC1a72d0B19242F1ae2C6047`** |
| `CredentialGatedPool` | `0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6` |
| `EASReader` | a Solidity `library` with `internal` functions — inlined into the registry bytecode, not separately deployed |
| Registry deploy tx | `0xda62e5f110d4d4caaa129e732b484b932b5c31dd3c488eafa1cdeb2b7c5e52fc` (gas 3,202,903) |
| Pool deploy tx | `0xe1869bb38c053355841520ad0bdc0474a268e2fcb4285822042b0d5ca4071221` (gas 1,271,830) |
| Deployed at | block `5465943`, 2026-09-10 |
| Deployer | `0xA5B3d738FB24C880a2BB1Bc4Ec65475489889714` |
| Chain ID | `102031` (`0x18e8f`) |
| RPC | `https://rpc.cc3-testnet.creditcoin.network` |
| Explorer | `https://creditcoin-testnet.blockscout.com` (account/contract pages: `/address/{addr}`) |

---

## The judge's one command

No API key. No local state. No trust in this README.

```bash
npx admissible verify 0x<EAS_UID>
```

It reads the mirrored record from the Creditcoin registry over the public RPC, fetches
the same UID from `easscan.org/graphql`, and prints a field-by-field diff plus PASS/FAIL.

Try it on a UID from the receipts file — a real Ethereum mainnet EAS attestation mirrored
during this project's own bench run, checked live against both the registry and easscan
while writing this document:

```bash
npx admissible verify 0xf816583fdd1d59500a5abf035afd62d4b57af18d71221117cfcce47030ca2d05
```

### Raw fallback — verification that does not depend on our CLI

If you would rather not run our code at all, read the chain directly. This is a public
RPC and a public contract; nothing here is ours except the contract, whose source is in
[`contracts/src/`](contracts/src/).

```bash
# The full mirrored record. chainKey 3 = Ethereum mainnet, 1 = Sepolia.
cast call 0xA972422a821F622bcC1a72d0B19242F1ae2C6047 "attestationOf(uint64,bytes32)" 3 0x<EAS_UID> \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network

# Just the boolean other contracts call.
cast call 0xA972422a821F622bcC1a72d0B19242F1ae2C6047 "isValid(uint64,bytes32)" 3 0x<EAS_UID> \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network

# What EAS deployment does this registry trust for chainKey 3?
# Should print 0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587 — the canonical mainnet EAS.
cast call 0xA972422a821F622bcC1a72d0B19242F1ae2C6047 "easAddress(uint64)" 3 \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network

# How many attestations has it mirrored?
cast call 0xA972422a821F622bcC1a72d0B19242F1ae2C6047 "totalMirrored()" \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network
```

Then cross-check the same UID against a source we do not control:

```bash
curl -s https://easscan.org/graphql -H 'content-type: application/json' \
  -d '{"query":"{attestation(where:{id:\"0x<EAS_UID>\"}){id txid time attester recipient schemaId revoked}}"}'
```

The `attester`, `recipient`, and `schemaId` should match field for field, and each comes
straight out of a proven Ethereum receipt log — a mismatch there would mean something is
genuinely broken. `txid` is one caveat worth knowing: it compares against `sourceTxHash`,
which is submitter-supplied metadata rather than a value the BlockProver proof covers
(full explanation: [docs/verify.md](docs/verify.md)). A spoofed `sourceTxHash` still shows
up as a mismatch here, since easscan is a source we do not control — but the guarantee is
"caught by cross-checking," not "proven on chain," and that distinction is the entire
point of not asking you to trust us.

---

## What it is

Attestcoin's readability layer can prove that a transaction happened on another chain and
extract its events. Every worked example does this with a source contract the example
author deployed, emitting a bespoke event the example author defined. That is the
documented happy path and it is good advice — but it means Attestcoin can only read
transactions that were created *for* Attestcoin.

Admissible reads the Ethereum that already exists.

It is an Attestcoin Smart Contract pointed at the **canonical EAS deployment** — a
contract we do not own, did not deploy, and cannot influence. It proves EAS transactions
onto Creditcoin, decodes them, and writes them into a persistent registry that any
Creditcoin contract can read forever:

```solidity
IAdmissibleRegistry reg = IAdmissibleRegistry(ADMISSIBLE_REGISTRY);
require(reg.isValidFrom(3, uid, ISSUER, KYC_SCHEMA), "no valid Ethereum credential");
```

And because facts stop being true, revocation runs the identical proof path: an EAS
attestation revoked on Ethereum can be proven revoked on Creditcoin the same way it was
proven mirrored (see "One disclosure about the revocation demo" below for where this
stands right now).

Three things ship on top of that registry:

- **`CredentialGatedPool`** — a Creditcoin lending pool that lends only to addresses
  holding a valid, non-revoked, mirrored EAS credential. The RWA-track payoff, and a
  worked example of the consumer side. It is configured with a real, non-wildcard
  requirement: chainKey 3 (Ethereum mainnet), attester `0x45C07600825E79e36629537BFcAC64cfB285B5ae`,
  schema `0x3969bb076acfb992af54d51274c5c868641ca5344e1aacd0b1f5e4f80ac0822f`
  (`setCredentialRequirement`, tx `0x53c7d6a028b3f1da4f1cfcd40d7da77390ed87493816c27fe549de5b94c75eea`).
  That pair was chosen because it is the most-repeated real pattern in the project's own
  mirrored evidence — the same attester/schema combination appeared 5 times across a
  30-UID sample of mainnet mirrors, each to a different real recipient, i.e. a genuine,
  recurring third-party credential issuer rather than a synthetic one. Reproducible,
  live, right now:

  ```bash
  # positive: a real holder of a matching, mirrored attestation
  cast call 0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6 \
    "eligibilityOf(address,bytes32)(uint8,string,uint256)" \
    0xDC5EF2B3f1b716cb62230B705D603944F8262cE9 \
    0x574c2482fb029ed3d7dc3cd68e243dc63e4ae2b964d8eac1afe1803b9da6c996 \
    --rpc-url https://rpc.cc3-testnet.creditcoin.network
  # -> (0, "Eligible to borrow", 10000000000000000000)

  # negative: a mirrored UID from a different attester
  cast call 0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6 \
    "eligibilityOf(address,bytes32)(uint8,string,uint256)" \
    0xDC5EF2B3f1b716cb62230B705D603944F8262cE9 \
    0xf816583fdd1d59500a5abf035afd62d4b57af18d71221117cfcce47030ca2d05 \
    --rpc-url https://rpc.cc3-testnet.creditcoin.network
  # -> (3, "Attestation is from a different attester", 0)
  ```

  The gate discriminates correctly on real data, not just in tests. Both UIDs came from a
  live easscan query for attestations under that attester/schema, cross-checked against
  `isValid` before use. Detail: [docs/attestcoin-integration.md](docs/attestcoin-integration.md).
- **Schema-wide mirroring** — `mirrorSchema()` in the SDK and a `/batch` page in the app
  mirror an entire EAS schema's recent attestations across grouped submissions, within
  the protocol's 10-proof / 1000-block batch limits.
- **A mirror worker** running continuously across both chainkeys.

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

Full technical detail: [docs/attestcoin-integration.md](docs/attestcoin-integration.md).

## Both chainkeys

| chainKey | Chain | Canonical EAS | Role |
|---|---|---|---|
| **1** | Ethereum Sepolia | `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` | Volume; the revocation demo |
| **3** | Ethereum **Mainnet** | `0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587` | Real third-party issuers |

Measured 2026-09-10: Attestcoin's mainnet attestation lag is **42 blocks (~8 minutes)**.
Sepolia enforces a **32-block reorg-protection window**.

---

## Quickstart

Requires Node 22+, pnpm 11, and Foundry.

```bash
git clone https://github.com/OkeyAmy/admissible && cd admissible
pnpm install
cp .env.example .env      # fill in PRIVATE_KEY (testnet only) and REGISTRY_ADDRESS

# is the protocol live?
curl https://proof-gen-api.cc3-testnet.creditcoin.network/api/v1/attested-height/3
# -> {"attestedHeight":25948260}

npx admissible verify 0x<EAS_UID>     # diff registry state against easscan
npx admissible mirror 0x<EAS_UID>     # prove an Ethereum attestation onto Creditcoin
npx admissible status                 # attested heights, registry, balance

forge build && forge test            # contracts — 78 tests, 3 suites
pnpm -F web dev                      # the paste-a-UID app
```

Longer walkthrough: [docs/quickstart.md](docs/quickstart.md).

---

## Evidence

Claims here are counts and percentiles. There are no adjectives in this section on
purpose.

### Pre-build feasibility probe — 2026-09-10, before any product code

Raw output committed at `prebuild-evidence/scale_probe.json`, generated by
`prebuild-evidence/probe.py`. All eleven are real Ethereum **mainnet** EAS transactions
written by third parties.

| Measurement | Result |
|---|---|
| Mainnet EAS attestations proof-generated | **11 / 11 succeeded, 0 failed** |
| Proof latency | median **3.56 s**, p95 **7.30 s** (min 1.31 s, max 7.30 s) |
| Continuity proof size | min 12 / median 32 / max 94 roots |
| Est. on-chain verify cost (`2.3e-5 + 2.9e-7 × roots`) | **3.2 – 5.0 × 10⁻⁵ CTC** |
| Attestcoin lag behind mainnet head | 42 blocks (~8 min) |
| Historical reach | a tx ~10,600 blocks back needed only 22 continuity roots |

### The tests, and proof that the tests work

```
Ran 3 test suites: 78 tests passed, 0 failed, 0 skipped (78 total tests)
  AttestationRegistry.t.sol   41 passed
  CredentialGatedPool.t.sol   23 passed
  EASReader.t.sol             14 passed
```

`forge build` is clean under the repo's configuration (`via_ir = true`,
`evm_version = "london"` — see [Attestcoin integration §1.2](docs/attestcoin-integration.md)
for why both are pinned).

A passing test suite is a weak claim on its own — tests can pass because they assert
nothing. So the two security guards were **deliberately removed** and the suite re-run.

| | |
|---|---|
| Guards removed | `require(receipt.receiptStatus == 1)` in `AttestationRegistry.sol` and `require(log.address_ == canonicalEas)` in `EASReader.sol` |
| Result | **exactly 6 tests fail**, all in `AttestationRegistry.t.sol` |
| Guards restored | **41 / 41 registry tests pass again (78 / 78 overall)** |

The six that failed are the six that should:

| Failing test | Guard it defends |
|---|---|
| `test_RevertWhen_SourceReceiptStatusIsZero` | receipt status |
| `test_RevertWhen_FailedReceiptIsRevoked` | receipt status |
| `test_RevertWhen_AttestedLogComesFromASpoofedEas` | emitter address |
| `test_RevertWhen_SpoofedEmitterIsPreviewed` | emitter address |
| `test_RevertWhen_SpoofedLogIsMixedWithARealOne` | emitter address |
| `test_RevertWhen_SepoliaEasLogIsSubmittedAsMainnet` | emitter address, per chainKey |

Both guards were removed in the same run, so the count is for the pair; the test names
indicate which guard each one targets.

`test_RevertWhen_SpoofedLogIsMixedWithARealOne` is the one worth reading. It puts a
spoofed log in the same receipt as a genuine one — the attack that a naive "check the
first log" implementation waves straight through.

Full procedure and raw output: `contracts/MUTATION-CHECK.md`.

### Deployed bytecode matches this source

The bytecode actually deployed at `0xA972422a821F622bcC1a72d0B19242F1ae2C6047` and
`0x947c2ECCD2A754aCbf19A30F01450766B4938Ad6` was diffed against a fresh local `forge build`
of this repository. Only the compiler's `immutable` placeholders differ, and each differs
in exactly the way it should:

| Contract | Immutable positions that differ | Value inserted |
|---|---|---|
| `AttestationRegistry` | 3 runs | `0fd2` — the `VERIFIER` precompile address |
| `CredentialGatedPool` | 5 runs | `a972422a…6047` — the registry address |

Everything else in both contracts' bytecode is byte-identical to source. This is the same
class of check `forge verify-contract` performs; it was run manually here because the
result is worth stating as evidence rather than assuming.

### Measured on-chain results

**Attestations mirrored: 386**, read live from the registry at `2026-09-11T11:34:49Z`:

```bash
cast call 0xA972422a821F622bcC1a72d0B19242F1ae2C6047 "totalMirrored()(uint256)" \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network
```

That is the ground-truth number — `execute()` is permissionless (§"Deployed on Creditcoin
CC3 testnet" above), so the registry's own counter, not any one process's log file, is what
counts. `receipts/summary.json` is a snapshot generated mid-run (`generatedAt
2026-09-11T11:23:59.894Z`); it will read lower than the number above and lower than the
`mirrors.jsonl`-derived table below, because both the bench and the mirror worker keep
running after it was written. Re-run the `cast call` above for the current figure rather
than trusting any number printed here once this file is more than a few minutes old.

The submission-level detail below is computed from `receipts/mirrors.jsonl` (943 rows) as
of the same timestamp. One row is logged per *attestation*, so a `multiAttest` submission
writes several rows sharing one `queryId`; submission-level fields (`ctcCost`, `gasUsed`,
latency) are therefore deduplicated **by `queryId`**, not summed per row — reproduction
steps in [docs/verify.md](docs/verify.md). This file records only what this project's own
bench script submitted; a second, independent process (`relayer/`, `receipts/relayer.jsonl`,
9 rows) also mirrors permissionlessly and accounts for part of the gap between the 348
attestations logged below and the registry's 386 — the rest is submissions made in the
minutes between reading this snapshot and reading the live counter above.

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
| Failed rows | **394** — see breakdown below |

**On the 394 failed rows**, two distinct causes, not one:

- **283 rows: `dedupe check failed`.** The bench and the relayer run as separate,
  independently-scheduled processes that sometimes race for the same `queryId`
  (`ASCBase` dedupes on `keccak(chainKey, blockHeight, txIndex)`). The registry correctly
  rejects the second submitter; no CTC is spent on these. This is the system working as
  designed, not a defect — it is the same replay protection that stops a `queryId` from
  ever writing an attestation twice.
- **110 rows: `transaction execution reverted`.** These are real failures, concentrated in
  just **4** distinct `queryId`s (all chainKey 1 / Sepolia). Two of the four repeat a
  previously-identified cause: one Sepolia source transaction with an outsized proof
  (776 continuity roots, sourceBlock 9,653,225) and a second, related one (778 roots,
  sourceBlock 9,653,223) — both far above the 12–94 root range measured in the pre-build
  probe. The other two (44 and 74 continuity roots — ordinary proof sizes) also reverted;
  in all four cases the row carries no `creditcoinTxHash` and no `gasUsed`, meaning the
  revert was caught before a transaction was mined, consistent with the error's own
  `action="sendTransaction"` field — a send-time simulation failure, not a mined-and-failed
  transaction.
- **1 row** has an empty `error` string — a logged failure whose cause was not captured in
  the message. Left in rather than filtered out.

`receipts/mirrors.jsonl` has **one line per attempt, failures included**. A receipts file
containing only successes is less credible, not more. Proof generation is free and
on-chain submission costs CTC, so they are recorded as separate fields — do not assume
every row is a Creditcoin transaction. `queryId` and `batchIndex` are recorded so the
attestation count and the transaction count are both independently derivable.

`bench/run.ts` is the reproducible script that generated the file. These numbers will grow
as the bench continues running; re-derive them from the file, and re-read `totalMirrored`
live, rather than trusting this table if it is stale.

### One disclosure about the revocation demo

A sweep of 15,000 recent Sepolia blocks found **zero** `Revoked` events; easscan returns
only a handful ever. Revocations are genuinely rare in the wild. The revocation
demonstration therefore uses an attestation **issued from a key we control** on Sepolia,
disclosed as such — not a third-party revocation, and not presented as one. Every other
proof in this project is of a transaction we did not create.

What has actually happened, on chain, as of this writing:

| Step | Status |
|---|---|
| Schema registered on Sepolia `SchemaRegistry` (`"bool admissibleDemoVerified2026"`, `revocable: true`) | done — tx `0x7f62d7cd45cf20b32de4a83b031b7e18f2d691363e122765e64314b5df5a6052` |
| Attestation issued (self-issued, recipient = attester = `0xA5B3d738FB24C880a2BB1Bc4Ec65475489889714`) | done — tx `0x8771a1dd1c69d7758ce9fb753534e89a2e2548a50502b475f06e05a6a17a5720`, block 11,681,621, UID `0x751a62300a8db56f65a5cc0f94fa3892ba814070262c007a2d76f1e3c960196a` |
| Revoke on Sepolia, then prove and mirror the `Revoked` event | done — revoke tx `0x225518f910e085b865062ea6450d99170fb5bdcc7a41ba1a00b7fe49c8e4b2de`, block 11,681,689; the registry flipped the demo UID to `revoked = true` (`totalRevoked()` reads `1`) |

Read the current number directly:

```bash
cast call 0xA972422a821F622bcC1a72d0B19242F1ae2C6047 "totalRevoked()(uint256)" \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network
```

Revocation is therefore a **completed live instance**, not a promise: the revoke path runs
the identical proof pipeline as a mirror, decoding `Revoked` instead of `Attested` and
flipping `revoked = true`, and two of the registry's mutation-checked security tests
(`test_RevertWhen_SourceReceiptStatusIsZero`, `test_RevertWhen_FailedReceiptIsRevoked`,
`contracts/MUTATION-CHECK.md`) specifically target this path.

#### How mainnet revocations are discovered (by default and at scale)

Revocations are rare in the wild, and no free source exposes a revocation-txid field
(easscan's GraphQL has none, verified by introspection). The worker therefore discovers
`Revoked` logs itself, filtered to the EAS address, in two modes:

- **Default (no key):** a rolling `~700`-block window on the free mainnet RPC, re-scanned
  every cycle. Robust against noisy free endpoints (tries several hosts — the public
  endpoints nondeterministically route `eth_getLogs` to archive-token-gated backends).
  Catches revocations within the last few hours of a running worker.
- **Full history (optional):** set a free `ETHERSCAN_API_KEY` (etherscan.io) in `vouchsafe/.env`
  and the worker walks the entire mainnet `Revoked` history newest-first via Etherscan V2
  `getLogs` — a bounded, resumable backfill that also retroactively catches older
  revocations like `0x0e2b3b32812878986ce9da6a3e2fa293a05fe3b332d45851d2893b64ae49bad4`
  (revoked `2026-07-27`, still *before* its mirror — a known, reproducible FAIL case that
  becomes a PASS once the backfill catch-up passes that block). Without the key, historical
  mainnet revocations are outside the reachable window and remain recorded as such in
  `receipts/mirrors.jsonl`.

---

## Provenance

Required by the hackathon IP terms, and worth reading as a map of the repo.

### Derived from the organizer's official examples

Source: [`github.com/gluwa/attestcoin-protocol-examples`](https://github.com/gluwa/attestcoin-protocol-examples)
(Gluwa / Creditcoin).

| File in this repo | Derived from | What was taken |
|---|---|---|
| `contracts/src/AttestationRegistry.sol` | `bridge/contracts/sol/ASCMinter.sol` and `ASCLoanManager.sol` | The readability-ASC shape: extend `ASCBase`, override `_processAndEmitEvent`, decode transaction type → receipt → logs by event signature, dispatch on an `action` discriminator. Business logic, storage layout, the emitter assertion, the N-entry loop, the `submit` wrapper and the revocation path are new. |
| `worker/` | `bridge/bridge-offchain-worker/worker.ts` | The off-chain worker loop shape: poll source chain, wait for attestation, build proof, submit, persist progress. Both-chainkey operation, EAS discovery, batching and receipt logging are new. |
| `foundry.toml`, remappings | the examples' Foundry config | Toolchain configuration. |

### Third-party dependencies, used as published

| Dependency | Owner | Licence |
|---|---|---|
| `@gluwa/asc-contracts@0.2.1` — `ASCBase`, `EvmV1Decoder`, `INativeQueryVerifier` | Gluwa / Creditcoin | Organizer's |
| `@gluwa/usc-sdk@0.18.0` — the Attestcoin Protocol client | Gluwa / Creditcoin | Organizer's |
| Ethereum Attestation Service — canonical deployments, event signatures, function selectors | EAS | **MIT** |
| `ethers@^6`, `forge-std`, Vite, React | respective authors | MIT / Apache-2.0 |

No EAS code is vendored into this repository. Admissible reads EAS's deployed contracts
and reuses its publicly documented event and selector definitions.

### New, written during the hackathon

Everything else, specifically:

- `contracts/src/EASReader.sol` — foreign-calldata and receipt-log decoding for a
  contract we do not own; the emitter assertion; the `attest` / `multiAttest` selector
  branch. Both selectors are decoded completely, including `multiAttest`'s doubly-nested
  dynamic arrays — not just their log topics. Detail in
  [docs/attestcoin-integration.md §4](docs/attestcoin-integration.md).
- `contracts/src/IAdmissibleRegistry.sol` — the consumer interface.
- `contracts/src/examples/CredentialGatedPool.sol` — the RWA-track consumer example.
- `packages/sdk/` — `@admissible/sdk` and the `admissible` CLI.
- `bench/`, `receipts/`, `web/`, `docs/`.

### On the name

**Admissible** — the metaphor is evidentiary: testimony taken in one jurisdiction,
admitted as evidence in another. That is precisely what this does. *Ethereum attestations,
admissible on Creditcoin.*

---

## Repo layout

```
admissible/
├── contracts/          Foundry. EASReader, AttestationRegistry, IAdmissibleRegistry,
│                       CredentialGatedPool. Tests use fixtures from real proofs.
├── packages/sdk/       @admissible/sdk — mirror / resolve / verify / eas, + the CLI
├── worker/             long-running mirror worker, both chainkeys
├── bench/              receipts generator at volume
├── web/                Vite + React + TS — the paste-a-UID app and the docs site
├── receipts/           mirrors.jsonl — the evidence artifact, committed
├── prebuild-evidence/  pre-build feasibility measurements
└── docs/               the documentation set, below
```

## Documentation

| Page | What it covers |
|---|---|
| [Attestcoin integration](docs/attestcoin-integration.md) | **The main technical document.** Full pipeline, `ASCBase` usage, foreign-calldata decoding, the three protocol gotchas, measured cost and latency. |
| [Quickstart](docs/quickstart.md) | Install, configure, mirror your first attestation, verify it. |
| [Architecture](docs/architecture.md) | The system in parts, and how they fit. |
| [SDK reference](docs/sdk.md) | Every exported function, with examples. |
| [Registry reference](docs/registry.md) | The on-chain contract and how to query it. |
| [Verification](docs/verify.md) | How independent verification works, and why it is trustworthy. |
| [How lending works](docs/how-lending-works.md) | Plain-language: present, borrow, repay, eligibility, no jargon. |

## Scope, stated plainly

- **Attestcoin writability is not live** — the documentation describes it as "undergoing
  3rd party testing and audits". Admissible is read-only, Ethereum → Creditcoin, by
  design. Nothing here writes back to Ethereum.
- **The Proof Builder is a hosted service**, and therefore a centralization point in a
  protocol whose pitch is removing centralized operators. `@gluwa/usc-sdk` ships
  `RawProofBuilder` for offline proof computation against the same interface; Admissible
  isolates proof acquisition behind one function so swapping it in is a constructor
  change. Operating a self-hosted proof builder was cut from a three-day build
  deliberately, not overlooked.
- **Mainnet EAS volume is low.** Mainnet supplies credibility; Sepolia supplies volume.
  Receipts label every mirror with its chainKey rather than blurring the two.
- **One queryId processes one action.** `ASCBase` retires a queryId once `execute`
  succeeds for it. A transaction containing both an `Attested` log and a `Revoked` log
  could only be processed under one action. In practice EAS's attest and revoke calls are
  disjoint, so this does not occur — but it is a real limit of the design, not a
  hypothetical one.
- **`attestByDelegation` / `multiAttestByDelegation` are not decoded.** The mirrored
  `Attested` log still works for these; the recovered-payload event
  (`AttestationPayloadRecovered`) does not fire for them. A test asserts this rather than
  leaving it a silent gap. Detail: [docs/attestcoin-integration.md §8](docs/attestcoin-integration.md).

## Licence

MIT. See [LICENSE](LICENSE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
