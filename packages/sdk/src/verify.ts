import { ZeroHash, getAddress } from 'ethers';

import { sourceChain } from './config.js';
import { detectChainKey, resolveUid } from './eas.js';
import { RegistryNotDeployedError, getRegistry } from './registry.js';
import { emptyRecord, resolve } from './resolve.js';
import type { ChainKey, DiffRow, MirroredAttestation, ResolvedUid, VerifyReport } from './types.js';

/**
 * The crux.
 *
 * Read the record the Creditcoin registry holds for `(chainKey, uid)`, fetch
 * the same UID from easscan, and diff them field by field. easscan is an
 * independent surface the judge can hit themselves — that is the whole point.
 *
 * PASS requires all of:
 *   - the registry holds a record for this UID
 *   - easscan holds a record for this UID on the same chain
 *   - every compared field is byte-identical
 *
 * Anything else is FAIL, with the reason stated.
 */

export interface VerifyOptions {
  registryAddress?: string;
  creditcoinRpc?: string;
  easscanUrl?: string;
  sourceRpc?: string;
}

function fmtAddress(a: string | null | undefined): string {
  if (!a) return '—';
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}

function fmtBytes32(v: string | null | undefined): string {
  if (!v) return '—';
  return v.toLowerCase();
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

function fmtTime(unix: number): string {
  if (!unix) return '0';
  return `${unix} (${new Date(unix * 1000).toISOString().replace('.000Z', 'Z')})`;
}

export async function verify(uid: string, chainKey?: ChainKey, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const notes: string[] = [];
  const failures: string[] = [];

  let resolvedChainKey: ChainKey;
  if (chainKey) {
    resolvedChainKey = chainKey;
  } else {
    const detected = await detectChainKey(uid, { easscanUrl: opts.easscanUrl });
    if (detected === null) {
      notes.push('easscan has no record of this UID on either Sepolia or Ethereum mainnet; defaulting to chainKey 3 for the registry lookup.');
      resolvedChainKey = 3;
    } else {
      resolvedChainKey = detected;
      notes.push(`chain auto-detected from easscan: ${sourceChain(detected).name} (chainKey ${detected}).`);
    }
  }

  // --- easscan side (independent of anything we deployed) ---
  let eas: ResolvedUid | null = null;
  let easError: string | null = null;
  try {
    eas = await resolveUid(uid, resolvedChainKey, { easscanUrl: opts.easscanUrl, sourceRpc: opts.sourceRpc });
  } catch (err) {
    easError = (err as Error).message;
  }

  // --- registry side ---
  let registryRecord: MirroredAttestation | null = null;
  let registryAddress = '';
  let registryError: string | null = null;
  try {
    const handle = getRegistry({ registryAddress: opts.registryAddress, creditcoinRpc: opts.creditcoinRpc });
    registryAddress = handle.address;
    try {
      const rec = await resolve(resolvedChainKey, uid, { registry: handle });
      registryRecord = rec.exists ? rec : null;
      if (!rec.exists) registryRecord = null;
    } finally {
      handle.provider.destroy();
    }
  } catch (err) {
    if (err instanceof RegistryNotDeployedError) registryError = err.message;
    else registryError = (err as Error).message;
  }

  const mirrored = registryRecord !== null;
  const foundOnEas = eas !== null;

  if (registryError) failures.push(registryError);
  if (easError) failures.push(`easscan lookup failed: ${easError}`);
  if (!registryError && !mirrored) {
    failures.push(`Registry ${registryAddress || '(unknown)'} holds no record for (chainKey ${resolvedChainKey}, ${uid}). It has not been mirrored.`);
  }
  if (!easError && !foundOnEas) {
    failures.push(`easscan has no attestation ${uid} on ${sourceChain(resolvedChainKey).name}.`);
  }
  if (eas && !eas.txid) {
    notes.push('This is an offchain EAS attestation — easscan records no Ethereum transaction for it, so it cannot be proved on Creditcoin.');
  }
  if (eas && eas.txid && eas.block === null) {
    notes.push('The source-chain RPC returned no receipt for the attesting transaction, so the block number could not be cross-checked.');
  }

  const rec = registryRecord ?? emptyRecord(resolvedChainKey, uid);
  const rows: DiffRow[] = [];

  const push = (field: string, registryValue: string, easValue: string, match: boolean, informational = false) => {
    rows.push({ field, registry: registryValue, easscan: easValue, match, informational });
  };

  // uid
  push(
    'uid',
    mirrored ? fmtBytes32(rec.uid) : '—',
    foundOnEas ? fmtBytes32(eas!.uid) : '—',
    mirrored && foundOnEas && fmtBytes32(rec.uid) === fmtBytes32(eas!.uid),
  );

  // chainKey — informational: it is the lookup key on both sides.
  push('chainKey', String(rec.chainKey || resolvedChainKey), String(resolvedChainKey), true, true);

  push(
    'schemaUid',
    mirrored ? fmtBytes32(rec.schemaUid) : '—',
    foundOnEas ? fmtBytes32(eas!.schemaId) : '—',
    mirrored && foundOnEas && fmtBytes32(rec.schemaUid) === fmtBytes32(eas!.schemaId),
  );

  push(
    'attester',
    mirrored ? fmtAddress(rec.attester) : '—',
    foundOnEas ? fmtAddress(eas!.attester) : '—',
    mirrored && foundOnEas && sameAddress(rec.attester, eas!.attester),
  );

  push(
    'recipient',
    mirrored ? fmtAddress(rec.recipient) : '—',
    foundOnEas ? fmtAddress(eas!.recipient) : '—',
    mirrored && foundOnEas && sameAddress(rec.recipient, eas!.recipient),
  );

  push(
    'sourceTxHash',
    mirrored ? fmtBytes32(rec.sourceTxHash) : '—',
    foundOnEas ? fmtBytes32(eas!.txid) : '—',
    mirrored && foundOnEas && eas!.txid !== null && fmtBytes32(rec.sourceTxHash) === fmtBytes32(eas!.txid),
  );

  // sourceBlock — easscan does not expose it; the value comes from the source
  // chain's own RPC receipt, which is a third independent surface.
  const easBlock = eas?.block ?? null;
  push(
    'sourceBlock',
    mirrored ? String(rec.sourceBlock) : '—',
    easBlock === null ? '— (from source RPC)' : String(easBlock),
    mirrored && easBlock !== null && rec.sourceBlock === easBlock,
    easBlock === null,
  );

  push(
    'revoked',
    mirrored ? String(rec.revoked) : '—',
    foundOnEas ? String(eas!.revoked) : '—',
    mirrored && foundOnEas && rec.revoked === eas!.revoked,
  );

  push(
    'revokedAt',
    mirrored ? fmtTime(rec.revokedAt) : '—',
    foundOnEas ? fmtTime(eas!.revocationTime) : '—',
    mirrored && foundOnEas && rec.revokedAt === eas!.revocationTime,
  );

  // Registry-only rows — nothing on easscan to compare against.
  push('mirroredAt', mirrored ? fmtTime(rec.mirroredAt) : '—', '— (Creditcoin only)', true, true);

  for (const row of rows) {
    if (row.informational) continue;
    if (!row.match) {
      if (mirrored && foundOnEas) {
        failures.push(`field mismatch: ${row.field} — registry ${row.registry} vs easscan ${row.easscan}`);
      }
    }
  }

  const outcome: VerifyReport['outcome'] = failures.length === 0 && mirrored && foundOnEas ? 'PASS' : 'FAIL';

  return {
    uid,
    chainKey: resolvedChainKey,
    outcome,
    mirrored,
    foundOnEas,
    registryAddress,
    registry: registryRecord,
    eas,
    rows,
    failures,
    notes,
  };
}

/** True when the record exists, is not revoked, and matches easscan exactly. */
export function isAdmissible(report: VerifyReport): boolean {
  return report.outcome === 'PASS' && report.registry !== null && !report.registry.revoked;
}

export { ZeroHash };
