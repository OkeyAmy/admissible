// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

import {IAdmissibleRegistry, MirroredAttestation} from "./IAdmissibleRegistry.sol";
import {EASReader} from "./EASReader.sol";

/// @title  AttestationRegistry
/// @notice Admissible's readability Application Smart Contract. It turns a *proven* Ethereum
///         transaction into on-chain, queryable Creditcoin state: every EAS attestation that
///         transaction created (or revoked) becomes a `MirroredAttestation`.
///
/// @dev    Attribution: extends `ASCBase` from `@gluwa/asc-contracts@0.2.1` and follows the
///         readability-ASC shape of the official `attestcoin-protocol-examples` (`ASCMinter.sol`,
///         `ASCLoanManager.sol`): override `_processAndEmitEvent`, decode the receipt with
///         `EvmV1Decoder`, write app state. Everything below `_processAndEmitEvent` is new work.
///
/// ── Three Attestcoin-specific facts this contract is built around ───────────────────────────
///
///  (1) **The precompile does not check transaction success.** `verifyAndEmit` proves *inclusion*
///      and *continuity*: this transaction is genuinely in this Ethereum block, and that block is
///      genuinely on the attested chain. A reverted transaction is still included in its block and
///      still has a receipt. Ethereum guarantees a reverted transaction emits no logs, but the
///      prover hands us the receipt fields verbatim and we are the ones who decide what to trust —
///      so `require(receipt.receiptStatus == 1)` is mandatory and is asserted before any decoding.
///
///  (2) **Dedupe is per transaction, not per UID.** `ASCBase._computeQueryId` hashes
///      (chainKey, blockHeight, txIndex). One `multiAttest` transaction is ONE query carrying MANY
///      attestations — real mainnet EAS volume is dominated by `multiAttest`. Therefore
///      `_processAndEmitEvent` MUST loop every matching log and write N registry entries from a
///      single `execute()`. Writing only `logs[0]` would silently drop the rest, and the drop would
///      be invisible: the query is marked processed, so the transaction can never be re-submitted.
///
///  (3) **`execute()` does not forward `chainKey` to `_processAndEmitEvent`.** See {submit}.
///
/// ── Known scope limits, stated rather than hidden ───────────────────────────────────────────
///
///  - A source transaction that contains BOTH `Attested` and `Revoked` logs can only be processed
///    under one `action`, because `ASCBase` retires the queryId after the first successful call.
///    In practice EAS attest and revoke transactions are disjoint. The alternative — processing
///    both event types on every submission — would break the frozen action discriminator in
///    SPEC.md §7b, so the action-based dispatch is kept and the limit documented here.
///  - `sourceTxHash` is caller-supplied metadata, NOT proven. See {submit}.
contract AttestationRegistry is ASCBase, IAdmissibleRegistry {
    using EASReader for EvmV1Decoder.ReceiptFields;

    /// @notice Action discriminator: decode `Attested` logs and mirror them.
    uint8 public constant ACTION_MIRROR = 0;
    /// @notice Action discriminator: decode `Revoked` logs and flip the records to revoked.
    uint8 public constant ACTION_REVOKE = 1;

    /// @notice Attestcoin source-chain key for Ethereum Sepolia.
    uint64 public constant CHAIN_KEY_SEPOLIA = 1;
    /// @notice Attestcoin source-chain key for Ethereum mainnet.
    uint64 public constant CHAIN_KEY_MAINNET = 3;

    /// @notice Owner, able to register EAS addresses for future source chains.
    address public owner;

    /// @inheritdoc IAdmissibleRegistry
    mapping(uint64 => address) public override easAddress;

    /// @inheritdoc IAdmissibleRegistry
    uint256 public override totalMirrored;

    /// @inheritdoc IAdmissibleRegistry
    uint256 public override totalRevoked;

    /// @dev (chainKey => uid => record). Never keyed on uid alone: mainnet and Sepolia are separate
    ///      EAS deployments and their UID spaces may collide.
    mapping(uint64 => mapping(bytes32 => MirroredAttestation)) private _attestations;

    /// @dev Context that `ASCBase.execute` verifies but does not forward. Written by {submit}
    ///      immediately before the self-call and cleared immediately after, so it is only ever
    ///      non-zero inside a single {submit} call frame.
    uint64  private _pendingChainKey;
    uint64  private _pendingBlockHeight;
    bytes32 private _pendingSourceTxHash;

    /// @notice Emitted when the attestation body — which the `Attested` event does NOT carry — is
    ///         recovered by ABI-decoding the proven Ethereum calldata.
    /// @param chainKey       Attestcoin source-chain key.
    /// @param uid            EAS attestation UID this payload belongs to.
    /// @param refUID         Referenced attestation UID (`0x0` if none).
    /// @param expirationTime EAS expiration timestamp (`0` = never).
    /// @param revocable      Whether EAS itself marks the attestation revocable.
    /// @param data           Schema-encoded attestation body, byte-for-byte as executed on Ethereum.
    event AttestationPayloadRecovered(
        uint64 indexed chainKey,
        bytes32 indexed uid,
        bytes32 refUID,
        uint64 expirationTime,
        bool revocable,
        bytes data
    );

    /// @notice Emitted when the owner registers or changes an EAS address for a chainKey.
    /// @param chainKey Attestcoin source-chain key.
    /// @param eas      Canonical EAS deployment address for that chain.
    event EasAddressSet(uint64 indexed chainKey, address indexed eas);

    /// @notice Emitted on ownership transfer.
    /// @param previousOwner Prior owner.
    /// @param newOwner      New owner.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Admissible: not owner");
        _;
    }

    /// @notice Deploys the registry with the two canonical EAS deployments pre-seeded.
    /// @dev    Seeding in the constructor means the security-critical addresses are correct from
    ///         block zero; they are owner-settable only so future Attestcoin source chains can be
    ///         added without a redeploy.
    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        _setEasAddress(CHAIN_KEY_SEPOLIA, 0xC2679fBD37d54388Ce493F1DB75320D236e1815e);
        _setEasAddress(CHAIN_KEY_MAINNET, 0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Entry point
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Submit a proven Ethereum transaction and mirror (or revoke) every EAS attestation
    ///         inside it. Permissionless — anyone, including a judge, can call this.
    ///
    /// @dev    THE `chainKey` PROBLEM AND ITS SOLUTION.
    ///
    ///         `ASCBase.execute` is `external` and **not** `virtual`, so it cannot be overridden,
    ///         and its signature hands `_processAndEmitEvent` only `(action, queryId,
    ///         encodedTransaction)`. But this registry must know the source `chainKey` (to pick the
    ///         canonical EAS address and to key storage) and the `blockHeight`.
    ///
    ///         Solution: this thin external wrapper records the context, then performs a *self-call*
    ///         into the inherited `execute`. The wrapper deliberately does **not** re-implement any
    ///         part of `execute` — verification, the `processedQueries` dedupe map and the queryId
    ///         derivation are still the base class's, unmodified, so the per-transaction dedupe
    ///         guarantee is exactly as strong as it was. `execute` remains callable directly and
    ///         still consumes queryIds from the same map; a direct call simply reverts inside
    ///         `_processAndEmitEvent` because no context was set, which is caught before any state
    ///         is written (the whole transaction reverts, including the `processedQueries` write).
    ///
    ///         `sourceTxHash` is stored as display metadata and is **not proven**. The prover's
    ///         `txBytes` is an ABI re-encoding, not the original RLP, and this decoder exposes
    ///         type-specific fields only for tx types 0 and 2 — so the original transaction hash
    ///         cannot be re-derived on-chain for all types. The *proven* identity of the source
    ///         transaction is `queryId = keccak(chainKey, blockHeight, txIndex)`, which is emitted
    ///         in every event. A spoofed `sourceTxHash` surfaces immediately as a FAIL in the
    ///         `admissible verify` field-by-field diff against easscan.
    ///
    /// @param action             0 = Mirror (`Attested` logs), 1 = Revoke (`Revoked` logs).
    /// @param chainKey           Attestcoin source-chain key (1 = Sepolia, 3 = mainnet).
    /// @param blockHeight        Ethereum block height the transaction was mined in.
    /// @param sourceTxHash       Ethereum transaction hash — unproven display metadata (see above).
    /// @param encodedTransaction Prover `txBytes`.
    /// @param merkleProof        `{root, siblings}` — exactly the prover response's `merkleProof`.
    /// @param continuityProof    `{lowerEndpointDigest, roots}` — the prover's `continuityProof`.
    /// @return success           True on success; reverts otherwise.
    function submit(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        bytes32 sourceTxHash,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof
    ) external returns (bool success) {
        require(chainKey != 0, "Admissible: chainKey must be non-zero");
        require(easAddress[chainKey] != address(0), "Admissible: unsupported chainKey");

        _pendingChainKey = chainKey;
        _pendingBlockHeight = blockHeight;
        _pendingSourceTxHash = sourceTxHash;

        success = this.execute(
            action,
            chainKey,
            blockHeight,
            encodedTransaction,
            merkleProof.root,
            merkleProof.siblings,
            continuityProof.lowerEndpointDigest,
            continuityProof.roots
        );

        _pendingChainKey = 0;
        _pendingBlockHeight = 0;
        _pendingSourceTxHash = bytes32(0);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // ASCBase hook
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ASCBase
    /// @dev Runs only after the precompile has verified inclusion + continuity and after ASCBase
    ///      has retired the queryId.
    function _processAndEmitEvent(
        uint8 action,
        bytes32 queryId,
        bytes memory encodedTransaction
    ) internal override {
        uint64 chainKey = _pendingChainKey;
        require(chainKey != 0, "Admissible: call submit(), not execute()");

        address eas = easAddress[chainKey];
        require(eas != address(0), "Admissible: unsupported chainKey");

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);

        // ATTESTCOIN GOTCHA #1: the block-prover precompile proves inclusion, not success. A
        // reverted Ethereum transaction is still provably in its block. Mirroring one would record
        // attestations that never took effect on Ethereum.
        require(receipt.receiptStatus == 1, "Admissible: source transaction did not succeed");

        if (action == ACTION_MIRROR) {
            _mirror(chainKey, queryId, receipt, encodedTransaction, eas);
        } else if (action == ACTION_REVOKE) {
            _revoke(chainKey, queryId, receipt, eas);
        } else {
            revert("Admissible: unknown action");
        }
    }

    function _mirror(
        uint64 chainKey,
        bytes32 queryId,
        EvmV1Decoder.ReceiptFields memory receipt,
        bytes memory encodedTransaction,
        address eas
    ) private {
        EASReader.EASEvent[] memory events = EASReader.readAttested(receipt, eas);
        require(events.length > 0, "Admissible: no Attested logs in transaction");

        // DEPTH PATH: recover the attestation bodies from the proven foreign calldata. Guarded by
        // try/catch and by a length match, so a router-wrapped transaction or an unusual encoding
        // degrades to "logs only" instead of blocking the mirror.
        (EASReader.AttestationPayload[] memory payloads, bool recovered) =
            _tryRecoverPayloads(encodedTransaction, events.length);

        // ATTESTCOIN GOTCHA #2: one query, many attestations. Loop everything.
        _writeAll(chainKey, queryId, events, payloads, recovered);
    }

    /// @dev The N-entries-from-one-query loop. Split out of `_mirror` to keep the stack shallow.
    function _writeAll(
        uint64 chainKey,
        bytes32 queryId,
        EASReader.EASEvent[] memory events,
        EASReader.AttestationPayload[] memory payloads,
        bool recovered
    ) private {
        for (uint256 i; i < events.length; ++i) {
            if (!_writeMirror(chainKey, queryId, events[i])) continue;
            if (recovered) _emitPayload(chainKey, events[i].uid, payloads[i]);
        }
    }

    /// @dev Isolated so the dynamic-`bytes` event encoding does not deepen the caller's stack.
    function _emitPayload(uint64 chainKey, bytes32 uid, EASReader.AttestationPayload memory p) private {
        emit AttestationPayloadRecovered(chainKey, uid, p.refUID, p.expirationTime, p.revocable, p.data);
    }

    /// @dev Writes one attestation record. Split out of `_mirror` to keep the stack shallow.
    ///      Returns false when the attestation was already mirrored (idempotent no-op).
    function _writeMirror(uint64 chainKey, bytes32 queryId, EASReader.EASEvent memory ev)
        private
        returns (bool written)
    {
        MirroredAttestation storage a = _attestations[chainKey][ev.uid];

        // `mirroredAt != 0` is the "already mirrored" sentinel, not `exists`: a revocation can
        // legitimately arrive before its attestation is mirrored, leaving a record with
        // exists == true and mirroredAt == 0. Keying on `exists` here would permanently block
        // that attestation from ever being mirrored.
        if (a.mirroredAt != 0) return false;

        a.chainKey     = chainKey;
        a.uid          = ev.uid;
        a.schemaUid    = ev.schemaUid;
        a.attester     = ev.attester;
        a.recipient    = ev.recipient;
        a.sourceBlock  = _pendingBlockHeight;
        a.sourceTxHash = _pendingSourceTxHash;
        a.mirroredAt   = uint64(block.timestamp);
        a.exists       = true;
        // a.revoked / a.revokedAt are deliberately preserved: an out-of-order revocation stays.

        unchecked { ++totalMirrored; }

        emit AttestationMirrored(
            chainKey, ev.uid, ev.schemaUid, ev.attester, ev.recipient, _pendingBlockHeight, queryId
        );

        return true;
    }

    function _revoke(
        uint64 chainKey,
        bytes32 queryId,
        EvmV1Decoder.ReceiptFields memory receipt,
        address eas
    ) private {
        EASReader.EASEvent[] memory events = EASReader.readRevoked(receipt, eas);
        require(events.length > 0, "Admissible: no Revoked logs in transaction");

        for (uint256 i; i < events.length; ++i) {
            EASReader.EASEvent memory ev = events[i];
            MirroredAttestation storage a = _attestations[chainKey][ev.uid];

            if (a.revoked) continue;

            if (!a.exists) {
                // Revocation proven before the attestation itself was mirrored. Record a tombstone
                // from the Revoked log's own topics — they carry recipient, attester and schema —
                // so `isValid` is false from this moment on. `mirroredAt` stays 0, which lets a
                // later Mirror submission fill in the remaining fields without resurrecting it.
                a.chainKey  = chainKey;
                a.uid       = ev.uid;
                a.schemaUid = ev.schemaUid;
                a.attester  = ev.attester;
                a.recipient = ev.recipient;
                a.exists    = true;
            }

            a.revoked   = true;
            a.revokedAt = uint64(block.timestamp);

            unchecked { ++totalRevoked; }

            emit AttestationRevoked(chainKey, ev.uid, a.revokedAt, queryId);
        }
    }

    function _tryRecoverPayloads(bytes memory encodedTransaction, uint256 expected)
        private
        view
        returns (EASReader.AttestationPayload[] memory payloads, bool recovered)
    {
        try this.decodeForeignCalldata(encodedTransaction) returns (
            EASReader.AttestationPayload[] memory p,
            bool ok
        ) {
            // Only pair payloads with logs when the counts agree. EAS emits one `Attested` log per
            // request in request order, so equal counts make index i ↔ log i sound; unequal counts
            // mean the transaction did something we do not model, and we decline to guess.
            if (ok && p.length == expected) {
                return (p, true);
            }
        } catch {
            // Unparseable foreign calldata must never block a mirror that the logs already prove.
        }
        return (new EASReader.AttestationPayload[](0), false);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views — the frozen interface
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IAdmissibleRegistry
    function attestationOf(uint64 chainKey, bytes32 uid)
        external
        view
        override
        returns (MirroredAttestation memory)
    {
        return _attestations[chainKey][uid];
    }

    /// @inheritdoc IAdmissibleRegistry
    function isValid(uint64 chainKey, bytes32 uid) public view override returns (bool) {
        MirroredAttestation storage a = _attestations[chainKey][uid];
        return a.exists && !a.revoked;
    }

    /// @inheritdoc IAdmissibleRegistry
    function isValidFrom(uint64 chainKey, bytes32 uid, address attester, bytes32 schemaUid)
        external
        view
        override
        returns (bool)
    {
        MirroredAttestation storage a = _attestations[chainKey][uid];
        return a.exists && !a.revoked && a.attester == attester && a.schemaUid == schemaUid;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views — decoding helpers for the SDK (free to call off-chain)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice ABI-decode the EAS attestation bodies out of a proven transaction's foreign calldata.
    /// @dev    `public` so the registry can call it through `this.` inside a `try/catch`; the SDK
    ///         calls it with `eth_call` to preview a transaction before paying to submit it.
    /// @param encodedTransaction Prover `txBytes`.
    /// @return payloads Flattened attestation bodies, in EAS emission order.
    /// @return ok       False when the transaction's calldata is not an EAS attest call.
    function decodeForeignCalldata(bytes memory encodedTransaction)
        public
        pure
        returns (EASReader.AttestationPayload[] memory payloads, bool ok)
    {
        EvmV1Decoder.CommonTxFields memory common = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        return EASReader.decodeAttestCalldata(common.data);
    }

    /// @notice ABI-decode the revoked UIDs out of a proven transaction's foreign calldata.
    /// @param encodedTransaction Prover `txBytes`.
    /// @return uids Revoked attestation UIDs, in EAS emission order.
    /// @return ok   False when the transaction's calldata is not an EAS revoke call.
    function decodeForeignRevokeCalldata(bytes memory encodedTransaction)
        public
        pure
        returns (bytes32[] memory uids, bool ok)
    {
        EvmV1Decoder.CommonTxFields memory common = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        return EASReader.decodeRevokeCalldata(common.data);
    }

    /// @notice Preview every `Attested` log a proven transaction would mirror, without submitting.
    /// @dev    Applies the same emitter assertion and shape validation as a real submission, so a
    ///         spoofed-EAS transaction fails here too — the SDK can reject it before spending CTC.
    /// @param chainKey           Attestcoin source-chain key.
    /// @param encodedTransaction Prover `txBytes`.
    /// @return events            The `Attested` logs, decoded.
    function previewAttested(uint64 chainKey, bytes memory encodedTransaction)
        external
        view
        returns (EASReader.EASEvent[] memory events)
    {
        address eas = easAddress[chainKey];
        require(eas != address(0), "Admissible: unsupported chainKey");
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        require(receipt.receiptStatus == 1, "Admissible: source transaction did not succeed");
        return EASReader.readAttested(receipt, eas);
    }

    /// @notice Preview every `Revoked` log a proven transaction would apply, without submitting.
    /// @param chainKey           Attestcoin source-chain key.
    /// @param encodedTransaction Prover `txBytes`.
    /// @return events            The `Revoked` logs, decoded.
    function previewRevoked(uint64 chainKey, bytes memory encodedTransaction)
        external
        view
        returns (EASReader.EASEvent[] memory events)
    {
        address eas = easAddress[chainKey];
        require(eas != address(0), "Admissible: unsupported chainKey");
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        require(receipt.receiptStatus == 1, "Admissible: source transaction did not succeed");
        return EASReader.readRevoked(receipt, eas);
    }

    /// @notice Whether a given Attestcoin query has already been consumed by this registry.
    /// @dev    Thin alias over `ASCBase.processedQueries` for SDK readability.
    /// @param queryId keccak(chainKey, blockHeight, txIndex).
    /// @return True if the query was already processed.
    function isQueryProcessed(bytes32 queryId) external view returns (bool) {
        return processedQueries[queryId];
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Register or replace the canonical EAS address for an Attestcoin source chain.
    /// @dev    Only needed when Attestcoin adds a source chain. Sepolia and mainnet are seeded in
    ///         the constructor so the security-critical values are never absent.
    /// @param chainKey Attestcoin source-chain key.
    /// @param eas      Canonical EAS deployment address on that chain.
    function setEasAddress(uint64 chainKey, address eas) external onlyOwner {
        require(chainKey != 0, "Admissible: chainKey must be non-zero");
        require(eas != address(0), "Admissible: eas must be non-zero");
        _setEasAddress(chainKey, eas);
    }

    /// @notice Transfer ownership of the registry.
    /// @param newOwner The new owner; cannot be the zero address.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Admissible: new owner is zero");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _setEasAddress(uint64 chainKey, address eas) private {
        easAddress[chainKey] = eas;
        emit EasAddressSet(chainKey, eas);
    }
}
