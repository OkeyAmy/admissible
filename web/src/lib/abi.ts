// ABI literals. Kept as TypeScript literals rather than JSON imports so that a
// missing artifact from another workspace can never break `tsc -b`.

/** IAdmissibleRegistry — frozen interface, SPEC.md §7b. */
export const REGISTRY_ABI = [
  'function attestationOf(uint64 chainKey, bytes32 uid) view returns (tuple(uint64 chainKey, bytes32 uid, bytes32 schemaUid, address attester, address recipient, uint64 sourceBlock, bytes32 sourceTxHash, uint64 mirroredAt, bool revoked, uint64 revokedAt, bool exists))',
  'function isValid(uint64 chainKey, bytes32 uid) view returns (bool)',
  'function isValidFrom(uint64 chainKey, bytes32 uid, address attester, bytes32 schemaUid) view returns (bool)',
  'function totalMirrored() view returns (uint256)',
  'function totalRevoked() view returns (uint256)',
  'function easAddress(uint64 chainKey) view returns (address)',
  'event AttestationMirrored(uint64 indexed chainKey, bytes32 indexed uid, bytes32 indexed schemaUid, address attester, address recipient, uint64 sourceBlock, bytes32 queryId)',
  'event AttestationRevoked(uint64 indexed chainKey, bytes32 indexed uid, uint64 revokedAt, bytes32 queryId)',
] as const;

/**
 * Submission surface of the deployed AttestationRegistry.
 *
 * `execute` is the permissionless ASCBase entrypoint (@gluwa/asc-contracts@0.2.1,
 * SPEC §4). `submit` is the registry's own wrapper: same proof, plus the source
 * transaction hash so the stored record can carry it. Prefer `submit`.
 *
 * `previewAttested` is a pure view over the same encoded transaction: it runs
 * EASReader against the foreign receipt logs and returns exactly the events the
 * registry would store — an on-chain read that costs nothing and needs no key.
 */
export const REGISTRY_WRITE_ABI = [
  'function submit(uint8 action, uint64 chainKey, uint64 blockHeight, bytes32 sourceTxHash, bytes encodedTransaction, tuple(bytes32 root, tuple(bytes32 hash, bool isLeft)[] siblings) merkleProof, tuple(bytes32 lowerEndpointDigest, bytes32[] roots) continuityProof) returns (bool success)',
  'function execute(uint8 action, uint64 chainKey, uint64 blockHeight, bytes encodedTransaction, bytes32 merkleRoot, tuple(bytes32 hash, bool isLeft)[] siblings, bytes32 lowerEndpointDigest, bytes32[] continuityRoots) returns (bool success)',
  'function previewAttested(uint64 chainKey, bytes encodedTransaction) view returns (tuple(address emitter, address recipient, address attester, bytes32 schemaUid, bytes32 uid)[] events)',
  'function previewRevoked(uint64 chainKey, bytes encodedTransaction) view returns (tuple(address emitter, address recipient, address attester, bytes32 schemaUid, bytes32 uid)[] events)',
  'function decodeForeignCalldata(bytes encodedTransaction) pure returns (tuple(bytes32 schema, address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value)[] payloads, bool ok)',
  'function isQueryProcessed(bytes32 queryId) view returns (bool)',
  'function VERIFIER() view returns (address)',
] as const;

/** Kept under the old name so existing imports keep resolving. */
export const ASC_EXECUTE_ABI = REGISTRY_WRITE_ABI;

/**
 * ChainInfo precompile 0x…0fd3. Two fragments lifted from the ABI shipped in
 * @gluwa/usc-sdk@0.18.0 (dist/chain-info/chain_info.json) so the browser can
 * read the attested height straight off the precompile with no bundled SDK.
 */
export const CHAIN_INFO_ABI = [
  'function get_latest_attestation_height_and_hash(uint64 chainKey) view returns (tuple(uint64 height, bytes32 hash, bool isAttestation, bool exists) result)',
  'function is_height_attested(uint64 chainKey, uint64 height) view returns (bool isAttested)',
  'function get_supported_chains() view returns (tuple(uint64 chainKey, uint64 chainId, bytes chainName, uint32 chainEncoding)[] chains)',
] as const;

/** EAS Attested/Revoked, for decoding logs recovered from foreign calldata. */
export const EAS_EVENT_ABI = [
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
  'event Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
] as const;

export const MIRROR_ACTION = 0;
export const REVOKE_ACTION = 1;
