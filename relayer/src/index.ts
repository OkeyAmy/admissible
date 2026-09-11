/**
 * relayer — the piece that lets the /app proof theatre reach stage 5.
 *
 * The browser build carries no private key on purpose (web/src/lib/config.ts
 * — VITE_DEMO_PRIVATE_KEY is empty by default and anything VITE_-prefixed is
 * readable in devtools anyway). This process holds the funded testnet key
 * instead, listens on a public-facing port, and submits proofs the browser
 * already built — but it never trusts the browser's bytes at face value: see
 * `handleMirror` below for the re-verification, dedupe, gas-cap, spend-cap
 * and rate-limit chain every request goes through before the key ever signs
 * anything.
 *
 * Node's own http module — no framework — per the brief to keep this small
 * and dependency-light.
 */
import './env.js';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Interface, formatEther, parseUnits } from 'ethers';
import {
  CREDITCOIN_CHAIN_ID,
  MIRROR_ACTION,
  NonceAllocator,
  RegistryNotDeployedError,
  getProof,
  getRegistry,
  isQueryProcessed,
  planGas,
  registryAbi,
  type ChainKey,
  type RegistryHandle,
} from '@admissible/sdk';

import { applyCors, GAS_CEILING, MAX_BODY_BYTES, PORT } from './config.js';
import { RATE_LIMIT_CAPACITY, RATE_LIMIT_PER_MIN, sweepStaleBuckets, takeToken } from './rateLimit.js';
import { ceilingWei, recordSpend, SPEND_CEILING_CTC, spentSoFarWei, wouldExceedCeiling } from './spendGuard.js';
import { appendRelayerReceipt, nowIso } from './receipts.js';
import { submitViaRegistry } from './submit-fix.js';
import { parseMirrorRequest, ValidationError, type MirrorRequestBody } from './validate.js';

function log(msg: string): void {
  console.log(`[relayer ${nowIso()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// One shared registry handle + nonce allocator for the process lifetime. The
// SDK's read helpers (isQueryProcessed, etc.) only call provider.destroy()
// when THEY constructed the handle — passing { registry } here means this
// process's provider is never torn down mid-flight.
// ---------------------------------------------------------------------------

let registry: RegistryHandle;
try {
  registry = getRegistry({});
} catch (err) {
  console.error(`[relayer] failed to construct registry handle: ${(err as Error).message}`);
  process.exit(1);
}
if (!registry.signer) {
  console.error('[relayer] no signer — set PRIVATE_KEY in the repo-root .env before starting the relayer.');
  process.exit(1);
}
const signer = registry.signer;
const nonces = new NonceAllocator(signer, await signer.getAddress());
const relayerAddress = await signer.getAddress();

log(`address ${relayerAddress}`);
log(`registry ${registry.address} on chainId ${CREDITCOIN_CHAIN_ID} (source: ${registry.addressSource})`);
log(`gas ceiling ${GAS_CEILING} · spend ceiling ${SPEND_CEILING_CTC} CTC · rate limit ${RATE_LIMIT_PER_MIN}/min (burst ${RATE_LIMIT_CAPACITY})`);

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new ValidationError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) throw new ValidationError('request body is empty');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('request body is not valid JSON');
  }
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

async function handleHealth(res: ServerResponse): Promise<void> {
  try {
    const balanceWei = await registry.provider.getBalance(relayerAddress);
    sendJson(res, 200, {
      ok: true,
      address: relayerAddress,
      balanceCtc: formatEther(balanceWei),
      registry: registry.address,
      chainId: CREDITCOIN_CHAIN_ID,
    });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /mirror
//
// Never trust the client's bundle. Every claimed field is re-derived from the
// prover service and compared before the funded key signs anything; the
// values actually submitted come from THIS process's re-derivation, not from
// the request body, so even a bug in the comparison could not get arbitrary
// calldata signed.
// ---------------------------------------------------------------------------

async function handleMirror(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req);
  const { allowed, retryAfterMs } = takeToken(ip);
  if (!allowed) {
    sendJson(res, 429, { ok: false, error: `rate limit exceeded — retry after ~${Math.ceil(retryAfterMs / 1000)}s` });
    return;
  }

  let body: MirrorRequestBody;
  try {
    const raw = await readJsonBody(req);
    body = parseMirrorRequest(raw);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: (err as Error).message });
    return;
  }

  const chainKey = body.chainKey as ChainKey;
  const actionLabel = body.action === MIRROR_ACTION ? 'mirror' : 'revoke';
  let queryId: string | null = null;
  let receiptBase = {
    sourceChainKey: chainKey,
    sourceTxHash: body.sourceTxHash,
    sourceBlock: body.blockHeight,
    action: actionLabel as 'mirror' | 'revoke',
    remoteAddress: ip,
  };

  try {
    // ---- re-derive the proof server-side; ignore the client's bytes from here on ----
    const { proof, latencyMs: proofLatencyMs } = await getProof(chainKey, body.sourceTxHash);

    const mismatches: string[] = [];
    if (proof.headerNumber !== body.blockHeight) mismatches.push('blockHeight');
    if (proof.txHash.toLowerCase() !== body.sourceTxHash.toLowerCase()) mismatches.push('sourceTxHash');
    if (proof.txBytes.toLowerCase() !== body.encodedTransaction.toLowerCase()) mismatches.push('encodedTransaction');
    if (proof.merkleProof.root.toLowerCase() !== body.merkleProof.root.toLowerCase()) mismatches.push('merkleProof.root');
    if (proof.merkleProof.siblings.length !== body.merkleProof.siblings.length) {
      mismatches.push('merkleProof.siblings.length');
    } else {
      for (let i = 0; i < proof.merkleProof.siblings.length; i++) {
        const a = proof.merkleProof.siblings[i]!;
        const b = body.merkleProof.siblings[i]!;
        if (a.hash.toLowerCase() !== b.hash.toLowerCase() || a.isLeft !== b.isLeft) {
          mismatches.push(`merkleProof.siblings[${i}]`);
          break;
        }
      }
    }
    // continuityProof is intentionally NOT compared strictly: batch.ts submits a
    // shared continuity proof spanning a whole block range, which will never
    // equal a single-transaction re-derivation here. The merkle proof above
    // already pins down which transaction is being mirrored; the continuity
    // proof used for submission is always this process's own re-derivation,
    // never the client's, so a mismatched continuityProof cannot smuggle
    // different calldata through — it can only make the submission use a
    // different (but still self-consistent, still server-derived) proof.

    if (mismatches.length > 0) {
      throw new ValidationError(
        `server-side re-derivation from the prover does not match the posted proof for chainKey ${chainKey} tx ${body.sourceTxHash}: ${mismatches.join(', ')}`,
      );
    }

    // ---- dedupe: never pay for a query the registry already has ----
    const dedupe = await isQueryProcessed(chainKey, proof.headerNumber, proof.txIndex, { registry });
    queryId = dedupe.queryId;
    receiptBase = { ...receiptBase, sourceBlock: proof.headerNumber };

    if (dedupe.processed) {
      await appendRelayerReceipt({
        easUid: null,
        ...receiptBase,
        continuityRoots: proof.continuityProof.roots.length,
        merkleSiblings: proof.merkleProof.siblings.length,
        queryId,
        batchIndex: 0,
        creditcoinTxHash: null,
        gasUsed: null,
        ctcCost: null,
        proofLatencyMs,
        submitLatencyMs: null,
        status: 'already-mirrored',
        error: null,
        attestationsWritten: null,
        producedBy: 'relayer',
        timestamp: nowIso(),
      });
      sendJson(res, 200, { ok: true, alreadyMirrored: true, queryId, creditcoinTxHash: null });
      return;
    }

    // ---- gas plan, capped ----
    const iface = new Interface(registryAbi());
    const args = [
      body.action,
      proof.chainKey,
      proof.headerNumber,
      proof.txHash,
      proof.txBytes,
      [proof.merkleProof.root, proof.merkleProof.siblings.map((s) => [s.hash, s.isLeft])],
      [proof.continuityProof.lowerEndpointDigest, proof.continuityProof.roots],
    ];
    const data = iface.encodeFunctionData('submit', args);
    const planned = await planGas(registry, data, relayerAddress, proof.continuityProof.roots.length);
    const gasLimit = planned.gasLimit > GAS_CEILING ? GAS_CEILING : planned.gasLimit;

    // ---- spend ceiling: worst-case cost at the current fee before signing ----
    const feeData = await registry.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    const maxCostWei = gasLimit * gasPrice;
    if (wouldExceedCeiling(maxCostWei)) {
      throw new Error(
        `submitting would exceed this process's spend ceiling of ${SPEND_CEILING_CTC} CTC (spent so far: ${formatEther(spentSoFarWei())} CTC, this tx could cost up to ${formatEther(maxCostWei)} CTC)`,
      );
    }

    // ---- submit ----
    const submitStarted = Date.now();
    let nonce: number;
    try {
      nonce = await nonces.take();
    } catch (err) {
      throw new Error(`nonce allocation failed: ${(err as Error).message}`);
    }

    let accounting;
    try {
      accounting = await submitViaRegistry(registry, body.action, proof, gasLimit, nonce);
    } catch (err) {
      await nonces.resync();
      throw err;
    }
    const submitLatencyMs = Date.now() - submitStarted;

    recordSpend(parseUnits(accounting.ctcCost, 18));

    if (accounting.status !== 1) {
      throw new Error(`Creditcoin transaction ${accounting.creditcoinTxHash} reverted (status ${accounting.status})`);
    }

    await appendRelayerReceipt({
      easUid: null,
      ...receiptBase,
      continuityRoots: proof.continuityProof.roots.length,
      merkleSiblings: proof.merkleProof.siblings.length,
      queryId,
      batchIndex: 0,
      creditcoinTxHash: accounting.creditcoinTxHash,
      gasUsed: accounting.gasUsed,
      ctcCost: accounting.ctcCost,
      proofLatencyMs,
      submitLatencyMs,
      status: 'mirrored',
      error: null,
      attestationsWritten: accounting.attestationsWritten,
      producedBy: 'relayer',
      timestamp: nowIso(),
    });

    sendJson(res, 200, {
      ok: true,
      creditcoinTxHash: accounting.creditcoinTxHash,
      blockNumber: accounting.blockNumber,
      gasUsed: accounting.gasUsed,
      ctcCost: accounting.ctcCost,
      queryId,
    });
  } catch (err) {
    const message = err instanceof RegistryNotDeployedError ? err.message : (err as Error).message;
    const status = err instanceof ValidationError ? 400 : 500;
    await appendRelayerReceipt({
      easUid: null,
      ...receiptBase,
      continuityRoots: null,
      merkleSiblings: null,
      queryId,
      batchIndex: 0,
      creditcoinTxHash: null,
      gasUsed: null,
      ctcCost: null,
      proofLatencyMs: null,
      submitLatencyMs: null,
      status: 'failed',
      error: message,
      attestationsWritten: null,
      producedBy: 'relayer',
      timestamp: nowIso(),
    });
    sendJson(res, status, { ok: false, error: message });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  applyCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    void handleHealth(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/mirror') {
    void handleMirror(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}  (GET /health, POST /mirror)`);
});

setInterval(sweepStaleBuckets, 5 * 60_000).unref();

// Never crash silently — an unhandled rejection here holds a funded key.
process.on('unhandledRejection', (reason) => {
  console.error('[relayer] unhandled rejection:', reason);
});
