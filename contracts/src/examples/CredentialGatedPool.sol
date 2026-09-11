// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAdmissibleRegistry, MirroredAttestation} from "../IAdmissibleRegistry.sol";

/// @title  CredentialGatedPool
/// @notice A minimal Creditcoin lending pool that will only lend to an address holding a valid,
///         non-revoked Ethereum attestation mirrored by Admissible.
///
/// @dev    This exists to prove one point: a third-party Creditcoin dApp consumes the registry in
///         about ten lines and needs to know nothing about Attestcoin, EAS, Merkle proofs or
///         Ethereum. It calls `isValidFrom` and `attestationOf` and that is the whole integration —
///         see {hasCredential}. Deposits and repayments are ordinary CTC transfers; the only
///         unusual thing about the pool is who is allowed to borrow.
///
///         Simplifications, stated plainly: interest-free, no liquidation, no collateral, a flat
///         per-borrower cap, and lenders share a single pool balance. It is a demonstration of the
///         credential gate, not a production credit market.
contract CredentialGatedPool {
    /// @notice Why a borrower is, or is not, allowed to draw down. Surfaced verbatim by the web app.
    /// @dev    `Eligible` is 0 so `status == Eligibility.Eligible` reads naturally in a UI.
    enum Eligibility {
        Eligible,       // 0 — credential mirrored, unrevoked, correctly issued, headroom remains
        NotMirrored,    // 1 — no such attestation has been mirrored for this chainKey/uid
        Revoked,        // 2 — mirrored, but revoked on Ethereum and proven revoked here
        WrongAttester,  // 3 — issued by someone other than this pool's required attester
        WrongSchema,    // 4 — issued under a different EAS schema than this pool requires
        NotRecipient,   // 5 — valid credential, but it belongs to a different address
        AtBorrowCap     // 6 — eligible, but already at the per-borrower principal cap
    }

    /// @notice The Admissible registry this pool trusts.
    IAdmissibleRegistry public immutable registry;

    /// @notice Owner, able to tune the credential requirement and the borrow cap.
    address public owner;

    /// @notice Attestcoin source-chain key the required credential must come from.
    uint64 public chainKey;

    /// @notice Required attester. `address(0)` means "any attester".
    address public requiredAttester;

    /// @notice Required EAS schema UID. `bytes32(0)` means "any schema".
    bytes32 public requiredSchema;

    /// @notice Maximum outstanding principal per borrower, in wei of CTC.
    uint256 public borrowCap;

    /// @notice Deposited principal per lender.
    mapping(address => uint256) public deposits;

    /// @notice Outstanding debt per borrower.
    mapping(address => uint256) public debt;

    /// @notice Sum of all lender deposits.
    uint256 public totalDeposits;

    /// @notice Sum of all outstanding debt.
    uint256 public totalDebt;

    /// @notice The mirrored attestation UID each address has presented to this pool.
    /// @dev    Lets the UI ask "why can't this wallet borrow?" with nothing but an address —
    ///         see {eligibilityReason}. Set by {presentCredential} and by a successful {borrow}.
    mapping(address => bytes32) public credentialOf;

    /// @notice Emitted when an address nominates the attestation it intends to borrow against.
    /// @param holder The address presenting the credential.
    /// @param uid    The mirrored EAS attestation UID.
    event CredentialPresented(address indexed holder, bytes32 indexed uid);

    /// @notice Emitted when a lender deposits CTC.
    /// @param lender The depositor.
    /// @param amount Amount in wei.
    event Deposited(address indexed lender, uint256 amount);

    /// @notice Emitted when a lender withdraws CTC.
    /// @param lender The withdrawer.
    /// @param amount Amount in wei.
    event Withdrawn(address indexed lender, uint256 amount);

    /// @notice Emitted when a credentialled borrower draws down.
    /// @param borrower The borrower.
    /// @param uid      The mirrored EAS attestation UID that unlocked the loan.
    /// @param amount   Amount in wei.
    event Borrowed(address indexed borrower, bytes32 indexed uid, uint256 amount);

    /// @notice Emitted on repayment.
    /// @param borrower The borrower.
    /// @param amount   Amount in wei applied to principal.
    event Repaid(address indexed borrower, uint256 amount);

    /// @notice Emitted when the credential requirement changes.
    /// @param chainKey  New source-chain key.
    /// @param attester  New required attester (`address(0)` = any).
    /// @param schemaUid New required schema (`bytes32(0)` = any).
    event CredentialRequirementSet(uint64 chainKey, address attester, bytes32 schemaUid);

    modifier onlyOwner() {
        require(msg.sender == owner, "Pool: not owner");
        _;
    }

    /// @notice Deploy the pool against an Admissible registry.
    /// @param registry_         Address of the deployed `AttestationRegistry`.
    /// @param chainKey_         Attestcoin source-chain key credentials must come from (1 or 3).
    /// @param requiredAttester_ Required attester, or `address(0)` for any.
    /// @param requiredSchema_   Required EAS schema UID, or `bytes32(0)` for any.
    /// @param borrowCap_        Maximum outstanding principal per borrower, in wei.
    constructor(
        IAdmissibleRegistry registry_,
        uint64 chainKey_,
        address requiredAttester_,
        bytes32 requiredSchema_,
        uint256 borrowCap_
    ) {
        require(address(registry_) != address(0), "Pool: registry is zero");
        require(chainKey_ != 0, "Pool: chainKey is zero");

        registry = registry_;
        owner = msg.sender;
        chainKey = chainKey_;
        requiredAttester = requiredAttester_;
        requiredSchema = requiredSchema_;
        borrowCap = borrowCap_;

        emit CredentialRequirementSet(chainKey_, requiredAttester_, requiredSchema_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // The entire Admissible integration
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Does `who` hold the credential this pool requires, evidenced by attestation `uid`?
    /// @dev    THIS IS THE WHOLE INTEGRATION. Two registry calls:
    ///          - `isValidFrom` — mirrored, not revoked, from the required attester and schema.
    ///            (When attester/schema are left as wildcards the pool falls back to `isValid`,
    ///            which is the same check minus the issuer constraint.)
    ///          - `attestationOf` — binds the credential to the caller by checking the EAS
    ///            `recipient`, so one person's attestation cannot be replayed by another.
    /// @param who The address claiming the credential.
    /// @param uid The mirrored EAS attestation UID being presented.
    /// @return True when the credential is valid, unrevoked, correctly issued and belongs to `who`.
    function hasCredential(address who, bytes32 uid) public view returns (bool) {
        if (requiredAttester != address(0) && requiredSchema != bytes32(0)) {
            if (!registry.isValidFrom(chainKey, uid, requiredAttester, requiredSchema)) return false;
        } else if (!registry.isValid(chainKey, uid)) {
            return false;
        }

        MirroredAttestation memory a = registry.attestationOf(chainKey, uid);
        return a.recipient == who;
    }

    /// @notice Explain, in one read-only call, exactly why `who` may or may not borrow against `uid`.
    /// @dev    Read-only and free. Checks run in the order a human would ask them, so the first
    ///         failing condition is the one reported. `AtBorrowCap` is returned only when the
    ///         credential itself is fine — it is a capacity answer, not a credential answer.
    /// @param who The prospective borrower.
    /// @param uid The mirrored EAS attestation UID being presented as the credential.
    /// @return status    Machine-readable eligibility code.
    /// @return reason    Human-readable explanation for the UI.
    /// @return headroom  Additional principal `who` could draw right now, in wei (0 unless eligible).
    function eligibilityOf(address who, bytes32 uid)
        public
        view
        returns (Eligibility status, string memory reason, uint256 headroom)
    {
        MirroredAttestation memory a = registry.attestationOf(chainKey, uid);

        if (!a.exists) {
            return (Eligibility.NotMirrored, "No attestation mirrored for this chainKey and UID", 0);
        }
        if (a.revoked) {
            return (Eligibility.Revoked, "Attestation was revoked on Ethereum", 0);
        }
        if (requiredAttester != address(0) && a.attester != requiredAttester) {
            return (Eligibility.WrongAttester, "Attestation is from a different attester", 0);
        }
        if (requiredSchema != bytes32(0) && a.schemaUid != requiredSchema) {
            return (Eligibility.WrongSchema, "Attestation uses a different EAS schema", 0);
        }
        if (a.recipient != who) {
            return (Eligibility.NotRecipient, "Attestation was issued to a different address", 0);
        }

        uint256 owed = debt[who];
        if (owed >= borrowCap) {
            return (Eligibility.AtBorrowCap, "Already at the per-borrower cap", 0);
        }

        return (Eligibility.Eligible, "Eligible to borrow", borrowCap - owed);
    }

    /// @notice Nominate the attestation you intend to borrow against.
    /// @dev    Pure bookkeeping — it grants nothing. It only lets {eligibilityReason} answer for a
    ///         bare address, which is what a wallet-connected UI has before the user types a UID.
    /// @param uid The mirrored EAS attestation UID.
    function presentCredential(bytes32 uid) external {
        require(uid != bytes32(0), "Pool: uid is zero");
        credentialOf[msg.sender] = uid;
        emit CredentialPresented(msg.sender, uid);
    }

    /// @notice One-argument, human-readable answer to "why can this address not borrow?".
    /// @dev    Uses the credential the address most recently presented or borrowed against.
    /// @param who The address to explain.
    /// @return reason Human-readable explanation, ready to render.
    function eligibilityReason(address who) external view returns (string memory reason) {
        bytes32 uid = credentialOf[who];
        if (uid == bytes32(0)) {
            return "No credential presented";
        }
        (, reason, ) = eligibilityOf(who, uid);
    }

    /// @notice Machine-readable eligibility for the credential `who` most recently presented.
    /// @param who The address to check.
    /// @return status   Eligibility code; `NotMirrored` when no credential has been presented.
    /// @return headroom Additional principal `who` could draw right now, in wei.
    function eligibilityStatus(address who) external view returns (Eligibility status, uint256 headroom) {
        bytes32 uid = credentialOf[who];
        if (uid == bytes32(0)) {
            return (Eligibility.NotMirrored, 0);
        }
        (status, , headroom) = eligibilityOf(who, uid);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Pool
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Supply CTC to the pool.
    function deposit() external payable {
        require(msg.value > 0, "Pool: zero deposit");
        deposits[msg.sender] += msg.value;
        totalDeposits += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw previously supplied CTC, subject to available liquidity.
    /// @param amount Amount in wei to withdraw.
    function withdraw(uint256 amount) external {
        require(amount > 0, "Pool: zero withdraw");
        require(deposits[msg.sender] >= amount, "Pool: insufficient deposit");
        require(address(this).balance >= amount, "Pool: insufficient liquidity");

        deposits[msg.sender] -= amount;
        totalDeposits -= amount;

        emit Withdrawn(msg.sender, amount);

        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Pool: transfer failed");
    }

    /// @notice Borrow CTC against a mirrored Ethereum attestation.
    /// @dev    The credential is the only gate — no collateral is taken. The attestation must be
    ///         mirrored, unrevoked, from the required attester/schema, and issued to `msg.sender`.
    /// @param uid    The mirrored EAS attestation UID presented as the credential.
    /// @param amount Amount in wei to borrow.
    function borrow(bytes32 uid, uint256 amount) external {
        require(amount > 0, "Pool: zero borrow");
        require(hasCredential(msg.sender, uid), "Pool: no valid mirrored credential");
        require(debt[msg.sender] + amount <= borrowCap, "Pool: exceeds borrow cap");
        require(address(this).balance >= amount, "Pool: insufficient liquidity");

        debt[msg.sender] += amount;
        totalDebt += amount;
        credentialOf[msg.sender] = uid;

        emit Borrowed(msg.sender, uid, amount);

        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Pool: transfer failed");
    }

    /// @notice Repay outstanding debt. Any excess above the outstanding balance is refunded.
    function repay() external payable {
        uint256 owed = debt[msg.sender];
        require(owed > 0, "Pool: nothing owed");
        require(msg.value > 0, "Pool: zero repayment");

        uint256 applied = msg.value > owed ? owed : msg.value;
        debt[msg.sender] = owed - applied;
        totalDebt -= applied;

        emit Repaid(msg.sender, applied);

        uint256 refund = msg.value - applied;
        if (refund > 0) {
            (bool sent, ) = msg.sender.call{value: refund}("");
            require(sent, "Pool: refund failed");
        }
    }

    /// @notice Liquidity currently available to borrowers and withdrawers.
    /// @return The pool's CTC balance in wei.
    function availableLiquidity() external view returns (uint256) {
        return address(this).balance;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Set which credential the pool requires.
    /// @param chainKey_         Attestcoin source-chain key (1 = Sepolia, 3 = mainnet).
    /// @param requiredAttester_ Required attester, or `address(0)` for any.
    /// @param requiredSchema_   Required EAS schema UID, or `bytes32(0)` for any.
    function setCredentialRequirement(
        uint64 chainKey_,
        address requiredAttester_,
        bytes32 requiredSchema_
    ) external onlyOwner {
        require(chainKey_ != 0, "Pool: chainKey is zero");
        chainKey = chainKey_;
        requiredAttester = requiredAttester_;
        requiredSchema = requiredSchema_;
        emit CredentialRequirementSet(chainKey_, requiredAttester_, requiredSchema_);
    }

    /// @notice Set the per-borrower principal cap.
    /// @param borrowCap_ New cap in wei.
    function setBorrowCap(uint256 borrowCap_) external onlyOwner {
        borrowCap = borrowCap_;
    }

    /// @notice Transfer ownership of the pool.
    /// @param newOwner The new owner; cannot be the zero address.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Pool: new owner is zero");
        owner = newOwner;
    }
}
