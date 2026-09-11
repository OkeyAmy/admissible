/**
 * Faster stand-in for `@admissible/sdk`'s `hydrateBlocks`.
 *
 * The SDK version (packages/sdk/src/eas.ts) hard-codes concurrency=6 for the
 * `getTransactionReceipt` calls that attach block/txIndex to each tx group.
 * At bench volume (thousands of candidate UIDs, mostly 1:1 `attest()` calls
 * on Sepolia, i.e. one unique transaction per UID) that meant thousands of
 * receipt calls gated at 6-at-a-time — measured live: a single 200-row
 * `listRecent` page took minutes to hydrate, making a 3000-UID target
 * effectively unreachable in session time. This is bench-only consumer code,
 * not a modification of packages/sdk/ — it does the identical job
 * (`provider.getTransactionReceipt` per unique txid) with a configurable,
 * much higher concurrency and one retry on transient failure.
 */
import { JsonRpcProvider, Network } from 'ethers';
import { SOURCE_CHAINS, type ChainKey, type TxGroup } from '@admissible/sdk';

const SOURCE_CHAIN_IDS: Record<ChainKey, number> = { 1: 11155111, 3: 1 };

function sourceRpcUrl(chainKey: ChainKey): string {
  const envKey = chainKey === 1 ? 'SEPOLIA_RPC' : 'MAINNET_RPC';
  return process.env[envKey] || SOURCE_CHAINS[chainKey].rpc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function hydrateBlocksFast(groups: TxGroup[], chainKey: ChainKey, concurrency = 24): Promise<TxGroup[]> {
  if (groups.length === 0) return groups;
  const provider = new JsonRpcProvider(sourceRpcUrl(chainKey), Network.from(SOURCE_CHAIN_IDS[chainKey]), {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  const out: TxGroup[] = [];
  try {
    let idx = 0;
    async function lane(): Promise<void> {
      for (;;) {
        const i = idx++;
        if (i >= groups.length) return;
        const g = groups[i]!;
        let receipt = null;
        for (let attempt = 0; attempt < 2 && !receipt; attempt++) {
          try {
            receipt = await provider.getTransactionReceipt(g.txid);
          } catch {
            if (attempt === 0) await sleep(500);
          }
        }
        if (receipt) out.push({ ...g, block: receipt.blockNumber, txIndex: receipt.index });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, () => lane()));
  } finally {
    provider.destroy();
  }
  return out;
}
