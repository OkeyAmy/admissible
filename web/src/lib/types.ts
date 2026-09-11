// Mirror of the frozen TypeScript interface in SPEC.md §7b.
// When @vouchsafe/sdk lands these types are structurally identical, so swapping
// the import is a one-line change in web/src/lib/mirror.ts.

export type ChainKey = 1 | 3;

export interface MirroredAttestation {
  chainKey: ChainKey;
  uid: string;
  schemaUid: string;
  attester: string;
  recipient: string;
  sourceBlock: number;
  sourceTxHash: string;
  mirroredAt: number;
  revoked: boolean;
  revokedAt: number;
  exists: boolean;
}

export type MirrorStage =
  | 'resolving'
  | 'awaiting-attestation'
  | 'building-proof'
  | 'submitting'
  | 'mirrored'
  | 'failed';

export interface MirrorProgress {
  stage: MirrorStage;
  attestedHeight?: number;
  targetBlock?: number;
  continuityRoots?: number;
  merkleSiblings?: number;
  creditcoinTxHash?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Web-local extensions. These carry the extra facts the proof theatre puts on
// screen (source tx hash, tx index, retry reason). They are additive: anything
// consuming plain MirrorProgress still works.
// ---------------------------------------------------------------------------

export interface MirrorProgressDetail extends MirrorProgress {
  /** The Ethereum transaction the UID was written in. */
  sourceTxHash?: string;
  /** Position of that transaction inside its block. */
  txIndex?: number;
  /** Merkle root the proof commits to. */
  merkleRoot?: string;
  /** Lower endpoint digest of the continuity proof. */
  lowerEndpointDigest?: string;
  /** Set while the prover is refusing because of the reorg-protection window. */
  waitingForConfirmations?: string;
  /** True when the record was already present in the registry (read-only path). */
  alreadyMirrored?: boolean;
  /** Number of bytes of foreign transaction the proof carries. */
  txBytesLength?: number;
  /** Milliseconds spent producing the proof. */
  proofLatencyMs?: number;
  /** True when the flow stopped because no signer is configured in the browser. */
  needsSigner?: boolean;
  /**
   * What the deployed registry says it would store for this proof, read back
   * from previewAttested() — a real eth_call against the real contract.
   */
  preview?: PreviewEvent[];
  /** The dedupe key ASCBase derives: keccak(chainKey, blockHeight, txIndex). */
  queryId?: string;
  /** True when that queryId has already been processed on Creditcoin. */
  queryProcessed?: boolean;
}

export interface PreviewEvent {
  emitter: string;
  recipient: string;
  attester: string;
  schemaUid: string;
  uid: string;
}

export interface EasAttestation {
  id: string;
  txid: string;
  time: number;
  attester: string;
  recipient: string;
  schemaId: string;
  revoked: boolean;
  revocationTime: number;
  isOffchain?: boolean;
  data?: string;
}

export interface ProofBundle {
  chainKey: number;
  headerNumber: number;
  txIndex: number;
  txHash: string;
  txBytes: string;
  continuityProof: { lowerEndpointDigest: string; roots: string[] };
  merkleProof: { root: string; siblings: { hash: string; isLeft: boolean }[] };
  cached?: boolean;
  generatedAt?: string;
}

export interface ReceiptRow {
  easUid: string;
  sourceChainKey: number;
  sourceTxHash: string;
  sourceBlock: number;
  continuityRoots?: number;
  merkleSiblings?: number;
  queryId?: string;
  batchIndex?: number;
  creditcoinTxHash?: string;
  gasUsed?: string;
  ctcCost?: string;
  proofLatencyMs?: number;
  submitLatencyMs?: number;
  status: string;
  timestamp: string;
  error?: string;
}
