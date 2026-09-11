// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {EASReader} from "../src/EASReader.sol";
import {MockNativeQueryVerifier, TxFixture, EasCalldata} from "./Fixtures.sol";

/// @notice Shared setup: a registry wired to a mocked block-prover precompile, plus proof helpers.
abstract contract AdmissibleTestBase is Test {
    address internal constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    /// @dev The real, canonical EAS deployments (SPEC.md §3).
    address internal constant EAS_SEPOLIA = 0xC2679fBD37d54388Ce493F1DB75320D236e1815e;
    address internal constant EAS_MAINNET = 0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587;

    /// @dev An attacker-deployed EAS clone: same events, different address.
    address internal constant FAKE_EAS = 0x00000000000000000000000000000000DeaDBeef;

    uint64 internal constant SEPOLIA = 1;
    uint64 internal constant MAINNET = 3;

    address internal constant ATTESTER = address(0xA77E57E4);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    bytes32 internal constant SCHEMA = keccak256("kyc-schema-v1");
    bytes32 internal constant OTHER_SCHEMA = keccak256("other-schema");

    AttestationRegistry internal registry;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        vm.etch(PRECOMPILE, address(new MockNativeQueryVerifier()).code);
        registry = new AttestationRegistry();
    }

    // ── proof helpers ────────────────────────────────────────────────────────────

    function _merkleProof(bytes32 root) internal pure returns (INativeQueryVerifier.MerkleProof memory) {
        INativeQueryVerifier.MerkleProofEntry[] memory siblings =
            new INativeQueryVerifier.MerkleProofEntry[](1);
        siblings[0] = INativeQueryVerifier.MerkleProofEntry({hash: root, isLeft: true});
        return INativeQueryVerifier.MerkleProof({root: root, siblings: siblings});
    }

    function _continuityProof() internal pure returns (INativeQueryVerifier.ContinuityProof memory) {
        bytes32[] memory roots = new bytes32[](2);
        roots[0] = keccak256("root-a");
        roots[1] = keccak256("root-b");
        return INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: keccak256("lower"), roots: roots});
    }

    /// @dev Reproduces `ASCBase._computeQueryId`: keccak(uint256 chainKey ‖ uint64 blockHeight ‖ uint256 txIndex).
    function _queryId(uint64 chainKey, uint64 blockHeight, bytes32 root, uint256 siblingCount)
        internal
        pure
        returns (bytes32)
    {
        uint256 txIndex = uint64(uint256(keccak256(abi.encode(root, siblingCount))));
        return keccak256(abi.encodePacked(uint256(chainKey), blockHeight, txIndex));
    }

    function _submit(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        bytes32 sourceTxHash,
        bytes memory encodedTransaction,
        bytes32 root
    ) internal returns (bool) {
        return registry.submit(
            action,
            chainKey,
            blockHeight,
            sourceTxHash,
            encodedTransaction,
            _merkleProof(root),
            _continuityProof()
        );
    }

    // ── transaction fixtures ─────────────────────────────────────────────────────

    function _easFor(uint64 chainKey) internal pure returns (address) {
        return chainKey == SEPOLIA ? EAS_SEPOLIA : EAS_MAINNET;
    }

    /// @dev A successful single-`attest` transaction: one Attested log + matching real EAS calldata.
    function _singleAttestTx(uint64 chainKey, bytes32 uid, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        address eas = _easFor(chainKey);
        return TxFixture.encodeTx(
            eas,
            EasCalldata.attest(SCHEMA, recipient, 0, true, bytes32(0), hex"1234"),
            1,
            TxFixture.logs1(TxFixture.attestedLog(eas, recipient, ATTESTER, SCHEMA, uid))
        );
    }

    /// @dev A single-`revoke` transaction for `uid`.
    function _revokeTx(uint64 chainKey, bytes32 uid, address recipient) internal pure returns (bytes memory) {
        address eas = _easFor(chainKey);
        return TxFixture.encodeTx(
            eas,
            EasCalldata.revoke(SCHEMA, uid),
            1,
            TxFixture.logs1(TxFixture.revokedLog(eas, recipient, ATTESTER, SCHEMA, uid))
        );
    }
}
