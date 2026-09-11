// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/// @title  EASReader
/// @notice Reads Ethereum Attestation Service (EAS) activity out of a *proven* Ethereum
///         transaction, as delivered by the Attestcoin Protocol block-prover precompile.
///
/// @dev    Two independent depths of extraction:
///
///         1. **Receipt logs** (`readAttested` / `readRevoked`). Cheap, and enough to know
///            *that* an attestation exists: recipient, attester, schema UID and UID.
///
///         2. **Foreign calldata** (`decodeAttestCalldata` / `decodeRevokeCalldata`). The
///            Attestcoin `EvmV1Decoder.CommonTxFields.data` field hands us the *raw calldata of a
///            transaction that happened on another chain*. EAS's `Attested` event deliberately does
///            not carry the attestation body — `expirationTime`, `revocable`, `refUID` and the
///            schema-encoded `data` payload exist **only** in the calldata. Because the prover
///            proves the whole transaction (not just its logs), we can ABI-decode that calldata
///            on Creditcoin and recover the complete attestation. Nothing is re-signed, nothing is
///            relayed by an oracle: the bytes are the same bytes Ethereum executed.
///
///         Selector/topic constants below were computed with `cast` and cross-checked against real
///         proven `txBytes` (see SPEC.md §3). `attest((bytes32,(address,uint64,bool,bytes32,bytes,
///         uint256)))` hashes to 0xf17325e7 and `multiAttest((bytes32,(address,uint64,bool,bytes32,
///         bytes,uint256)[])[])` hashes to 0x44adc90e, which pins the struct layouts exactly — so
///         `abi.decode` over the calldata argument region is exact, not heuristic.
///
///         EAS is MIT licensed; the request struct shapes mirror EAS `ISchemaRegistry`/`IEAS`.
library EASReader {
    // ─────────────────────────────────────────────────────────────────────────────
    // Verified EAS constants (SPEC.md §3 — do not change)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice topic0 of `Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)`.
    bytes32 internal constant ATTESTED_TOPIC =
        0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35;

    /// @notice topic0 of `Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)`.
    bytes32 internal constant REVOKED_TOPIC =
        0xf930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615;

    /// @notice topic0 of `RevokedOffchain(address indexed revoker, bytes32 indexed data, uint64 indexed timestamp)`.
    bytes32 internal constant REVOKED_OFFCHAIN_TOPIC =
        0x92a1f7a41a7c585a8b09e25b195e225b1d43248daca46b0faf9e0792777a2229;

    /// @notice `attest(AttestationRequest)` selector.
    bytes4 internal constant ATTEST_SELECTOR = 0xf17325e7;
    /// @notice `multiAttest(MultiAttestationRequest[])` selector — most real mainnet volume.
    bytes4 internal constant MULTI_ATTEST_SELECTOR = 0x44adc90e;
    /// @notice `revoke(RevocationRequest)` selector.
    bytes4 internal constant REVOKE_SELECTOR = 0x46926267;
    /// @notice `multiRevoke(MultiRevocationRequest[])` selector.
    bytes4 internal constant MULTI_REVOKE_SELECTOR = 0x4cb7e9e5;

    // ─────────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice A decoded EAS `Attested` or `Revoked` log.
    struct EASEvent {
        address emitter;    // always the canonical EAS address; asserted, never assumed
        address recipient;  // topics[1]
        address attester;   // topics[2]
        bytes32 schemaUid;  // topics[3]
        bytes32 uid;        // data[0:32]
    }

    /// @dev EAS `AttestationRequestData`.
    struct AttestationRequestData {
        address recipient;
        uint64  expirationTime;
        bool    revocable;
        bytes32 refUID;
        bytes   data;
        uint256 value;
    }

    /// @dev EAS `AttestationRequest` — the sole argument of `attest()`.
    struct AttestationRequest {
        bytes32 schema;
        AttestationRequestData data;
    }

    /// @dev EAS `MultiAttestationRequest` — `multiAttest()` takes an array of these, and each
    ///      element carries an array of request datas. Two levels of dynamic nesting.
    struct MultiAttestationRequest {
        bytes32 schema;
        AttestationRequestData[] data;
    }

    /// @dev EAS `RevocationRequestData`.
    struct RevocationRequestData {
        bytes32 uid;
        uint256 value;
    }

    /// @dev EAS `RevocationRequest` — the sole argument of `revoke()`.
    struct RevocationRequest {
        bytes32 schema;
        RevocationRequestData data;
    }

    /// @dev EAS `MultiRevocationRequest`.
    struct MultiRevocationRequest {
        bytes32 schema;
        RevocationRequestData[] data;
    }

    /// @notice One attestation body recovered from proven foreign calldata, flattened so that a
    ///         `multiAttest` batch and a single `attest` produce the same shape.
    struct AttestationPayload {
        bytes32 schema;
        address recipient;
        uint64  expirationTime;
        bool    revocable;
        bytes32 refUID;
        bytes   data;            // schema-encoded body — NOT present in the Attested event
        uint256 value;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Path 1 — receipt logs
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Extract every `Attested` log from a proven receipt.
    /// @param receipt         Receipt fields decoded from the prover's `txBytes`.
    /// @param canonicalEas    The EAS deployment address for the source chainKey.
    /// @return events         Every `Attested` log, in receipt order.
    function readAttested(
        EvmV1Decoder.ReceiptFields memory receipt,
        address canonicalEas
    ) internal pure returns (EASEvent[] memory events) {
        return _readEvents(receipt, ATTESTED_TOPIC, canonicalEas);
    }

    /// @notice Extract every `Revoked` log from a proven receipt.
    /// @param receipt         Receipt fields decoded from the prover's `txBytes`.
    /// @param canonicalEas    The EAS deployment address for the source chainKey.
    /// @return events         Every `Revoked` log, in receipt order.
    function readRevoked(
        EvmV1Decoder.ReceiptFields memory receipt,
        address canonicalEas
    ) internal pure returns (EASEvent[] memory events) {
        return _readEvents(receipt, REVOKED_TOPIC, canonicalEas);
    }

    /// @dev THE SECURITY CORE.
    ///
    ///      The Attestcoin precompile proves "this transaction really happened in this Ethereum
    ///      block". It says nothing about *which contract* emitted a given log. Anyone can deploy
    ///      an EAS-shaped clone on Sepolia for a few cents, emit an `Attested` event with any
    ///      recipient/attester/schema they like, and get a perfectly valid inclusion proof for it.
    ///      Without the emitter assertion below, that forged log would be mirrored as a genuine
    ///      Ethereum attestation. The proof is real; the *meaning* is not.
    ///
    ///      Behaviour is fail-closed: an EAS-topic log from an unrecognised emitter reverts the
    ///      whole submission rather than being filtered out. If a transaction contains logs that
    ///      look like EAS but did not come from EAS, the transaction is not what it claims to be,
    ///      and refusing to interpret it at all is safer than interpreting it partially.
    function _readEvents(
        EvmV1Decoder.ReceiptFields memory receipt,
        bytes32 topic0,
        address canonicalEas
    ) private pure returns (EASEvent[] memory events) {
        require(canonicalEas != address(0), "EASReader: no canonical EAS for chainKey");

        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, topic0);
        events = new EASEvent[](logs.length);

        for (uint256 i; i < logs.length; ++i) {
            EvmV1Decoder.LogEntry memory log = logs[i];

            // Emitter assertion — see the doc comment above. This is the line that makes the
            // whole system trustworthy.
            require(log.address_ == canonicalEas, "EASReader: log emitter is not canonical EAS");

            // Shape validation before any decoding, so a malformed log can never be read as if it
            // had the EAS layout. topics = [sig, recipient, attester, schemaUID]; data = uid.
            require(log.topics.length == 4, "EASReader: expected 4 topics on EAS log");
            require(log.data.length == 32, "EASReader: expected 32 bytes of EAS log data");

            events[i] = EASEvent({
                emitter:   log.address_,
                recipient: address(uint160(uint256(log.topics[1]))),
                attester:  address(uint160(uint256(log.topics[2]))),
                schemaUid: log.topics[3],
                uid:       _toBytes32(log.data)
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Path 2 — proven foreign calldata
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Read the 4-byte function selector of proven foreign calldata.
    /// @param txData `EvmV1Decoder.CommonTxFields.data` from the proven transaction.
    /// @return sel   The selector, or `0x00000000` if the calldata is shorter than 4 bytes.
    function selectorOf(bytes memory txData) internal pure returns (bytes4 sel) {
        if (txData.length < 4) return bytes4(0);
        // solhint-disable-next-line no-inline-assembly
        assembly {
            sel := mload(add(txData, 32))
        }
    }

    /// @notice Recover the full attestation bodies from proven `attest()` / `multiAttest()` calldata.
    ///
    /// @dev    BOTH selectors are decoded completely — including the doubly-nested dynamic arrays of
    ///         `multiAttest`. This is exact rather than best-effort because the selector itself pins
    ///         the ABI: `0x44adc90e` *is* the keccak of the canonical signature we decode against,
    ///         so any calldata that starts with it and decodes without reverting had exactly this
    ///         shape on Ethereum. `multiAttest` results are flattened in EAS's own iteration order:
    ///         request 0's datas, then request 1's datas, and so on — which is the order in which
    ///         EAS emits its `Attested` logs, so index i here pairs with `Attested` log i.
    ///
    ///         KNOWN LIMITATIONS (documented rather than faked):
    ///          - If the proven transaction went to a router/multicall/relayer instead of directly
    ///            to EAS, `txData` is that wrapper's calldata and this returns `(empty, false)`.
    ///            The log path (path 1) still works, so mirroring is unaffected.
    ///          - `attestByDelegation` / `multiAttestByDelegation` are not decoded; their selectors
    ///            are simply unrecognised and yield `(empty, false)`.
    ///          - Calldata that carries a known selector but a truncated/corrupt argument region
    ///            makes `abi.decode` revert. Callers that must not fail should invoke this behind a
    ///            `try/catch` (AttestationRegistry does exactly that).
    ///
    /// @param txData    Proven foreign calldata.
    /// @return payloads One entry per attestation, flattened, in EAS emission order.
    /// @return ok       False when the selector is not an EAS attest selector (payloads is empty).
    function decodeAttestCalldata(bytes memory txData)
        internal
        pure
        returns (AttestationPayload[] memory payloads, bool ok)
    {
        bytes4 sel = selectorOf(txData);

        if (sel == ATTEST_SELECTOR) {
            AttestationRequest memory req = abi.decode(_argumentRegion(txData), (AttestationRequest));
            payloads = new AttestationPayload[](1);
            payloads[0] = _flatten(req.schema, req.data);
            return (payloads, true);
        }

        if (sel == MULTI_ATTEST_SELECTOR) {
            MultiAttestationRequest[] memory reqs =
                abi.decode(_argumentRegion(txData), (MultiAttestationRequest[]));

            uint256 total;
            for (uint256 i; i < reqs.length; ++i) {
                total += reqs[i].data.length;
            }

            payloads = new AttestationPayload[](total);
            uint256 k;
            for (uint256 i; i < reqs.length; ++i) {
                bytes32 schema = reqs[i].schema;
                AttestationRequestData[] memory datas = reqs[i].data;
                for (uint256 j; j < datas.length; ++j) {
                    payloads[k++] = _flatten(schema, datas[j]);
                }
            }
            return (payloads, true);
        }

        return (new AttestationPayload[](0), false);
    }

    /// @notice Recover the revoked UIDs from proven `revoke()` / `multiRevoke()` calldata.
    /// @dev    Same exactness argument and same limitations as {decodeAttestCalldata}.
    /// @param txData Proven foreign calldata.
    /// @return uids  Revoked attestation UIDs, flattened in EAS emission order.
    /// @return ok    False when the selector is not an EAS revoke selector (uids is empty).
    function decodeRevokeCalldata(bytes memory txData)
        internal
        pure
        returns (bytes32[] memory uids, bool ok)
    {
        bytes4 sel = selectorOf(txData);

        if (sel == REVOKE_SELECTOR) {
            RevocationRequest memory req = abi.decode(_argumentRegion(txData), (RevocationRequest));
            uids = new bytes32[](1);
            uids[0] = req.data.uid;
            return (uids, true);
        }

        if (sel == MULTI_REVOKE_SELECTOR) {
            MultiRevocationRequest[] memory reqs =
                abi.decode(_argumentRegion(txData), (MultiRevocationRequest[]));

            uint256 total;
            for (uint256 i; i < reqs.length; ++i) {
                total += reqs[i].data.length;
            }

            uids = new bytes32[](total);
            uint256 k;
            for (uint256 i; i < reqs.length; ++i) {
                RevocationRequestData[] memory datas = reqs[i].data;
                for (uint256 j; j < datas.length; ++j) {
                    uids[k++] = datas[j].uid;
                }
            }
            return (uids, true);
        }

        return (new bytes32[](0), false);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────

    function _flatten(bytes32 schema, AttestationRequestData memory d)
        private
        pure
        returns (AttestationPayload memory)
    {
        return AttestationPayload({
            schema:         schema,
            recipient:      d.recipient,
            expirationTime: d.expirationTime,
            revocable:      d.revocable,
            refUID:         d.refUID,
            data:           d.data,
            value:          d.value
        });
    }

    /// @dev Copy `txData[4:]` — the ABI argument region — into fresh memory. Offsets inside an ABI
    ///      argument region are relative to its own start, so once the selector is stripped the
    ///      bytes are a valid standalone `abi.encode` payload.
    function _argumentRegion(bytes memory txData) private pure returns (bytes memory out) {
        require(txData.length >= 4, "EASReader: calldata shorter than a selector");
        uint256 n = txData.length - 4;
        out = new bytes(n);
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let src := add(txData, 36) // 32 length prefix + 4 selector
            let dst := add(out, 32)
            // Copies in 32-byte words. `out` was just allocated with its length rounded up to a
            // whole number of words, so the final partial word never runs past the allocation.
            for { let i := 0 } lt(i, n) { i := add(i, 32) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
        }
    }

    function _toBytes32(bytes memory b) private pure returns (bytes32 word) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            word := mload(add(b, 32))
        }
    }
}
