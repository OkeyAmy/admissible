/**
 * bench — the evidence generator.
 *
 * Pulls real EAS attestation UIDs from easscan GraphQL on both source chains
 * (chainKey 1 = Sepolia, for volume; chainKey 3 = Ethereum mainnet, for
 * credibility), mirrors them into the Creditcoin registry through
 * `submitViaRegistry` (the `submit()` fix — see submit-fix.ts), and appends
 * one receipts/mirrors.jsonl line per UID for every attempt, success or
 * failure.
 *
 * Resumable: every tx group is checked against the registry's
 * `processedQueries` map before any prover/Creditcoin work happens, so a
 * killed-and-restarted run costs nothing extra and never double-submits.
 */
import './env.js';
import {
  getRegistry,
  totals,
  listSchemas,
  listBySchema,
  listRecent,
  groupByTx,
  attestedHeight,
  getProof,
  isQueryProcessed,
  computeQueryId,
  NonceAllocator,
  MIRROR_ACTION,
  type ChainKey,
  type TxGroup,
} from '@admissible/sdk';
import { submitViaRegistry } from './submit-fix.js';
import { appendReceipt, nowIso, type ReceiptLine } from './receipts.js';
import { hydrateBlocksFast } from './hydrate.js';

const CHAIN_KEYS: ChainKey[] = [1, 3];

// A bit above the documented reorg-protection windows so we never hand the
// prover a block it will reject with BlockNotOnSourceChain, and never stall
// a submission on waitUntilAttested.
const MARGIN: Record<ChainKey, number> = { 1: 40, 3: 60 };

const TARGET: Record<ChainKey, number> = {
  1: Number(process.env.BENCH_TARGET_SEPOLIA ?? 1500),
  3: Number(process.env.BENCH_TARGET_MAINNET ?? 150),
};

const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 6);
const SCHEMA_SAMPLE = Number(process.env.BENCH_SCHEMA_SAMPLE ?? 25);
const ROWS_PER_SCHEMA = Number(process.env.BENCH_ROWS_PER_SCHEMA ?? 150);
const RECENT_PAGE = 200;
const RECENT_MAX_PAGES = Number(process.env.BENCH_RECENT_MAX_PAGES ?? 60);
// easscan occasionally resets large/rapid connections (observed live: "TypeError:
// terminated" on take=400 while take=200 succeeded seconds later) — this caps how
// long the schema-weighted pass burns retrying before falling back to listRecent.
const SCHEMA_PASS_BUDGET_MS = Number(process.env.BENCH_SCHEMA_BUDGET_MS ?? 90_000);
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Candidate extends TxGroup {
  block: number;
  txIndex: number;
}

function log(msg: string): void {
  console.log(`[bench ${new Date().toISOString()}] ${msg}`);
}

/**
 * Gather tx groups to mirror on one chain, fattest (most UIDs per tx) first —
 * a `multiAttest` transaction is the only real multiplier: one Creditcoin
 * submission, many registry records.
 */
async function collectCandidates(chainKey: ChainKey, head: number, target: number): Promise<Candidate[]> {
  const margin = MARGIN[chainKey];
  const seenTx = new Set<string>();
  const groups: Candidate[] = [];

  function admit(gs: TxGroup[]) {
    for (const g of gs) {
      if (g.block === undefined || g.txIndex === undefined) continue;
      if (g.block > head - margin) continue; // too close to the reorg window / attestation lag
      if (seenTx.has(g.txid)) continue;
      seenTx.add(g.txid);
      groups.push(g as Candidate);
    }
  }

  // Pass 1: schema-weighted — favors multiAttest transactions.
  try {
    const schemas = await listSchemas(chainKey, SCHEMA_SAMPLE);
    schemas.sort((a, b) => b.attestationCount - a.attestationCount);
    log(`chainKey ${chainKey}: ${schemas.length} schemas, top attestationCounts = ${schemas.slice(0, 5).map((s) => s.attestationCount).join(', ')}`);
    const schemaPassDeadline = Date.now() + SCHEMA_PASS_BUDGET_MS;
    for (const s of schemas) {
      if (s.attestationCount === 0) continue;
      const have = groups.reduce((n, g) => n + g.uids.length, 0);
      if (have >= target) break;
      if (Date.now() > schemaPassDeadline) {
        log(`chainKey ${chainKey}: schema pass budget (${SCHEMA_PASS_BUDGET_MS}ms) exceeded, moving to the recent-timeline pass`);
        break;
      }
      try {
        const rows = await listBySchema(s.id, chainKey, ROWS_PER_SCHEMA);
        let g = groupByTx(rows, chainKey);
        g = await hydrateBlocksFast(g, chainKey);
        admit(g);
      } catch (err) {
        log(`chainKey ${chainKey}: schema ${s.id} listBySchema failed: ${(err as Error).message}`);
      }
      await sleep(250); // be gentle on easscan — avoid tripping its connection reset behavior
    }
  } catch (err) {
    log(`chainKey ${chainKey}: listSchemas failed, falling back to recent-only: ${(err as Error).message}`);
  }

  groups.sort((a, b) => b.uids.length - a.uids.length);

  // Pass 2: broad recent-timeline pages to fill the rest of the target.
  for (let page = 0; page < RECENT_MAX_PAGES; page++) {
    const have = groups.reduce((n, g) => n + g.uids.length, 0);
    if (have >= target) break;
    let rows;
    try {
      rows = await listRecent(chainKey, RECENT_PAGE, { skip: page * RECENT_PAGE });
    } catch (err) {
      log(`chainKey ${chainKey}: listRecent page ${page} failed: ${(err as Error).message}`);
      continue;
    }
    if (rows.length === 0) break;
    let g = groupByTx(rows, chainKey);
    g = await hydrateBlocksFast(g, chainKey);
    admit(g);
    await sleep(150);
  }

  const totalUids = groups.reduce((n, g) => n + g.uids.length, 0);
  log(`chainKey ${chainKey}: collected ${groups.length} tx groups / ${totalUids} UIDs (target ${target}, head ${head}, margin ${margin})`);
  return groups;
}

/**
 * Gas heuristic — skips eth_estimateGas (one fewer RPC round trip per
 * submission; the *reported* gasUsed always comes from the real receipt, so
 * over-provisioning gasLimit costs nothing extra — CTC cost is gasUsed ×
 * gasPrice, not gasLimit).
 *
 * Measured live (this run's own receipts): gasUsed for continuityRoots=972
 * was 1,012,775 (~700/root), but one continuityRoots=776 submission
 * consumed its ENTIRE 6,558,000 gasLimit and reverted out-of-gas — the
 * relationship is not simple linear per-root cost (likely driven by the
 * decoded receipt's total log count, which easscan doesn't expose ahead of
 * submission). Generous flat floor + per-root/per-uid slope, comfortably
 * under Creditcoin's measured 75,000,000 block gas limit.
 */
/**
 * Recalibrated from real receipts after the first ~250 live submissions.
 * Solved the per-root / per-uid coefficients from three actual (roots, uidCount,
 * gasUsed) data points: (91,1,390193), (997,4,1692627), (73,25,5276008) — real
 * per-uid storage cost came out near 204,000 gas (a `MirroredAttestation`
 * struct write is several SSTOREs plus the event), not the 80,000 first
 * assumed. That undershoot produced confirmed out-of-gas reverts on
 * perfectly valid 50-UID multiAttest transactions (gasUsed ~7.33M against a
 * ~7.44M limit, i.e. genuinely out of gas, not a decode/business-logic
 * revert — verified independently against the Sepolia receipt: canonical
 * EAS address, status 1, 50 matching Attested logs). Generous margin here
 * costs nothing extra — CTC cost is gasUsed × gasPrice, not gasLimit.
 */
function heuristicGasLimit(continuityRoots: number, uidCount: number): bigint {
  const limit = 1_200_000n + BigInt(continuityRoots) * 2_500n + BigInt(uidCount) * 280_000n;
  const cap = 70_000_000n; // Creditcoin CC3 testnet block gas limit measured at 75,000,000
  return limit > cap ? cap : limit;
}

let batchCounter = 0;

async function processGroup(
  chainKey: ChainKey,
  group: Candidate,
  registry: ReturnType<typeof getRegistry>,
  nonces: NonceAllocator,
): Promise<void> {
  const batchIndex = batchCounter++;
  const emit = (partial: Partial<ReceiptLine> & { easUid: string; status: ReceiptLine['status'] }) => {
    const line: ReceiptLine = {
      sourceChainKey: chainKey,
      sourceTxHash: group.txid,
      sourceBlock: group.block,
      continuityRoots: null,
      merkleSiblings: null,
      queryId: null,
      batchIndex,
      creditcoinTxHash: null,
      gasUsed: null,
      ctcCost: null,
      proofLatencyMs: null,
      submitLatencyMs: null,
      error: null,
      attestationsWritten: null,
      proofAttempts: null,
      batchTxCount: group.uids.length,
      producedBy: 'bench',
      action: 'mirror',
      timestamp: nowIso(),
      ...partial,
    };
    return appendReceipt(line);
  };

  // ---- dedupe pre-check: never pay for a query the registry already has ----
  let processed: boolean;
  let queryId: string;
  try {
    const r = await isQueryProcessed(chainKey, group.block, group.txIndex, { registry });
    processed = r.processed;
    queryId = r.queryId;
  } catch (err) {
    const message = (err as Error)?.message || (err as { code?: string })?.code || String(err) || 'unknown error (no message)';
    await Promise.all(group.uids.map((uid) => emit({ easUid: uid, status: 'failed', error: `dedupe check failed: ${message}` })));
    return;
  }

  if (processed) {
    await Promise.all(group.uids.map((uid) => emit({ easUid: uid, status: 'already-mirrored', queryId })));
    return;
  }

  // ---- proof (free — no CTC spent here) ----
  const proofStart = Date.now();
  let proof: Awaited<ReturnType<typeof getProof>>['proof'];
  let proofLatencyMs: number;
  let proofAttempts: number;
  try {
    const attempt = await getProof(chainKey, group.txid, { maxAttempts: 6, baseDelayMs: 4000 });
    proof = attempt.proof;
    proofLatencyMs = attempt.latencyMs;
    proofAttempts = attempt.attempts;
  } catch (err) {
    proofLatencyMs = Date.now() - proofStart;
    const message = (err as Error).message;
    await Promise.all(
      group.uids.map((uid) => emit({ easUid: uid, status: 'failed', error: message, queryId, proofLatencyMs })),
    );
    return;
  }

  const continuityRoots = proof.continuityProof.roots.length;
  const merkleSiblings = proof.merkleProof.siblings.length;
  // The precompile's own tx index is authoritative for the dedupe key.
  const effectiveQueryId = computeQueryId(chainKey, proof.headerNumber, proof.txIndex);

  // ---- submit (this costs CTC) ----
  const gasLimit = heuristicGasLimit(continuityRoots, group.uids.length);
  const nonce = await nonces.take();
  const submitStart = Date.now();
  try {
    const accounting = await submitViaRegistry(registry, MIRROR_ACTION, proof, gasLimit, nonce);
    const submitLatencyMs = Date.now() - submitStart;

    if (accounting.status !== 1) {
      await Promise.all(
        group.uids.map((uid) =>
          emit({
            easUid: uid,
            status: 'failed',
            error: `Creditcoin transaction reverted (status ${accounting.status})`,
            queryId: effectiveQueryId,
            continuityRoots,
            merkleSiblings,
            creditcoinTxHash: accounting.creditcoinTxHash,
            gasUsed: accounting.gasUsed,
            ctcCost: accounting.ctcCost,
            proofLatencyMs,
            submitLatencyMs,
            proofAttempts,
          }),
        ),
      );
      return;
    }

    const mirroredSet = new Set(accounting.mirroredUids.map((u) => u.toLowerCase()));
    await Promise.all(
      group.uids.map((uid) => {
        const hit = mirroredSet.has(uid.toLowerCase());
        return emit({
          easUid: uid,
          status: hit ? 'mirrored' : 'failed',
          error: hit ? null : 'uid not found among AttestationMirrored events for this transaction despite tx success',
          queryId: effectiveQueryId,
          continuityRoots,
          merkleSiblings,
          creditcoinTxHash: accounting.creditcoinTxHash,
          gasUsed: accounting.gasUsed,
          ctcCost: accounting.ctcCost,
          proofLatencyMs,
          submitLatencyMs,
          attestationsWritten: accounting.attestationsWritten,
          proofAttempts,
        });
      }),
    );
  } catch (err) {
    const submitLatencyMs = Date.now() - submitStart;
    const message = (err as Error).message ?? String(err);
    if (/Query already processed/i.test(message)) {
      await Promise.all(group.uids.map((uid) => emit({ easUid: uid, status: 'already-mirrored', queryId: effectiveQueryId, proofLatencyMs, proofAttempts })));
      return;
    }
    await nonces.resync();
    await Promise.all(
      group.uids.map((uid) =>
        emit({
          easUid: uid,
          status: 'failed',
          error: message,
          queryId: effectiveQueryId,
          continuityRoots,
          merkleSiblings,
          proofLatencyMs,
          submitLatencyMs,
          proofAttempts,
        }),
      ),
    );
  }
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  let done = 0;
  const total = items.length;
  async function lane(): Promise<void> {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await worker(items[i]!);
      done++;
      if (done % 25 === 0 || done === total) log(`progress: ${done}/${total} tx groups processed`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => lane()));
}

async function main() {
  log(`starting — targets: sepolia(1)=${TARGET[1]}, mainnet(3)=${TARGET[3]}, concurrency=${CONCURRENCY}`);
  const registry = getRegistry();
  if (!registry.signer) throw new Error('bench: no signer — set PRIVATE_KEY in .env');
  const signerAddress = await registry.signer.getAddress();
  log(`signer ${signerAddress}, registry ${registry.address} (source: ${registry.addressSource})`);

  const before = await totals({ registry });
  log(`registry before: totalMirrored=${before.totalMirrored} totalRevoked=${before.totalRevoked}`);

  const nonces = new NonceAllocator(registry.signer, signerAddress);

  const allCandidates: Array<{ chainKey: ChainKey; group: Candidate }> = [];
  for (const chainKey of CHAIN_KEYS) {
    const head = await attestedHeight(chainKey).catch((err) => {
      log(`chainKey ${chainKey}: attestedHeight failed, skipping: ${(err as Error).message}`);
      return -1;
    });
    if (head < 0) continue;
    const groups = await collectCandidates(chainKey, head, TARGET[chainKey]);
    for (const group of groups) allCandidates.push({ chainKey, group });
  }

  // Interleave chains (round-robin) so mainnet evidence isn't all clustered
  // at the end of the file, and keep each chain's own fattest-first order.
  const byChain: Record<ChainKey, Array<{ chainKey: ChainKey; group: Candidate }>> = { 1: [], 3: [] };
  for (const c of allCandidates) byChain[c.chainKey].push(c);
  const interleaved: Array<{ chainKey: ChainKey; group: Candidate }> = [];
  const maxLen = Math.max(byChain[1].length, byChain[3].length);
  for (let i = 0; i < maxLen; i++) {
    if (byChain[1][i]) interleaved.push(byChain[1][i]!);
    if (byChain[3][i]) interleaved.push(byChain[3][i]!);
  }

  log(`total candidate tx groups across both chains: ${interleaved.length}`);

  await runPool(interleaved, CONCURRENCY, ({ chainKey, group }) => processGroup(chainKey, group, registry, nonces));

  const after = await totals({ registry });
  log(`registry after: totalMirrored=${after.totalMirrored} totalRevoked=${after.totalRevoked} (delta ${after.totalMirrored - before.totalMirrored})`);

  registry.provider.destroy();
  log('done.');
}

main().catch((err) => {
  console.error('[bench] FATAL:', err);
  process.exitCode = 1;
});
