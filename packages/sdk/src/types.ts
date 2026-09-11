/**
 * The frozen interface — SPEC.md §7b.
 *
 * The four declarations below (`ChainKey`, `MirroredAttestation`, `MirrorStage`,
 * `MirrorProgress`) are the contract shared by the Solidity registry, this SDK,
 * the worker and the web app. They are reproduced verbatim from the spec.
 */

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
  | 'resolving' // UID → source tx via easscan
  | 'awaiting-attestation' // waiting for Attestcoin to attest the block
  | 'building-proof' // prover service
  | 'submitting' // Creditcoin tx in flight
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

/* ------------------------------------------------------------------ */
/* Everything below is additive — it does not alter the frozen shapes. */
/* ------------------------------------------------------------------ */

/** Action discriminator passed to `ASCBase.execute(uint8 action, …)`. */
export const MIRROR_ACTION = 0;
export const REVOKE_ACTION = 1;
export type RegistryAction = typeof MIRROR_ACTION | typeof REVOKE_ACTION;

/** A row as easscan's GraphQL returns it, normalised. */
export interface EasAttestation {
  uid: string;
  /** `null` when easscan has no L1 transaction for this UID (offchain attestations). */
  txid: string | null;
  time: number;
  attester: string;
  recipient: string;
  schemaId: string;
  revoked: boolean;
  revocationTime: number;
  isOffchain: boolean;
}

/** `resolveUid` result — the easscan row plus the source-chain coordinates. */
export interface ResolvedUid extends EasAttestation {
  chainKey: ChainKey;
  /** Source-chain block the attesting tx landed in. `null` if `txid` is null. */
  block: number | null;
  /** Index of the attesting tx within its block. `null` if `txid` is null. */
  txIndex: number | null;
}

export interface ProofSummary {
  chainKey: number;
  headerNumber: number;
  txIndex: number;
  txHash: string;
  txBytes: string;
  merkleRoot: string;
  merkleSiblings: number;
  continuityRoots: number;
  lowerEndpointDigest: string;
  cached: boolean;
}

export interface MirrorOptions {
  /** Called at every one of the five stages. The web app renders this. */
  onProgress?: (p: MirrorProgress) => void;
  /** `0` = Mirror (Attested logs), `1` = Revoke (Revoked logs). */
  action?: RegistryAction;
  /** Signer for the Creditcoin submission. Falls back to `PRIVATE_KEY` in env. */
  signer?: import('ethers').Signer;
  registryAddress?: string;
  creditcoinRpc?: string;
  proverUrl?: string;
  sourceRpc?: string;
  easscanUrl?: string;
  /** Max wall-clock to wait for the source block to be attested. Default 20 min. */
  attestationTimeoutMs?: number;
  /** Skip the on-chain `processedQueries` pre-check (the worker relies on it). */
  skipDedupeCheck?: boolean;
  /** Explicit source tx hash; skips the easscan resolve step. */
  sourceTxHash?: string;
  /** Force a gas limit instead of estimating. */
  gasLimit?: bigint;
}

export type MirrorStatus = 'mirrored' | 'already-mirrored' | 'failed';

export interface MirrorResult {
  status: MirrorStatus;
  easUid: string;
  sourceChainKey: ChainKey;
  sourceTxHash: string | null;
  sourceBlock: number | null;
  continuityRoots: number | null;
  merkleSiblings: number | null;
  queryId: string | null;
  batchIndex: number;
  creditcoinTxHash: string | null;
  gasUsed: string | null;
  ctcCost: string | null;
  /** Milliseconds spent in the prover service. Free — no CTC is spent here. */
  proofLatencyMs: number | null;
  /** Milliseconds spent submitting + mining on Creditcoin. This costs CTC. */
  submitLatencyMs: number | null;
  /** Milliseconds spent waiting for Attestcoin to attest the source block. */
  attestationWaitMs: number | null;
  /** Number of `AttestationMirrored`/`AttestationRevoked` events in the receipt. */
  attestationsWritten: number | null;
  error: string | null;
  timestamp: string;
}

export interface DiffRow {
  field: string;
  registry: string;
  easscan: string;
  match: boolean;
  /** Informational rows are shown but do not decide PASS/FAIL. */
  informational?: boolean;
}

export type VerifyOutcome = 'PASS' | 'FAIL';

export interface VerifyReport {
  uid: string;
  chainKey: ChainKey;
  outcome: VerifyOutcome;
  /** `false` when the registry has no record for `(chainKey, uid)`. */
  mirrored: boolean;
  /** `false` when easscan has no record for this UID on this chain. */
  foundOnEas: boolean;
  registryAddress: string;
  registry: MirroredAttestation | null;
  eas: ResolvedUid | null;
  rows: DiffRow[];
  /** Reasons the report failed. Empty on PASS. */
  failures: string[];
  notes: string[];
}
