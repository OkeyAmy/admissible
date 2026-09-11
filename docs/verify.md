# Verification

This project rests on a premise: claims should be checkable. This page is how ours get
checked, with no API key, no local state, and — if you like — no Admissible code at all.

## The one command

```bash
npx admissible verify 0xf816583fdd1d59500a5abf035afd62d4b57af18d71221117cfcce47030ca2d05
```

The values in the table below are real — pulled live from the deployed registry, from
easscan, and (for `sourceBlock`, a third independent surface) from Ethereum mainnet's own
RPC, all while this document was being written. **This is not literal captured CLI
stdout** — the actual `admissible verify` output is formatted differently and scores a few
more fields than shown here (`uid`, `revokedAt`, plus `chainKey` and `mirroredAt` as
informational rows — full list in [sdk.md](./sdk.md)) — but every value below is exactly
what a real run against this UID reads on both sides, and they agree on all of them:

```
UID          0xf816583fdd1d59500a5abf035afd62d4b57af18d71221117cfcce47030ca2d05
chainKey     3  (Ethereum Mainnet)

field          creditcoin registry                                                 easscan.org
-------------- -------------------------------------------------------------------- ------------------------------------------------------------------
attester       0xC9C2695D3E7b1e910a8C53DAb7a8D67ad5dBbA70                            0xC9C2695D3E7b1e910a8C53DAb7a8D67ad5dBbA70
recipient      0x32CC7f86Cb334a2d91D8896851C0DF505c447f74                            0x32CC7f86Cb334a2d91D8896851C0DF505c447f74
schemaUid      0xc59265615401143689cbfe73046a922c975c99d97e4c248070435b1104b2dea7    0xc59265615401143689cbfe73046a922c975c99d97e4c248070435b1104b2dea7
sourceTxHash   0x125d7158c94b7515cf67bd3540577288467c7df5bc79913287eba9c468118ad0    0x125d7158c94b7515cf67bd3540577288467c7df5bc79913287eba9c468118ad0 (easscan's txid)
sourceBlock    25256519                                                              25256519 (from Ethereum mainnet RPC, not easscan)
revoked        false                                                                 false

All fields agree — the shape of result a real PASS run reports.
```

### A real mismatch, found while writing this document

Nothing here was staged. A second mainnet UID drawn from the same bench run —
`0x4095ca981096b69eec61ffb67e326e9a4b7ecb43add8f9bb33f03534570252fa` — surfaced a real
divergence: the registry holds `revoked = false`, while easscan reports `revoked = true`
(the revocation landed roughly 48 seconds after the attestation). Every other field
matches. This is not a spoofing case and not a bug in the emitter check — the mirror is
doing exactly what it is documented to do. Mirroring an `Attested` log (action `0`) and
mirroring a `Revoked` log (action `1`) are two separate proof submissions (§"Write path"
in [registry](./registry.md)); this bench run only submitted the first for this UID. The
registry entry is a snapshot **as of the moment it was proven**, not a live subscription —
and `verify` catching a stale snapshot, instead of silently reporting PASS, is the tool
working correctly. Run `npx admissible verify` on this UID yourself to see the FAIL, and
the diagnostic value of the diff is the point: a boolean "is it valid" would have hidden
exactly this.

## Why this is worth anything

A verification is only meaningful if the two sides are genuinely independent. Here they
are:

**Side one — Creditcoin.** Contract-held state on CC3 testnet, read across the public
RPC. Only one route leads there: someone submitted an Attestcoin proof that the
BlockProver precompile at `0x…0FD2` accepted. The contract does carry a narrow owner role
(it can register the canonical EAS address for a *new* source chainKey), but no function,
owner-gated or otherwise, can write, forge, or revoke a `MirroredAttestation` by hand —
see [registry](./registry.md). Almost every field in that struct is derived from the
proven receipt logs and is cryptographically assured to exist on Ethereum. **One field is
the exception:** `sourceTxHash` is caller-supplied display metadata, not something the
BlockProver proof covers — see the callout below the comparison table.

**Side two — easscan.org.** A public Ethereum indexer, operated by the EAS team, that has
never heard of this project and that we cannot influence.

Neither side is derived from the other. Inside Admissible, easscan serves UID *discovery*
only — locating which Ethereum transaction to prove — and nothing it returns is ever an
input to on-chain state. If the two sides agree, the agreement means something.

**What you are not asked to trust:** this documentation, our receipts file, our worker,
the Proof Builder service, or our CLI. The section below removes even the CLI.

## Verifying without our CLI

Two commands against two public endpoints.

### 1. Read Creditcoin

```bash
RPC=https://rpc.cc3-testnet.creditcoin.network
REG=0xA972422a821F622bcC1a72d0B19242F1ae2C6047
UID=0x<EAS_UID>

cast call $REG "attestationOf(uint64,bytes32)" 3 $UID --rpc-url $RPC
```

The response is the complete `MirroredAttestation` struct: chainKey, uid, schemaUid,
attester, recipient, sourceBlock, sourceTxHash, mirroredAt, revoked, revokedAt, exists.
Field order and types are in [registry](./registry.md).

### 2. Read Ethereum, from someone who is not us

```bash
curl -s https://easscan.org/graphql -H 'content-type: application/json' \
  -d '{"query":"{attestation(where:{id:\"0x<EAS_UID>\"}){id txid time attester recipient schemaId revoked revocationTime}}"}'
```

Use `https://sepolia.easscan.org/graphql` for Sepolia UIDs.

### 3. Compare

| Registry field | easscan field |
|---|---|
| `attester` | `attester` |
| `recipient` | `recipient` |
| `schemaUid` | `schemaId` |
| `sourceTxHash` | `txid` |
| `revoked` | `revoked` |

The two should line up exactly. That is the entire claim of this project — with one caveat
worth stating precisely: `attester`, `recipient`, `schemaUid` and `revoked` come out of
the proven Ethereum receipt logs, so a mismatch there is a cryptographic impossibility
unless something is genuinely wrong. `sourceTxHash` is different — it is metadata the
submitter typed in, not something the BlockProver proof covers (the prover's `txBytes` is
an ABI re-encoding, and the decoder cannot re-derive the original hash for every
transaction type). The CLI's `verify` still scores it against easscan's `txid` and reports
a mismatch as FAIL, so a spoofed value does not pass silently — but the guarantee behind
that field is "caught by cross-checking a second source," not "proven on chain," and this
page says so rather than blurring the two.

## Three more checks worth running

### What does the registry trust as EAS?

Everything above is only as secure as the registry's refusal to accept logs from any
deployment but the canonical EAS one. That posture is public:

```bash
cast call $REG "easAddress(uint64)" 3 --rpc-url $RPC
# expect 0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587  — canonical mainnet EAS

cast call $REG "easAddress(uint64)" 1 --rpc-url $RPC
# expect 0xC2679fBD37d54388Ce493F1DB75320D236e1815e  — canonical Sepolia EAS
```

Had those printed anything else, the rest of this page would not be worth reading.

### Is the source transaction real on Ethereum?

Take `sourceTxHash` from step 1 and look it up on a chain we have nothing to do with. Note
what this check does and does not establish: `sourceTxHash` is submitter-supplied metadata,
not a value the BlockProver proof covers, so this looks up whatever hash was typed in — it
is a plausibility check, and the reason the field is also cross-checked against easscan's
`txid` in step 3 above rather than trusted on its own.

```bash
cast tx <SOURCE_TX_HASH> --rpc-url https://ethereum-rpc.publicnode.com
```

Confirm that `to` is the canonical EAS address and that the transaction predates anything
we did.

### Prove one yourself

`submit` (and the `execute` it calls internally) is `external` and permissionless —
`ASCBase` imposes no owner, no allowlist, and no source-contract binding. You do not need
our permission or our worker to write to our registry:

```bash
npx admissible mirror 0x<SOME_OTHER_EAS_UID>
```

Pick a UID we have never touched, from your own key, with your own testnet CTC. If it
lands, the pipeline is real and it is not ours.

## Reading the receipts file

`receipts/mirrors.jsonl` is one JSON object per line, **one line per attempt including
failures**. A receipts file containing only successes is less credible, not more.

```json
{"easUid":"0x…","sourceChainKey":3,"sourceTxHash":"0x…","sourceBlock":25946469,
 "continuityRoots":32,"merkleSiblings":9,"queryId":"0x…","batchIndex":0,
 "creditcoinTxHash":"0x…","gasUsed":"…","ctcCost":"0.0000323",
 "proofLatencyMs":3560,"submitLatencyMs":1180,"status":"mirrored",
 "timestamp":"2026-09-13T…"}
```

Keep two things in mind before drawing conclusions from it:

1. **Rows are not transactions.** Proof generation is free; only submission costs CTC.
   `proofLatencyMs` and `submitLatencyMs` are separate fields because they have different
   cost profiles and different failure modes.
2. **Attestations are not submissions.** `ASCBase` dedupes on
   `(chainKey, blockHeight, txIndex)`, so one `multiAttest` transaction is one `execute`
   call carrying many attestations. `queryId` and `batchIndex` are recorded so both counts
   are independently derivable. Rows sharing a `queryId` came from one Creditcoin
   transaction.

Verify the row-level headline numbers yourself:

```bash
# attestations recorded as mirrored (one row per attestation)
grep -c '"status":"mirrored"' receipts/mirrors.jsonl

# distinct Creditcoin submissions (a multiAttest submission writes several rows
# sharing one queryId, so this is normally smaller than the count above)
grep -o '"queryId":"[^"]*"' receipts/mirrors.jsonl | sort -u | wc -l

# failed rows — read the error field before trusting this as "N independent failures";
# rows sharing a queryId are one failed submission, logged once per attestation it
# would have written
grep -c '"status":"failed"' receipts/mirrors.jsonl
grep '"status":"failed"' receipts/mirrors.jsonl | grep -o '"queryId":"[^"]*"' | sort -u | wc -l
```

**Cost, gas and latency are per-submission values, repeated on every row that shares a
`queryId`.** Summing `ctcCost` (or `gasUsed`, or a latency field) across raw rows
over-counts any grouped `multiAttest` submission by however many attestations it wrote.
Deduplicate by `queryId` first:

```python
import json
rows = [json.loads(l) for l in open("receipts/mirrors.jsonl") if l.strip()]
mirrored = [r for r in rows if r["status"] == "mirrored"]
by_query = {r["queryId"]: r for r in mirrored}          # keep one row per submission
total_ctc = sum(float(r["ctcCost"]) for r in by_query.values() if r.get("ctcCost"))
print(f"{len(mirrored)} attestations in {len(by_query)} submissions, {total_ctc} CTC spent")
```

Then take any `creditcoinTxHash` from the file to
`https://creditcoin-testnet.blockscout.com/address/<address>` (or `/tx/<hash>` for a
transaction) and confirm it exists.

## Verifying the revocation demonstration

The revocation demo uses an attestation **issued and revoked from a key we control** on
Sepolia. This is disclosed rather than glossed: a sweep of 15,000 recent Sepolia blocks
found zero `Revoked` events, and easscan returns only a handful ever. Revocations are
genuinely rare in the wild, so waiting for a stranger to revoke something was not a
plan. (That sweep was Sepolia specifically — the mainnet mismatch documented above,
under "A real mismatch, found while writing this document," *is* a real third-party
revocation. It does not show up as revoked in the registry only because this bench run
submitted the Mirror action for it and never the separate Revoke action — the two are
independent proof submissions, not because such revocations do not happen on mainnet.)

What is being demonstrated is the revocation *mechanism* — the `Revoked` event
(topic0 `0xf930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615`) proven
through the same BlockProver path, flipping registry state:

```bash
cast call $REG "attestationOf(uint64,bytes32)" 1 0x<REVOKED_UID> --rpc-url $RPC
# revoked == true, revokedAt != 0

cast call $REG "isValid(uint64,bytes32)" 1 0x<REVOKED_UID> --rpc-url $RPC
# false
```

It is not a third-party revocation and is not presented as one. Every other proof in this
project is of a transaction we did not create.

## Checking that the security tests are real

`forge test` reports 78 tests across 3 suites — 41 in `AttestationRegistry.t.sol`, 23 in
`CredentialGatedPool.t.sol`, 14 in `EASReader.t.sol` — all passing, 0 failed, 0 skipped.
That is a weak claim by itself — a test can pass because it asserts nothing.

You can check the tests bite, in about a minute. Delete these two lines:

```solidity
// contracts/src/AttestationRegistry.sol
require(receipt.receiptStatus == 1, "Admissible: source transaction did not succeed");

// contracts/src/EASReader.sol
require(log.address_ == canonicalEas, "EASReader: log emitter is not canonical EAS");
```

Then:

```bash
forge test
```

Exactly **6** of the 41 `AttestationRegistry.t.sol` tests should fail, all of them the
receipt-status and spoofed-emitter cases listed in `contracts/MUTATION-CHECK.md`. Restore
the two lines and you are back to 41/41 (78/78 across all three suites).

If removing a security check does not break a test, that check was never tested. This one
is.

## Reproducing the pre-build measurements

The feasibility probe run on 2026-09-10, before any product code was written, is
committed at `prebuild-evidence/scale_probe.json` with the script that produced it at
`prebuild-evidence/probe.py`. Its eleven transactions are real Ethereum mainnet EAS
transactions written by third parties. Re-run it against the live prover:

```bash
python3 prebuild-evidence/probe.py
```

Or fetch a single proof by hand:

```bash
curl -s https://proof-gen-api.cc3-testnet.creditcoin.network/api/v1/proof-by-tx/3/\
0xa579af8e43e78c884ce7b67f6753a96c67bf2ded055552806bb284df0e87b7d1 | head -c 400
```

Latency will differ from the recorded run — the prover caches, and network conditions
change. The continuity-root and Merkle-sibling counts should not.