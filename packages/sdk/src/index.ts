/**
 * @admissible/sdk — Ethereum attestations, admissible on Creditcoin.
 *
 * Mirror any Ethereum Attestation Service attestation into a Creditcoin smart
 * contract through the Attestcoin Protocol: no oracle, no bridge, no new
 * signature. The attestation is proved, not re-asserted.
 */

/* ---------- the frozen interface (SPEC.md §7b) ---------- */
export type {
  ChainKey,
  MirroredAttestation,
  MirrorStage,
  MirrorProgress,
} from './types.js';

/* ---------- everything additive ---------- */
export type {
  DiffRow,
  EasAttestation,
  MirrorOptions,
  MirrorResult,
  MirrorStatus,
  ProofSummary,
  RegistryAction,
  ResolvedUid,
  VerifyOutcome,
  VerifyReport,
} from './types.js';
export { MIRROR_ACTION, REVOKE_ACTION } from './types.js';

/* ---------- configuration: verified defaults, env only overrides ---------- */
export {
  BLOCK_PROVER_PRECOMPILE,
  CHAIN_INFO_PRECOMPILE,
  CHAIN_KEYS,
  CREDITCOIN_CHAIN_ID,
  CREDITCOIN_EXPLORER,
  CREDITCOIN_RPC,
  DEFAULT_REGISTRY_ADDRESS,
  EAS_SELECTORS,
  EAS_TOPICS,
  MAX_BATCH_BLOCK_SPAN,
  MAX_BATCH_PROOFS,
  PROVER_URL,
  SOURCE_CHAINS,
  isChainKey,
  readDeployments,
  repoRoot,
  resolveEasscanUrl,
  resolveEndpoints,
  resolveSourceRpc,
  sourceChain,
} from './config.js';
export type { Deployments, Endpoints, SourceChain } from './config.js';

/* ---------- easscan ---------- */
export {
  EasQueryError,
  detectChainKey,
  easscanLink,
  getAttestation,
  groupByTx,
  hydrateBlocks,
  listByTxid,
  listBySchema,
  listRecent,
  listRevoked,
  listSchemas,
  parseUid,
  resolveUid,
  sourceHead,
} from './eas.js';
export type { EasOptions, ListOptions, TxGroup } from './eas.js';

/* ---------- Attestcoin Protocol ---------- */
export {
  ProverError,
  attestedHeight,
  computeQueryId,
  flattenBatch,
  getBatchProof,
  getProof,
  isRetryableProverError,
  makeChainInfoProvider,
  makeProofBuilder,
  onchainAttestedHeight,
  planBatches,
  summariseProof,
  waitUntilAttested,
} from './attestcoin.js';
export type {
  BatchContinuityResponse,
  BatchProofAttempt,
  ContinuityResponse,
  ProofAttempt,
  ProofBuilder,
} from './attestcoin.js';

/* ---------- registry ---------- */
export {
  REGISTRY_ABI_FRAGMENT,
  RegistryNotDeployedError,
  deploymentsPath,
  getRegistry,
  registryAbi,
  registryAbiSource,
  reloadRegistryAbi,
} from './registry.js';
export type { RegistryHandle } from './registry.js';

/* ---------- read the registry ---------- */
export {
  emptyRecord,
  filterUnmirrored,
  isQueryProcessed,
  isValid,
  isValidFrom,
  resolve,
  resolveOrNull,
  totals,
} from './resolve.js';
export type { RegistryTotals, ResolveOptions } from './resolve.js';

/* ---------- submission plumbing ---------- */
export { NonceAllocator, accountForReceipt, formatCtc, planGas, waitForReceipt } from './submit.js';
export type { GasPlan, SubmissionAccounting } from './submit.js';

/* ---------- the pipeline ---------- */
export {
  AttestationNotFoundError,
  OffchainAttestationError,
  mirror,
  mirrorBatch,
  mirrorRevocation,
  mirrorSchema,
  mirrorTransaction,
  submitProof,
} from './mirror.js';
export type {
  BatchProgress,
  MirrorBatchOptions,
  MirrorBatchResult,
  MirrorSchemaOptions,
  MirrorSchemaResult,
} from './mirror.js';

/* ---------- verify ---------- */
export { isAdmissible, verify } from './verify.js';
export type { VerifyOptions } from './verify.js';
