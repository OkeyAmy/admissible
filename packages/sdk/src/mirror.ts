import { Interface } from 'ethers';

import {
  MAX_BATCH_BLOCK_SPAN,
  MAX_BATCH_PROOFS,
  attestedHeight,
  computeQueryId,
  getBatchProof,
  getProof,
  makeProofBuilder,
  planBatches,
  waitUntilAttested,
  type ContinuityResponse,
} from './attestcoin.js';
import { sourceChain } from './config.js';
import { groupByTx, hydrateBlocks, listBySchema, resolveUid, type TxGroup } from './eas.js';
import { sourceProvider } from './providers.js';
import { getRegistry, registryAbi, type RegistryHandle } from './registry.js';
import { isQueryProcessed, resolve } from './resolve.js';
import { NonceAllocator, accountForReceipt, planGas, waitForReceipt } from './submit.js';
import {
  MIRROR_ACTION,
  REVOKE_ACTION,
  type ChainKey,
  type MirrorOptions,
  type MirrorProgress,
  type MirrorResult,
  type RegistryAction,
} from './types.js';

/**
 * The pipeline: resolve → wait for attestation → build proof → submit.
 *
 * `opts.onProgress` fires at every one of the five stages defined in SPEC §7b.
 * The web app renders those stages live; nothing here may skip one.
 */

function now(): string {
  return new Date().toISOString();
}

function emptyResult(uid: string, chainKey: ChainKey): MirrorResult {
  return {
    status: 'failed',
    easUid: uid,
    sourceChainKey: chainKey,
    sourceTxHash: null,
    sourceBlock: null,
    continuityRoots: null,
    merkleSiblings: null,
    queryId: null,
    batchIndex: 0,
    creditcoinTxHash: null,
    gasUsed: null,
    ctcCost: null,
    proofLatencyMs: null,
    submitLatencyMs: null,
    attestationWaitMs: null,
    attestationsWritten: null,
    error: null,
    timestamp: now(),
  };
}

export class OffchainAttestationError extends Error {
  constructor(uid: string) {
    super(
      `Attestation ${uid} is an offchain EAS attestation — easscan records no Ethereum transaction for it, so there is nothing on L1 to prove.`,
    );
    this.name = 'OffchainAttestationError';
  }
}

export class AttestationNotFoundError extends Error {
  constructor(uid: string, chainKey: ChainKey) {
    super(`easscan has no attestation ${uid} on ${sourceChain(chainKey).name} (chainKey ${chainKey}).`);
    this.name = 'AttestationNotFoundError';
  }
}

interface Prepared {
  txHash: string;
  block: number;
  txIndex: number;
}

/**
 * Mirror one EAS attestation, identified by UID.
 *
 * `opts.action` selects the code path: `0` decodes `Attested` logs (mirror),
 * `1` decodes `Revoked` logs (revocation). A UID's revocation lives in a
 * DIFFERENT transaction from its attestation, so revocations are normally
 * driven through `mirrorTransaction(revokeTxHash, …, { action: 1 })`.
 */
export async function mirror(uid: string, chainKey: ChainKey, opts: MirrorOptions = {}): Promise<MirrorResult> {
  const progress = opts.onProgress ?? (() => {});
  const result = emptyResult(uid, chainKey);

  let prepared: Prepared;
  progress({ stage: 'resolving' });
  try {
    if (opts.sourceTxHash) {
      const resolved = await resolveTxCoordinates(opts.sourceTxHash, chainKey, opts);
      prepared = resolved;
    } else {
      const row = await resolveUid(uid, chainKey, { easscanUrl: opts.easscanUrl, sourceRpc: opts.sourceRpc });
      if (!row) throw new AttestationNotFoundError(uid, chainKey);
      if (!row.txid) throw new OffchainAttestationError(uid);
      if (row.block === null || row.txIndex === null) {
        throw new Error(
          `Source RPC returned no receipt for ${row.txid} on ${sourceChain(chainKey).name}; cannot determine the block to prove.`,
        );
      }
      prepared = { txHash: row.txid, block: row.block, txIndex: row.txIndex };
    }
  } catch (err) {
    result.error = (err as Error).message;
    result.timestamp = now();
    progress({ stage: 'failed', error: result.error });
    return result;
  }

  return mirrorPrepared(uid, chainKey, prepared, opts, result);
}

/**
 * Mirror every attestation carried by ONE source transaction. A `multiAttest`
 * transaction is one query on Creditcoin carrying many attestations, so this is
 * the unit of work — and the unit the registry dedupes on.
 */
export async function mirrorTransaction(
  txHash: string,
  chainKey: ChainKey,
  opts: MirrorOptions = {},
): Promise<MirrorResult> {
  const progress = opts.onProgress ?? (() => {});
  const result = emptyResult(txHash, chainKey);
  progress({ stage: 'resolving' });
  let prepared: Prepared;
  try {
    prepared = await resolveTxCoordinates(txHash, chainKey, opts);
  } catch (err) {
    result.error = (err as Error).message;
    progress({ stage: 'failed', error: result.error });
    return result;
  }
  return mirrorPrepared(txHash, chainKey, prepared, opts, result);
}

async function resolveTxCoordinates(txHash: string, chainKey: ChainKey, opts: MirrorOptions): Promise<Prepared> {
  const provider = sourceProvider(chainKey, opts.sourceRpc);
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error(`Source RPC has no receipt for ${txHash} on ${sourceChain(chainKey).name}.`);
    return { txHash, block: receipt.blockNumber, txIndex: receipt.index };
  } finally {
    provider.destroy();
  }
}

async function mirrorPrepared(
  label: string,
  chainKey: ChainKey,
  prepared: Prepared,
  opts: MirrorOptions,
  result: MirrorResult,
): Promise<MirrorResult> {
  const progress = opts.onProgress ?? (() => {});
  const action: RegistryAction = opts.action ?? MIRROR_ACTION;

  result.sourceTxHash = prepared.txHash;
  result.sourceBlock = prepared.block;
  result.queryId = computeQueryId(chainKey, prepared.block, prepared.txIndex);

  let registry: RegistryHandle;
  try {
    registry = getRegistry({
      registryAddress: opts.registryAddress,
      creditcoinRpc: opts.creditcoinRpc,
      signer: opts.signer,
    });
  } catch (err) {
    result.error = (err as Error).message;
    progress({ stage: 'failed', error: result.error });
    return result;
  }

  try {
    // ---- dedupe pre-check: never pay for a query the registry already has ----
    if (!opts.skipDedupeCheck) {
      const { processed } = await isQueryProcessed(chainKey, prepared.block, prepared.txIndex, { registry });
      if (processed) {
        result.status = 'already-mirrored';
        result.timestamp = now();
        progress({ stage: 'mirrored', targetBlock: prepared.block });
        return result;
      }
    }

    // ---- stage 2: wait for Attestcoin to attest the source block ----
    const builder = makeProofBuilder(chainKey, opts.proverUrl);
    const waitStarted = Date.now();
    const head = await attestedHeight(chainKey, opts.proverUrl).catch(() => -1);
    progress({ stage: 'awaiting-attestation', attestedHeight: head >= 0 ? head : undefined, targetBlock: prepared.block });

    if (head < prepared.block) {
      await waitUntilAttested(chainKey, prepared.block, {
        proverUrl: opts.proverUrl,
        builder,
        timeoutMs: opts.attestationTimeoutMs ?? 1_200_000,
        onPoll: (attested, target) => progress({ stage: 'awaiting-attestation', attestedHeight: attested, targetBlock: target }),
      });
    }
    result.attestationWaitMs = Date.now() - waitStarted;

    // ---- stage 3: build the proof (free — no CTC is spent here) ----
    progress({ stage: 'building-proof', attestedHeight: head >= 0 ? head : undefined, targetBlock: prepared.block });
    const { proof, latencyMs } = await getProof(chainKey, prepared.txHash, { proverUrl: opts.proverUrl, builder });
    result.proofLatencyMs = latencyMs;
    result.continuityRoots = proof.continuityProof.roots.length;
    result.merkleSiblings = proof.merkleProof.siblings.length;

    // The precompile's own tx index is authoritative for the dedupe key.
    if (proof.txIndex !== prepared.txIndex) {
      result.queryId = computeQueryId(chainKey, proof.headerNumber, proof.txIndex);
    }

    progress({
      stage: 'building-proof',
      targetBlock: proof.headerNumber,
      continuityRoots: result.continuityRoots,
      merkleSiblings: result.merkleSiblings,
    });

    // ---- stage 4: submit to the registry (this is what costs CTC) ----
    if (!registry.signer) {
      throw new Error('No signer. Set PRIVATE_KEY in the environment or pass opts.signer to mirror().');
    }
    progress({ stage: 'submitting', targetBlock: proof.headerNumber, continuityRoots: result.continuityRoots, merkleSiblings: result.merkleSiblings });

    const submitStarted = Date.now();
    const accounting = await submitProof(registry, action, proof, opts.gasLimit);
    result.submitLatencyMs = Date.now() - submitStarted;
    result.creditcoinTxHash = accounting.creditcoinTxHash;
    result.gasUsed = accounting.gasUsed;
    result.ctcCost = accounting.ctcCost;
    result.attestationsWritten = accounting.attestationsWritten;
    if (accounting.queryIdsFromEvents.length === 1) result.queryId = accounting.queryIdsFromEvents[0]!;

    if (accounting.status !== 1) {
      throw new Error(`Creditcoin transaction ${accounting.creditcoinTxHash} reverted (status ${accounting.status}).`);
    }

    result.status = 'mirrored';
    result.timestamp = now();
    progress({
      stage: 'mirrored',
      targetBlock: proof.headerNumber,
      continuityRoots: result.continuityRoots,
      merkleSiblings: result.merkleSiblings,
      creditcoinTxHash: accounting.creditcoinTxHash,
    });
    return result;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // "Query already processed" is a race with another submitter, not a failure.
    if (/Query already processed/i.test(message)) {
      result.status = 'already-mirrored';
      result.error = null;
      result.timestamp = now();
      progress({ stage: 'mirrored', targetBlock: prepared.block });
      return result;
    }
    result.status = 'failed';
    result.error = message;
    result.timestamp = now();
    progress({ stage: 'failed', error: message, creditcoinTxHash: result.creditcoinTxHash ?? undefined });
    return result;
  } finally {
    registry.provider.destroy();
    void label;
  }
}

/** One `execute()` call carrying one proved source transaction. */
export async function submitProof(
  registry: RegistryHandle,
  action: RegistryAction,
  proof: ContinuityResponse,
  gasLimitOverride?: bigint,
  nonce?: number,
) {
  const iface = new Interface(registryAbi());
  const args = [
    action,
    proof.chainKey,
    proof.headerNumber,
    proof.txBytes,
    proof.merkleProof.root,
    proof.merkleProof.siblings.map((s) => [s.hash, s.isLeft]),
    proof.continuityProof.lowerEndpointDigest,
    proof.continuityProof.roots,
  ];
  const data = iface.encodeFunctionData('execute', args);

  const from = await registry.signer!.getAddress();
  const gas = await planGas(registry, data, from, proof.continuityProof.roots.length, gasLimitOverride);

  const tx = await registry.contract.execute(...args, nonce === undefined ? { gasLimit: gas.gasLimit } : { gasLimit: gas.gasLimit, nonce });
  const receipt = await waitForReceipt(tx);
  return accountForReceipt(receipt, iface);
}

/* ------------------------------------------------------------------ */
/* Batch mirroring                                                      */
/* ------------------------------------------------------------------ */

export interface BatchProgress {
  batchIndex: number;
  batchCount: number;
  stage: MirrorProgress['stage'] | 'batch-proof';
  txCount: number;
  fromBlock?: number;
  toBlock?: number;
  continuityRoots?: number;
  creditcoinTxHash?: string;
  error?: string;
}

export interface MirrorBatchOptions extends Omit<MirrorOptions, 'onProgress'> {
  onProgress?: (p: MirrorProgress) => void;
  onBatchProgress?: (p: BatchProgress) => void;
  /**
   * `batch`   — one `getBatchProof` call for the whole group.
   * `single`  — one `getProof` call per transaction, issued concurrently.
   * `auto`    — `batch` when the registry exposes a batch submission entry
   *             point, `single` otherwise.
   *
   * Why `auto` matters: the BlockProver precompile accepts a shared continuity
   * proof only through its *batch* verification path. Verified live — with a
   * shared proof spanning blocks 25925431..25925820, `verifySingle` returns
   * true at the lower endpoint and reverts "Merkle root mismatch" at the
   * higher one, while `verifyBatch` returns true for both. So a shared proof
   * cannot be split across separate `execute()` calls.
   */
  proofMode?: 'auto' | 'batch' | 'single';
  /** Concurrent Creditcoin submissions. Nonces are allocated in order. */
  submitConcurrency?: number;
}

export interface MirrorBatchResult {
  results: MirrorResult[];
  batches: number;
  /** How proofs were actually obtained, per batch. */
  proofMode: 'batch' | 'single';
  /** How submissions actually happened. `per-tx` means one `execute()` per source tx. */
  submissionMode: 'batch-execute' | 'per-tx';
}

/**
 * Mirror many source transactions. Batches respect BOTH hard prover limits:
 * at most 10 proofs, spanning at most 1000 blocks.
 */
export async function mirrorBatch(
  txs: Array<{ txHash: string; block: number; txIndex?: number; uid?: string }>,
  chainKey: ChainKey,
  opts: MirrorBatchOptions = {},
): Promise<MirrorBatchResult> {
  const onBatch = opts.onBatchProgress ?? (() => {});
  const registry = getRegistry({
    registryAddress: opts.registryAddress,
    creditcoinRpc: opts.creditcoinRpc,
    signer: opts.signer,
  });

  const proofMode: 'batch' | 'single' =
    opts.proofMode === 'batch' || opts.proofMode === 'single'
      ? opts.proofMode
      : registry.hasBatchExecute
        ? 'batch'
        : 'single';
  const submissionMode: 'batch-execute' | 'per-tx' = registry.hasBatchExecute && proofMode === 'batch' ? 'batch-execute' : 'per-tx';

  const batches = planBatches(txs, MAX_BATCH_PROOFS, MAX_BATCH_BLOCK_SPAN);
  const results: MirrorResult[] = [];

  try {
    const builder = makeProofBuilder(chainKey, opts.proverUrl, 120_000);
    const signerAddress = registry.signer ? await registry.signer.getAddress() : null;
    const nonces = registry.signer && signerAddress ? new NonceAllocator(registry.signer, signerAddress) : null;

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]!;
      const fromBlock = batch[0]!.block;
      const toBlock = batch[batch.length - 1]!.block;
      onBatch({ batchIndex: bi, batchCount: batches.length, stage: 'awaiting-attestation', txCount: batch.length, fromBlock, toBlock });

      // Wait once per batch for the highest block in it.
      try {
        const head = await attestedHeight(chainKey, opts.proverUrl).catch(() => -1);
        if (head < toBlock) {
          await waitUntilAttested(chainKey, toBlock, {
            proverUrl: opts.proverUrl,
            builder,
            timeoutMs: opts.attestationTimeoutMs ?? 1_200_000,
          });
        }
      } catch (err) {
        for (const t of batch) results.push(failedResult(t, chainKey, bi, (err as Error).message));
        onBatch({ batchIndex: bi, batchCount: batches.length, stage: 'failed', txCount: batch.length, error: (err as Error).message });
        continue;
      }

      onBatch({ batchIndex: bi, batchCount: batches.length, stage: 'batch-proof', txCount: batch.length, fromBlock, toBlock });

      if (proofMode === 'batch' && batch.length > 1) {
        try {
          const shared = await getBatchProof(chainKey, batch.map((t) => t.txHash), { proverUrl: opts.proverUrl, builder });
          onBatch({
            batchIndex: bi,
            batchCount: batches.length,
            stage: 'submitting',
            txCount: batch.length,
            fromBlock,
            toBlock,
            continuityRoots: shared.proof.continuityProof.roots.length,
          });
          const submitted = await submitSharedBatch(registry, opts, chainKey, bi, batch, shared);
          results.push(...submitted);
          continue;
        } catch (err) {
          // Fall through to per-transaction proofs; record why.
          onBatch({ batchIndex: bi, batchCount: batches.length, stage: 'building-proof', txCount: batch.length, error: (err as Error).message });
        }
      }

      // Per-transaction proofs, issued concurrently, then submitted with
      // sequential nonces so several can be in flight at once.
      const submitConcurrency = opts.submitConcurrency ?? 4;
      for (let i = 0; i < batch.length; i += submitConcurrency) {
        const slice = batch.slice(i, i + submitConcurrency);
        const settled = await Promise.all(
          slice.map(async (t) => {
            const res = emptyResult(t.uid ?? t.txHash, chainKey);
            res.batchIndex = bi;
            res.sourceTxHash = t.txHash;
            res.sourceBlock = t.block;
            try {
              if (!opts.skipDedupeCheck && t.txIndex !== undefined) {
                const { processed, queryId } = await isQueryProcessed(chainKey, t.block, t.txIndex, { registry });
                res.queryId = queryId;
                if (processed) {
                  res.status = 'already-mirrored';
                  res.timestamp = now();
                  return res;
                }
              }
              const { proof, latencyMs } = await getProof(chainKey, t.txHash, { proverUrl: opts.proverUrl, builder });
              res.proofLatencyMs = latencyMs;
              res.continuityRoots = proof.continuityProof.roots.length;
              res.merkleSiblings = proof.merkleProof.siblings.length;
              res.queryId = computeQueryId(chainKey, proof.headerNumber, proof.txIndex);

              if (!registry.signer) throw new Error('No signer available for submission.');
              const nonce = nonces ? await nonces.take() : undefined;
              const submitStarted = Date.now();
              try {
                const accounting = await submitProof(registry, opts.action ?? MIRROR_ACTION, proof, opts.gasLimit, nonce);
                res.submitLatencyMs = Date.now() - submitStarted;
                res.creditcoinTxHash = accounting.creditcoinTxHash;
                res.gasUsed = accounting.gasUsed;
                res.ctcCost = accounting.ctcCost;
                res.attestationsWritten = accounting.attestationsWritten;
                res.status = accounting.status === 1 ? 'mirrored' : 'failed';
                if (accounting.status !== 1) res.error = `Creditcoin transaction reverted (status ${accounting.status})`;
              } catch (submitErr) {
                await nonces?.resync();
                throw submitErr;
              }
            } catch (err) {
              const message = (err as Error).message ?? String(err);
              if (/Query already processed/i.test(message)) {
                res.status = 'already-mirrored';
              } else {
                res.status = 'failed';
                res.error = message;
              }
            }
            res.timestamp = now();
            return res;
          }),
        );
        results.push(...settled);
      }
    }
  } finally {
    registry.provider.destroy();
  }

  return { results, batches: batches.length, proofMode, submissionMode };
}

function failedResult(t: { txHash: string; block: number; uid?: string }, chainKey: ChainKey, batchIndex: number, error: string): MirrorResult {
  const r = emptyResult(t.uid ?? t.txHash, chainKey);
  r.batchIndex = batchIndex;
  r.sourceTxHash = t.txHash;
  r.sourceBlock = t.block;
  r.error = error;
  return r;
}

/**
 * Submit a whole batch through the registry's batch entry point, when one
 * exists. `registry.hasBatchExecute` is discovered from the deployed ABI.
 */
async function submitSharedBatch(
  registry: RegistryHandle,
  opts: MirrorBatchOptions,
  chainKey: ChainKey,
  batchIndex: number,
  batch: Array<{ txHash: string; block: number; txIndex?: number; uid?: string }>,
  shared: Awaited<ReturnType<typeof getBatchProof>>,
): Promise<MirrorResult[]> {
  if (!registry.batchExecuteName) {
    throw new Error('registry exposes no batch execute entry point');
  }
  if (!registry.signer) throw new Error('No signer available for submission.');

  const iface = new Interface(registryAbi());
  const entries = shared.entries;
  const args = [
    opts.action ?? MIRROR_ACTION,
    chainKey,
    entries.map((e) => e.height),
    entries.map((e) => e.txBytes),
    entries.map((e) => e.merkleProof.root),
    entries.map((e) => e.merkleProof.siblings.map((s) => [s.hash, s.isLeft])),
    shared.proof.continuityProof.lowerEndpointDigest,
    shared.proof.continuityProof.roots,
  ];

  const data = iface.encodeFunctionData(registry.batchExecuteName, args);
  const from = await registry.signer.getAddress();
  const gas = await planGas(registry, data, from, shared.proof.continuityProof.roots.length, opts.gasLimit);

  const submitStarted = Date.now();
  const tx = await registry.contract[registry.batchExecuteName](...args, { gasLimit: gas.gasLimit });
  const receipt = await waitForReceipt(tx);
  const accounting = accountForReceipt(receipt, iface);
  const submitLatencyMs = Date.now() - submitStarted;

  // One submission covers the whole batch: attribute the shared cost evenly and
  // keep `queryId` per source transaction so both counts stay derivable.
  return batch.map((t) => {
    const r = emptyResult(t.uid ?? t.txHash, chainKey);
    const entry = entries.find((e) => e.txHash.toLowerCase() === t.txHash.toLowerCase());
    r.batchIndex = batchIndex;
    r.sourceTxHash = t.txHash;
    r.sourceBlock = entry?.height ?? t.block;
    r.continuityRoots = shared.proof.continuityProof.roots.length;
    r.merkleSiblings = entry?.merkleProof.siblings.length ?? null;
    r.queryId = entry ? computeQueryId(chainKey, entry.height, entry.txIndex) : null;
    r.creditcoinTxHash = accounting.creditcoinTxHash;
    r.gasUsed = accounting.gasUsed;
    r.ctcCost = accounting.ctcCost;
    r.proofLatencyMs = shared.latencyMs;
    r.submitLatencyMs = submitLatencyMs;
    r.attestationsWritten = accounting.attestationsWritten;
    r.status = accounting.status === 1 ? 'mirrored' : 'failed';
    if (accounting.status !== 1) r.error = `Creditcoin transaction reverted (status ${accounting.status})`;
    r.timestamp = now();
    return r;
  });
}

/* ------------------------------------------------------------------ */
/* Schema-wide mirroring                                                */
/* ------------------------------------------------------------------ */

export interface MirrorSchemaOptions extends MirrorBatchOptions {
  /** How many recent attestations of this schema to consider. Default 100. */
  limit?: number;
  /** Skip UIDs already present in the registry. Default true — makes it resumable. */
  skipExisting?: boolean;
}

export interface MirrorSchemaResult extends MirrorBatchResult {
  schemaUid: string;
  chainKey: ChainKey;
  /** Attestations easscan returned for this schema. */
  considered: number;
  /** Attestations already in the registry before this run. */
  skipped: number;
  /** Distinct source transactions actually submitted. */
  transactions: number;
  /** Attestations covered by those transactions. */
  attestations: number;
}

/**
 * Mirror a whole EAS schema's recent attestations.
 *
 * Groups the schema's attestations by source transaction first — one
 * `multiAttest` transaction carries many attestations and costs one query — then
 * splits those transactions into batches that satisfy both hard prover limits.
 * Resumable: anything already in the registry is skipped.
 */
export async function mirrorSchema(
  schemaUid: string,
  chainKey: ChainKey,
  opts: MirrorSchemaOptions = {},
): Promise<MirrorSchemaResult> {
  const limit = opts.limit ?? 100;
  const skipExisting = opts.skipExisting ?? true;

  const rows = await listBySchema(schemaUid, chainKey, limit, { easscanUrl: opts.easscanUrl, sourceRpc: opts.sourceRpc });
  const considered = rows.length;

  let groups: TxGroup[] = groupByTx(rows, chainKey);
  groups = await hydrateBlocks(groups, chainKey, { sourceRpc: opts.sourceRpc });

  let skipped = 0;
  if (skipExisting && groups.length > 0) {
    const registry = getRegistry({ registryAddress: opts.registryAddress, creditcoinRpc: opts.creditcoinRpc, signer: opts.signer });
    try {
      const keep: TxGroup[] = [];
      for (const g of groups) {
        if (g.block === undefined || g.txIndex === undefined) continue;
        const { processed } = await isQueryProcessed(chainKey, g.block, g.txIndex, { registry });
        if (processed) skipped += g.uids.length;
        else keep.push(g);
      }
      groups = keep;
    } finally {
      registry.provider.destroy();
    }
  }

  const txs = groups
    .filter((g): g is TxGroup & { block: number; txIndex: number } => g.block !== undefined && g.txIndex !== undefined)
    .map((g) => ({ txHash: g.txid, block: g.block, txIndex: g.txIndex, uid: g.uids[0] }));

  const attestations = groups.reduce((n, g) => n + g.uids.length, 0);

  if (txs.length === 0) {
    return {
      results: [],
      batches: 0,
      proofMode: 'single',
      submissionMode: 'per-tx',
      schemaUid,
      chainKey,
      considered,
      skipped,
      transactions: 0,
      attestations: 0,
    };
  }

  const batchResult = await mirrorBatch(txs, chainKey, opts);
  return { ...batchResult, schemaUid, chainKey, considered, skipped, transactions: txs.length, attestations };
}

export { MIRROR_ACTION, REVOKE_ACTION };

/** Convenience: mirror a revocation transaction (action = 1). */
export async function mirrorRevocation(revokeTxHash: string, chainKey: ChainKey, opts: MirrorOptions = {}): Promise<MirrorResult> {
  return mirrorTransaction(revokeTxHash, chainKey, { ...opts, action: REVOKE_ACTION });
}

/** Re-exported so callers can compute the dedupe key without the whole module. */
export { computeQueryId, resolve };
