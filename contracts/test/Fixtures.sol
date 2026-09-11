// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EASReader} from "../src/EASReader.sol";

/// @notice Stand-in for the Creditcoin block-prover precompile at 0x…0FD2.
/// @dev    `vm.etch`ed over the precompile address. Deliberately STATELESS: `vm.etch` copies runtime
///         code, not storage, so `calculateTxIndex` is a pure hash of the proof. That also gives
///         every distinct Merkle proof a distinct txIndex, hence a distinct ASCBase queryId — which
///         is exactly what the dedupe/replay tests need.
contract MockNativeQueryVerifier {
    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        return true;
    }

    function calculateTxIndex(INativeQueryVerifier.MerkleProof calldata merkleProof)
        external
        pure
        returns (uint64)
    {
        return uint64(uint256(keccak256(abi.encode(merkleProof.root, merkleProof.siblings.length))));
    }
}

/// @notice A precompile mock that refuses every proof, to prove ASCBase's verification gate is live.
contract RejectingVerifier {
    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        return false;
    }

    function calculateTxIndex(INativeQueryVerifier.MerkleProof calldata merkleProof)
        external
        pure
        returns (uint64)
    {
        return uint64(uint256(keccak256(abi.encode(merkleProof.root, merkleProof.siblings.length))));
    }
}

/// @notice Builds `encodedTransaction` blobs in the exact shape the prover emits, so unit tests need
///         no live proofs. Mirrors the fixture style of the official
///         `ASCLoanManagerSourceBinding.t.sol`: construct `LogEntry` arrays in memory and
///         `abi.encode(uint8 txType, bytes[] chunks)` around them.
library TxFixture {
    /// @dev Prover encoding: chunk[0] = common tx fields, chunk[1] = type-specific, chunk[2] = receipt.
    function encodeTx(
        address to,
        bytes memory callData,
        uint8 receiptStatus,
        EvmV1Decoder.LogEntryTuple[] memory logs
    ) internal pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](3);

        chunks[0] = abi.encode(
            uint64(7),              // nonce
            uint64(300_000),        // gasLimit
            address(0xBEEF),        // from
            false,                  // toIsNull
            to,                     // to
            uint256(0),             // value
            callData                // raw foreign calldata
        );

        chunks[1] = abi.encode(
            uint64(1),
            uint128(1 gwei),
            uint128(2 gwei),
            new EvmV1Decoder.AccessListEntryBytes32[](0),
            uint8(0),
            bytes32(0),
            bytes32(0)
        );

        chunks[2] = abi.encode(receiptStatus, uint64(180_000), logs, bytes(""));

        return abi.encode(uint8(2), chunks);
    }

    function attestedLog(
        address emitter,
        address recipient,
        address attester,
        bytes32 schemaUid,
        bytes32 uid
    ) internal pure returns (EvmV1Decoder.LogEntryTuple memory) {
        return _easLog(EASReader.ATTESTED_TOPIC, emitter, recipient, attester, schemaUid, uid);
    }

    function revokedLog(
        address emitter,
        address recipient,
        address attester,
        bytes32 schemaUid,
        bytes32 uid
    ) internal pure returns (EvmV1Decoder.LogEntryTuple memory) {
        return _easLog(EASReader.REVOKED_TOPIC, emitter, recipient, attester, schemaUid, uid);
    }

    /// @notice An unrelated ERC-20 Transfer-ish log, to prove non-EAS logs are ignored, not decoded.
    function noiseLog(address emitter) internal pure returns (EvmV1Decoder.LogEntryTuple memory) {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        topics[1] = bytes32(uint256(uint160(address(0x1111))));
        topics[2] = bytes32(uint256(uint160(address(0x2222))));
        return EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: abi.encode(uint256(1))});
    }

    /// @notice An EAS-topic log with the wrong number of topics.
    function malformedTopicsLog(address emitter, bytes32 uid)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = EASReader.ATTESTED_TOPIC;
        topics[1] = bytes32(uint256(uint160(address(0xAAAA))));
        topics[2] = bytes32(uint256(uint160(address(0xBBBB))));
        return EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: abi.encode(uid)});
    }

    /// @notice An EAS-topic log whose data is not exactly one 32-byte UID.
    function malformedDataLog(address emitter) internal pure returns (EvmV1Decoder.LogEntryTuple memory) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = EASReader.ATTESTED_TOPIC;
        topics[1] = bytes32(uint256(uint160(address(0xAAAA))));
        topics[2] = bytes32(uint256(uint160(address(0xBBBB))));
        topics[3] = keccak256("schema");
        return EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: hex"dead"});
    }

    function _easLog(
        bytes32 topic0,
        address emitter,
        address recipient,
        address attester,
        bytes32 schemaUid,
        bytes32 uid
    ) private pure returns (EvmV1Decoder.LogEntryTuple memory) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = topic0;
        topics[1] = bytes32(uint256(uint160(recipient)));
        topics[2] = bytes32(uint256(uint160(attester)));
        topics[3] = schemaUid;
        return EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: abi.encode(uid)});
    }

    function logs1(EvmV1Decoder.LogEntryTuple memory a)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple[] memory out)
    {
        out = new EvmV1Decoder.LogEntryTuple[](1);
        out[0] = a;
    }

    function logs2(EvmV1Decoder.LogEntryTuple memory a, EvmV1Decoder.LogEntryTuple memory b)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple[] memory out)
    {
        out = new EvmV1Decoder.LogEntryTuple[](2);
        out[0] = a;
        out[1] = b;
    }

    function logs3(
        EvmV1Decoder.LogEntryTuple memory a,
        EvmV1Decoder.LogEntryTuple memory b,
        EvmV1Decoder.LogEntryTuple memory c
    ) internal pure returns (EvmV1Decoder.LogEntryTuple[] memory out) {
        out = new EvmV1Decoder.LogEntryTuple[](3);
        out[0] = a;
        out[1] = b;
        out[2] = c;
    }
}

/// @notice Builds real EAS calldata for the `attest` / `multiAttest` / `revoke` / `multiRevoke`
///         selectors, so the calldata-recovery path is exercised against the true ABI layout.
library EasCalldata {
    function attest(
        bytes32 schema,
        address recipient,
        uint64 expirationTime,
        bool revocable,
        bytes32 refUID,
        bytes memory data
    ) internal pure returns (bytes memory) {
        EASReader.AttestationRequest memory req = EASReader.AttestationRequest({
            schema: schema,
            data: EASReader.AttestationRequestData({
                recipient: recipient,
                expirationTime: expirationTime,
                revocable: revocable,
                refUID: refUID,
                data: data,
                value: 0
            })
        });
        return abi.encodeWithSelector(EASReader.ATTEST_SELECTOR, req);
    }

    /// @notice Two `MultiAttestationRequest`s: the first with `nFirst` datas, the second with one.
    function multiAttest(
        bytes32 schemaA,
        bytes32 schemaB,
        address[] memory recipientsA,
        address recipientB
    ) internal pure returns (bytes memory) {
        EASReader.MultiAttestationRequest[] memory reqs = new EASReader.MultiAttestationRequest[](2);

        EASReader.AttestationRequestData[] memory datasA =
            new EASReader.AttestationRequestData[](recipientsA.length);
        for (uint256 i; i < recipientsA.length; ++i) {
            datasA[i] = EASReader.AttestationRequestData({
                recipient: recipientsA[i],
                expirationTime: uint64(1000 + i),
                revocable: true,
                refUID: bytes32(uint256(i + 1)),
                data: abi.encodePacked("payload-", bytes1(uint8(0x41 + i))),
                value: 0
            });
        }
        reqs[0] = EASReader.MultiAttestationRequest({schema: schemaA, data: datasA});

        EASReader.AttestationRequestData[] memory datasB = new EASReader.AttestationRequestData[](1);
        datasB[0] = EASReader.AttestationRequestData({
            recipient: recipientB,
            expirationTime: 0,
            revocable: false,
            refUID: bytes32(0),
            data: hex"c0ffee",
            value: 0
        });
        reqs[1] = EASReader.MultiAttestationRequest({schema: schemaB, data: datasB});

        return abi.encodeWithSelector(EASReader.MULTI_ATTEST_SELECTOR, reqs);
    }

    function revoke(bytes32 schema, bytes32 uid) internal pure returns (bytes memory) {
        EASReader.RevocationRequest memory req = EASReader.RevocationRequest({
            schema: schema,
            data: EASReader.RevocationRequestData({uid: uid, value: 0})
        });
        return abi.encodeWithSelector(EASReader.REVOKE_SELECTOR, req);
    }

    function multiRevoke(bytes32 schema, bytes32[] memory uids) internal pure returns (bytes memory) {
        EASReader.MultiRevocationRequest[] memory reqs = new EASReader.MultiRevocationRequest[](1);
        EASReader.RevocationRequestData[] memory datas = new EASReader.RevocationRequestData[](uids.length);
        for (uint256 i; i < uids.length; ++i) {
            datas[i] = EASReader.RevocationRequestData({uid: uids[i], value: 0});
        }
        reqs[0] = EASReader.MultiRevocationRequest({schema: schema, data: datas});
        return abi.encodeWithSelector(EASReader.MULTI_REVOKE_SELECTOR, reqs);
    }
}
