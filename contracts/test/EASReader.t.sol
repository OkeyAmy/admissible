// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

import {EASReader} from "../src/EASReader.sol";
import {TxFixture, EasCalldata} from "./Fixtures.sol";

/// @dev Library functions are `internal`, so they need a deployed harness to be called from tests.
contract EASReaderHarness {
    function decodeAttest(bytes memory txData)
        external
        pure
        returns (EASReader.AttestationPayload[] memory, bool)
    {
        return EASReader.decodeAttestCalldata(txData);
    }

    function decodeRevoke(bytes memory txData) external pure returns (bytes32[] memory, bool) {
        return EASReader.decodeRevokeCalldata(txData);
    }

    function selectorOf(bytes memory txData) external pure returns (bytes4) {
        return EASReader.selectorOf(txData);
    }

    function readAttested(bytes memory encodedTx, address eas)
        external
        pure
        returns (EASReader.EASEvent[] memory)
    {
        return EASReader.readAttested(EvmV1Decoder.decodeReceiptFields(encodedTx), eas);
    }
}

contract EASReaderTest is Test {
    address internal constant EAS_MAINNET = 0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant ATTESTER = address(0xA77E57E4);

    bytes32 internal constant SCHEMA_A = keccak256("schema-a");
    bytes32 internal constant SCHEMA_B = keccak256("schema-b");

    EASReaderHarness internal reader;

    function setUp() public {
        reader = new EASReaderHarness();
    }

    // ── verified constants ───────────────────────────────────────────────────────

    function test_ConstantsMatchTheVerifiedNetworkFacts() public pure {
        assertEq(
            EASReader.ATTESTED_TOPIC,
            keccak256("Attested(address,address,bytes32,bytes32)"),
            "Attested topic0"
        );
        assertEq(
            EASReader.REVOKED_TOPIC,
            keccak256("Revoked(address,address,bytes32,bytes32)"),
            "Revoked topic0"
        );
        // The selectors pin the exact struct layouts we abi.decode against.
        assertEq(
            EASReader.ATTEST_SELECTOR,
            bytes4(keccak256("attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))"))
        );
        assertEq(
            EASReader.MULTI_ATTEST_SELECTOR,
            bytes4(keccak256("multiAttest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)[])[])"))
        );
        assertEq(
            EASReader.REVOKE_SELECTOR,
            bytes4(keccak256("revoke((bytes32,(bytes32,uint256)))"))
        );
        assertEq(
            EASReader.MULTI_REVOKE_SELECTOR,
            bytes4(keccak256("multiRevoke((bytes32,(bytes32,uint256)[])[])"))
        );
    }

    // ── calldata recovery: attest ────────────────────────────────────────────────

    function test_DecodeAttestCalldataRecoversTheWholeBody() public view {
        bytes memory callData =
            EasCalldata.attest(SCHEMA_A, ALICE, 1893456000, true, keccak256("ref"), hex"cafebabe");

        (EASReader.AttestationPayload[] memory p, bool ok) = reader.decodeAttest(callData);

        assertTrue(ok);
        assertEq(p.length, 1);
        assertEq(p[0].schema, SCHEMA_A);
        assertEq(p[0].recipient, ALICE);
        assertEq(p[0].expirationTime, 1893456000);
        assertTrue(p[0].revocable);
        assertEq(p[0].refUID, keccak256("ref"));
        assertEq(p[0].data, hex"cafebabe");
        assertEq(p[0].value, 0);
    }

    // ── calldata recovery: multiAttest, both nesting levels ──────────────────────

    function test_DecodeMultiAttestFlattensInEmissionOrder() public view {
        address[] memory recipientsA = new address[](2);
        recipientsA[0] = ALICE;
        recipientsA[1] = BOB;

        bytes memory callData = EasCalldata.multiAttest(SCHEMA_A, SCHEMA_B, recipientsA, address(0xCAFE));

        (EASReader.AttestationPayload[] memory p, bool ok) = reader.decodeAttest(callData);

        assertTrue(ok);
        assertEq(p.length, 3, "two requests -> 2 + 1 attestations");

        // Request 0's datas first, in order, then request 1's — EAS's own iteration order.
        assertEq(p[0].schema, SCHEMA_A);
        assertEq(p[0].recipient, ALICE);
        assertEq(p[0].expirationTime, 1000);
        assertEq(p[0].refUID, bytes32(uint256(1)));
        assertEq(p[0].data, bytes("payload-A"));

        assertEq(p[1].schema, SCHEMA_A);
        assertEq(p[1].recipient, BOB);
        assertEq(p[1].expirationTime, 1001);
        assertEq(p[1].refUID, bytes32(uint256(2)));
        assertEq(p[1].data, bytes("payload-B"));

        assertEq(p[2].schema, SCHEMA_B, "second request carries its own schema");
        assertEq(p[2].recipient, address(0xCAFE));
        assertEq(p[2].expirationTime, 0);
        assertFalse(p[2].revocable);
        assertEq(p[2].refUID, bytes32(0));
        assertEq(p[2].data, hex"c0ffee");
    }

    function test_DecodeMultiAttestHandlesAnEmptyBatch() public view {
        address[] memory none = new address[](0);
        bytes memory callData = EasCalldata.multiAttest(SCHEMA_A, SCHEMA_B, none, address(0xCAFE));

        (EASReader.AttestationPayload[] memory p, bool ok) = reader.decodeAttest(callData);
        assertTrue(ok);
        assertEq(p.length, 1, "only the second request contributes");
        assertEq(p[0].recipient, address(0xCAFE));
    }

    // ── calldata recovery: revoke ────────────────────────────────────────────────

    function test_DecodeRevokeCalldata() public view {
        (bytes32[] memory uids, bool ok) = reader.decodeRevoke(EasCalldata.revoke(SCHEMA_A, keccak256("u")));
        assertTrue(ok);
        assertEq(uids.length, 1);
        assertEq(uids[0], keccak256("u"));
    }

    function test_DecodeMultiRevokeCalldata() public view {
        bytes32[] memory input = new bytes32[](3);
        input[0] = keccak256("u1");
        input[1] = keccak256("u2");
        input[2] = keccak256("u3");

        (bytes32[] memory uids, bool ok) = reader.decodeRevoke(EasCalldata.multiRevoke(SCHEMA_A, input));
        assertTrue(ok);
        assertEq(uids.length, 3);
        assertEq(uids[0], input[0]);
        assertEq(uids[1], input[1]);
        assertEq(uids[2], input[2]);
    }

    // ── graceful degradation, not faking ─────────────────────────────────────────

    function test_UnknownSelectorReturnsFalseNotGarbage() public view {
        (EASReader.AttestationPayload[] memory p, bool ok) =
            reader.decodeAttest(abi.encodeWithSelector(bytes4(0x12345678), uint256(1)));
        assertFalse(ok, "must report failure rather than invent a payload");
        assertEq(p.length, 0);
    }

    function test_AttestByDelegationSelectorIsNotDecoded() public view {
        // Documented limitation: delegated attestations are not decoded, and say so honestly.
        bytes4 delegated = bytes4(
            keccak256("attestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256),(uint8,bytes32,bytes32),address,uint64))")
        );
        (, bool ok) = reader.decodeAttest(abi.encodeWithSelector(delegated, uint256(0)));
        assertFalse(ok);
    }

    function test_CalldataShorterThanASelectorReturnsFalse() public view {
        (EASReader.AttestationPayload[] memory p, bool ok) = reader.decodeAttest(hex"aabb");
        assertFalse(ok);
        assertEq(p.length, 0);
        assertEq(reader.selectorOf(hex"aabb"), bytes4(0));
    }

    function test_EmptyCalldataReturnsFalse() public view {
        (, bool ok) = reader.decodeAttest(hex"");
        assertFalse(ok);
    }

    function test_SelectorOf() public view {
        assertEq(reader.selectorOf(EasCalldata.attest(SCHEMA_A, ALICE, 0, true, bytes32(0), hex"01")), EASReader.ATTEST_SELECTOR);
    }

    // ── log reading ──────────────────────────────────────────────────────────────

    function test_ReadAttestedDecodesTopicsAndData() public view {
        bytes memory encoded = TxFixture.encodeTx(
            EAS_MAINNET,
            hex"",
            1,
            TxFixture.logs2(
                TxFixture.attestedLog(EAS_MAINNET, ALICE, ATTESTER, SCHEMA_A, keccak256("uid1")),
                TxFixture.attestedLog(EAS_MAINNET, BOB, ATTESTER, SCHEMA_B, keccak256("uid2"))
            )
        );

        EASReader.EASEvent[] memory events = reader.readAttested(encoded, EAS_MAINNET);
        assertEq(events.length, 2);
        assertEq(events[0].recipient, ALICE);
        assertEq(events[0].attester, ATTESTER);
        assertEq(events[0].schemaUid, SCHEMA_A);
        assertEq(events[0].uid, keccak256("uid1"));
        assertEq(events[1].recipient, BOB);
        assertEq(events[1].schemaUid, SCHEMA_B);
        assertEq(events[1].uid, keccak256("uid2"));
    }

    function test_RevertWhen_CanonicalEasIsZero() public {
        bytes memory encoded = TxFixture.encodeTx(
            EAS_MAINNET,
            hex"",
            1,
            TxFixture.logs1(TxFixture.attestedLog(EAS_MAINNET, ALICE, ATTESTER, SCHEMA_A, keccak256("u")))
        );
        vm.expectRevert(bytes("EASReader: no canonical EAS for chainKey"));
        reader.readAttested(encoded, address(0));
    }

    function test_ReadAttestedReturnsEmptyWhenThereAreNoEasLogs() public view {
        bytes memory encoded =
            TxFixture.encodeTx(EAS_MAINNET, hex"", 1, TxFixture.logs1(TxFixture.noiseLog(EAS_MAINNET)));
        assertEq(reader.readAttested(encoded, EAS_MAINNET).length, 0);
    }
}
