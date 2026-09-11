# Admissible — canonical build spec

**Every agent working on this repo reads this file first. All facts below were verified live against the real network on 2026-09-10. Do not re-derive them. Do not "fix" them.**

Hackathon: BUIDL CTC 2026 Fall (DoraHacks) · Sponsor: Creditcoin / Credit Labs · Track: **RWA**
Deadline: **2026-09-13 23:59 ET**.

---

## 1. What this is, in one sentence

Ethereum has millions of attestations — KYC checks, credentials, reputation — locked in the Ethereum Attestation Service. **Admissible makes any of them cryptographically provable inside a Creditcoin smart contract**, using the Attestcoin Protocol, with no oracle, no bridge, and no re-signing.

The pitch line used across the UI: **"They already wrote it."**
Subline: **"Ethereum attestations, admissible on Creditcoin."**
Third line (app page): **"No oracle. No bridge. No new signature."**

## 2. The flow, end to end

```
EAS on Ethereum (mainnet or Sepolia)
  │  someone — a stranger — writes an attestation.  Attested(recipient, attester, uid, schemaUID)
  ▼
Attestcoin attestors attest the Ethereum block onto Creditcoin
  │  (chainKey 3 = mainnet, chainKey 1 = Sepolia)
  ▼
Proof Builder service produces (merkleProof, continuityProof) for that transaction
  ▼
AttestationRegistry.execute(...)  on Creditcoin
  │  ASCBase verifies via BlockProver precompile 0x…0FD2  (synchronous, native speed)
  │  EASReader decodes the receipt logs → every Attested event in the tx
  ▼
Registry stores (chainKey, uid) → MirroredAttestation.  Any Creditcoin contract can now read it.
```

Revocation runs the identical path over the `Revoked` event and flips `revoked = true`.

## 3. Verified network facts — DO NOT CHANGE

### Creditcoin CC3 testnet
| | |
|---|---|
| RPC | `https://rpc.cc3-testnet.creditcoin.network` |
| Chain ID | `102031` (`0x18e8f`) |
| Native token | CTC |
| ChainInfo precompile | `0x0000000000000000000000000000000000000fd3` |
| BlockProver precompile | `0x0000000000000000000000000000000000000FD2` |
| Explorer | `https://creditcoin-testnet.blockscout.com` — **SETTLED, do not change again without new evidence.** `explorer.cc3-testnet.creditcoin.network` does not resolve. `creditcoin3-testnet.subscan.io` resolves but returns "Account Not Found" for our real deployed contract (confirmed live in-browser by the user) — its indexer does not cover this contract, possibly this testnet's EVM side at all. Blockscout's REST API (`/api/v2/addresses/{addr}`, `/api/v2/transactions/{hash}`) returns genuinely correct data verified against our real deploy tx and registry address — `creation_transaction_hash` and block number match exactly, checked with `curl`, not a guess from an HTTP 200. Link pattern: `{explorer}/tx/{hash}` for transactions, `{explorer}/address/{addr}` for accounts/contracts. If re-verifying, use the JSON API, never just an HTTP status code or a `<title>` tag — Subscan is a client-hydrated SPA that returns 200 with a generic shell regardless of whether the data exists. |
| ASC dashboard | `https://dashboard.cc3-testnet.creditcoin.network/` |

### Attestcoin prover service
Base: `https://proof-gen-api.cc3-testnet.creditcoin.network`
(`https://prover.cc3-testnet.creditcoin.network` is the same service — either works.)

- `GET /api/v1/attested-height/{chainKey}` → `{"attestedHeight": 25948260}`
- `GET /api/v1/proof-by-tx/{chainKey}/{txHash}` → returns **the proof object directly**, NOT wrapped in `{success, data}`:
  ```json
  { "chainKey": 3, "headerNumber": 25946469, "txIndex": 442, "txHash": "0x…",
    "txBytes": "0x…",
    "continuityProof": { "lowerEndpointDigest": "0x…", "roots": ["0x…"] },
    "merkleProof": { "root": "0x…", "siblings": [{"hash":"0x…","isLeft":true}] },
    "cached": true, "generatedAt": "…" }
  ```
- Error shape: `{"code":"BlockNotOnSourceChain","message":"… within the source chain's reorg-protection window (32 block(s)) …"}` — **retryable, not fatal.**

### Source chains (Creditcoin testnet)
| chainKey | Chain | EAS contract |
|---|---|---|
| **1** | Ethereum Sepolia | `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` |
| **3** | Ethereum Mainnet | `0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587` |

Mainnet attestation lag measured at **42 blocks (~8 min)**. Sepolia has a **32-block reorg-protection window**.

### EAS topics and selectors (computed with `cast`; `Attested` reproduces exactly the topic0 observed inside real proven `txBytes`)
| Item | Value |
|---|---|
| `Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)` | `0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35` |
| `Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)` | `0xf930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615` |
| `RevokedOffchain(address indexed revoker, bytes32 indexed data, uint64 indexed timestamp)` | `0x92a1f7a41a7c585a8b09e25b195e225b1d43248daca46b0faf9e0792777a2229` |
| `attest(...)` selector | `0xf17325e7` |
| `multiAttest(...)` selector | `0x44adc90e` ← most real mainnet volume |
| `revoke(...)` selector | `0x46926267` |
| `multiRevoke(...)` selector | `0x4cb7e9e5` |

**Topic layout for `Attested`:** `topics[0]`=sig, `topics[1]`=recipient, `topics[2]`=attester, `topics[3]`=schemaUID, `data`=`uid` (32 bytes). Same layout for `Revoked`.

### easscan GraphQL (unauthenticated, live)
- Mainnet: `https://easscan.org/graphql`
- Sepolia: `https://sepolia.easscan.org/graphql`
```graphql
{ attestations(take:20, orderBy:{time:desc}) { id txid time attester recipient schemaId revoked revocationTime } }
```
`id` is the UID. `txid` is the attesting transaction hash. This is also **the judge's independent cross-check surface** — the verify command diffs registry state against it.

### Working public RPCs (most public RPCs reject these calls)
- Sepolia: `https://ethereum-sepolia-rpc.publicnode.com` ✅
- Mainnet blocks/receipts: `https://ethereum-rpc.publicnode.com` ✅ (**no archive `eth_getLogs`** — use easscan GraphQL for discovery)

### Measured baseline (committed in `prebuild-evidence/`)
11/11 real Ethereum **mainnet** EAS attestations proof-generated. Median **3.56 s**, p95 **7.30 s**. Continuity roots 12–94. Est. cost **3.2–5.0×10⁻⁵ CTC** per verification via the docs formula `2.3e-5 + 2.9e-7 × roots`.

## 4. The framework: `@gluwa/asc-contracts@0.2.1`

`ASCBase.sol` (readability) — **read in full; there is no source-contract binding.**

```solidity
abstract contract ASCBase {
    INativeQueryVerifier public immutable VERIFIER;   // precompile 0x0FD2
    mapping(bytes32 => bool) public processedQueries;

    function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction)
        internal virtual;

    function execute(
        uint8 action, uint64 chainKey, uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot, INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest, bytes32[] calldata continuityRoots
    ) external returns (bool success);
}
```

Critical properties:
1. **`execute` is `external` and permissionless.** No owner, no allowlist. Anyone — including a judge — can submit a mirror. Proving a transaction sent to a contract we do not own is fully supported. (The `registerSourceLoanContract` machinery in the official loan example is app-level logic that example adds, **not** a base-class constraint.)
2. **Dedupe key is `keccak(chainKey, blockHeight, txIndex)`** — per transaction, *not* per UID. A `multiAttest` transaction is **one** query carrying **many** attestations. `_processAndEmitEvent` MUST loop every matching log and write N entries. Getting this wrong silently drops attestations.
3. The precompile **does not check transaction success**. You MUST `require(receipt.receiptStatus == 1)`.

### `EvmV1Decoder` (from `@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol`)
```solidity
struct CommonTxFields { uint64 nonce; uint64 gasLimit; address from; bool toIsNull; address to; uint256 value; bytes data; }
struct LogEntry      { address address_; bytes32[] topics; bytes data; }
struct ReceiptFields { uint8 receiptStatus; uint64 receiptGasUsed; LogEntry[] receiptLogs; bytes receiptLogsBloom; }

function getTransactionType(bytes memory encodedTx) returns (uint8);
function isValidTransactionType(uint8 txType) returns (bool);
function decodeCommonTxFields(bytes memory chunk) returns (CommonTxFields memory);   // .data == raw calldata
function decodeReceiptFields(bytes memory chunk) returns (ReceiptFields memory);
function getLogsByEventSignature(ReceiptFields memory receipt, bytes32 sig) returns (LogEntry[] memory);
```
`CommonTxFields.data` giving us **raw foreign calldata** is what makes full EAS payload recovery possible. That is the depth-of-integration story.

### `@gluwa/usc-sdk@0.18.0` (pin this version)
```ts
import { chainInfo, proofProvider, blockProver } from '@gluwa/usc-sdk';

const provider = new ethers.JsonRpcProvider(CREDITCOIN_RPC);
const info    = new chainInfo.PrecompileChainInfoProvider(provider);
const builder = new proofProvider.service.ProofBuilder(chainKey, PROVER_URL);

await builder.waitUntilHeightAttested(chainKey, blockNumber); // ← use THIS one, not the chainInfo one (docs mark that "legacy")
const proof = await builder.getProof(txHash);
const batch = await builder.getBatchProof([tx1, tx2]);        // max 10, within a 1000-block range
```
Peer dep: **ethers v6** (`^6.15.0`). Do not introduce viem alongside it.

## 5. Repo layout

```
vouchsafe/
├── contracts/          Foundry. EASReader, AttestationRegistry, IAdmissibleRegistry, CredentialGatedPool
├── packages/sdk/       @admissible/sdk — mirror / resolve / verify / eas, + the `admissible` CLI
├── worker/             long-running mirror worker (both chainkeys)
├── bench/              receipts generator at volume
├── web/                Vite + React + TS — dark landing + cream app
├── receipts/           mirrors.jsonl — the evidence artifact, committed
├── docs/               attestcoin-integration.md, design-refs/
├── prebuild-evidence/  pre-build measurements (already present, do not modify)
└── .env                already generated (gitignored) — see below
```

Toolchain: **Node 22, pnpm 11.18.0 workspaces, Foundry 1.7.1, Solidity ^0.8.28.**

> **CORRECTION (2026-09-10, supersedes any earlier instruction saying "npm workspaces" or "pnpm unavailable").**
> pnpm **is** installed at `/usr/local/bin/pnpm` — an earlier probe misread it (pnpm and npm both report version `11.18.0`, which is what caused the confusion) and the repo was briefly set up on npm workspaces. **This is the user's preferred package manager.** The repo has been migrated:
> - `pnpm-workspace.yaml` defines the workspace (`packages/*`, `worker`, `web`, `bench`); the `workspaces` field is **gone** from `package.json`.
> - `package-lock.json` deleted, `pnpm-lock.yaml` committed. `packageManager: pnpm@11.18.0` is pinned.
> - `.npmrc` sets **`node-linker=hoisted`** on purpose: `foundry.toml` remaps `@gluwa/asc-contracts/=node_modules/@gluwa/asc-contracts/`, so a flat npm-like layout keeps Foundry resolving unchanged. **Do not remove this setting.**
> - Build-script allowlists live in `pnpm-workspace.yaml` under `onlyBuiltDependencies` (pnpm 11 no longer reads the `pnpm` field in `package.json`). `esbuild` is allowlisted there because Vite needs it.
>
> **Use `pnpm` for every command from now on** — `pnpm install`, `pnpm add -F web <dep>`, `pnpm -F web build`, `pnpm -r build`. Do **not** run `npm install` or `npm ci`; it will resurrect `package-lock.json` and fight the lockfile.
> Verified after migration: `forge build` succeeds and `forge test` reports **41 passed, 0 failed**.

## 6. Environment

`.env` is **already generated** at repo root with the dev wallet and every endpoint above. Load it; do not regenerate it. Deployer address: `0xA5B3d738FB24C880a2BB1Bc4Ec65475489889714` (testnet only). `REGISTRY_ADDRESS` is filled in after deploy.

**Testnet CTC is FUNDED: 10,000 CTC confirmed on the deployer address.** At ~3–5×10⁻⁵ CTC per verification this is effectively unlimited (millions of verifications). **There is no funding constraint on evidence volume — do not write code that rations submissions, and do not hedge the numbers in any doc.** Target thousands of mirrored attestations, not hundreds.

## 7. Design system — non-negotiable, shared by every UI surface

The product has **two moods on purpose**: a dark cinematic threshold (the landing) that opens into a warm, calm, document-like workspace (the app). Reference comps live in `docs/design-refs/`.

### Palette
```
--ink            #0B0A08   near-black, landing ground
--ink-soft       #17150F
--cream          #FAF5EC   app background (warm paper)
--cream-deep     #F2EADC   app secondary surface
--graphite       #1A1814   app primary text
--graphite-soft  #6B6355   app secondary text
--warm-light     #E8B87A   the golden light from the doorway; glows, focus, accents on dark
--lime           #D6E85B   ACTION only — primary buttons, submit arrow, live indicators
--lime-deep      #C2D63F   lime hover
--rule           rgba(26,24,20,0.14)   hairline rules on cream
--rule-dark      rgba(250,245,236,0.16) hairline rules on ink
```
Lime is **exclusively** for action and liveness. Never decorative. On the dark landing, accents are `--warm-light`, never lime.

### Type
- **Display / headline:** a high-contrast editorial serif. Use a variable serif via `@fontsource-variable/fraunces` or Playfair Display. Landing headline ~clamp(2.6rem, 6vw, 4.4rem), app headline enormous — `clamp(3.5rem, 11vw, 7.5rem)`, tight leading (0.92), `-0.02em` tracking.
- **UI / body:** a clean grotesque — Inter (`@fontsource-variable/inter`).
- **Mono:** JetBrains Mono for hashes, UIDs, addresses, proof internals. **Every hash on screen is mono.**
- Wordmark `admissible`: lowercase, serif, letter-spacing `0.18em` on the dark landing; on the cream app it is larger and set in the grotesque, letter-spacing normal.

### Motion
Slow and confident. `cubic-bezier(0.16, 1, 0.3, 1)`, 600–900 ms for entrances. The landing headline and rule fade up in sequence. Respect `prefers-reduced-motion` everywhere. No bounce, no spring, nothing playful — this is an evidence product.

### Landing page (`/`) — match `docs/design-refs/Pasted image (4).png`
- Full-bleed background: `web/public/media/hero-threshold.png` (already copied — the dark room with the vertical slit of golden light). `object-fit: cover`, centered. A subtle vignette on top so text stays legible at any viewport.
- Top-left: wordmark `admissible`, small, wide-tracked, cream.
- Left third, optically centered: headline **"They already wrote it."** in serif, cream. Below it a **hairline rule** about 210px wide. Below that, the subline **"Ethereum attestations, admissible on Creditcoin."** small, serif, warm-grey.
- Bottom-right: **"Enter"** → routes to `/app`. Underline on hover, no button chrome.
- The whole page is quiet. No cards, no nav bar, no feature grid above the fold. Below the fold, a restrained scroll section may explain the mechanism — keep the same dark ground and warm accents.

### App page (`/app`) — match `docs/design-refs/Pasted image (1).png`
- Background `--cream`, full height.
- Header: `admissible` wordmark left (grotesque, ~1.75rem, `--graphite`); `docs` link right.
- Centered stack, generous vertical whitespace:
  - Display serif headline **"Paste the UID."** — two lines, very large.
  - A single wide input, 1px `--rule` border, square corners, placeholder `0x… or easscan.org/…`; flush to its right a square **lime** submit button with a `→` glyph. The button is the only saturated element on the page.
  - Below, small `--graphite-soft`: **"No oracle. No bridge. No new signature."**
- Footer: a hairline rule, then `Registry · Verify · Revocation · SDK` centered, small.

Keep both moods coherent: same serif, same rule weights, same slow motion. The cream app is the dark landing with the lights turned on.

## 7b. THE FROZEN INTERFACE — every agent builds against this

This is the contract between the contracts, the SDK, the worker, and the web app. It is frozen so all four can be built in parallel. **If you believe it needs to change, say so in your report — do not change it unilaterally.**

```solidity
// contracts/src/IAdmissibleRegistry.sol
pragma solidity ^0.8.28;

struct MirroredAttestation {
    uint64  chainKey;        // 1 = Sepolia, 3 = Ethereum Mainnet
    bytes32 uid;             // the EAS attestation UID
    bytes32 schemaUid;
    address attester;
    address recipient;
    uint64  sourceBlock;     // Ethereum block the attestation was written in
    bytes32 sourceTxHash;
    uint64  mirroredAt;      // Creditcoin block.timestamp when mirrored
    bool    revoked;
    uint64  revokedAt;       // 0 if not revoked
    bool    exists;
}

interface IAdmissibleRegistry {
    event AttestationMirrored(
        uint64 indexed chainKey, bytes32 indexed uid, bytes32 indexed schemaUid,
        address attester, address recipient, uint64 sourceBlock, bytes32 queryId
    );
    event AttestationRevoked(uint64 indexed chainKey, bytes32 indexed uid, uint64 revokedAt, bytes32 queryId);

    /// @notice Full record for a mirrored attestation. `exists == false` if never mirrored.
    function attestationOf(uint64 chainKey, bytes32 uid) external view returns (MirroredAttestation memory);
    /// @notice True only if mirrored AND not revoked. This is the function other dApps call.
    function isValid(uint64 chainKey, bytes32 uid) external view returns (bool);
    /// @notice True if the attestation is mirrored and its attester and schema match.
    function isValidFrom(uint64 chainKey, bytes32 uid, address attester, bytes32 schemaUid) external view returns (bool);
    /// @notice Total attestations mirrored, for the receipts/stats surface.
    function totalMirrored() external view returns (uint256);
    function totalRevoked() external view returns (uint256);
    /// @notice Canonical EAS address this registry accepts logs from, per chainKey.
    function easAddress(uint64 chainKey) external view returns (address);
}
```

Action discriminator passed to `ASCBase.execute(uint8 action, …)`:
```
0 = Mirror   (decode Attested logs)
1 = Revoke   (decode Revoked logs)
```

TypeScript mirror of the same shape (`packages/sdk/src/types.ts`):
```ts
export type ChainKey = 1 | 3;
export interface MirroredAttestation {
  chainKey: ChainKey; uid: string; schemaUid: string;
  attester: string; recipient: string;
  sourceBlock: number; sourceTxHash: string;
  mirroredAt: number; revoked: boolean; revokedAt: number; exists: boolean;
}
export type MirrorStage =
  | 'resolving'      // UID → source tx via easscan
  | 'awaiting-attestation'  // waiting for Attestcoin to attest the block
  | 'building-proof'        // prover service
  | 'submitting'            // Creditcoin tx in flight
  | 'mirrored' | 'failed';
export interface MirrorProgress {
  stage: MirrorStage;
  attestedHeight?: number; targetBlock?: number;
  continuityRoots?: number; merkleSiblings?: number;
  creditcoinTxHash?: string; error?: string;
}
```

`mirror()` MUST accept an `onProgress: (p: MirrorProgress) => void` callback — the web app renders the five live stages from it. That callback is the demo.

## 8. Hard rules from the hackathon (must not be violated)

- **Original work created during the hackathon.** Everything in `vouchsafe/` is new. **Do not import or vendor the DRS repo** (`github.com/OkeyAmy/DRS`) — it predates the event.
- **Must be deployed on a testnet** (CC3). Deployed addresses go in the README.
- **Must integrate the Attestcoin Protocol as a core feature**, with working integration code and a dedicated technical document (`docs/attestcoin-integration.md`). Depth of Attestcoin utilisation is an explicit core scoring criterion.
- **Attribute third-party IP.** EAS is MIT. `@gluwa/asc-contracts`, `@gluwa/usc-sdk`, and patterns adapted from `github.com/gluwa/attestcoin-protocol-examples` are the organizer's. The README must state plainly which files derive from the official examples and which are new.

## 9. Evidence discipline (this is how the project is judged)

Claims are numbers, never adjectives. Never write "fast" or "reliable" — write counts and percentiles.

`receipts/mirrors.jsonl`, one line per attempt (**failures included** — a file with only successes is less credible):
```json
{"easUid":"0x…","sourceChainKey":3,"sourceTxHash":"0x…","sourceBlock":25946469,
 "continuityRoots":32,"merkleSiblings":9,"queryId":"0x…","batchIndex":0,
 "creditcoinTxHash":"0x…","gasUsed":"…","ctcCost":"0.0000323",
 "proofLatencyMs":3560,"submitLatencyMs":1180,"status":"mirrored",
 "timestamp":"2026-09-13T…"}
```
Keep **proof generation** (free) and **on-chain submission** (costs CTC) as distinct fields — they have different cost profiles and failure modes. Record `queryId` + `batchIndex` so attestation count and transaction count are both derivable.

The judge's one command must work with no API key and no local state:
```bash
npx admissible verify 0x<EAS_UID>
```
→ reads `(chainKey, uid)` from the Creditcoin registry over the public RPC → fetches the same UID from easscan GraphQL → prints a field-by-field diff and PASS/FAIL.
