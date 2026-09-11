// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice One Ethereum EAS attestation, mirrored onto Creditcoin through the Attestcoin Protocol.
/// @dev    Keyed on (chainKey, uid) everywhere. A UID is only unique *within* one EAS deployment;
///         Sepolia (chainKey 1) and Ethereum mainnet (chainKey 3) are different deployments and
///         their UID spaces are allowed to collide. Never key on `uid` alone.
struct MirroredAttestation {
    uint64  chainKey;        // 1 = Sepolia, 3 = Ethereum Mainnet
    bytes32 uid;             // the EAS attestation UID
    bytes32 schemaUid;
    address attester;
    address recipient;
    uint64  sourceBlock;     // Ethereum block the attestation was written in
    bytes32 sourceTxHash;
    uint64  mirroredAt;      // Creditcoin block.timestamp when mirrored
    bool    revoked;
    uint64  revokedAt;       // 0 if not revoked
    bool    exists;
}

/// @title  IAdmissibleRegistry
/// @notice The frozen read surface of the Admissible registry (SPEC.md §7b). The SDK, the worker
///         and the web app are all built against exactly these signatures.
interface IAdmissibleRegistry {
    /// @notice Emitted once per `Attested` log recovered from a proven Ethereum transaction.
    /// @param chainKey    Attestcoin source-chain key (1 = Sepolia, 3 = mainnet).
    /// @param uid         EAS attestation UID.
    /// @param schemaUid   EAS schema UID.
    /// @param attester    Address that wrote the attestation on Ethereum.
    /// @param recipient   Subject of the attestation.
    /// @param sourceBlock Ethereum block height the attesting transaction was mined in.
    /// @param queryId     Attestcoin query id — keccak(chainKey, blockHeight, txIndex). This, not
    ///                    `sourceTxHash`, is the proven identity of the source transaction.
    event AttestationMirrored(
        uint64 indexed chainKey, bytes32 indexed uid, bytes32 indexed schemaUid,
        address attester, address recipient, uint64 sourceBlock, bytes32 queryId
    );

    /// @notice Emitted once per `Revoked` log recovered from a proven Ethereum transaction.
    /// @param chainKey  Attestcoin source-chain key.
    /// @param uid       EAS attestation UID being revoked.
    /// @param revokedAt Creditcoin `block.timestamp` at which the revocation was recorded.
    /// @param queryId   Attestcoin query id of the proven revoking transaction.
    event AttestationRevoked(uint64 indexed chainKey, bytes32 indexed uid, uint64 revokedAt, bytes32 queryId);

    /// @notice Full record for a mirrored attestation. `exists == false` if never mirrored.
    /// @param chainKey Attestcoin source-chain key (1 = Sepolia, 3 = mainnet).
    /// @param uid      EAS attestation UID.
    /// @return The stored record; an all-zero struct when nothing is known about (chainKey, uid).
    function attestationOf(uint64 chainKey, bytes32 uid) external view returns (MirroredAttestation memory);

    /// @notice True only if mirrored AND not revoked. This is the function other dApps call.
    /// @param chainKey Attestcoin source-chain key.
    /// @param uid      EAS attestation UID.
    /// @return True when the attestation is known to this registry and has not been revoked.
    function isValid(uint64 chainKey, bytes32 uid) external view returns (bool);

    /// @notice True if the attestation is mirrored and its attester and schema match.
    /// @dev    Revocation is included in the check: a revoked attestation is never `isValidFrom`.
    /// @param chainKey  Attestcoin source-chain key.
    /// @param uid       EAS attestation UID.
    /// @param attester  Required issuer address.
    /// @param schemaUid Required EAS schema UID.
    /// @return True when the attestation is valid and was issued by `attester` under `schemaUid`.
    function isValidFrom(uint64 chainKey, bytes32 uid, address attester, bytes32 schemaUid) external view returns (bool);

    /// @notice Total attestations mirrored, for the receipts/stats surface.
    /// @return Cumulative count of distinct (chainKey, uid) pairs mirrored.
    function totalMirrored() external view returns (uint256);

    /// @notice Total attestations recorded as revoked.
    /// @return Cumulative count of distinct (chainKey, uid) pairs revoked.
    function totalRevoked() external view returns (uint256);

    /// @notice Canonical EAS address this registry accepts logs from, per chainKey.
    /// @param chainKey Attestcoin source-chain key.
    /// @return The EAS deployment address; `address(0)` when the chainKey is unsupported.
    function easAddress(uint64 chainKey) external view returns (address);
}
