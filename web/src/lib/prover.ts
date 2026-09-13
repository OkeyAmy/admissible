import { PROVER_URL } from './config';
import type { ChainKey, ProofBundle } from './types';

export class ProverError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ProverError';
    this.code = code;
    this.status = status;
  }
  /**
   * BlockNotOnSourceChain means the block is still inside the source chain's
   * reorg-protection window. The prover also reports plain "not attested to
   * yet" (no BlockNotOnSourceChain code, seen live 2026-09-13) when the
   * attested height simply hasn't caught up — a different condition, same
   * fix: wait and retry. SPEC §3: both are retryable, not fatal. The UI
   * renders these as "waiting for confirmations", never as a failure.
   */
  get retryable(): boolean {
    return (
      this.code === 'BlockNotOnSourceChain' ||
      /not attested/i.test(this.message) ||
      this.status >= 500 ||
      this.status === 429
    );
  }
}

async function proverFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${PROVER_URL}${path}`, { signal });
  } catch (e) {
    throw new ProverError('NetworkError', (e as Error).message || 'network error reaching the prover', 0);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = body as { code?: string; message?: string } | null;
    throw new ProverError(err?.code ?? `HTTP${res.status}`, err?.message ?? text.slice(0, 300), res.status);
  }
  return body as T;
}

/** GET /api/v1/attested-height/{chainKey} → { attestedHeight } */
export async function getAttestedHeight(chainKey: ChainKey, signal?: AbortSignal): Promise<number> {
  const body = await proverFetch<{ attestedHeight: number }>(`/api/v1/attested-height/${chainKey}`, signal);
  return Number(body.attestedHeight);
}

/**
 * GET /api/v1/proof-by-tx/{chainKey}/{txHash}
 * SPEC §3: returns the proof object directly, NOT wrapped in {success, data}.
 */
export async function getProofByTx(chainKey: ChainKey, txHash: string, signal?: AbortSignal): Promise<ProofBundle> {
  return proverFetch<ProofBundle>(`/api/v1/proof-by-tx/${chainKey}/${txHash}`, signal);
}
