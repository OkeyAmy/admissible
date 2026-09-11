import { ZeroAddress, ZeroHash, type Signer } from 'ethers';

import { computeQueryId } from './attestcoin.js';
import { getRegistry, type RegistryHandle } from './registry.js';
import type { ChainKey, MirroredAttestation } from './types.js';

/**
 * Read side of the registry. Everything here is an `eth_call` over the public
 * Creditcoin RPC — no key, no cost.
 */

export interface ResolveOptions {
  registryAddress?: string;
  creditcoinRpc?: string;
  signer?: Signer;
  /** Reuse an already-constructed handle (the worker and bench do). */
  registry?: RegistryHandle;
}

function handle(opts: ResolveOptions): { r: RegistryHandle; owned: boolean } {
  if (opts.registry) return { r: opts.registry, owned: false };
  return { r: getRegistry({ registryAddress: opts.registryAddress, creditcoinRpc: opts.creditcoinRpc, signer: opts.signer }), owned: true };
}

const EMPTY: Omit<MirroredAttestation, 'chainKey' | 'uid'> = {
  schemaUid: ZeroHash,
  attester: ZeroAddress,
  recipient: ZeroAddress,
  sourceBlock: 0,
  sourceTxHash: ZeroHash,
  mirroredAt: 0,
  revoked: false,
  revokedAt: 0,
  exists: false,
};

/** `(chainKey, uid)` → the full mirrored record. `exists === false` if never mirrored. */
export async function resolve(chainKey: ChainKey, uid: string, opts: ResolveOptions = {}): Promise<MirroredAttestation> {
  const { r, owned } = handle(opts);
  try {
    const raw = await r.contract.attestationOf(chainKey, uid);
    return {
      chainKey: Number(raw.chainKey) as ChainKey,
      uid: raw.uid,
      schemaUid: raw.schemaUid,
      attester: raw.attester,
      recipient: raw.recipient,
      sourceBlock: Number(raw.sourceBlock),
      sourceTxHash: raw.sourceTxHash,
      mirroredAt: Number(raw.mirroredAt),
      revoked: Boolean(raw.revoked),
      revokedAt: Number(raw.revokedAt),
      exists: Boolean(raw.exists),
    };
  } finally {
    if (owned) r.provider.destroy();
  }
}

/** Same as `resolve`, but returns `null` instead of an empty record. */
export async function resolveOrNull(chainKey: ChainKey, uid: string, opts: ResolveOptions = {}): Promise<MirroredAttestation | null> {
  const rec = await resolve(chainKey, uid, opts);
  return rec.exists ? rec : null;
}

export function emptyRecord(chainKey: ChainKey, uid: string): MirroredAttestation {
  return { chainKey, uid, ...EMPTY };
}

/** True only if mirrored AND not revoked — the call other Creditcoin dApps make. */
export async function isValid(chainKey: ChainKey, uid: string, opts: ResolveOptions = {}): Promise<boolean> {
  const { r, owned } = handle(opts);
  try {
    return Boolean(await r.contract.isValid(chainKey, uid));
  } finally {
    if (owned) r.provider.destroy();
  }
}

export async function isValidFrom(
  chainKey: ChainKey,
  uid: string,
  attester: string,
  schemaUid: string,
  opts: ResolveOptions = {},
): Promise<boolean> {
  const { r, owned } = handle(opts);
  try {
    return Boolean(await r.contract.isValidFrom(chainKey, uid, attester, schemaUid));
  } finally {
    if (owned) r.provider.destroy();
  }
}

export interface RegistryTotals {
  totalMirrored: number;
  totalRevoked: number;
  easAddress: Record<ChainKey, string>;
}

export async function totals(opts: ResolveOptions = {}): Promise<RegistryTotals> {
  const { r, owned } = handle(opts);
  try {
    const [mirrored, revoked, eas1, eas3] = await Promise.all([
      r.contract.totalMirrored(),
      r.contract.totalRevoked(),
      r.contract.easAddress(1).catch(() => ZeroAddress),
      r.contract.easAddress(3).catch(() => ZeroAddress),
    ]);
    return {
      totalMirrored: Number(mirrored),
      totalRevoked: Number(revoked),
      easAddress: { 1: eas1, 3: eas3 },
    };
  } finally {
    if (owned) r.provider.destroy();
  }
}

/**
 * Has this exact source transaction already been proved? The registry dedupes
 * per transaction via `ASCBase.processedQueries`, so this is the check that
 * stops the worker from ever double-submitting.
 */
export async function isQueryProcessed(
  chainKey: ChainKey,
  blockHeight: number,
  txIndex: number,
  opts: ResolveOptions = {},
): Promise<{ processed: boolean; queryId: string }> {
  const queryId = computeQueryId(chainKey, blockHeight, txIndex);
  const { r, owned } = handle(opts);
  try {
    const processed = Boolean(await r.contract.processedQueries(queryId));
    return { processed, queryId };
  } finally {
    if (owned) r.provider.destroy();
  }
}

/** Bulk `exists` lookup — the bench uses it to skip work already on chain. */
export async function filterUnmirrored(
  chainKey: ChainKey,
  uids: string[],
  opts: ResolveOptions = {},
  concurrency = 8,
): Promise<string[]> {
  const { r, owned } = handle(opts);
  try {
    const out: string[] = [];
    for (let i = 0; i < uids.length; i += concurrency) {
      const slice = uids.slice(i, i + concurrency);
      const results = await Promise.all(
        slice.map(async (uid) => {
          try {
            const rec = await r.contract.attestationOf(chainKey, uid);
            return { uid, exists: Boolean(rec.exists) };
          } catch {
            return { uid, exists: false };
          }
        }),
      );
      for (const res of results) if (!res.exists) out.push(res.uid);
    }
    return out;
  } finally {
    if (owned) r.provider.destroy();
  }
}
