import { Contract, Wallet } from 'ethers';
import { MIRROR_ACTION, REGISTRY_WRITE_ABI } from './abi';
import { DEMO_PRIVATE_KEY, PROVER_URL } from './config';
import { creditcoinProvider, locateSourceTx, readAttestedTip } from './chain';
import { fetchBySchema } from './easscan';
import { getAttestedHeight, ProverError } from './prover';
import { resolveRegistryAddress } from './registry';
import { RELAYER_URL, hasSigner, relayerReachable, submitViaRelayer } from './mirror';
import type { ChainKey, EasAttestation } from './types';

/**
 * Batch mirroring. Mirrors the SDK's `mirrorSchema(schemaUid, chainKey, …)`.
 *
 * Constraint from SPEC §4: a batch proof covers at most 10 transactions inside
 * a 1000-block range. The prover answers such a batch with ONE continuity proof
 * spanning fromHeader…toHeader plus a per-transaction merkle proof — verified
 * live against /api/v1/proof-batch-by-tx/{chainKey} on 2026-09-10. That shared
 * continuity proof is the whole reason batching is cheaper than N single mirrors.
 */

export const MAX_TXS_PER_BATCH = 10;
export const MAX_BLOCK_SPAN = 1000;

export interface BatchProofBundle {
  chainKey: number;
  fromHeader: number;
  toHeader: number;
  continuityProof: { lowerEndpointDigest: string; roots: string[] };
  merkleProofs: Record<string, Record<string, {
    txHash: string;
    txBytes: string;
    merkleProof: { root: string; siblings: { hash: string; isLeft: boolean }[] };
  }>>;
  cached?: boolean;
  generatedAt?: string;
}

export interface ResolvedTx {
  txHash: string;
  blockNumber: number;
  txIndex: number;
  uids: string[];
}

export interface PlannedBatch {
  index: number;
  txs: ResolvedTx[];
  fromBlock: number;
  toBlock: number;
  attestationCount: number;
}

export type BatchStatus = 'planned' | 'waiting' | 'proving' | 'submitting' | 'done' | 'needs-signer' | 'failed';

export interface BatchState extends PlannedBatch {
  status: BatchStatus;
  continuityRoots?: number;
  proofCount?: number;
  proofLatencyMs?: number;
  creditcoinTxHashes: string[];
  submittedCount?: number;
  error?: string;
  note?: string;
}

export interface BatchPlan {
  chainKey: ChainKey;
  schemaUid: string;
  attestations: EasAttestation[];
  onchainAttestations: number;
  offchainSkipped: number;
  txs: ResolvedTx[];
  batches: PlannedBatch[];
}

async function fetchBatchProof(chainKey: ChainKey, txHashes: string[], signal?: AbortSignal): Promise<BatchProofBundle> {
  let res: Response;
  try {
    res = await fetch(`${PROVER_URL}/api/v1/proof-batch-by-tx/${chainKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(txHashes),
      signal,
    });
  } catch (e) {
    throw new ProverError('NetworkError', (e as Error).message, 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* left null */
  }
  if (!res.ok) {
    const err = body as { code?: string; message?: string } | null;
    throw new ProverError(err?.code ?? `HTTP${res.status}`, err?.message ?? text.slice(0, 300), res.status);
  }
  return body as BatchProofBundle;
}

export function flattenBatchProof(bundle: BatchProofBundle) {
  const out: {
    headerNumber: number;
    txIndex: number;
    txHash: string;
    txBytes: string;
    merkleProof: { root: string; siblings: { hash: string; isLeft: boolean }[] };
  }[] = [];
  for (const [header, byIndex] of Object.entries(bundle.merkleProofs ?? {})) {
    for (const [txIndex, proof] of Object.entries(byIndex)) {
      out.push({ headerNumber: Number(header), txIndex: Number(txIndex), ...proof });
    }
  }
  return out.sort((a, b) => a.headerNumber - b.headerNumber || a.txIndex - b.txIndex);
}

/** Greedy packing: ≤10 transactions, ≤1000-block span, oldest first. */
export function planBatches(txs: ResolvedTx[]): PlannedBatch[] {
  const sorted = txs.slice().sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex);
  const batches: PlannedBatch[] = [];
  let current: ResolvedTx[] = [];
  for (const tx of sorted) {
    const wouldSpan = current.length ? tx.blockNumber - current[0].blockNumber : 0;
    if (current.length >= MAX_TXS_PER_BATCH || wouldSpan > MAX_BLOCK_SPAN) {
      batches.push(toBatch(batches.length, current));
      current = [];
    }
    current.push(tx);
  }
  if (current.length) batches.push(toBatch(batches.length, current));
  return batches;
}

function toBatch(index: number, txs: ResolvedTx[]): PlannedBatch {
  return {
    index,
    txs,
    fromBlock: txs[0].blockNumber,
    toBlock: txs[txs.length - 1].blockNumber,
    attestationCount: txs.reduce((n, t) => n + t.uids.length, 0),
  };
}

export interface PlanOptions {
  chainKey: ChainKey;
  schemaUid: string;
  limit: number;
  onNote?: (note: string) => void;
  signal?: AbortSignal;
}

/**
 * Pulls recent attestations for a schema from easscan, resolves the distinct
 * transactions they were written in, and packs them into submittable batches.
 */
export async function planSchemaMirror(opts: PlanOptions): Promise<BatchPlan> {
  const { chainKey, schemaUid, limit } = opts;
  opts.onNote?.('Reading recent attestations from easscan…');
  const attestations = await fetchBySchema(chainKey, schemaUid, limit);
  const onchain = attestations.filter((a) => a.txid);
  const byTx = new Map<string, string[]>();
  for (const a of onchain) {
    const list = byTx.get(a.txid) ?? [];
    list.push(a.id);
    byTx.set(a.txid, list);
  }

  const txs: ResolvedTx[] = [];
  let resolved = 0;
  for (const [txHash, uids] of byTx) {
    if (opts.signal?.aborted) break;
    resolved += 1;
    opts.onNote?.(`Locating transaction ${resolved} of ${byTx.size} on ${chainKey === 3 ? 'mainnet' : 'Sepolia'}…`);
    const located = await locateSourceTx(chainKey, txHash);
    if (!located || located.status !== 1) continue;
    txs.push({ txHash, blockNumber: located.blockNumber, txIndex: located.txIndex, uids });
  }

  return {
    chainKey,
    schemaUid,
    attestations,
    onchainAttestations: onchain.length,
    offchainSkipped: attestations.length - onchain.length,
    txs,
    batches: planBatches(txs),
  };
}

export interface RunOptions {
  plan: BatchPlan;
  onBatch: (state: BatchState) => void;
  signal?: AbortSignal;
}

export interface RunSummary {
  attestationsMirrored: number;
  attestationsProven: number;
  creditcoinTransactions: number;
  batchesCompleted: number;
  batchesFailed: number;
  elapsedMs: number;
  proofLatencies: number[];
  submitted: boolean;
  stoppedReason?: string;
}

/**
 * Executes a plan. Proof generation always runs for real — it is free and fully
 * public. Submission prefers the relayer (relayer/README.md — it holds the
 * funded key server-side), falls back to a browser-held signer if
 * VITE_DEMO_PRIVATE_KEY is set (dev-only), and otherwise each batch settles as
 * `needs-signer` — the page reports proofs built rather than claiming mirrors
 * that never happened.
 */
export async function runSchemaMirror(opts: RunOptions): Promise<RunSummary> {
  const { plan, onBatch, signal } = opts;
  const startedAt = performance.now();
  const registryAddress = await resolveRegistryAddress();

  // Decide the submission mode once, before committing a whole plan to it —
  // mixing modes mid-run would make the per-batch reporting confusing.
  let submissionMode: 'signer' | 'relayer' | 'none' = 'none';
  if (registryAddress) {
    if (hasSigner()) submissionMode = 'signer';
    else if (RELAYER_URL && (await relayerReachable(RELAYER_URL, signal))) submissionMode = 'relayer';
  }
  const canSubmit = submissionMode !== 'none';

  let attestationsMirrored = 0;
  let attestationsProven = 0;
  let creditcoinTransactions = 0;
  let batchesCompleted = 0;
  let batchesFailed = 0;
  const proofLatencies: number[] = [];

  for (const batch of plan.batches) {
    if (signal?.aborted) break;
    const state: BatchState = { ...batch, status: 'waiting', creditcoinTxHashes: [] };
    onBatch({ ...state });

    // The batch's newest block must be attested before the prover will answer —
    // checked against the prover's own cache first (that's what actually gates
    // proof-building), falling back to the ChainInfo precompile only if that
    // HTTP call itself fails, so a transient RPC hiccup can't fail the batch.
    try {
      for (;;) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        let height: number;
        try {
          height = await getAttestedHeight(plan.chainKey, signal);
        } catch {
          height = (await readAttestedTip(plan.chainKey)).height;
        }
        state.note = `attested height ${height.toLocaleString('en-US')} / target ${batch.toBlock.toLocaleString('en-US')}`;
        onBatch({ ...state });
        if (height >= batch.toBlock) break;
        await new Promise((r) => setTimeout(r, 6000));
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') break;
      state.status = 'failed';
      state.error = (e as Error).message;
      batchesFailed += 1;
      onBatch({ ...state });
      continue;
    }

    state.status = 'proving';
    state.note = undefined;
    onBatch({ ...state });

    let bundle: BatchProofBundle;
    const t0 = performance.now();
    try {
      bundle = await fetchBatchProof(plan.chainKey, batch.txs.map((t) => t.txHash), signal);
    } catch (e) {
      state.status = 'failed';
      state.error = e instanceof ProverError ? `${e.code}: ${e.message}` : (e as Error).message;
      batchesFailed += 1;
      onBatch({ ...state });
      continue;
    }
    const proofLatencyMs = performance.now() - t0;
    proofLatencies.push(proofLatencyMs);

    const proofs = flattenBatchProof(bundle);
    attestationsProven += batch.attestationCount;
    state.continuityRoots = bundle.continuityProof.roots.length;
    state.proofCount = proofs.length;
    state.proofLatencyMs = proofLatencyMs;

    if (!canSubmit) {
      state.status = 'needs-signer';
      state.note = registryAddress
        ? 'proof built · submission needs a funded signer'
        : 'proof built · registry not deployed yet';
      batchesCompleted += 1;
      onBatch({ ...state });
      continue;
    }

    state.status = 'submitting';
    onBatch({ ...state });

    try {
      let submitted = 0;

      if (submissionMode === 'signer') {
        const wallet = new Wallet(DEMO_PRIVATE_KEY, creditcoinProvider());
        const registry = new Contract(registryAddress, [...REGISTRY_WRITE_ABI], wallet);
        for (const proof of proofs) {
          if (signal?.aborted) break;
          // One shared continuity proof, one merkle proof per transaction.
          const tx = await registry.submit(
            MIRROR_ACTION,
            plan.chainKey,
            proof.headerNumber,
            proof.txHash,
            proof.txBytes,
            [proof.merkleProof.root, proof.merkleProof.siblings.map((s) => [s.hash, s.isLeft])],
            [bundle.continuityProof.lowerEndpointDigest, bundle.continuityProof.roots],
          );
          state.creditcoinTxHashes.push(tx.hash);
          creditcoinTransactions += 1;
          submitted += 1;
          state.submittedCount = submitted;
          onBatch({ ...state });
          await tx.wait();
        }
      } else {
        // Relayer path — one POST per transaction. The relayer re-derives
        // each proof itself from the prover rather than trusting the shared
        // batch continuity proof at face value (relayer/README.md — a shared
        // continuity proof spanning a block range can never equal the
        // relayer's own single-transaction re-derivation, so it is not
        // compared strictly there; what is submitted is always the
        // relayer's own re-derived, self-consistent proof).
        for (const proof of proofs) {
          if (signal?.aborted) break;
          const relayed = await submitViaRelayer(
            RELAYER_URL,
            {
              action: MIRROR_ACTION,
              chainKey: plan.chainKey,
              blockHeight: proof.headerNumber,
              sourceTxHash: proof.txHash,
              encodedTransaction: proof.txBytes,
              merkleProof: proof.merkleProof,
              continuityProof: bundle.continuityProof,
            },
            signal,
          );
          if (!relayed.ok) {
            throw new Error(`Relayer at ${RELAYER_URL} declined ${proof.txHash}: ${relayed.error ?? 'unknown error'}`);
          }
          if (relayed.creditcoinTxHash) {
            state.creditcoinTxHashes.push(relayed.creditcoinTxHash);
            creditcoinTransactions += 1;
          }
          submitted += 1;
          state.submittedCount = submitted;
          onBatch({ ...state });
        }
      }

      const mirrored = batch.txs
        .filter((t) => proofs.some((p) => p.txHash.toLowerCase() === t.txHash.toLowerCase()))
        .reduce((n, t) => n + t.uids.length, 0);
      attestationsMirrored += mirrored;
      state.status = 'done';
      batchesCompleted += 1;
      onBatch({ ...state });
    } catch (e) {
      state.status = 'failed';
      state.error = (e as Error).message;
      batchesFailed += 1;
      onBatch({ ...state });
    }
  }

  return {
    attestationsMirrored,
    attestationsProven,
    creditcoinTransactions,
    batchesCompleted,
    batchesFailed,
    elapsedMs: performance.now() - startedAt,
    proofLatencies,
    submitted: canSubmit,
    stoppedReason: canSubmit
      ? undefined
      : registryAddress
        ? 'No funded signer is configured in this browser build and no relayer is reachable.'
        : 'The registry address is not configured yet.',
  };
}
