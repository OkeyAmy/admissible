import { FetchRequest, JsonRpcProvider, Network } from 'ethers';

import { CREDITCOIN_CHAIN_ID, resolveEndpoints, resolveSourceRpc } from './config.js';
import type { ChainKey } from './types.js';

/**
 * Provider construction, in one place.
 *
 * ethers performs a network-detection round trip before the first call unless
 * it is handed a concrete `Network`. Measured against the public Creditcoin
 * testnet RPC: detection-then-call took 3634 ms and frequently exceeded the
 * 5 s default request timeout outright; passing `Network.from(102031)` with
 * `staticNetwork` made the same ChainInfo precompile read take 372 ms. So every
 * provider in this SDK is constructed with its chain id already known.
 */

const SOURCE_CHAIN_IDS: Record<ChainKey, number> = {
  1: 11155111, // Ethereum Sepolia
  3: 1, // Ethereum Mainnet
};

const DEFAULT_TIMEOUT_MS = 30_000;

function request(url: string, timeoutMs: number): FetchRequest {
  const req = new FetchRequest(url);
  req.timeout = timeoutMs;
  return req;
}

export function creditcoinProvider(rpc?: string, timeoutMs = DEFAULT_TIMEOUT_MS): JsonRpcProvider {
  const { creditcoinRpc } = resolveEndpoints({ creditcoinRpc: rpc });
  return new JsonRpcProvider(request(creditcoinRpc, timeoutMs), Network.from(CREDITCOIN_CHAIN_ID), {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

export function sourceProvider(chainKey: ChainKey, rpc?: string, timeoutMs = DEFAULT_TIMEOUT_MS): JsonRpcProvider {
  const url = resolveSourceRpc(chainKey, rpc);
  return new JsonRpcProvider(request(url, timeoutMs), Network.from(SOURCE_CHAIN_IDS[chainKey]), {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

/** For an arbitrary URL whose chain id is not known ahead of time. */
export function anyProvider(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): JsonRpcProvider {
  return new JsonRpcProvider(request(url, timeoutMs), undefined, { staticNetwork: true });
}

export { SOURCE_CHAIN_IDS };
