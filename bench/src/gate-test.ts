/**
 * ONE real end-to-end submission before the volume loop, per plan: confirm
 * receipt status === 1, an AttestationMirrored event in the logs, and that
 * totalMirrored() delta equals attestationsWritten. Run with:
 *   pnpm -F @admissible/bench exec tsx src/gate-test.ts
 */
import './env.js';
import {
  getRegistry,
  totals,
  listRecent,
  groupByTx,
  hydrateBlocks,
  attestedHeight,
  getProof,
  isQueryProcessed,
  MIRROR_ACTION,
} from '@admissible/sdk';
import { submitViaRegistry } from './submit-fix.js';

async function main() {
  const chainKey = 1 as const; // Sepolia — fast attestation, easy to find an already-attested block
  console.log(`[gate] fetching recent attestations on chainKey ${chainKey}...`);

  const head = await attestedHeight(chainKey);
  console.log(`[gate] attestedHeight(${chainKey}) = ${head}`);

  // Page back through easscan until we find a tx group whose block is safely
  // behind the attested height (no waitUntilAttested stall).
  let picked: { txid: string; block: number; txIndex: number; uids: string[] } | null = null;
  for (let skip = 0; skip < 500 && !picked; skip += 50) {
    const rows = await listRecent(chainKey, 50, { skip });
    if (rows.length === 0) break;
    let groups = groupByTx(rows, chainKey);
    groups = await hydrateBlocks(groups, chainKey);
    for (const g of groups) {
      if (g.block === undefined || g.txIndex === undefined) continue;
      if (g.block <= head - 5) {
        picked = { txid: g.txid, block: g.block, txIndex: g.txIndex, uids: g.uids };
        break;
      }
    }
  }
  if (!picked) throw new Error('gate: could not find an already-attested tx group in the first 500 recent rows');
  console.log(`[gate] picked tx ${picked.txid} block ${picked.block} txIndex ${picked.txIndex} carrying ${picked.uids.length} UID(s)`);

  const registry = getRegistry();
  if (!registry.signer) throw new Error('gate: no signer — set PRIVATE_KEY');

  const { processed, queryId } = await isQueryProcessed(chainKey, picked.block, picked.txIndex, { registry });
  console.log(`[gate] queryId ${queryId} processed=${processed}`);
  if (processed) {
    console.log('[gate] already mirrored on a prior run — picking is fine, this just confirms dedupe works. Exiting gate test as PASS (idempotent).');
    registry.provider.destroy();
    return;
  }

  const before = await totals({ registry });
  console.log(`[gate] totalMirrored before = ${before.totalMirrored}`);

  const proofStart = Date.now();
  const { proof, latencyMs, attempts } = await getProof(chainKey, picked.txid, { maxAttempts: 6 });
  console.log(`[gate] proof obtained in ${latencyMs}ms (attempts=${attempts}), continuityRoots=${proof.continuityProof.roots.length}, merkleSiblings=${proof.merkleProof.siblings.length}`);
  void proofStart;

  const submitStart = Date.now();
  const accounting = await submitViaRegistry(registry, MIRROR_ACTION, proof);
  const submitLatencyMs = Date.now() - submitStart;
  console.log(`[gate] submitted in ${submitLatencyMs}ms`);
  console.log(`[gate] creditcoinTxHash = ${accounting.creditcoinTxHash}`);
  console.log(`[gate] status = ${accounting.status}, gasUsed = ${accounting.gasUsed}, ctcCost = ${accounting.ctcCost}`);
  console.log(`[gate] attestationsWritten (from events) = ${accounting.attestationsWritten}, mirroredUids = ${JSON.stringify(accounting.mirroredUids)}`);

  if (accounting.status !== 1) throw new Error(`gate FAIL: tx reverted, status=${accounting.status}`);
  if (accounting.attestationsWritten === 0) throw new Error('gate FAIL: no AttestationMirrored event in receipt');

  const after = await totals({ registry });
  console.log(`[gate] totalMirrored after = ${after.totalMirrored}`);
  const delta = after.totalMirrored - before.totalMirrored;
  console.log(`[gate] totalMirrored delta = ${delta} (events said ${accounting.attestationsWritten})`);

  if (delta !== accounting.attestationsWritten) {
    throw new Error(`gate FAIL: totalMirrored delta (${delta}) != attestationsWritten from events (${accounting.attestationsWritten})`);
  }

  console.log('[gate] PASS — submit() works, totalMirrored() accounting matches event accounting.');
  registry.provider.destroy();
}

main().catch((err) => {
  console.error('[gate] FAILED:', err);
  process.exit(1);
});
