/**
 * The long-running mirror worker.
 *
 * Follows the shape of the organizer's official example
 * (github.com/gluwa/attestcoin-protocol-examples/blob/main/bridge/bridge-offchain-worker/worker.ts):
 * env-driven config, a graceful-shutdown flag on SIGINT/SIGTERM, and a
 * `while (!isShuttingDown)` poll loop with a fixed interval. Two deliberate
 * departures from that example, both forced by facts in SPEC.md §3:
 *
 *  1. Event DISCOVERY for Mirror uses easscan GraphQL on BOTH chains, not
 *     `contract.queryFilter`/`eth_getLogs` — Ethereum mainnet's working public
 *     RPC (`ethereum-rpc.publicnode.com`) has no archive `eth_getLogs`, so a
 *     log-polling loop like the example's `pollEvents` would silently see
 *     nothing on chainKey 3. Sepolia's public RPC DOES support `eth_getLogs`
 *     (SPEC.md §3), which is used, but only for Revoke discovery (see below) —
 *     Mirror discovery stays on easscan for both chains so the two code paths
 *     don't diverge.
 *
 *  2. Submission goes through `submitViaRegistry` (submit-fix.ts), not
 *     `contract.execute(...)` the way the official example's
 *     `submitProofToMinter` does — this registry's `execute` is a bare
 *     ASCBase entrypoint guarded to revert on direct calls; the real
 *     entrypoint is `submit(...)`. See submit-fix.ts for the full writeup.
 *
 * Revocation discovery:
 *  - Sepolia (chainKey 1): `Revoked` events carry no `txid` in the easscan
 *    schema (verified live via GraphQL introspection — only the ORIGINAL
 *    attesting tx's `txid` is exposed), so easscan cannot resolve a
 *    revocation's source transaction. This worker scans `eth_getLogs` on the
 *    Sepolia RPC for the `Revoked` topic and reads `log.transactionHash` /
 *    `log.transactionIndex` itself.
 *  - Mainnet (chainKey 3): the same easscan limitation applies, and the free
 *    public RPC serves `eth_getLogs` only for a shallow recent window
 *    (verified: ~1024 blocks; deeper ranges return an "archive requests
 *    require a personal token" error on publicnode). Two paths, in priority
 *    order:
 *      1. If `ETHERSCAN_API_KEY` is set (free, etherscan.io): backfill via the
 *         Etherscan V2 `getLogs` endpoint filtered on the `Revoked` topic,
 *         walking newest-blocks-first from head. Etherscan indexes the full
 *         history, so previously-unreachable old revocations become mirrorable
 *         and the observed `revoked=false`-despite-easscan gap closes.
 *      2. Otherwise, a rolling recent-window scan on the public RPC keeps new
 *         revocations flowing while the deep history stays unmirrorable.
 *
 * Never double-submits: every group is checked against the registry's
 * `processedQueries` map (`isQueryProcessed`) before any prover/Creditcoin
 * work happens — the same guarantee `mirrorSchema`'s `skipExisting` documents
 * in the SDK, applied here by hand because of the `submit()` workaround.
 */
import './env.js';
import { JsonRpcProvider, Network, type Log } from 'ethers';
import {
  getRegistry,
  totals,
  listRecent,
  groupByTx,
  hydrateBlocks,
  attestedHeight,
  getProof,
  isQueryProcessed,
  isRetryableProverError,
  computeQueryId,
  NonceAllocator,
  MIRROR_ACTION,
  REVOKE_ACTION,
  EAS_TOPICS,
  SOURCE_CHAINS,
  type ChainKey,
  type TxGroup,
  type RegistryHandle,
} from '@admissible/sdk';
import { submitViaRegistry } from './submit-fix.js';
import { appendReceipt, nowIso, type ReceiptLine } from './receipts.js';
import { loadState, saveState, type WorkerState } from './state.js';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 25_000);
const MIRROR_TAKE = Number(process.env.WORKER_MIRROR_TAKE ?? 80);
const REVOKE_LOG_CHUNK = Number(process.env.WORKER_REVOKE_LOG_CHUNK ?? 4_000);
const MARGIN: Record<ChainKey, number> = { 1: 40, 3: 60 };
/** Bound the demo run; unset (0) means run forever, matching the example's shape. */
const MAX_CYCLES = Number(process.env.WORKER_MAX_CYCLES ?? 0);
const SEPOLIA_EAS = SOURCE_CHAINS[1].eas;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? SOURCE_CHAINS[1].rpc;
const MAINNET_RPC = process.env.MAINNET_RPC ?? SOURCE_CHAINS[3].rpc;
const MAINNET_EAS = SOURCE_CHAINS[3].eas;

/**
 * Mainnet revocation discovery (chainKey 3). Free, no-key defaults and the
 * measures taken to stay inside them:
 *
 *  - The free public RPC (`ethereum-rpc.publicnode.com`) serves `eth_getLogs`
 *    only over a shallow recent window (~1024 blocks; deeper ranges error with
 *    "Archive requests require a personal token" — verified live). The recent
 *    scan therefore re-scans the rolling window every cycle instead of keeping
 *    a forward cursor; `isQueryProcessed` makes that safe.
 *  - The Etherscan V2 `getLogs` endpoint (free API key, etherscan.io) serves
 *    the FULL mainnet history filtered by topic, which unblocks backfilling
 *    old revocations end-to-end.
 */
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY?.trim() || '';
const ETHERSCAN_LOGS_URL = 'https://api.etherscan.io/v2/api';
/** Etherscan V2 free tier: ~1 req/s. Chunks are kept small and paced. */
const ETHERSCAN_CHUNK = Number(process.env.WORKER_MAINNET_REVOKE_CHUNK ?? 20_000);
const ETHERSCAN_PACE_MS = Number(process.env.WORKER_ETHERSCAN_PACE_MS ?? 350);
/** Hard per-cycle budget so a cycle neither starts a multi-hour backfill nor
 *  hammers the free tier; the walk resumes from `state.mainnetRevokeLog`. */
const MAINNET_REVOKE_GROUPS_PER_CYCLE = Number(process.env.WORKER_MAINNET_REVOKE_TAKE ?? 60);
const MAINNET_REVOKE_BLOCKS_PER_CYCLE = Number(process.env.WORKER_MAINNET_REVOKE_BLOCKS ?? 250_000);
/** Recent-window size used when no Etherscan key is configured. */
const MAINNET_REVOKE_RECENT_WINDOW = Number(process.env.WORKER_MAINNET_REVOKE_WINDOW ?? 700);
// Free mainnet RPCs are nondeterministically routed to archive-token-gated
// backends for eth_getLogs; try several hosts before giving up on a cycle.
const MAINNET_REVOKE_LOGS_RPCS = (process.env.WORKER_MAINNET_REVOKE_LOGS_RPCS ?? `${MAINNET_RPC},https://ethereum.publicnode.com,https://ethereum-rpc.publicnode.com`)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// How many consecutive cycles a slice may stall on `skipped-not-attested`
// (unprovable tx) before the backfill abandons it and walks past. Bounds the
// upstream prover's unknowable "will never be attestable" case so a single
// >500KB revoke tx cannot starve fresh revocations forever. Abandoned groups
// stay in the receipts file — nothing is silently dropped.
const MAINNET_REVOKE_MAX_SKIPPED = Number(process.env.WORKER_MAINNET_REVOKE_MAX_SKIPPED ?? 3);
/** Etherscan truncates big result sets; below this count we trust a chunk. */
const ETHERSCAN_TRUSTED_LOG_COUNT = 500;

let isShuttingDown = false;
process.on('SIGINT', () => {
  console.log('\n[worker] received SIGINT, shutting down gracefully...');
  isShuttingDown = true;
});
process.on('SIGTERM', () => {
  console.log('\n[worker] received SIGTERM, shutting down gracefully...');
  isShuttingDown = true;
});

function log(msg: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Recalibrated from real bench receipts — see bench/src/index.ts for the
 *  full write-up. Real per-uid registry-write cost measured near 204,000
 *  gas, not the 80,000 first assumed; the old heuristic produced genuine
 *  out-of-gas reverts on valid 50-UID multiAttest transactions. */
function heuristicGasLimit(continuityRoots: number, uidCount: number): bigint {
  const limit = 1_200_000n + BigInt(continuityRoots) * 2_500n + BigInt(uidCount) * 280_000n;
  const cap = 70_000_000n; // Creditcoin CC3 testnet block gas limit measured at 75,000,000
  return limit > cap ? cap : limit;
}

let batchCounter = 0;

interface Group {
  txid: string;
  block: number;
  txIndex: number;
  uids: string[];
}

/** Proof → submit → one receipt line per UID. Shared by both the Mirror and
 *  the Sepolia Revoke path; only `action` and `producedBy`/`action` differ. */
async function mirrorOrRevokeGroup(
  chainKey: ChainKey,
  group: Group,
  action: typeof MIRROR_ACTION | typeof REVOKE_ACTION,
  registry: RegistryHandle,
  nonces: NonceAllocator,
): Promise<'mirrored' | 'already-mirrored' | 'failed' | 'skipped-not-attested'> {
  const batchIndex = batchCounter++;
  const actionName = action === MIRROR_ACTION ? 'mirror' : 'revoke';
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
      producedBy: 'worker',
      action: actionName,
      timestamp: nowIso(),
      ...partial,
    };
    return appendReceipt(line);
  };

  let processed: boolean;
  let queryId: string;
  try {
    const r = await isQueryProcessed(chainKey, group.block, group.txIndex, { registry });
    processed = r.processed;
    queryId = r.queryId;
  } catch (err) {
    const message = (err as Error)?.message || (err as { code?: string })?.code || String(err) || 'unknown error (no message)';
    await Promise.all(group.uids.map((uid) => emit({ easUid: uid, status: 'failed', error: `dedupe check failed: ${message}` })));
    return 'failed';
  }

  if (processed) {
    await Promise.all(group.uids.map((uid) => emit({ easUid: uid, status: 'already-mirrored', queryId })));
    return 'already-mirrored';
  }

  const proofStart = Date.now();
  let proof: Awaited<ReturnType<typeof getProof>>['proof'];
  let proofLatencyMs: number;
  let proofAttempts: number;
  try {
    const attempt = await getProof(chainKey, group.txid, { maxAttempts: 5, baseDelayMs: 5000 });
    proof = attempt.proof;
    proofLatencyMs = attempt.latencyMs;
    proofAttempts = attempt.attempts;
  } catch (err) {
    proofLatencyMs = Date.now() - proofStart;
    const message = (err as Error).message;
    const retryable = isRetryableProverError(err);
    await Promise.all(
      group.uids.map((uid) =>
        emit({
          easUid: uid,
          status: 'failed',
          error: retryable ? `retryable (will be re-attempted next poll cycle): ${message}` : message,
          queryId,
          proofLatencyMs,
        }),
      ),
    );
    return retryable ? 'skipped-not-attested' : 'failed';
  }

  const continuityRoots = proof.continuityProof.roots.length;
  const merkleSiblings = proof.merkleProof.siblings.length;
  const effectiveQueryId = computeQueryId(chainKey, proof.headerNumber, proof.txIndex);

  const gasLimit = heuristicGasLimit(continuityRoots, group.uids.length);
  const nonce = await nonces.take();
  const submitStart = Date.now();
  try {
    const accounting = await submitViaRegistry(registry, action, proof, gasLimit, nonce);
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
      return 'failed';
    }

    const writtenSet = new Set([...accounting.mirroredUids, ...accounting.revokedUids].map((u) => u.toLowerCase()));
    await Promise.all(
      group.uids.map((uid) => {
        const hit = writtenSet.has(uid.toLowerCase());
        return emit({
          easUid: uid,
          status: hit ? 'mirrored' : 'failed',
          error: hit ? null : `uid not found among Attestation${action === MIRROR_ACTION ? 'Mirrored' : 'Revoked'} events despite tx success`,
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
    return 'mirrored';
  } catch (err) {
    const submitLatencyMs = Date.now() - submitStart;
    const message = (err as Error).message ?? String(err);
    if (/Query already processed/i.test(message)) {
      await Promise.all(group.uids.map((uid) => emit({ easUid: uid, status: 'already-mirrored', queryId: effectiveQueryId, proofLatencyMs, proofAttempts })));
      return 'already-mirrored';
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
    return 'failed';
  }
}

/** Mirror pass — easscan discovery on BOTH chains (see file header for why). */
async function pollMirror(chainKey: ChainKey, registry: RegistryHandle, nonces: NonceAllocator, state: WorkerState): Promise<number> {
  const head = await attestedHeight(chainKey).catch((err) => {
    log(`chainKey ${chainKey}: attestedHeight failed: ${(err as Error).message}`);
    return -1;
  });
  if (head < 0) return 0;

  const rows = await listRecent(chainKey, MIRROR_TAKE).catch((err) => {
    log(`chainKey ${chainKey}: listRecent failed: ${(err as Error).message}`);
    return [];
  });
  if (rows.length === 0) return 0;

  let groups: TxGroup[] = groupByTx(rows, chainKey);
  groups = await hydrateBlocks(groups, chainKey);

  const margin = MARGIN[chainKey];
  const ready = groups.filter((g): g is TxGroup & { block: number; txIndex: number } => g.block !== undefined && g.txIndex !== undefined && g.block <= head - margin);

  let acted = 0;
  for (const g of ready) {
    const outcome = await mirrorOrRevokeGroup(chainKey, g, MIRROR_ACTION, registry, nonces);
    if (outcome === 'mirrored') acted++;
  }

  const maxTime = rows.reduce((m, r) => Math.max(m, r.time), state.chains[String(chainKey) as '1' | '3'].lastSeenAttestTime);
  state.chains[String(chainKey) as '1' | '3'].lastSeenAttestTime = maxTime;

  log(`chainKey ${chainKey}: mirror pass — ${rows.length} easscan rows, ${groups.length} tx groups, ${ready.length} past reorg margin, ${acted} newly mirrored`);
  return acted;
}

/** Revoke pass, Sepolia only — direct eth_getLogs, no easscan round trip. */
async function pollRevokeSepolia(provider: JsonRpcProvider, registry: RegistryHandle, nonces: NonceAllocator, state: WorkerState): Promise<number> {
  const head = await provider.getBlockNumber();
  const margin = MARGIN[1];
  const safeHead = head - margin;
  const from = state.sepoliaRevokeLog.fromBlock || Math.max(0, safeHead - 5_000);
  if (from > safeHead) return 0;

  const groups = new Map<string, Group>();
  let cursor = from;
  let acted = 0;

  while (cursor <= safeHead) {
    const to = Math.min(cursor + REVOKE_LOG_CHUNK - 1, safeHead);
    try {
      const logs = await provider.getLogs({ address: SEPOLIA_EAS, topics: [EAS_TOPICS.Revoked], fromBlock: cursor, toBlock: to });
      for (const l of logs) {
        // SPEC.md §3: topics[0]=sig, topics[1]=recipient, topics[2]=attester,
        // topics[3]=schemaUID, data=uid (32 bytes) — the ABI encoding of a
        // single non-indexed bytes32 IS the raw 32-byte value, so `data` can
        // be used directly as the uid with no further decoding.
        const uid = l.data;
        const g = groups.get(l.transactionHash) ?? { txid: l.transactionHash, block: l.blockNumber, txIndex: l.transactionIndex, uids: [] };
        if (!g.uids.includes(uid)) g.uids.push(uid);
        groups.set(l.transactionHash, g);
      }
      cursor = to + 1;
    } catch (err) {
      log(`sepolia revoke log scan ${cursor}-${to} failed: ${(err as Error).message}`);
      break; // leave cursor where it is; retried next cycle
    }
  }

  for (const g of groups.values()) {
    const outcome = await mirrorOrRevokeGroup(1, g, REVOKE_ACTION, registry, nonces);
    if (outcome === 'mirrored') acted++;
  }

  state.sepoliaRevokeLog.fromBlock = cursor;
  if (groups.size > 0 || cursor > from) {
    log(`sepolia revoke pass — scanned blocks ${from}-${cursor - 1}, ${groups.size} revoke tx groups, ${acted} newly revoked`);
  }
  return acted;
}

/**
 * Etherscan V2 `getLogs`, filtered to the EAS `Revoked` topic on chainKey 3.
 * Returns one entry per log. Free tier needs an API key (etherscan.io); the
 * V2 endpoint is authenticated via `apikey` (V1 is deprecated — verified live:
 * V1 answers "deprecated", V2 schema accepts `module=logs&action=getLogs`).
 */
interface EtherscanLog {
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  data: string;
}

async function fetchEtherscanRevokeLogs(fromBlock: number, toBlock: number, key: string): Promise<EtherscanLog[]> {
  const url = new URL(ETHERSCAN_LOGS_URL);
  url.searchParams.set('chainid', '1');
  url.searchParams.set('module', 'logs');
  url.searchParams.set('action', 'getLogs');
  url.searchParams.set('address', MAINNET_EAS);
  url.searchParams.set('topic0', EAS_TOPICS.Revoked);
  url.searchParams.set('fromBlock', String(fromBlock));
  url.searchParams.set('toBlock', String(toBlock));
  url.searchParams.set('apikey', key);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`etherscan getLogs ${fromBlock}-${toBlock}: HTTP ${res.status}`);
  const body = (await res.json()) as { status: string; message?: string; result?: EtherscanLog[] };
  // Etherscan encodes a legitimate zero-match query as status "0" with
  // message "No records found" and result: [] — not an error (verified live).
  // Only status "0" with anything else, or a missing/non-array result, is
  // a real failure worth retrying.
  if (body.status === '0' && body.message === 'No records found' && Array.isArray(body.result)) {
    return body.result;
  }
  if (body.status !== '1' || !Array.isArray(body.result)) {
    throw new Error(`etherscan getLogs ${fromBlock}-${toBlock}: ${String(body.message ?? body.status)}`);
  }
  return body.result;
}

function revokeGroupsFromLogs(logs: EtherscanLog[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const l of logs) {
    // Revoked address-indexed(address,address,bytes32,bytes32): topics =
    // [sig, recipient, attester, schemaUID], data = the non-indexed bytes32
    // uid — a single bytes32 ABI-encodes as its raw 32 bytes (SPEC.md §3).
    const uid = /^0x[0-9a-fA-F]{64}$/.test(l.data) ? l.data.toLowerCase() : null;
    if (!uid) continue;
    const block = Number(l.blockNumber);
    const g = groups.get(l.transactionHash) ?? { txid: l.transactionHash, block, txIndex: Number(l.transactionIndex), uids: [] };
    if (!g.uids.includes(uid)) g.uids.push(uid);
    groups.set(l.transactionHash, g);
  }
  return groups;
}

/**
 * Mainnet revocation backfill, newest-first over full history. Walks downward
 * from `head - margin` in `ETHERSCAN_CHUNK` slices, submits every group found
 * (dedupe is on-chain via `isQueryProcessed`), and only advances the cursor
 * past a slice whose groups all reached a terminal outcome. A retryable
 * prover failure (`skipped-not-attested`) leaves the cursor in place — but
 * only for `MAINNET_REVOKE_MAX_SKIPPED` consecutive cycles, after which the
 * slice is abandoned and the walk continues, so one permanently unprovable
 * group cannot starve fresh revocations during continuous operation. Budgeted
 * per cycle (blocks walked and groups submitted) so the first-ever boot does
 * not start a multi-hour sweep.
 */
async function pollRevokeMainnetEtherscan(
  mainnetHead: number,
  registry: RegistryHandle,
  nonces: NonceAllocator,
  state: WorkerState,
): Promise<number> {
  const target = Math.max(0, mainnetHead - MARGIN[3]);
  let cursor = Math.max(state.mainnetRevokeLog.fromBlock, 0);
  if (cursor >= target) return 0;

  let acted = 0;
  let processedBlocks = 0;
  let high = target;
  while (high > cursor && processedBlocks < MAINNET_REVOKE_BLOCKS_PER_CYCLE) {
    let low = Math.max(cursor, high - ETHERSCAN_CHUNK + 1);
    let logs: EtherscanLog[] | null = null;
    try {
      logs = await fetchEtherscanRevokeLogs(low, high, ETHERSCAN_API_KEY);
    } catch (err) {
      log(`mainnet revoke etherscan ${low}-${high} failed: ${(err as Error).message}`);
      break; // keep cursor; retried next cycle
    }

    // Etherscan free tier truncates oversized result sets — shrink the slice
    // to a fixed tail and re-fetch rather than silently processing a partial
    // and advancing past the remainder. (Rare: it needs 500+ Revoked logs in
    // one 1000-block window.) A saturated 1000-block tail is the granularity
    // limit of this cheap path; we process it and move on.
    let shrinkFailed = false;
    while (logs[0] && logs.length >= ETHERSCAN_TRUSTED_LOG_COUNT && high - low > 1_000) {
      low = high - 999;
      try {
        logs = await fetchEtherscanRevokeLogs(low, high, ETHERSCAN_API_KEY);
      } catch (err) {
        log(`mainnet revoke etherscan ${low}-${high} (shrunk) failed: ${(err as Error).message}`);
        shrinkFailed = true;
        break;
      }
    }
    // A failed shrink re-fetch leaves `logs` holding the stale, untrusted
    // oversized result from before the shrink attempt — processing it and
    // advancing the cursor past `high` would silently drop whatever
    // revocations didn't fit in that truncated set. Retry the whole slice
    // next cycle instead, same as the outer fetch failure above.
    if (shrinkFailed) break;
    if (logs.length === 0) {
      cursor = low;
      state.mainnetRevokeLog.fromBlock = cursor;
      processedBlocks += high - low + 1;
      high = cursor - 1;
      await sleep(ETHERSCAN_PACE_MS);
      continue;
    }

    const groups = revokeGroupsFromLogs(logs);
    await sleep(ETHERSCAN_PACE_MS);

    let budgetHit = false;
    let unattested = 0;
    for (const g of groups.values()) {
      if (acted >= MAINNET_REVOKE_GROUPS_PER_CYCLE) {
        budgetHit = true; // budget hit — leave the slice for next cycle
        break;
      }
      const outcome = await mirrorOrRevokeGroup(3, g, REVOKE_ACTION, registry, nonces);
      if (outcome === 'mirrored') acted++;
      if (outcome === 'skipped-not-attested') unattested++;
      if (outcome === 'failed') log(`mainnet revoke group ${g.txid} (block ${g.block}) failed permanently; logged to receipts and skipped`);
    }

    if (budgetHit) break;

    if (unattested > 0) {
      const prev = state.mainnetRevokeStuck;
      state.mainnetRevokeStuck = prev.atBlock === low
        ? { atBlock: low, count: prev.count + 1 }
        : { atBlock: low, count: 1 };
      const stuck = state.mainnetRevokeStuck;
      if (stuck.count < MAINNET_REVOKE_MAX_SKIPPED) {
        log(`mainnet revoke: slice anchored ${low} unattested (${unattested} group(s)) — cycle ${stuck.count}/${MAINNET_REVOKE_MAX_SKIPPED}; leaving for next cycle`);
        break;
      }
      log(`mainnet revoke: abandoning slice anchored ${low} after ${stuck.count} unattested cycles — ${unattested} unprovable group(s) logged to receipts and skipped`);
      state.mainnetRevokeStuck = { atBlock: 0, count: 0 }; // fall through: advance the walk
    }

    cursor = low;
    state.mainnetRevokeLog.fromBlock = cursor;
    processedBlocks += high - low + 1;
    high = cursor - 1;
  }

  log(
    `mainnet revoke pass — etherscan ${state.mainnetRevokeLog.fromBlock}-${target}, ` +
      `${acted} newly revoked, ${processedBlocks} blocks walked this cycle`,
  );
  return acted;
}

/** No-key fallback: rolling recent-window scan on the public RPC (~1024-block
 *  free window on publicnode, verified live). Re-scans the window every cycle;
 *  on-chain dedupe keeps it idle-cheap when nothing new has been revoked. */
async function pollRevokeMainnetRecent(
  provider: JsonRpcProvider,
  registry: RegistryHandle,
  nonces: NonceAllocator,
): Promise<number> {
  const head = await provider.getBlockNumber().catch((err) => {
    log(`mainnet revoke recent head failed: ${(err as Error).message}`);
    return -1;
  });
  if (head < 0) return 0;
  const safeTo = Math.max(0, head - MARGIN[3]);
  const from = Math.max(0, safeTo - MAINNET_REVOKE_RECENT_WINDOW);

  let logs: Log[] | null = null;
  for (const rpc of MAINNET_REVOKE_LOGS_RPCS) {
    try {
      const p = rpc === MAINNET_RPC
        ? provider
        : new JsonRpcProvider(rpc, Network.from(1), { staticNetwork: true, batchMaxCount: 1 });
      try {
        logs = await p.getLogs({ address: MAINNET_EAS, topics: [EAS_TOPICS.Revoked], fromBlock: from, toBlock: safeTo });
        break;
      } finally {
        if (p !== provider) p.destroy();
      }
    } catch (err) {
      log(`mainnet revoke recent scan ${from}-${safeTo} on ${rpc} failed: ${(err as Error).message}`);
      logs = null;
    }
  }
  if (!logs || logs.length === 0) {
    log(`mainnet revoke pass — recent scan blocks ${from}-${safeTo}: 0 revoke logs (no Etherscan key set; historical backfill off)`);
    return 0;
  }

  const groups = new Map<string, Group>();
  for (const l of logs) {
    const uid = /^0x[0-9a-fA-F]{64}$/.test(l.data) ? l.data.toLowerCase() : null;
    if (!uid) continue;
    const g = groups.get(l.transactionHash) ?? { txid: l.transactionHash, block: l.blockNumber, txIndex: l.transactionIndex, uids: [] };
    if (!g.uids.includes(uid)) g.uids.push(uid);
    groups.set(l.transactionHash, g);
  }

  let acted = 0;
  for (const g of groups.values()) {
    const outcome = await mirrorOrRevokeGroup(3, g, REVOKE_ACTION, registry, nonces);
    if (outcome === 'mirrored') acted++;
  }
  log(`mainnet revoke pass — recent scan blocks ${from}-${safeTo}, ${groups.size} revoke tx groups, ${acted} newly revoked`);
  return acted;
}

async function pollRevokeMainnet(
  provider: JsonRpcProvider,
  registry: RegistryHandle,
  nonces: NonceAllocator,
  state: WorkerState,
): Promise<number> {
  if (!ETHERSCAN_API_KEY) return pollRevokeMainnetRecent(provider, registry, nonces);
  const head = await provider.getBlockNumber().catch((err) => {
    log(`mainnet head failed: ${(err as Error).message}`);
    return -1;
  });
  if (head < 0) return 0;
  return pollRevokeMainnetEtherscan(head, registry, nonces, state);
}

async function main() {
  log(`starting — poll interval ${POLL_INTERVAL_MS}ms, mirror take ${MIRROR_TAKE}, maxCycles ${MAX_CYCLES || 'unbounded'}`);
  const registry = getRegistry();
  if (!registry.signer) throw new Error('worker: no signer — set PRIVATE_KEY in .env');
  const signerAddress = await registry.signer.getAddress();
  log(`signer ${signerAddress}, registry ${registry.address} (source: ${registry.addressSource})`);

  const before = await totals({ registry });
  log(`registry at startup: totalMirrored=${before.totalMirrored} totalRevoked=${before.totalRevoked}`);

  const nonces = new NonceAllocator(registry.signer, signerAddress);
  const sepoliaProvider = new JsonRpcProvider(SEPOLIA_RPC, Network.from(11155111), { staticNetwork: true, batchMaxCount: 1 });
  const mainnetProvider = new JsonRpcProvider(MAINNET_RPC, Network.from(1), { staticNetwork: true, batchMaxCount: 1 });

  const state = loadState();
  let cycle = 0;

  while (!isShuttingDown) {
    cycle++;
    state.cycles++;
    log(`cycle ${cycle} starting`);
    try {
      const mirrored1 = await pollMirror(1, registry, nonces, state);
      const mirrored3 = await pollMirror(3, registry, nonces, state);
      const revoked1 = await pollRevokeSepolia(sepoliaProvider, registry, nonces, state);
      const revoked3 = await pollRevokeMainnet(mainnetProvider, registry, nonces, state);
      log(`cycle ${cycle} done — mirrored ${mirrored1 + mirrored3} (sepolia ${mirrored1}, mainnet ${mirrored3}), revoked ${revoked1 + revoked3} (sepolia ${revoked1}, mainnet ${revoked3})`);
    } catch (err) {
      log(`cycle ${cycle} FAILED: ${(err as Error).message}`);
    }
    saveState(state);

    if (MAX_CYCLES > 0 && cycle >= MAX_CYCLES) {
      log(`reached WORKER_MAX_CYCLES=${MAX_CYCLES}, stopping.`);
      break;
    }
    if (!isShuttingDown) await sleep(POLL_INTERVAL_MS);
  }

  const after = await totals({ registry });
  log(`registry at shutdown: totalMirrored=${after.totalMirrored} totalRevoked=${after.totalRevoked}`);
  sepoliaProvider.destroy();
  mainnetProvider.destroy();
  registry.provider.destroy();
  log('worker stopped.');
}

main().catch((err) => {
  console.error('[worker] FATAL:', err);
  process.exitCode = 1;
});
