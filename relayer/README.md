# relayer

The piece that lets `/app`'s five-stage proof theatre finish at stage 5 with a
real Creditcoin transaction hash, instead of stopping at `needs-signer`.

## Why this exists

`web/` is a browser build. It carries no private key on purpose:
`VITE_DEMO_PRIVATE_KEY` defaults to empty, and anything prefixed `VITE_` is
compiled into the client bundle and readable by anyone who opens devtools.
That is the right call, not a gap to route around in the browser. Instead,
this small Node process holds the funded testnet key server-side and submits
proofs the browser already built (stages 1–3 are public reads and always run
for real in the browser; stage 4, the write, needs a funded signer, so it is
handed off here).

## Run it

```bash
pnpm install                 # from the repo root, once, links @admissible/sdk
pnpm -F relayer start        # reads PRIVATE_KEY etc. from the repo-root .env
```

Listens on `http://localhost:8787` by default. `web/` talks to it at
`VITE_RELAYER_URL` (defaults to `http://localhost:8787` in dev — see
`web/src/lib/config.ts`).

## Endpoints

### `GET /health`

```json
{ "ok": true, "address": "0x...", "balanceCtc": "9999.96...", "registry": "0x...", "chainId": 102031 }
```

### `POST /mirror`

Body — the proof bundle the browser already built:

```json
{
  "action": 0,
  "chainKey": 1,
  "blockHeight": 11672330,
  "sourceTxHash": "0x...",
  "encodedTransaction": "0x...",
  "merkleProof": { "root": "0x...", "siblings": [{ "hash": "0x...", "isLeft": true }] },
  "continuityProof": { "lowerEndpointDigest": "0x...", "roots": ["0x..."] }
}
```

Success:

```json
{ "ok": true, "creditcoinTxHash": "0x...", "blockNumber": 5467850, "gasUsed": "5274493", "ctcCost": "0.0026372465", "queryId": "0x..." }
```

Already mirrored (no gas spent — short-circuited against `processedQueries`):

```json
{ "ok": true, "alreadyMirrored": true, "queryId": "0x...", "creditcoinTxHash": null }
```

Failure:

```json
{ "ok": false, "error": "..." }
```

## Safety model

This process holds a funded key on a public-facing port. Every `POST
/mirror` request goes through all of the following, in order, before the key
ever signs anything:

1. **Per-IP rate limit.** A token bucket (`src/rateLimit.ts`), default 5
   requests/minute with a burst of 5, consumed before any other work starts.
   Configurable: `RELAYER_RATE_LIMIT_PER_MIN`, `RELAYER_RATE_LIMIT_BURST`.

2. **Shape validation** (`src/validate.ts`). `action` must be `0` (Mirror) or
   `1` (Revoke) — the two discriminators the contract actually knows about,
   SPEC.md §7b; anything else is rejected before it costs a network call.
   `chainKey` must be `1` or `3`. All hash/byte fields are checked for shape.

3. **Server-side re-derivation — the client's bundle is never trusted.** The
   relayer calls the Attestcoin prover itself
   (`@admissible/sdk`'s `getProof(chainKey, sourceTxHash)`) for the claimed
   `(chainKey, sourceTxHash)` and compares the result against what was
   posted: `blockHeight`, `sourceTxHash`, `encodedTransaction`, and the
   merkle proof must all match, or the request is rejected with a 400
   naming which field diverged. **The values actually submitted come from
   this re-derivation, not from the request body** — so even a bug in the
   comparison could not get arbitrary calldata signed by the funded key.
   (`continuityProof` is deliberately *not* compared strictly: `batch.ts`
   submits one continuity proof shared across a whole block range, which
   will never equal a single-transaction re-derivation here. The merkle
   proof already pins down which transaction is being mirrored; the
   continuity proof used for submission is always the server's own, so a
   divergent one here can only route to a different self-consistent
   server-derived proof, never to attacker-supplied calldata.)

4. **Dedupe pre-check.** `processedQueries` (via the SDK's
   `isQueryProcessed`) is read before any submission, so a re-submitted or
   already-mirrored transaction short-circuits with `alreadyMirrored: true`
   instead of paying gas for a call that would revert.

5. **Gas cap.** The gas limit is planned with the SDK's `planGas` (the same
   `400_000 + continuityRoots × 6_000` fallback the worker and bench use)
   and then clamped to `RELAYER_GAS_CEILING` (default 8,000,000 — above the
   worst continuity-root count observed in `receipts/mirrors.jsonl` so far).
   The client cannot forward its own gas limit; there is no field for it.

6. **Per-process spend ceiling.** `src/spendGuard.ts` tracks cumulative CTC
   spent by this process (in memory, resets on restart) and refuses to
   submit if the worst-case cost of a transaction (`gasLimit × current gas
   price`) would push cumulative spend over `RELAYER_SPEND_CEILING_CTC`
   (default 2 CTC — at the documented ~3–5×10⁻⁵ CTC per verification, that
   is tens of thousands of submissions; the ceiling bounds one process's
   blast radius, not a real funding constraint — SPEC §6 notes the key
   holds ~10,000 CTC).

7. **Every attempt is logged**, success or failure, to
   `receipts/relayer.jsonl` in the same schema shape as `receipts/mirrors.jsonl`
   (SPEC.md §9), with `producedBy: "relayer"` so relayer-submitted mirrors
   are distinguishable in the evidence trail without being a different
   format.

### CORS

`Access-Control-Allow-Origin: *`, deliberately. This relayer's actual write
boundary is everything in the numbered list above — proof re-verification,
a fixed action allowlist, a gas cap, a spend cap, and per-IP rate limiting —
none of which an `Origin` header changes. Anyone can already `curl` this
endpoint directly; pretending an origin allowlist is a security control here
would be decorative, not real. That is an acceptable posture for a public,
read-mostly testnet demo service and is called out here rather than left
implicit.

## Env vars

All read from the repo-root `.env` (same loader as `worker/` and `bench/`,
see `src/env.ts`) plus a few relayer-only overrides:

| Var | Default | Meaning |
|---|---|---|
| `PRIVATE_KEY` | — (required) | The funded Creditcoin signer. Never logged, never returned in a response. |
| `REGISTRY_ADDRESS` | from `contracts/deployments.json` | AttestationRegistry address. |
| `CREDITCOIN_RPC` | `https://rpc.cc3-testnet.creditcoin.network` | |
| `PROVER_URL` | `https://proof-gen-api.cc3-testnet.creditcoin.network` | |
| `RELAYER_PORT` | `8787` | |
| `RELAYER_GAS_CEILING` | `8000000` | Hard cap on the gas limit forwarded to `submit(...)`. |
| `RELAYER_SPEND_CEILING_CTC` | `2` | Cumulative CTC this process will spend before refusing further submissions. |
| `RELAYER_RATE_LIMIT_PER_MIN` | `5` | Token refill rate, per IP. |
| `RELAYER_RATE_LIMIT_BURST` | `5` | Token bucket capacity, per IP. |
| `RELAYER_MAX_BODY_BYTES` | `524288` | Max accepted request body size. |

## Why `submit(...)`, not `execute(...)`

`AttestationRegistry` inherits `ASCBase.execute(...)`, which is `external`
but **not** `virtual` and does not accept a caller-supplied `chainKey`
override path — the deployed registry wraps it behind its own
`submit(uint8 action, uint64 chainKey, uint64 blockHeight, bytes32
sourceTxHash, bytes encodedTransaction, merkleProof, continuityProof)`,
which records `(chainKey, blockHeight, sourceTxHash)` and then self-calls
the inherited `execute`. Calling `execute(...)` directly reverts before any
state is written (`AttestationRegistry.sol` requires the `submit()` context
to be set). `packages/sdk/src/mirror.ts`'s `submitProof()` calls `execute`
directly and so reverts against this deployment — a bug in the SDK this
package does not modify. `src/submit-fix.ts` is a byte-identical copy of the
workaround `worker/` and `bench/` already carry: it reuses the SDK's
`registryAbi`, `planGas`, `waitForReceipt`, and `accountForReceipt`, and
calls `.submit(...)` instead of `.execute(...)`. No calldata is hand-rolled;
only the entrypoint name differs from what `packages/sdk/src/mirror.ts`
calls.

## Verified end-to-end

Two independent runs against the live network, both confirmed by reading
`totalMirrored()` and `attestationOf(...)` back from chain afterward:

**Run 1** — Sepolia (chainKey 1) `multiAttest` transaction
`0x32fc53140b081b521f7d556e048bba86375465864402b577496c4efede6a15f1`
(block 11,672,330, 25 `Attested` logs), proof re-derived and submitted
through this relayer:

```json
{"ok":true,"creditcoinTxHash":"0x22139a9a9e9bcd87f78ce7004b00ac326a24752f1980bae4e7faccb3500e4f28","blockNumber":5467850,"gasUsed":"5274493","ctcCost":"0.0026372465","queryId":"0x999329db641a92ccc7710d3cece6c26e9b90a6268e7fa2b3d90d85a27dd6b857"}
```

`totalMirrored()` read 101 immediately after (was 100 before), and
`attestationOf(1, uid)` for one of the 25 UIDs in that transaction returned
`exists: true` with the matching `sourceTxHash`. A re-post of the identical
body afterward returned `{"ok":true,"alreadyMirrored":true,...}` with no
new transaction, confirming the dedupe pre-check.

**Run 2** — after wiring `web/src/lib/mirror.ts` and `batch.ts` to call this
relayer (the change described above), re-verified with the exact request
shape the browser now sends: Sepolia `attest` transaction
`0x12644f279bf222f056ae59aaf58ac4403a7096cf057680916831710e2cc26a2c`
(block 11,673,604, EAS UID
`0xee6ca646314b49f7bb00df4b8a29824ebeae5b4a4de81ac9f88c42c5a54cfac0`):

```json
{"ok":true,"creditcoinTxHash":"0x07144e7fd2b135776266018a58724c7b4174dbaa88c6d936f31fd9b4c15deb7a","blockNumber":5468978,"gasUsed":"378941","ctcCost":"0.0001894705","queryId":"0xc051925f88212aa540ffc0a7b5f8cc21931217a9da5675a850ec61c90e6a7d6a"}
```

`totalMirrored()` read 144 immediately after (was 143 before — bench is a
separate, concurrently-running process also mirroring against the same
registry, so this count moves independently of the relayer). `resolve(1,
uid)` returned `exists: true` with `sourceTxHash` and `sourceBlock` matching
the source transaction. A first attempt in this run failed on a transient
public-RPC nonce-fetch timeout (`nonce allocation failed: request timeout`)
and is logged as `status: "failed"` in `receipts/relayer.jsonl` alongside the
successful retry — evidence discipline per SPEC §9: failures are logged, not
discarded.
