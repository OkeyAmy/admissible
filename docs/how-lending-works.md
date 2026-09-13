# How the lending pool actually works

Plain-language walkthrough of `CredentialGatedPool` — the contract that turns a mirrored
Ethereum attestation into borrowing power on Creditcoin. If you can read a tweet, you can
read this.

## The one-sentence version

**Your Ethereum attestation is your credit score. No paperwork, no collateral, no oracle —
just proof that a specific fact about you exists on Ethereum, checked live on Creditcoin.**

## The three moves

There are exactly three things you ever do with the pool, in order:

1. **Present** — `presentCredential(uid)`. You show the pool which mirrored attestation is
   yours. One transaction, from your own wallet. This is the only step where you sign
   anything before you actually get money.
2. **Borrow** — `borrow(uid, amount)`. The pool checks your credential is real, still valid,
   and yours — then sends you CTC. No collateral changes hands. The credential *is* the
   collateral.
3. **Repay** — `repay()`. Send CTC back with the transaction. Overpay by accident? The
   contract sends the extra back in the same transaction. Underpay? Your remaining balance
   just goes down, you can repay again later.

That's the entire lifecycle. Someone else deposited the CTC you're borrowing (`deposit()`),
and can pull it back out when it's not lent (`withdraw()`) — that's the "bank" side, separate
from the "borrower" side above.

## What makes you eligible (in plain English)

Every borrow attempt boils down to one question, answered by `eligibilityOf(yourAddress, uid)` —
a free, no-gas, read-only call anyone can run before ever touching real money:

| Status | What it means in human terms |
|---|---|
| **Eligible** | You're good. This is the only status that lets you borrow. |
| **Not mirrored** | This attestation UID has never been proven onto Creditcoin. It might be totally real on Ethereum — it just hasn't made the trip yet. |
| **Revoked** | The attestation *was* valid, but its issuer withdrew it on Ethereum, and Creditcoin found out. Dead credential, permanently, unless a new one is issued. |
| **Wrong attester** | The fact is real, but it wasn't written by the specific issuer this pool trusts. Someone else can look at the exact same fact type and still get rejected here if it came from a different source. |
| **Wrong schema** | Same idea — the *shape* of the fact (its schema) doesn't match what this pool asked for. |
| **Not the recipient** | The attestation is real, valid, from the right issuer — it just wasn't written about *you*. You can't borrow on someone else's credential. |
| **At borrow cap** | Everything checks out, you're just already borrowed up to the limit for this credential. |

Nothing on that list can be faked by clicking a button. Every check reads real,
already-proven Ethereum state off the Creditcoin registry — the pool never trusts a claim,
only a proof.

## "Wait, no collateral at all?"

Correct — and that's deliberate, not a shortcut. Traditional DeFi lending overcollateralizes
(lock $150 to borrow $100) because a wallet address has no history. This pool inverts that:
instead of collateral, you post *identity* — a real-world or on-chain fact about you that
someone else already vouched for on Ethereum, that you cannot forge, and that can be publicly
checked by anyone. The trade is: less capital required to borrow, but the credential itself
carries the risk. Revoke the underlying attestation, and future borrows against it stop
working immediately — no vote, no upgrade, no migration.

## Two pools, two jobs — don't mix them up

There are **two separate, independently deployed instances** of this exact contract, and
they answer different questions:

- **The main pool** (`/pool` on the site) is pinned to one real credential — a specific
  attester and schema, already used by real people on Ethereum mainnet, that we do not
  control the keys for. This is the credibility demo: real third-party facts, checked live.
  Nobody here can complete `presentCredential`/`borrow`/`repay` on it, because that needs the
  actual holder's private key — which is the whole point.
- **The sandbox pool** (`/sandbox`) is wildcard: any mirrored, non-revoked attestation on
  Sepolia qualifies, from any issuer, about anyone. This is the one you can actually run
  end-to-end yourself — self-issue a credential with your own wallet, mirror it, then
  present → borrow → repay for real, live, with your own signature the whole way.

Same code, same rules, same eligibility logic — just pointed at different data, for
different reasons.

## Quick answers for the AMA

- **Is there interest?** No — this is a fixed-principal demo (`repay()` just returns what
  you borrowed, no accrual). Disclosed on purpose, not hidden.
- **Can I borrow more than the cap?** No — `borrowCap` is a hard per-borrower ceiling,
  enforced on-chain (`debt[you] + amount <= borrowCap`), currently 10 CTC on the main pool.
- **What if the pool has no liquidity?** `borrow()` reverts with `"Pool: insufficient liquidity"`.
  Eligibility and liquidity are two independent checks — you can be perfectly eligible and
  still not be able to borrow if nobody's deposited.
- **What if my credential gets revoked after I already borrowed?** Your existing debt doesn't
  change automatically — but any *new* borrow attempt against that UID will immediately fail
  with `Revoked`. The registry flips the moment Creditcoin proves the revocation; the pool
  reads that flip on the very next check.
- **Who can call `presentCredential` for me?** Nobody but you — it's `msg.sender`-scoped by
  design. That's what makes eligibility here impossible to fabricate on someone else's behalf.

## For devs

```solidity
function eligibilityOf(address who, bytes32 uid)
    external view returns (Eligibility status, string memory reason, uint256 headroom);

function presentCredential(bytes32 uid) external;
function borrow(bytes32 uid, uint256 amount) external;
function repay() external payable;
```

Full source: `contracts/src/examples/CredentialGatedPool.sol`. Full field reference and
addresses: [`docs/registry.md`](./registry.md).
