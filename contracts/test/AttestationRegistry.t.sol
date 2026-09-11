// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

import {AdmissibleTestBase} from "./Base.t.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {IAdmissibleRegistry, MirroredAttestation} from "../src/IAdmissibleRegistry.sol";
import {EASReader} from "../src/EASReader.sol";
import {TxFixture, EasCalldata, RejectingVerifier} from "./Fixtures.sol";

contract AttestationRegistryTest is AdmissibleTestBase {
    bytes32 internal constant UID_A = keccak256("uid-a");
    bytes32 internal constant UID_B = keccak256("uid-b");
    bytes32 internal constant UID_C = keccak256("uid-c");

    // ─────────────────────────────────────────────────────────────────────────────
    // Deployment invariants
    // ─────────────────────────────────────────────────────────────────────────────

    function test_ConstructorSeedsCanonicalEasAddresses() public view {
        assertEq(registry.easAddress(SEPOLIA), EAS_SEPOLIA, "sepolia EAS");
        assertEq(registry.easAddress(MAINNET), EAS_MAINNET, "mainnet EAS");
        assertEq(registry.easAddress(2), address(0), "unknown chainKey must be unset");
        assertEq(registry.owner(), address(this));
        assertEq(address(registry.VERIFIER()), PRECOMPILE);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Happy path
    // ─────────────────────────────────────────────────────────────────────────────

    function test_MirrorSingleAttestation() public {
        bytes memory encoded = _singleAttestTx(MAINNET, UID_A, ALICE);
        bytes32 root = keccak256("proof-1");
        bytes32 srcTx = keccak256("eth-tx-1");

        vm.expectEmit(true, true, true, true, address(registry));
        emit IAdmissibleRegistry.AttestationMirrored(
            MAINNET, UID_A, SCHEMA, ATTESTER, ALICE, 25_946_469, _queryId(MAINNET, 25_946_469, root, 1)
        );

        assertTrue(_submit(registry.ACTION_MIRROR(), MAINNET, 25_946_469, srcTx, encoded, root));

        MirroredAttestation memory a = registry.attestationOf(MAINNET, UID_A);
        assertEq(a.chainKey, MAINNET);
        assertEq(a.uid, UID_A);
        assertEq(a.schemaUid, SCHEMA);
        assertEq(a.attester, ATTESTER);
        assertEq(a.recipient, ALICE);
        assertEq(a.sourceBlock, 25_946_469);
        assertEq(a.sourceTxHash, srcTx);
        assertEq(a.mirroredAt, uint64(block.timestamp));
        assertFalse(a.revoked);
        assertEq(a.revokedAt, 0);
        assertTrue(a.exists);

        assertTrue(registry.isValid(MAINNET, UID_A));
        assertTrue(registry.isValidFrom(MAINNET, UID_A, ATTESTER, SCHEMA));
        assertEq(registry.totalMirrored(), 1);
        assertEq(registry.totalRevoked(), 0);
        assertTrue(registry.isQueryProcessed(_queryId(MAINNET, 25_946_469, root, 1)));
    }

    function test_IsValidFromRejectsWrongAttesterOrSchema() public {
        _submit(0, MAINNET, 100, keccak256("t"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p"));

        assertTrue(registry.isValidFrom(MAINNET, UID_A, ATTESTER, SCHEMA));
        assertFalse(registry.isValidFrom(MAINNET, UID_A, BOB, SCHEMA));
        assertFalse(registry.isValidFrom(MAINNET, UID_A, ATTESTER, OTHER_SCHEMA));
    }

    function test_UnknownUidIsNotValidAndHasEmptyRecord() public view {
        assertFalse(registry.isValid(MAINNET, UID_C));
        MirroredAttestation memory a = registry.attestationOf(MAINNET, UID_C);
        assertFalse(a.exists);
        assertEq(a.uid, bytes32(0));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // THE multiAttest CASE: one query, N registry entries
    // ─────────────────────────────────────────────────────────────────────────────

    function test_MultiAttest_OneQueryWritesEveryAttestation() public {
        address eas = EAS_MAINNET;

        address[] memory recipientsA = new address[](2);
        recipientsA[0] = ALICE;
        recipientsA[1] = BOB;

        bytes memory encoded = TxFixture.encodeTx(
            eas,
            EasCalldata.multiAttest(SCHEMA, OTHER_SCHEMA, recipientsA, address(0xCAFE)),
            1,
            TxFixture.logs3(
                TxFixture.attestedLog(eas, ALICE, ATTESTER, SCHEMA, UID_A),
                TxFixture.attestedLog(eas, BOB, ATTESTER, SCHEMA, UID_B),
                TxFixture.attestedLog(eas, address(0xCAFE), ATTESTER, OTHER_SCHEMA, UID_C)
            )
        );

        _submit(0, MAINNET, 25_946_470, keccak256("multi-tx"), encoded, keccak256("proof-multi"));

        // Three entries from ONE execute(). Dedupe is per transaction, so if the implementation
        // only handled logs[0] the other two would be lost forever.
        assertEq(registry.totalMirrored(), 3, "all three attestations must be written");
        assertTrue(registry.isValid(MAINNET, UID_A));
        assertTrue(registry.isValid(MAINNET, UID_B));
        assertTrue(registry.isValid(MAINNET, UID_C));

        assertEq(registry.attestationOf(MAINNET, UID_A).recipient, ALICE);
        assertEq(registry.attestationOf(MAINNET, UID_B).recipient, BOB);
        assertEq(registry.attestationOf(MAINNET, UID_C).recipient, address(0xCAFE));
        assertEq(registry.attestationOf(MAINNET, UID_C).schemaUid, OTHER_SCHEMA);
    }

    function test_MultiAttest_RecoversPayloadsFromProvenCalldata() public {
        address eas = EAS_MAINNET;

        address[] memory recipientsA = new address[](2);
        recipientsA[0] = ALICE;
        recipientsA[1] = BOB;

        bytes memory encoded = TxFixture.encodeTx(
            eas,
            EasCalldata.multiAttest(SCHEMA, OTHER_SCHEMA, recipientsA, address(0xCAFE)),
            1,
            TxFixture.logs3(
                TxFixture.attestedLog(eas, ALICE, ATTESTER, SCHEMA, UID_A),
                TxFixture.attestedLog(eas, BOB, ATTESTER, SCHEMA, UID_B),
                TxFixture.attestedLog(eas, address(0xCAFE), ATTESTER, OTHER_SCHEMA, UID_C)
            )
        );

        // The attestation body lives ONLY in the calldata; the Attested event does not carry it.
        vm.expectEmit(true, true, false, true, address(registry));
        emit AttestationRegistry.AttestationPayloadRecovered(
            MAINNET, UID_A, bytes32(uint256(1)), 1000, true, bytes("payload-A")
        );
        vm.expectEmit(true, true, false, true, address(registry));
        emit AttestationRegistry.AttestationPayloadRecovered(
            MAINNET, UID_B, bytes32(uint256(2)), 1001, true, bytes("payload-B")
        );
        vm.expectEmit(true, true, false, true, address(registry));
        emit AttestationRegistry.AttestationPayloadRecovered(
            MAINNET, UID_C, bytes32(0), 0, false, hex"c0ffee"
        );

        _submit(0, MAINNET, 25_946_470, keccak256("multi-tx"), encoded, keccak256("proof-multi"));
    }

    function test_Attest_RecoversPayloadFromProvenCalldata() public {
        address eas = EAS_SEPOLIA;
        bytes memory encoded = TxFixture.encodeTx(
            eas,
            EasCalldata.attest(SCHEMA, ALICE, 1893456000, true, keccak256("ref"), hex"deadbeef"),
            1,
            TxFixture.logs1(TxFixture.attestedLog(eas, ALICE, ATTESTER, SCHEMA, UID_A))
        );

        vm.expectEmit(true, true, false, true, address(registry));
        emit AttestationRegistry.AttestationPayloadRecovered(
            SEPOLIA, UID_A, keccak256("ref"), 1893456000, true, hex"deadbeef"
        );

        _submit(0, SEPOLIA, 5_000_000, keccak256("t"), encoded, keccak256("p"));
    }

    function test_MirrorStillWorksWhenCalldataIsNotAnEasCall() public {
        // A router/multicall transaction: the logs are genuine EAS logs, but `to` and the calldata
        // belong to the wrapper, so the deep path cannot decode. Mirroring must not be blocked.
        address router = address(0x1234567890123456789012345678901234567890);
        bytes memory encoded = TxFixture.encodeTx(
            router,
            abi.encodeWithSelector(bytes4(0x12345678), uint256(1)),
            1,
            TxFixture.logs1(TxFixture.attestedLog(EAS_MAINNET, ALICE, ATTESTER, SCHEMA, UID_A))
        );

        vm.recordLogs();
        _submit(0, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));
        Vm.Log[] memory entries = vm.getRecordedLogs();

        assertTrue(registry.isValid(MAINNET, UID_A), "mirror must still succeed");

        bytes32 payloadTopic = keccak256("AttestationPayloadRecovered(uint64,bytes32,bytes32,uint64,bool,bytes)");
        for (uint256 i; i < entries.length; ++i) {
            assertTrue(entries[i].topics[0] != payloadTopic, "must not fabricate a payload event");
        }
    }

    function test_NonEasLogsAreIgnoredNotDecoded() public {
        address eas = EAS_MAINNET;
        bytes memory encoded = TxFixture.encodeTx(
            eas,
            EasCalldata.attest(SCHEMA, ALICE, 0, true, bytes32(0), hex"01"),
            1,
            TxFixture.logs2(
                TxFixture.noiseLog(address(0x9999)),
                TxFixture.attestedLog(eas, ALICE, ATTESTER, SCHEMA, UID_A)
            )
        );

        _submit(0, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));
        assertEq(registry.totalMirrored(), 1);
        assertTrue(registry.isValid(MAINNET, UID_A));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // SECURITY: spoofed emitter
    // ─────────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_AttestedLogComesFromASpoofedEas() public {
        // A perfectly valid Ethereum transaction, provable by Attestcoin, that emits an
        // EAS-shaped Attested event from an attacker's own contract.
        bytes memory encoded = TxFixture.encodeTx(
            FAKE_EAS,
            EasCalldata.attest(SCHEMA, ALICE, 0, true, bytes32(0), hex"01"),
            1,
            TxFixture.logs1(TxFixture.attestedLog(FAKE_EAS, ALICE, ATTESTER, SCHEMA, UID_A))
        );

        vm.expectRevert(bytes("EASReader: log emitter is not canonical EAS"));
        _submit(0, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));

        assertFalse(registry.isValid(MAINNET, UID_A));
        assertEq(registry.totalMirrored(), 0);
    }

    function test_RevertWhen_SpoofedLogIsMixedWithARealOne() public {
        // Fail-closed: one forged log poisons the whole submission rather than being filtered out.
        bytes memory encoded = TxFixture.encodeTx(
            EAS_MAINNET,
            hex"",
            1,
            TxFixture.logs2(
                TxFixture.attestedLog(EAS_MAINNET, ALICE, ATTESTER, SCHEMA, UID_A),
                TxFixture.attestedLog(FAKE_EAS, BOB, ATTESTER, SCHEMA, UID_B)
            )
        );

        vm.expectRevert(bytes("EASReader: log emitter is not canonical EAS"));
        _submit(0, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));
        assertEq(registry.totalMirrored(), 0);
    }

    function test_RevertWhen_SepoliaEasLogIsSubmittedAsMainnet() public {
        // The Sepolia EAS address is a legitimate EAS — just not the one mainnet uses. Submitting
        // it under chainKey 3 must fail on the emitter assertion.
        bytes memory encoded = TxFixture.encodeTx(
            EAS_SEPOLIA,
            hex"",
            1,
            TxFixture.logs1(TxFixture.attestedLog(EAS_SEPOLIA, ALICE, ATTESTER, SCHEMA, UID_A))
        );

        vm.expectRevert(bytes("EASReader: log emitter is not canonical EAS"));
        _submit(0, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));
    }

    function test_RevertWhen_SpoofedEmitterIsPreviewed() public {
        bytes memory encoded = TxFixture.encodeTx(
            FAKE_EAS,
            hex"",
            1,
            TxFixture.logs1(TxFixture.attestedLog(FAKE_EAS, ALICE, ATTESTER, SCHEMA, UID_A))
        );
        vm.expectRevert(bytes("EASReader: log emitter is not canonical EAS"));
        registry.previewAttested(MAINNET, encoded);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // SECURITY: the precompile does not check transaction success
    // ─────────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_SourceReceiptStatusIsZero() public {
        address eas = EAS_MAINNET;
        bytes memory encoded = TxFixture.encodeTx(
            eas,
            EasCalldata.attest(SCHEMA, ALICE, 0, true, bytes32(0), hex"01"),
            0, // reverted on Ethereum — still provably included in its block
            TxFixture.logs1(TxFixture.attestedLog(eas, ALICE, ATTESTER, SCHEMA, UID_A))
        );

        vm.expectRevert(bytes("Admissible: source transaction did not succeed"));
        _submit(0, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));

        assertFalse(registry.isValid(MAINNET, UID_A));
        assertEq(registry.totalMirrored(), 0);
    }

    function test_RevertWhen_FailedReceiptIsRevoked() public {
        address eas = EAS_MAINNET;
        bytes memory encoded = TxFixture.encodeTx(
            eas,
            EasCalldata.revoke(SCHEMA, UID_A),
            0,
            TxFixture.logs1(TxFixture.revokedLog(eas, ALICE, ATTESTER, SCHEMA, UID_A))
        );

        vm.expectRevert(bytes("Admissible: source transaction did not succeed"));
        _submit(1, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Malformed logs
    // ─────────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_EasLogHasWrongTopicCount() public {
        bytes memory encoded = TxFixture.encodeTx(
            EAS_MAINNET,
            hex"",
            1,
            TxFixture.logs1(TxFixture.malformedTopicsLog(EAS_MAINNET, UID_A))
        );
        vm.expectRevert(bytes("EASReader: expected 4 topics on EAS log"));
        _submit(0, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));
    }

    function test_RevertWhen_EasLogDataIsNot32Bytes() public {
        bytes memory encoded = TxFixture.encodeTx(
            EAS_MAINNET,
            hex"",
            1,
            TxFixture.logs1(TxFixture.malformedDataLog(EAS_MAINNET))
        );
        vm.expectRevert(bytes("EASReader: expected 32 bytes of EAS log data"));
        _submit(0, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));
    }

    function test_RevertWhen_TransactionHasNoAttestedLogs() public {
        bytes memory encoded = TxFixture.encodeTx(
            EAS_MAINNET, hex"", 1, TxFixture.logs1(TxFixture.noiseLog(EAS_MAINNET))
        );
        vm.expectRevert(bytes("Admissible: no Attested logs in transaction"));
        _submit(0, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));
    }

    function test_RevertWhen_TransactionHasNoRevokedLogs() public {
        bytes memory encoded = TxFixture.encodeTx(
            EAS_MAINNET, hex"", 1, TxFixture.logs1(TxFixture.noiseLog(EAS_MAINNET))
        );
        vm.expectRevert(bytes("Admissible: no Revoked logs in transaction"));
        _submit(1, MAINNET, 10, keccak256("t"), encoded, keccak256("p"));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Revocation
    // ─────────────────────────────────────────────────────────────────────────────

    function test_RevocationFlipsIsValidToFalse() public {
        _submit(0, MAINNET, 100, keccak256("t1"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p1"));
        assertTrue(registry.isValid(MAINNET, UID_A));

        vm.warp(block.timestamp + 3600);

        bytes32 root = keccak256("p2");
        vm.expectEmit(true, true, false, true, address(registry));
        emit IAdmissibleRegistry.AttestationRevoked(
            MAINNET, UID_A, uint64(block.timestamp), _queryId(MAINNET, 101, root, 1)
        );

        _submit(1, MAINNET, 101, keccak256("t2"), _revokeTx(MAINNET, UID_A, ALICE), root);

        assertFalse(registry.isValid(MAINNET, UID_A), "revoked attestation must not be valid");
        assertFalse(registry.isValidFrom(MAINNET, UID_A, ATTESTER, SCHEMA), "isValidFrom must honour revocation");

        MirroredAttestation memory a = registry.attestationOf(MAINNET, UID_A);
        assertTrue(a.revoked);
        assertEq(a.revokedAt, uint64(block.timestamp));
        assertTrue(a.exists);
        assertEq(a.recipient, ALICE, "mirrored fields survive revocation");

        assertEq(registry.totalMirrored(), 1);
        assertEq(registry.totalRevoked(), 1);
    }

    function test_RevokeBeforeMirror_DoesNotBlockTheLaterMirror() public {
        // Attestcoin proofs can arrive out of order. Revoke first…
        _submit(1, MAINNET, 200, keccak256("r"), _revokeTx(MAINNET, UID_A, ALICE), keccak256("pr"));

        MirroredAttestation memory tombstone = registry.attestationOf(MAINNET, UID_A);
        assertTrue(tombstone.exists);
        assertTrue(tombstone.revoked);
        assertEq(tombstone.mirroredAt, 0, "tombstone must not claim to be mirrored");
        assertEq(tombstone.attester, ATTESTER, "revoked log topics still identify the attestation");
        assertFalse(registry.isValid(MAINNET, UID_A));
        assertEq(registry.totalMirrored(), 0);
        assertEq(registry.totalRevoked(), 1);

        // …then mirror. The mirror must still land, and must not resurrect validity.
        _submit(0, MAINNET, 199, keccak256("m"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("pm"));

        MirroredAttestation memory a = registry.attestationOf(MAINNET, UID_A);
        assertEq(a.mirroredAt, uint64(block.timestamp), "mirror must not be silently dropped");
        assertEq(a.sourceBlock, 199);
        assertEq(a.recipient, ALICE);
        assertTrue(a.revoked, "revocation must survive the later mirror");
        assertFalse(registry.isValid(MAINNET, UID_A));
        assertEq(registry.totalMirrored(), 1);
        assertEq(registry.totalRevoked(), 1);
    }

    function test_DoubleRevokeDoesNotDoubleCount() public {
        _submit(0, MAINNET, 100, keccak256("t1"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p1"));
        _submit(1, MAINNET, 101, keccak256("t2"), _revokeTx(MAINNET, UID_A, ALICE), keccak256("p2"));
        // A second, different transaction that revokes the same UID (different queryId).
        _submit(1, MAINNET, 102, keccak256("t3"), _revokeTx(MAINNET, UID_A, ALICE), keccak256("p3"));
        assertEq(registry.totalRevoked(), 1, "revocation is idempotent per UID");
    }

    function test_MultiRevokeAppliesToEveryUid() public {
        _submit(0, MAINNET, 100, keccak256("m1"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("pa"));
        _submit(0, MAINNET, 101, keccak256("m2"), _singleAttestTx(MAINNET, UID_B, BOB), keccak256("pb"));
        assertEq(registry.totalMirrored(), 2);

        bytes32[] memory uids = new bytes32[](2);
        uids[0] = UID_A;
        uids[1] = UID_B;

        bytes memory encoded = TxFixture.encodeTx(
            EAS_MAINNET,
            EasCalldata.multiRevoke(SCHEMA, uids),
            1,
            TxFixture.logs2(
                TxFixture.revokedLog(EAS_MAINNET, ALICE, ATTESTER, SCHEMA, UID_A),
                TxFixture.revokedLog(EAS_MAINNET, BOB, ATTESTER, SCHEMA, UID_B)
            )
        );

        _submit(1, MAINNET, 102, keccak256("rev"), encoded, keccak256("pr"));

        assertFalse(registry.isValid(MAINNET, UID_A));
        assertFalse(registry.isValid(MAINNET, UID_B));
        assertEq(registry.totalRevoked(), 2);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // chainKey isolation
    // ─────────────────────────────────────────────────────────────────────────────

    function test_ChainKeyIsolation_SameUidOnBothChainsDoesNotCollide() public {
        // Identical UID, different EAS deployments. These are two unrelated attestations.
        _submit(0, MAINNET, 100, keccak256("t-main"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p-main"));
        _submit(0, SEPOLIA, 100, keccak256("t-sep"), _singleAttestTx(SEPOLIA, UID_A, BOB), keccak256("p-sep"));

        assertEq(registry.attestationOf(MAINNET, UID_A).recipient, ALICE);
        assertEq(registry.attestationOf(SEPOLIA, UID_A).recipient, BOB);
        assertEq(registry.attestationOf(MAINNET, UID_A).chainKey, MAINNET);
        assertEq(registry.attestationOf(SEPOLIA, UID_A).chainKey, SEPOLIA);
        assertEq(registry.totalMirrored(), 2);

        // Revoking on one chain must not touch the other.
        _submit(1, MAINNET, 101, keccak256("t-rev"), _revokeTx(MAINNET, UID_A, ALICE), keccak256("p-rev"));
        assertFalse(registry.isValid(MAINNET, UID_A));
        assertTrue(registry.isValid(SEPOLIA, UID_A), "sepolia record must be untouched");
    }

    function test_ChainKeyIsolation_QueryIdsAreDistinctPerChain() public {
        bytes32 root = keccak256("shared-root");
        _submit(0, MAINNET, 100, keccak256("t1"), _singleAttestTx(MAINNET, UID_A, ALICE), root);
        // Same block height, same merkle root — different chainKey, so a different queryId.
        _submit(0, SEPOLIA, 100, keccak256("t2"), _singleAttestTx(SEPOLIA, UID_B, BOB), root);
        assertEq(registry.totalMirrored(), 2);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Replay / dedupe
    // ─────────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_SameQueryIsReplayed() public {
        bytes memory encoded = _singleAttestTx(MAINNET, UID_A, ALICE);
        _submit(0, MAINNET, 100, keccak256("t"), encoded, keccak256("p"));

        vm.expectRevert(bytes("Query already processed"));
        _submit(0, MAINNET, 100, keccak256("t"), encoded, keccak256("p"));

        assertEq(registry.totalMirrored(), 1);
    }

    function test_RevertWhen_ReplayedByADifferentCaller() public {
        bytes memory encoded = _singleAttestTx(MAINNET, UID_A, ALICE);
        _submit(0, MAINNET, 100, keccak256("t"), encoded, keccak256("p"));

        vm.prank(BOB);
        vm.expectRevert(bytes("Query already processed"));
        _submit(0, MAINNET, 100, keccak256("t"), encoded, keccak256("p"));
    }

    function test_ReMirroringTheSameUidFromAnotherTxIsANoOp() public {
        _submit(0, MAINNET, 100, keccak256("t1"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p1"));
        // Different queryId, same UID: the query passes dedupe but the record must not be rewritten.
        _submit(0, MAINNET, 999, keccak256("t2"), _singleAttestTx(MAINNET, UID_A, BOB), keccak256("p2"));

        assertEq(registry.totalMirrored(), 1, "no double counting");
        assertEq(registry.attestationOf(MAINNET, UID_A).recipient, ALICE, "first write wins");
        assertEq(registry.attestationOf(MAINNET, UID_A).sourceBlock, 100);
    }

    function test_SubmissionIsPermissionless() public {
        vm.prank(BOB);
        _submit(0, MAINNET, 100, keccak256("t"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p"));
        assertTrue(registry.isValid(MAINNET, UID_A));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Entry-point wiring
    // ─────────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_ExecuteIsCalledDirectly() public {
        // Documents the chainKey solution: `execute` still exists and still shares the same
        // `processedQueries` map, but without submit()'s context it cannot resolve a chainKey.
        INativeQueryVerifier.MerkleProofEntry[] memory siblings =
            new INativeQueryVerifier.MerkleProofEntry[](1);
        siblings[0] = INativeQueryVerifier.MerkleProofEntry({hash: keccak256("p"), isLeft: true});
        bytes32[] memory roots = new bytes32[](0);

        vm.expectRevert(bytes("Admissible: call submit(), not execute()"));
        registry.execute(
            0, MAINNET, 100, _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p"), siblings, bytes32(0), roots
        );

        // And the failed direct call must not have burned the queryId.
        assertFalse(registry.isQueryProcessed(_queryId(MAINNET, 100, keccak256("p"), 1)));
    }

    function test_RevertWhen_ChainKeyIsUnsupported() public {
        vm.expectRevert(bytes("Admissible: unsupported chainKey"));
        _submit(0, 7, 100, keccak256("t"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p"));
    }

    function test_RevertWhen_ChainKeyIsZero() public {
        vm.expectRevert(bytes("Admissible: chainKey must be non-zero"));
        _submit(0, 0, 100, keccak256("t"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p"));
    }

    function test_RevertWhen_ActionIsUnknown() public {
        vm.expectRevert(bytes("Admissible: unknown action"));
        _submit(9, MAINNET, 100, keccak256("t"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p"));
    }

    function test_PendingContextIsClearedAfterSubmit() public {
        _submit(0, MAINNET, 100, keccak256("t"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p"));

        // If submit() leaked its context, a direct execute() would now succeed. It must not.
        INativeQueryVerifier.MerkleProofEntry[] memory siblings =
            new INativeQueryVerifier.MerkleProofEntry[](1);
        siblings[0] = INativeQueryVerifier.MerkleProofEntry({hash: keccak256("q"), isLeft: true});
        bytes32[] memory roots = new bytes32[](0);

        vm.expectRevert(bytes("Admissible: call submit(), not execute()"));
        registry.execute(
            0, MAINNET, 100, _singleAttestTx(MAINNET, UID_B, BOB), keccak256("q"), siblings, bytes32(0), roots
        );
    }

    function test_RevertWhen_ProofVerificationFails() public {
        vm.etch(PRECOMPILE, address(new RejectingVerifier()).code);
        vm.expectRevert(bytes("Proof of inclusion verification failed"));
        _submit(0, MAINNET, 100, keccak256("t"), _singleAttestTx(MAINNET, UID_A, ALICE), keccak256("p"));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views for the SDK
    // ─────────────────────────────────────────────────────────────────────────────

    function test_PreviewAttestedMatchesWhatWouldBeWritten() public view {
        bytes memory encoded = _singleAttestTx(MAINNET, UID_A, ALICE);
        EASReader.EASEvent[] memory events = registry.previewAttested(MAINNET, encoded);
        assertEq(events.length, 1);
        assertEq(events[0].uid, UID_A);
        assertEq(events[0].recipient, ALICE);
        assertEq(events[0].attester, ATTESTER);
        assertEq(events[0].schemaUid, SCHEMA);
        assertEq(events[0].emitter, EAS_MAINNET);
    }

    function test_PreviewRevoked() public view {
        EASReader.EASEvent[] memory events = registry.previewRevoked(MAINNET, _revokeTx(MAINNET, UID_A, ALICE));
        assertEq(events.length, 1);
        assertEq(events[0].uid, UID_A);
    }

    function test_DecodeForeignRevokeCalldata() public view {
        (bytes32[] memory uids, bool ok) =
            registry.decodeForeignRevokeCalldata(_revokeTx(MAINNET, UID_A, ALICE));
        assertTrue(ok);
        assertEq(uids.length, 1);
        assertEq(uids[0], UID_A);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────────

    function test_OwnerCanRegisterANewSourceChain() public {
        address newEas = address(0xE45);
        registry.setEasAddress(9, newEas);
        assertEq(registry.easAddress(9), newEas);
    }

    function test_RevertWhen_NonOwnerSetsEasAddress() public {
        vm.prank(BOB);
        vm.expectRevert(bytes("Admissible: not owner"));
        registry.setEasAddress(9, address(0xE45));
    }

    function test_OwnershipTransfer() public {
        registry.transferOwnership(BOB);
        assertEq(registry.owner(), BOB);
        vm.expectRevert(bytes("Admissible: not owner"));
        registry.setEasAddress(9, address(0xE45));
    }
}
