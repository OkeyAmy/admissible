import { chainInfo, proofProvider } from '@gluwa/usc-sdk';
import { solidityPackedKeccak256 } from 'ethers';

import { creditcoinProvider } from './providers.js';

import {
  CHAIN_INFO_PRECOMPILE,
  MAX_BATCH_BLOCK_SPAN,
  MAX_BATCH_PROOFS,
  resolveEndpoints,
} from './config.js';
import type { ChainKey, ProofSummary } from './types.js';

/**
 * A thin, idiomatic wrapper over `@gluwa/usc-sdk`.
 *
 * Two rules encoded here, both from the SDK's own documentation and from live
 * behaviour of the prover service:
 *
 *  1. Height waiting goes through `proofProvider.service.ProofBuilder`, NOT
 *     `chainInfo.PrecompileChainInfoProvider` — the SDK marks the latter
 *     "legacy". The ProofBuilder version polls the prover's own attestation
 *     cache, which is the thing that actually has to be warm before a proof
 *     request can succeed.
 *  2. `BlockNotOnSourceChain` is RETRYABLE. It means the block is still inside
 *     the source chain's 32-block reorg-protection window, not that anything is
 *     wrong. The prover marks such errors `"retriable": true` in its body.
 */

export type ProofBuilder = InstanceType<typeof proofProvider.service.ProofBuilder>;
export type ContinuityResponse = proofProvider.ContinuityResponse;
export type BatchContinuityResponse = proofProvider.BatchContinuityResponse;

export { MAX_BATCH_PROOFS, MAX_BATCH_BLOCK_SPAN };

/** Errors surfaced by the prover service, with the service's own retry advice. */
export class ProverError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'ProverError';
  }
}

/** Prover error codes we know are transient. */
const RETRYABLE_CODES = new Set(['BlockNotOnSourceChain', 'AttestationNotFound', 'HeightNotAttested', 'Timeout']);

export function isRetryableProverError(err: unknown): boolean {
  if (err instanceof ProverError) return err.retriable || (err.code !== null && RETRYABLE_CODES.has(err.code));
  const msg = String((err as Error)?.message ?? err);
  if (/BlockNotOnSourceChain|reorg-protection|ECONNRESET|ETIMEDOUT|socket hang up|timeout of \d+ms/i.test(msg)) return true;
  if (/status code (429|50\d)/.test(msg)) return true;
  return false;
}

export function makeProofBuilder(chainKey: ChainKey, proverUrl?: string, timeoutMs = 60_000): ProofBuilder {
  const { proverUrl: url } = resolveEndpoints({ proverUrl });
  return new proofProvider.service.ProofBuilder(chainKey, url, timeoutMs);
}

export function makeChainInfoProvider(creditcoinRpc?: string): chainInfo.PrecompileChainInfoProvider {
  const provider = creditcoinProvider(creditcoinRpc);
  return new chainInfo.PrecompileChainInfoProvider(provider, CHAIN_INFO_PRECOMPILE);
}

/**
 * Latest attested source-chain height, straight from the prover service.
 * `GET /api/v1/attested-height/{chainKey}` → `{"attestedHeight": 25948260}`.
 * Free, unauthenticated, and the number `admissible status` prints.
 */
export async function attestedHeight(chainKey: ChainKey, proverUrl?: string, timeoutMs = 20_000): Promise<number> {
  const { proverUrl: url } = resolveEndpoints({ proverUrl });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/v1/attested-height/${chainKey}`, { signal: controller.signal });
    if (!res.ok) throw new ProverError(`attested-height returned HTTP ${res.status}`, null, res.status >= 500);
    const body = (await res.json()) as { attestedHeight?: number };
    if (typeof body.attestedHeight !== 'number') {
      throw new ProverError(`attested-height returned no height for chainKey ${chainKey}`, null, true);
    }
    return body.attestedHeight;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The on-chain view of the same number, read from the ChainInfo precompile
 * (`0x…0FD3`). `status` prints both so a divergence between the chain and the
 * prover's cache is visible rather than hidden.
 */
export async function onchainAttestedHeight(
  chainKey: ChainKey,
  creditcoinRpc?: string,
): Promise<{ height: number; hash: string; isAttestation: boolean; exists: boolean }> {
  const info = makeChainInfoProvider(creditcoinRpc);
  return info.getLatestAttestedHeightAndHash(chainKey);
}

/**
 * Wait for `targetHeight` to be attested AND present in the prover's cache.
 * Uses `ProofBuilder.waitUntilHeightAttested` (not the legacy chainInfo one).
 */
export async function waitUntilAttested(
  chainKey: ChainKey,
  targetHeight: number,
  opts: {
    proverUrl?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
    extraDelayMs?: number;
    builder?: ProofBuilder;
    onPoll?: (attested: number, target: number) => void;
  } = {},
): Promise<void> {
  const builder = opts.builder ?? makeProofBuilder(chainKey, opts.proverUrl);
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 1_200_000;
  const extraDelayMs = opts.extraDelayMs ?? 5_000;

  if (opts.onPoll) {
    // Poll ourselves so the caller can render live progress, then hand off to the
    // SDK for the final (short) wait plus its consistency delay.
    const started = Date.now();
    for (;;) {
      const h = await attestedHeight(chainKey, opts.proverUrl).catch(() => -1);
      if (h >= 0) opts.onPoll(h, targetHeight);
      if (h >= targetHeight) break;
      if (Date.now() - started > timeoutMs) {
        throw new ProverError(
          `Timed out after ${Math.round((Date.now() - started) / 1000)}s waiting for chainKey ${chainKey} height ${targetHeight} (latest attested ${h})`,
          'HeightNotAttested',
          true,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  await builder.waitUntilHeightAttested(chainKey, targetHeight, pollIntervalMs, timeoutMs, extraDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The `@gluwa/usc-sdk` ProofBuilder collapses HTTP failures into a string, so
 * the service's structured `{code, message, retriable}` body is lost. When a
 * proof request fails we re-read the endpoint once to recover the code — that
 * is what tells us whether to back off and retry or give up.
 */
async function classifyProofFailure(chainKey: ChainKey, txHash: string, proverUrl: string, fallback: string): Promise<ProverError> {
  try {
    const res = await fetch(`${proverUrl}/api/v1/proof-by-tx/${chainKey}/${txHash}`);
    if (res.ok) return new ProverError(fallback, null, true); // raced; treat as transient
    const body = (await res.json()) as { code?: string; message?: string; retriable?: boolean };
    const code = body.code ?? null;
    const retriable = body.retriable ?? (code !== null && RETRYABLE_CODES.has(code));
    return new ProverError(body.message ? `${code ?? 'ProverError'}: ${body.message}` : fallback, code, retriable);
  } catch {
    return new ProverError(fallback, null, true);
  }
}

export interface ProofAttempt {
  proof: ContinuityResponse;
  /** Wall-clock milliseconds spent in the prover service. Costs no CTC. */
  latencyMs: number;
  attempts: number;
}

/**
 * Fetch a single-transaction proof, retrying transient failures with
 * exponential backoff. Retryable includes `BlockNotOnSourceChain`.
 */
export async function getProof(
  chainKey: ChainKey,
  txHash: string,
  opts: { proverUrl?: string; builder?: ProofBuilder; maxAttempts?: number; baseDelayMs?: number; onRetry?: (attempt: number, err: ProverError) => void } = {},
): Promise<ProofAttempt> {
  const { proverUrl } = resolveEndpoints({ proverUrl: opts.proverUrl });
  const builder = opts.builder ?? makeProofBuilder(chainKey, proverUrl);
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 5_000;

  const started = Date.now();
  let lastErr: ProverError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await builder.getProof(txHash);
    if (result.success && result.data) {
      return { proof: result.data, latencyMs: Date.now() - started, attempts: attempt };
    }
    lastErr = await classifyProofFailure(chainKey, txHash, proverUrl, result.error ?? 'proof generation failed');
    if (!lastErr.retriable || attempt === maxAttempts) break;
    opts.onRetry?.(attempt, lastErr);
    await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  throw lastErr ?? new ProverError('proof generation failed', null, false);
}

export interface BatchProofAttempt {
  proof: BatchContinuityResponse;
  latencyMs: number;
  attempts: number;
  /** Flattened, in ascending block order. */
  entries: Array<{ height: number; txIndex: number; txHash: string; txBytes: string; merkleProof: { root: string; siblings: Array<{ hash: string; isLeft: boolean }> } }>;
}

/**
 * Batch proof for up to 10 transactions inside a 1000-block span. Both limits
 * are enforced by the service — exceeding the span returns
 * `{"code":"BatchSpanTooLarge","retriable":false}` (verified live).
 */
export async function getBatchProof(
  chainKey: ChainKey,
  txHashes: string[],
  opts: { proverUrl?: string; builder?: ProofBuilder; maxAttempts?: number; baseDelayMs?: number; onRetry?: (attempt: number, err: ProverError) => void } = {},
): Promise<BatchProofAttempt> {
  if (txHashes.length === 0) throw new Error('getBatchProof called with no transactions');
  if (txHashes.length > MAX_BATCH_PROOFS) {
    throw new ProverError(`Batch of ${txHashes.length} exceeds the hard limit of ${MAX_BATCH_PROOFS} proofs`, 'BatchTooLarge', false);
  }

  const { proverUrl } = resolveEndpoints({ proverUrl: opts.proverUrl });
  const builder = opts.builder ?? makeProofBuilder(chainKey, proverUrl, 120_000);
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 5_000;

  const started = Date.now();
  let lastErr: ProverError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await builder.getBatchProof(txHashes);
    if (result.success && result.data) {
      return {
        proof: result.data,
        latencyMs: Date.now() - started,
        attempts: attempt,
        entries: flattenBatch(result.data),
      };
    }
    lastErr = await classifyBatchFailure(chainKey, txHashes, proverUrl, result.error ?? 'batch proof generation failed');
    if (!lastErr.retriable || attempt === maxAttempts) break;
    opts.onRetry?.(attempt, lastErr);
    await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  throw lastErr ?? new ProverError('batch proof generation failed', null, false);
}

async function classifyBatchFailure(
  chainKey: ChainKey,
  txHashes: string[],
  proverUrl: string,
  fallback: string,
): Promise<ProverError> {
  try {
    const res = await fetch(`${proverUrl}/api/v1/proof-batch-by-tx/${chainKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(txHashes),
    });
    if (res.ok) return new ProverError(fallback, null, true);
    const body = (await res.json()) as { code?: string; message?: string; retriable?: boolean };
    const code = body.code ?? null;
    const retriable = body.retriable ?? (code !== null && RETRYABLE_CODES.has(code));
    return new ProverError(body.message ? `${code ?? 'ProverError'}: ${body.message}` : fallback, code, retriable);
  } catch {
    return new ProverError(fallback, null, true);
  }
}

export function flattenBatch(data: BatchContinuityResponse): BatchProofAttempt['entries'] {
  const out: BatchProofAttempt['entries'] = [];
  for (const [height, byIndex] of data.merkleProofs.entries()) {
    for (const [txIndex, entry] of byIndex.entries()) {
      out.push({
        height: Number(height),
        txIndex: Number(txIndex),
        txHash: entry.txHash,
        txBytes: entry.txBytes,
        merkleProof: entry.merkleProof as unknown as { root: string; siblings: Array<{ hash: string; isLeft: boolean }> },
      });
    }
  }
  out.sort((a, b) => a.height - b.height || a.txIndex - b.txIndex);
  return out;
}

export function summariseProof(p: ContinuityResponse): ProofSummary {
  return {
    chainKey: p.chainKey,
    headerNumber: p.headerNumber,
    txIndex: p.txIndex,
    txHash: p.txHash,
    txBytes: p.txBytes,
    merkleRoot: p.merkleProof.root,
    merkleSiblings: p.merkleProof.siblings.length,
    continuityRoots: p.continuityProof.roots.length,
    lowerEndpointDigest: p.continuityProof.lowerEndpointDigest,
    cached: p.cached,
  };
}

/**
 * The registry's dedupe key, mirrored from `ASCBase._computeQueryId`:
 *
 *   mstore(ptr,        chainKey)              // bytes [0,32)   uint256
 *   mstore(ptr+32, shl(192, blockHeight))     // bytes [32,40)  uint64
 *   mstore(ptr+40,     txIndex)               // bytes [40,72)  uint256
 *   keccak256(ptr, 72)
 *
 * `txIndex` is the value the BlockProver precompile derives from the merkle
 * proof (`calculateTxIndex`), which the prover service also returns as
 * `txIndex`. It is per TRANSACTION, not per UID — one `multiAttest` transaction
 * is one query carrying many attestations.
 */
export function computeQueryId(chainKey: number, blockHeight: number, txIndex: number): string {
  return solidityPackedKeccak256(['uint256', 'uint64', 'uint256'], [chainKey, blockHeight, txIndex]);
}

/** Split transactions into batches obeying both hard prover limits. */
export function planBatches<T extends { block: number }>(items: T[], maxSize = MAX_BATCH_PROOFS, maxSpan = MAX_BATCH_BLOCK_SPAN): T[][] {
  const sorted = [...items].sort((a, b) => a.block - b.block);
  const batches: T[][] = [];
  let current: T[] = [];
  for (const item of sorted) {
    if (current.length === 0) {
      current.push(item);
      continue;
    }
    const span = item.block - current[0]!.block;
    if (current.length >= maxSize || span > maxSpan - 1) {
      batches.push(current);
      current = [item];
    } else {
      current.push(item);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}
