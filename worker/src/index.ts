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
 * Revocation: `Revoked` events carry no `txid` in the easscan schema (verified
 * live via GraphQL introspection — only the ORIGINAL attesting tx's `txid` is
 * exposed), so easscan cannot resolve a revocation's source transaction. On
 * Sepolia (chainKey 1) this worker scans `eth_getLogs` directly for the
 * `Revoked` topic and reads `log.transactionHash` / `log.transactionIndex`
 * itself — no easscan round trip needed. On Ethereum mainnet (chainKey 3) the
 * public RPC has no `eth_getLogs`, so that path is structurally unavailable;
 * the worker says so explicitly (one receipts line per newly-revoked UID
 * easscan reports, status "failed", not silently skipped.
 *
 * Never double-submits: every group is checked against the registry's
 * `processedQueries` map (`isQueryProcessed`) before any prover/Creditcoin
 * work happens — the same guarantee `mirrorSchema`'s `skipExisting` documents
 * in the SDK, applied here by hand because of the `submit()` workaround.
 */
import './env.js';
import { JsonRpcProvider, Network } from 'ethers';
import {
  getRegistry,
  totals,
  listRecent,
  listRevoked,
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
 * Mainnet revocation discovery is structurally unavailable: easscan's schema
 * has no revocation-txid field (verified live via GraphQL introspection —
 * only the original attesting tx's `txid` is exposed) and Ethereum mainnet's
 * working public RPC has no archive `eth_getLogs` (SPEC.md §3), so there is
 * no way to obtain the Revoked event's own transaction for proving. Rather
 * than silently doing nothing, this logs the limitation as an explicit
 * failed attempt per newly-observed revoked UID — capped, and only once per
 * UID (`lastSeenRevokeTime` cursor).
 */
async function pollRevokeMainnetNotice(state: WorkerState): Promise<void> {
  const rows = await listRevoked(3, 20).catch(() => []);
  const cursor = state.chains['3'].lastSeenRevokeTime;
  const fresh = rows.filter((r) => r.revocationTime > cursor);
  if (fresh.length === 0) return;

  for (const r of fresh.slice(0, 10)) {
    await appendReceipt({
      easUid: r.uid,
      sourceChainKey: 3,
      sourceTxHash: r.txid,
      sourceBlock: null,
      continuityRoots: null,
      merkleSiblings: null,
      queryId: null,
      batchIndex: batchCounter++,
      creditcoinTxHash: null,
      gasUsed: null,
      ctcCost: null,
      proofLatencyMs: null,
      submitLatencyMs: null,
      status: 'failed',
      error:
        'Ethereum mainnet revocation discovery unavailable: easscan exposes no revocation-txid field (GraphQL introspection verified), and the working public mainnet RPC has no archive eth_getLogs (SPEC.md §3) to find the Revoked event directly. This UID is revoked on EAS mainnet per easscan but cannot be mirrored as revoked from this worker.',
      attestationsWritten: null,
      proofAttempts: null,
      batchTxCount: 1,
      producedBy: 'worker',
      action: 'revoke',
      timestamp: nowIso(),
    });
  }
  state.chains['3'].lastSeenRevokeTime = rows.reduce((m, r) => Math.max(m, r.revocationTime), cursor);
  log(`mainnet revoke notice — ${fresh.length} newly-revoked UIDs logged as unresolvable (RPC limitation)`);
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
      await pollRevokeMainnetNotice(state);
      log(`cycle ${cycle} done — mirrored ${mirrored1 + mirrored3} (sepolia ${mirrored1}, mainnet ${mirrored3}), revoked ${revoked1}`);
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
  registry.provider.destroy();
  log('worker stopped.');
}

main().catch((err) => {
  console.error('[worker] FATAL:', err);
  process.exitCode = 1;
});
