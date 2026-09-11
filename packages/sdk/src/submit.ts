import { Interface, type ContractTransactionResponse, type Signer, type TransactionReceipt } from 'ethers';

import type { RegistryHandle } from './registry.js';

/**
 * Submission plumbing: gas sizing, nonce allocation and receipt accounting.
 *
 * The gas fallback is the one the official Attestcoin examples use
 * (`shared/utils/index.ts`): pallet-evm does not always propagate revert
 * reasons during estimation, so estimation failing is not evidence the call
 * would fail. The constant term here is larger than the examples' because this
 * registry writes one storage record per attestation in the transaction.
 */

export const GAS_BUFFER_PERCENT = 135;

export interface GasPlan {
  gasLimit: bigint;
  /** `estimate` when eth_estimateGas succeeded, `fallback` when it did not. */
  source: 'estimate' | 'fallback' | 'override';
  estimateError?: string;
}

export async function planGas(
  registry: RegistryHandle,
  data: string,
  from: string,
  continuityRoots: number,
  override?: bigint,
): Promise<GasPlan> {
  if (override) return { gasLimit: override, source: 'override' };
  try {
    const estimated = await registry.provider.estimateGas({ to: registry.address, data, from });
    return { gasLimit: (estimated * BigInt(GAS_BUFFER_PERCENT)) / 100n, source: 'estimate' };
  } catch (err) {
    const calculated = BigInt(400_000 + continuityRoots * 6_000);
    return {
      gasLimit: calculated,
      source: 'fallback',
      estimateError: (err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message,
    };
  }
}

/**
 * Hands out sequential nonces so several submissions can be in flight from one
 * wallet. On any submission error the caller calls `resync()`, which re-reads
 * the pending nonce from the node rather than guessing.
 */
export class NonceAllocator {
  private next: number | null = null;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly signer: Signer,
    private readonly address: string,
  ) {}

  async take(): Promise<number> {
    while (this.pending) await this.pending;
    if (this.next === null) await this.resync();
    const n = this.next!;
    this.next = n + 1;
    return n;
  }

  async resync(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const provider = this.signer.provider;
      if (!provider) throw new Error('signer has no provider');
      this.next = await provider.getTransactionCount(this.address, 'pending');
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
}

export interface SubmissionAccounting {
  creditcoinTxHash: string;
  blockNumber: number;
  gasUsed: string;
  /** Real cost, `gasUsed × effectiveGasPrice` formatted in CTC. */
  ctcCost: string;
  status: number;
  /** Number of `AttestationMirrored` + `AttestationRevoked` events in the receipt. */
  attestationsWritten: number;
  mirroredUids: string[];
  revokedUids: string[];
  queryIdsFromEvents: string[];
}

export function accountForReceipt(receipt: TransactionReceipt, iface: Interface): SubmissionAccounting {
  const mirroredUids: string[] = [];
  const revokedUids: string[] = [];
  const queryIds: string[] = [];

  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name === 'AttestationMirrored') {
      mirroredUids.push(String(parsed.args.uid));
      queryIds.push(String(parsed.args.queryId));
    } else if (parsed.name === 'AttestationRevoked') {
      revokedUids.push(String(parsed.args.uid));
      queryIds.push(String(parsed.args.queryId));
    }
  }

  const gasPrice = receipt.gasPrice ?? 0n;
  const wei = receipt.gasUsed * gasPrice;

  return {
    creditcoinTxHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    ctcCost: formatCtc(wei),
    status: receipt.status ?? 0,
    attestationsWritten: mirroredUids.length + revokedUids.length,
    mirroredUids,
    revokedUids,
    queryIdsFromEvents: [...new Set(queryIds)],
  };
}

/** 18-decimal formatting without ethers' trailing-zero trimming, so receipts
 *  keep a stable number of significant digits. */
export function formatCtc(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '') || '0';
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export async function waitForReceipt(tx: ContractTransactionResponse, confirmations = 1, timeoutMs = 180_000): Promise<TransactionReceipt> {
  const receipt = await tx.wait(confirmations, timeoutMs);
  if (!receipt) throw new Error(`No receipt for Creditcoin transaction ${tx.hash} after ${timeoutMs}ms`);
  return receipt;
}
