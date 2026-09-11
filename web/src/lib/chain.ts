import { Contract, JsonRpcProvider } from 'ethers';
import { CHAIN_INFO_ABI } from './abi';
import { CHAIN_INFO_PRECOMPILE, CREDITCOIN_RPC, SOURCE_CHAINS } from './config';
import type { ChainKey } from './types';

let ccProvider: JsonRpcProvider | null = null;

export function creditcoinProvider(): JsonRpcProvider {
  if (!ccProvider) {
    ccProvider = new JsonRpcProvider(CREDITCOIN_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  }
  return ccProvider;
}

const sourceProviders = new Map<ChainKey, JsonRpcProvider>();

export function sourceProvider(chainKey: ChainKey): JsonRpcProvider {
  let p = sourceProviders.get(chainKey);
  if (!p) {
    p = new JsonRpcProvider(SOURCE_CHAINS[chainKey].rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
    sourceProviders.set(chainKey, p);
  }
  return p;
}

export function chainInfoContract(): Contract {
  return new Contract(CHAIN_INFO_PRECOMPILE, [...CHAIN_INFO_ABI], creditcoinProvider());
}

export interface AttestedTip {
  height: number;
  hash: string;
  isAttestation: boolean;
  exists: boolean;
}

/**
 * Reads the latest attested height straight off the ChainInfo precompile
 * 0x…0fd3 over the public Creditcoin RPC. This is a real eth_call to the
 * precompile — not the prover's HTTP mirror of the same number.
 */
export async function readAttestedTip(chainKey: ChainKey): Promise<AttestedTip> {
  const c = chainInfoContract();
  const r = await c.get_latest_attestation_height_and_hash(chainKey);
  return {
    height: Number(r[0]),
    hash: String(r[1]),
    isAttestation: Boolean(r[2]),
    exists: Boolean(r[3]),
  };
}

export async function isHeightAttested(chainKey: ChainKey, height: number): Promise<boolean> {
  const c = chainInfoContract();
  return Boolean(await c.is_height_attested(chainKey, height));
}

export interface SourceTxLocation {
  blockNumber: number;
  txIndex: number;
  status: number;
  logCount: number;
  to: string | null;
}

/** Locates an Ethereum transaction: which block, which index, how many logs. */
export async function locateSourceTx(chainKey: ChainKey, txHash: string): Promise<SourceTxLocation | null> {
  const receipt = await sourceProvider(chainKey).getTransactionReceipt(txHash);
  if (!receipt) return null;
  return {
    blockNumber: receipt.blockNumber,
    txIndex: receipt.index,
    status: receipt.status ?? 0,
    logCount: receipt.logs.length,
    to: receipt.to,
  };
}
