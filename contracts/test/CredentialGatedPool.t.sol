// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AdmissibleTestBase} from "./Base.t.sol";
import {IAdmissibleRegistry} from "../src/IAdmissibleRegistry.sol";
import {CredentialGatedPool} from "../src/examples/CredentialGatedPool.sol";

/// @notice Proves the registry is consumable by an ordinary Creditcoin dApp that knows nothing
///         about Attestcoin, EAS, Merkle proofs or Ethereum.
contract CredentialGatedPoolTest is AdmissibleTestBase {
    CredentialGatedPool internal pool;

    bytes32 internal constant UID_ALICE = keccak256("uid-alice");
    bytes32 internal constant UID_BOB = keccak256("uid-bob");

    address internal constant LENDER = address(0x11D3);

    uint256 internal constant CAP = 10 ether;

    function setUp() public override {
        super.setUp();
        pool = new CredentialGatedPool(IAdmissibleRegistry(address(registry)), MAINNET, ATTESTER, SCHEMA, CAP);

        vm.deal(LENDER, 100 ether);
        vm.prank(LENDER);
        pool.deposit{value: 50 ether}();
    }

    function _mirrorFor(address recipient, bytes32 uid, uint64 height, bytes32 salt) internal {
        _submit(0, MAINNET, height, keccak256("src"), _singleAttestTx(MAINNET, uid, recipient), salt);
    }

    function _revokeFor(address recipient, bytes32 uid, uint64 height, bytes32 salt) internal {
        _submit(1, MAINNET, height, keccak256("src"), _revokeTx(MAINNET, uid, recipient), salt);
    }

    // ── plumbing ─────────────────────────────────────────────────────────────────

    function test_DepositAndWithdraw() public {
        assertEq(pool.totalDeposits(), 50 ether);
        assertEq(pool.availableLiquidity(), 50 ether);

        vm.prank(LENDER);
        pool.withdraw(20 ether);

        assertEq(pool.deposits(LENDER), 30 ether);
        assertEq(pool.availableLiquidity(), 30 ether);
        assertEq(LENDER.balance, 70 ether);
    }

    function test_RevertWhen_WithdrawingMoreThanDeposited() public {
        vm.prank(LENDER);
        vm.expectRevert(bytes("Pool: insufficient deposit"));
        pool.withdraw(60 ether);
    }

    // ── the gate ─────────────────────────────────────────────────────────────────

    function test_RevertWhen_BorrowingWithoutAnyCredential() public {
        assertFalse(pool.hasCredential(ALICE, UID_ALICE));

        vm.prank(ALICE);
        vm.expectRevert(bytes("Pool: no valid mirrored credential"));
        pool.borrow(UID_ALICE, 1 ether);
    }

    function test_BorrowSucceedsOnceTheAttestationIsMirrored() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));
        assertTrue(pool.hasCredential(ALICE, UID_ALICE));

        vm.prank(ALICE);
        pool.borrow(UID_ALICE, 3 ether);

        assertEq(ALICE.balance, 3 ether);
        assertEq(pool.debt(ALICE), 3 ether);
        assertEq(pool.totalDebt(), 3 ether);
        assertEq(pool.availableLiquidity(), 47 ether);
        assertEq(pool.credentialOf(ALICE), UID_ALICE, "borrow records the credential used");
    }

    function test_RevertWhen_PresentingSomeoneElsesCredential() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));

        // Bob points at Alice's perfectly valid attestation.
        assertFalse(pool.hasCredential(BOB, UID_ALICE));

        vm.prank(BOB);
        vm.expectRevert(bytes("Pool: no valid mirrored credential"));
        pool.borrow(UID_ALICE, 1 ether);
    }

    function test_RevertWhen_CredentialIsFromTheWrongAttester() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));
        pool.setCredentialRequirement(MAINNET, address(0xBADA77E5), SCHEMA);

        vm.prank(ALICE);
        vm.expectRevert(bytes("Pool: no valid mirrored credential"));
        pool.borrow(UID_ALICE, 1 ether);
    }

    function test_RevertWhen_CredentialIsFromTheWrongSchema() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));
        pool.setCredentialRequirement(MAINNET, ATTESTER, OTHER_SCHEMA);

        vm.prank(ALICE);
        vm.expectRevert(bytes("Pool: no valid mirrored credential"));
        pool.borrow(UID_ALICE, 1 ether);
    }

    function test_RevertWhen_CredentialIsFromTheWrongChain() public {
        // Mirror on Sepolia, but the pool requires mainnet.
        _submit(0, SEPOLIA, 100, keccak256("s"), _singleAttestTx(SEPOLIA, UID_ALICE, ALICE), keccak256("ps"));

        vm.prank(ALICE);
        vm.expectRevert(bytes("Pool: no valid mirrored credential"));
        pool.borrow(UID_ALICE, 1 ether);
    }

    function test_RevocationStopsFurtherBorrowing() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));

        vm.prank(ALICE);
        pool.borrow(UID_ALICE, 2 ether);
        assertEq(pool.debt(ALICE), 2 ether);

        // Ethereum revokes the attestation; the revocation is proven onto Creditcoin.
        _revokeFor(ALICE, UID_ALICE, 101, keccak256("p2"));

        assertFalse(pool.hasCredential(ALICE, UID_ALICE));

        vm.prank(ALICE);
        vm.expectRevert(bytes("Pool: no valid mirrored credential"));
        pool.borrow(UID_ALICE, 1 ether);

        // Existing debt is untouched — revocation gates new credit, it does not erase old loans.
        assertEq(pool.debt(ALICE), 2 ether);
    }

    function test_RevertWhen_BorrowingOverTheCap() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));

        vm.prank(ALICE);
        pool.borrow(UID_ALICE, CAP);

        vm.prank(ALICE);
        vm.expectRevert(bytes("Pool: exceeds borrow cap"));
        pool.borrow(UID_ALICE, 1);
    }

    // ── repayment ────────────────────────────────────────────────────────────────

    function test_RepayReducesDebt() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));

        vm.prank(ALICE);
        pool.borrow(UID_ALICE, 4 ether);

        vm.prank(ALICE);
        pool.repay{value: 1.5 ether}();

        assertEq(pool.debt(ALICE), 2.5 ether);
        assertEq(pool.totalDebt(), 2.5 ether);
    }

    function test_RepayRefundsExcess() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));

        vm.prank(ALICE);
        pool.borrow(UID_ALICE, 2 ether);
        assertEq(ALICE.balance, 2 ether);

        vm.deal(ALICE, 5 ether);
        vm.prank(ALICE);
        pool.repay{value: 5 ether}();

        assertEq(pool.debt(ALICE), 0);
        assertEq(ALICE.balance, 3 ether, "3 ether of the 5 must be refunded");
    }

    function test_RevertWhen_RepayingNothingOwed() public {
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(bytes("Pool: nothing owed"));
        pool.repay{value: 1 ether}();
    }

    // ── the explain-yourself surface ─────────────────────────────────────────────

    function test_EligibilityReason_NoCredentialPresented() public view {
        assertEq(pool.eligibilityReason(ALICE), "No credential presented");
    }

    function test_EligibilityReason_NotMirrored() public {
        vm.prank(ALICE);
        pool.presentCredential(UID_ALICE);
        assertEq(pool.eligibilityReason(ALICE), "No attestation mirrored for this chainKey and UID");
    }

    function test_EligibilityReason_Eligible() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));
        vm.prank(ALICE);
        pool.presentCredential(UID_ALICE);

        assertEq(pool.eligibilityReason(ALICE), "Eligible to borrow");

        (CredentialGatedPool.Eligibility status, uint256 headroom) = pool.eligibilityStatus(ALICE);
        assertEq(uint256(status), uint256(CredentialGatedPool.Eligibility.Eligible));
        assertEq(headroom, CAP);
    }

    function test_EligibilityReason_Revoked() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));
        _revokeFor(ALICE, UID_ALICE, 101, keccak256("p2"));

        vm.prank(ALICE);
        pool.presentCredential(UID_ALICE);

        assertEq(pool.eligibilityReason(ALICE), "Attestation was revoked on Ethereum");
        (CredentialGatedPool.Eligibility status, ) = pool.eligibilityStatus(ALICE);
        assertEq(uint256(status), uint256(CredentialGatedPool.Eligibility.Revoked));
    }

    function test_EligibilityReason_NotRecipient() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));

        vm.prank(BOB);
        pool.presentCredential(UID_ALICE);

        assertEq(pool.eligibilityReason(BOB), "Attestation was issued to a different address");
    }

    function test_EligibilityReason_WrongAttester() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));
        pool.setCredentialRequirement(MAINNET, address(0xBADA77E5), SCHEMA);

        vm.prank(ALICE);
        pool.presentCredential(UID_ALICE);

        assertEq(pool.eligibilityReason(ALICE), "Attestation is from a different attester");
    }

    function test_EligibilityReason_WrongSchema() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));
        pool.setCredentialRequirement(MAINNET, ATTESTER, OTHER_SCHEMA);

        vm.prank(ALICE);
        pool.presentCredential(UID_ALICE);

        assertEq(pool.eligibilityReason(ALICE), "Attestation uses a different EAS schema");
    }

    function test_EligibilityReason_AtBorrowCap() public {
        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));

        vm.prank(ALICE);
        pool.borrow(UID_ALICE, CAP);

        assertEq(pool.eligibilityReason(ALICE), "Already at the per-borrower cap");
    }

    // ── wildcard configuration (how the pool ships before a demo issuer is chosen) ─

    function test_WildcardRequirementAcceptsAnyAttesterAndSchema() public {
        CredentialGatedPool open =
            new CredentialGatedPool(IAdmissibleRegistry(address(registry)), MAINNET, address(0), bytes32(0), CAP);

        _mirrorFor(ALICE, UID_ALICE, 100, keccak256("p1"));

        assertTrue(open.hasCredential(ALICE, UID_ALICE));
        assertFalse(open.hasCredential(BOB, UID_ALICE), "recipient binding still applies");
    }

    function test_RevertWhen_NonOwnerChangesRequirement() public {
        vm.prank(BOB);
        vm.expectRevert(bytes("Pool: not owner"));
        pool.setCredentialRequirement(MAINNET, ATTESTER, SCHEMA);
    }
}
