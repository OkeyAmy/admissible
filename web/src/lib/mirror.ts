import { AbiCoder, Contract, keccak256, Wallet } from 'ethers';
import { MIRROR_ACTION, REGISTRY_WRITE_ABI } from './abi';
import { DEMO_PRIVATE_KEY } from './config';
import { creditcoinProvider, locateSourceTx, readAttestedTip } from './chain';
import { fetchAttestation } from './easscan';
import { getAttestedHeight, getProofByTx, ProverError } from './prover';
import { readAttestation, resolveRegistryAddress } from './registry';
import type {
  ChainKey,
  MirroredAttestation,
  MirrorProgressDetail,
  PreviewEvent,
  ProofBundle,
} from './types';

/**
 * Server-side relayer that holds the funded Creditcoin key and submits on
 * this browser's behalf — see relayer/README.md. `VITE_RELAYER_URL` set
 * explicitly (including local dev's `http://localhost:8787`) is used as-is;
 * set it to the empty string to disable relaying entirely and fall straight
 * through to the needs-signer stop. Left unset, it resolves to the page's own
 * origin at runtime rather than a host baked in at build time — serve-static
 * proxies same-origin `/mirror` to the local relayer, so this stays correct
 * whether the site is reached by IP, domain, http, or https.
 */
const rawRelayerUrl = (import.meta.env as Record<string, string | undefined>).VITE_RELAYER_URL;
export const RELAYER_URL = (rawRelayerUrl === undefined ? window.location.origin : rawRelayerUrl).trim();

export interface RelayerMirrorRequest {
  action: number;
  chainKey: ChainKey;
  blockHeight: number;
  sourceTxHash: string;
  encodedTransaction: string;
  merkleProof: ProofBundle['merkleProof'];
  continuityProof: ProofBundle['continuityProof'];
}

export interface RelayerMirrorResponse {
  ok: boolean;
  creditcoinTxHash?: string | null;
  blockNumber?: number;
  gasUsed?: string;
  ctcCost?: string;
  queryId?: string;
  alreadyMirrored?: boolean;
  error?: string;
}

/**
 * POSTs the already-built proof to the relayer. Throws only on a network-
 * level failure (relayer not running, timeout, aborted) — an HTTP response
 * the relayer sent, `{ok:false,...}` included, is returned normally so the
 * caller can tell "relayer declined this submission" apart from "no relayer
 * reachable at all". Exported so batch.ts can reuse it instead of carrying a
 * second copy.
 */
export async function submitViaRelayer(baseUrl: string, body: RelayerMirrorRequest, signal?: AbortSignal): Promise<RelayerMirrorResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${baseUrl}/mirror`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return (await res.json()) as RelayerMirrorResponse;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Cheap reachability probe (GET /health, short timeout) — batch.ts uses this
 *  once per run to decide submission mode before committing a whole plan to it. */
export async function relayerReachable(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * ASCBase dedupes per transaction, not per UID: keccak(chainKey, blockHeight,
 * txIndex). SPEC §4 point 2 — a multiAttest transaction is one query carrying
 * many attestations.
 */
export function computeQueryId(chainKey: number, blockHeight: number, txIndex: number): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(['uint64', 'uint64', 'uint64'], [chainKey, blockHeight, txIndex]),
  );
}

/**
 * Asks the deployed registry what it would store for this proof. A view call:
 * no gas, no key, and it runs the same EASReader code path the write would.
 */
export async function previewAttested(
  registryAddress: string,
  chainKey: ChainKey,
  encodedTransaction: string,
): Promise<PreviewEvent[]> {
  const c = new Contract(registryAddress, [...REGISTRY_WRITE_ABI], creditcoinProvider());
  const events = await c.previewAttested(chainKey, encodedTransaction);
  return (events as unknown[]).map((e) => {
    const row = e as [string, string, string, string, string];
    return {
      emitter: String(row[0]),
      recipient: String(row[1]),
      attester: String(row[2]),
      schemaUid: String(row[3]),
      uid: String(row[4]),
    };
  });
}

/**
 * When @admissible/sdk lands this whole module becomes a thin wrapper around
 * its `mirror()`. The stage names, the MirrorProgress shape and the callback
 * contract are already identical to SPEC §7b, so the swap is mechanical.
 */

export interface MirrorOptions {
  uid: string;
  chainKey: ChainKey;
  onProgress: (p: MirrorProgressDetail) => void;
  signal?: AbortSignal;
  /** Poll interval while the source block is not yet attested. */
  pollMs?: number;
}

export interface MirrorOutcome {
  stage: 'mirrored' | 'failed' | 'needs-signer';
  record?: MirroredAttestation | null;
  proof?: ProofBundle;
  creditcoinTxHash?: string;
  error?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export function hasSigner(): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(DEMO_PRIVATE_KEY);
}

/**
 * Runs the five stages of SPEC §2 against live infrastructure and reports every
 * transition through onProgress. Stages 1–3 are entirely public reads and always
 * run for real. Stage 4 needs a funded signer; without one the run stops with
 * `needs-signer` rather than pretending.
 */
export async function mirror(opts: MirrorOptions): Promise<MirrorOutcome> {
  const { uid, chainKey, onProgress, signal } = opts;
  const pollMs = opts.pollMs ?? 6000;
  const emit = (p: MirrorProgressDetail) => onProgress(p);

  // ---------------------------------------------------------------- stage 1
  emit({ stage: 'resolving' });

  // A record already in the registry is the authoritative answer and needs no
  // signer at all — read it first.
  let existing: MirroredAttestation | null = null;
  try {
    if (await resolveRegistryAddress()) {
      existing = await readAttestation(chainKey, uid);
    }
  } catch {
    existing = null;
  }

  const eas = await fetchAttestation(chainKey, uid);
  if (!eas) {
    const message = `easscan has no attestation ${uid} on chainKey ${chainKey}.`;
    emit({ stage: 'failed', error: message });
    return { stage: 'failed', error: message };
  }
  if (!eas.txid) {
    const message =
      'This UID is an off-chain attestation — it was never written in an Ethereum transaction, so there is nothing to prove.';
    emit({ stage: 'failed', error: message });
    return { stage: 'failed', error: message };
  }

  const located = await locateSourceTx(chainKey, eas.txid);
  if (!located) {
    const message = `The source transaction ${eas.txid} was not found on the public RPC.`;
    emit({ stage: 'failed', error: message });
    return { stage: 'failed', error: message };
  }

  emit({
    stage: 'resolving',
    sourceTxHash: eas.txid,
    targetBlock: located.blockNumber,
    txIndex: located.txIndex,
  });

  if (existing) {
    emit({
      stage: 'mirrored',
      sourceTxHash: eas.txid,
      targetBlock: located.blockNumber,
      txIndex: located.txIndex,
      alreadyMirrored: true,
    });
    return { stage: 'mirrored', record: existing };
  }

  // ---------------------------------------------------------------- stage 2
  const targetBlock = located.blockNumber;
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    // The prover's own attestation cache gates proof-building, not the raw
    // on-chain precompile — a block can show attested on-chain slightly
    // before the prover's cache has ingested it, and proof-by-tx fails until
    // it has. So the prover's height is checked first; the ChainInfo
    // precompile 0x…0fd3 is only a fallback if that HTTP call itself fails.
    let attestedHeight: number;
    try {
      attestedHeight = await getAttestedHeight(chainKey, signal);
    } catch {
      const tip = await readAttestedTip(chainKey);
      attestedHeight = tip.height;
    }
    emit({ stage: 'awaiting-attestation', attestedHeight, targetBlock, sourceTxHash: eas.txid, txIndex: located.txIndex });
    if (attestedHeight >= targetBlock) break;
    await sleep(pollMs, signal);
  }

  // ---------------------------------------------------------------- stage 3
  const proofStart = performance.now();
  let proof: ProofBundle | null = null;
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    emit({ stage: 'building-proof', targetBlock, sourceTxHash: eas.txid, txIndex: located.txIndex });
    try {
      proof = await getProofByTx(chainKey, eas.txid, signal);
      break;
    } catch (e) {
      if (e instanceof ProverError && e.retryable) {
        // SPEC §3: BlockNotOnSourceChain is the reorg-protection window, not a
        // failure. Keep the run in the waiting state and say so plainly.
        emit({
          stage: 'building-proof',
          targetBlock,
          sourceTxHash: eas.txid,
          txIndex: located.txIndex,
          waitingForConfirmations: e.message,
        });
        await sleep(pollMs, signal);
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      emit({ stage: 'failed', error: message });
      return { stage: 'failed', error: message };
    }
  }
  const proofLatencyMs = performance.now() - proofStart;

  emit({
    stage: 'building-proof',
    targetBlock: proof.headerNumber,
    txIndex: proof.txIndex,
    sourceTxHash: proof.txHash,
    continuityRoots: proof.continuityProof.roots.length,
    merkleSiblings: proof.merkleProof.siblings.length,
    merkleRoot: proof.merkleProof.root,
    lowerEndpointDigest: proof.continuityProof.lowerEndpointDigest,
    txBytesLength: (proof.txBytes.length - 2) / 2,
    proofLatencyMs,
  });

  // ---------------------------------------------------------------- stage 4
  const registryAddress = await resolveRegistryAddress();
  const proofFacts: MirrorProgressDetail = {
    stage: 'submitting',
    continuityRoots: proof.continuityProof.roots.length,
    merkleSiblings: proof.merkleProof.siblings.length,
    targetBlock: proof.headerNumber,
    txIndex: proof.txIndex,
    sourceTxHash: proof.txHash,
    proofLatencyMs,
    queryId: computeQueryId(chainKey, proof.headerNumber, proof.txIndex),
  };

  if (!registryAddress) {
    const message = 'The registry address is not configured, so there is nothing to submit the proof to.';
    emit({ ...proofFacts, stage: 'failed', error: message, needsSigner: true });
    return { stage: 'needs-signer', proof, error: message };
  }

  // Ask the deployed contract what it would store. Free, keyless, and it runs
  // the real EASReader decode over the real foreign receipt logs.
  try {
    const [preview, queryProcessed] = await Promise.all([
      previewAttested(registryAddress, chainKey, proof.txBytes),
      new Contract(registryAddress, [...REGISTRY_WRITE_ABI], creditcoinProvider())
        .isQueryProcessed(proofFacts.queryId!)
        .then(Boolean)
        .catch(() => false),
    ]);
    proofFacts.preview = preview;
    proofFacts.queryProcessed = queryProcessed;
    emit({ ...proofFacts });
  } catch {
    emit({ ...proofFacts });
  }

  // Prefer the relayer: it holds the funded key server-side (relayer/README.md)
  // so this browser build never has to. Only fall back to a browser-held
  // signer (dev-only, VITE_DEMO_PRIVATE_KEY) or the honest needs-signer stop
  // when the relayer is not configured or not reachable.
  let relayerUnreachable: string | null = null;
  if (RELAYER_URL) {
    try {
      const relayed = await submitViaRelayer(
        RELAYER_URL,
        {
          action: MIRROR_ACTION,
          chainKey,
          blockHeight: proof.headerNumber,
          sourceTxHash: proof.txHash,
          encodedTransaction: proof.txBytes,
          merkleProof: proof.merkleProof,
          continuityProof: proof.continuityProof,
        },
        signal,
      );
      if (relayed.ok) {
        const creditcoinTxHash = relayed.creditcoinTxHash ?? undefined;
        const record = await readAttestation(chainKey, uid);
        emit({
          ...proofFacts,
          stage: 'mirrored',
          creditcoinTxHash,
          queryId: relayed.queryId ?? proofFacts.queryId,
          alreadyMirrored: relayed.alreadyMirrored,
        });
        return { stage: 'mirrored', record, proof, creditcoinTxHash };
      }
      // The relayer was reached and declined the submission (validation,
      // dedupe race, rate limit, spend ceiling, mismatched re-derivation,
      // ...) — that is a definite failure, not a reason to silently fall
      // back to a fake signature.
      const message = `Relayer at ${RELAYER_URL} declined the submission: ${relayed.error ?? 'unknown error'}`;
      emit({ ...proofFacts, stage: 'failed', error: message });
      return { stage: 'failed', proof, error: message };
    } catch (e) {
      // Network-level failure only (relayer not running, timed out, aborted)
      // — fall through to the local-signer / needs-signer paths below rather
      // than failing the whole run, since "no relayer running" is an
      // expected dev-time state, not a reason to abandon the honest fallback.
      relayerUnreachable = e instanceof Error ? e.message : String(e);
    }
  }

  if (!hasSigner()) {
    const message = relayerUnreachable
      ? `Proof built and checked against the deployed registry. No relayer reachable at ${RELAYER_URL} (${relayerUnreachable}), and this browser build carries no signer by design.`
      : 'Proof built and checked against the deployed registry. Submitting it costs CTC and needs a funded signer, which this browser build deliberately does not carry.';
    emit({ ...proofFacts, needsSigner: true, error: message });
    return { stage: 'needs-signer', proof, error: message };
  }

  try {
    const wallet = new Wallet(DEMO_PRIVATE_KEY, creditcoinProvider());
    const registry = new Contract(registryAddress, [...REGISTRY_WRITE_ABI], wallet);
    const tx = await registry.submit(
      MIRROR_ACTION,
      chainKey,
      proof.headerNumber,
      proof.txHash,
      proof.txBytes,
      [proof.merkleProof.root, proof.merkleProof.siblings.map((s) => [s.hash, s.isLeft])],
      [proof.continuityProof.lowerEndpointDigest, proof.continuityProof.roots],
    );
    emit({ ...proofFacts, creditcoinTxHash: tx.hash });
    await tx.wait();
    const record = await readAttestation(chainKey, uid);
    emit({ ...proofFacts, stage: 'mirrored', creditcoinTxHash: tx.hash });
    return { stage: 'mirrored', record, proof, creditcoinTxHash: tx.hash };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit({ ...proofFacts, stage: 'failed', error: message });
    return { stage: 'failed', proof, error: message };
  }
}
