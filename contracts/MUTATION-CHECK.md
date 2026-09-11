# Mutation check — do the security tests actually catch the bug?

A test that passes is worth nothing if it would also pass with the guard removed. The two
security-critical `require`s in this codebase were therefore deleted, the suite re-run, and the
failures recorded. Both guards are restored; this file is the evidence that the tests are real.

Run date: 2026-09-10. Toolchain: Foundry 1.7.1, Solidity 0.8.28.

## Baseline — guards in place

```
41 tests passed, 0 failed, 0 skipped (41 total tests)
```

## Mutation 1 + 2 — both guards removed simultaneously

Lines commented out:

| File | Line |
|---|---|
| `contracts/src/EASReader.sol` | `require(log.address_ == canonicalEas, "EASReader: log emitter is not canonical EAS");` |
| `contracts/src/AttestationRegistry.sol` | `require(receipt.receiptStatus == 1, "Admissible: source transaction did not succeed");` |

Result: **exactly 6 tests failed**, and they were precisely the 6 that target these two guards —
no more, no fewer:

| Failing test | Guard it defends |
|---|---|
| `test_RevertWhen_AttestedLogComesFromASpoofedEas` | emitter assertion |
| `test_RevertWhen_SpoofedLogIsMixedWithARealOne` | emitter assertion (fail-closed on mixed logs) |
| `test_RevertWhen_SepoliaEasLogIsSubmittedAsMainnet` | emitter assertion (right EAS, wrong chain) |
| `test_RevertWhen_SpoofedEmitterIsPreviewed` | emitter assertion on the SDK preview path |
| `test_RevertWhen_SourceReceiptStatusIsZero` | `receiptStatus == 1` |
| `test_RevertWhen_FailedReceiptIsRevoked` | `receiptStatus == 1` on the revoke path |

The other 35 tests still passed, which is the expected result: they exercise behaviour these two
guards do not govern.

## Why these two guards specifically

**Emitter assertion.** The Attestcoin block-prover precompile proves that a transaction really
occurred in a real Ethereum block. It does not prove *which contract* emitted a given log. Anyone
can deploy an EAS-shaped clone on Sepolia for a few cents, emit `Attested` with any
recipient/attester/schema they choose, and obtain a completely valid inclusion proof for it. Without
this assertion that forged log mirrors as a genuine Ethereum attestation — the proof is real, the
meaning is not.

**`receiptStatus == 1`.** The precompile proves inclusion, not success. A reverted Ethereum
transaction is still included in its block and still has a receipt. Without this check, a
transaction that failed on Ethereum could be mirrored as though it had taken effect.

## Reproducing

Comment out either `require`, then:

```bash
forge test
```
