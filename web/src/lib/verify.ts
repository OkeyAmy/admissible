import { fetchAttestation } from './easscan';
import { readAttestation, readIsValid, RegistryNotDeployedError, resolveRegistryAddress } from './registry';
import type { ChainKey, EasAttestation, MirroredAttestation } from './types';

export type FieldVerdict = 'match' | 'mismatch' | 'not-comparable';

export interface DiffRow {
  field: string;
  registry: string;
  easscan: string;
  verdict: FieldVerdict;
  mono: boolean;
  note?: string;
}

export interface VerifyResult {
  uid: string;
  chainKey: ChainKey;
  registryAddress: string;
  record: MirroredAttestation | null;
  eas: EasAttestation | null;
  isValid: boolean | null;
  rows: DiffRow[];
  /** PASS only when the record exists and every comparable field matches. */
  pass: boolean;
  /** Set when a verdict could not be reached at all. */
  blocked?: string;
}

const eq = (a: string | undefined | null, b: string | undefined | null) =>
  Boolean(a) && Boolean(b) && a!.toLowerCase() === b!.toLowerCase();

/**
 * The browser twin of `npx admissible verify`.
 *
 * Only fields that exist on both sides count towards the verdict. sourceBlock
 * and mirroredAt have no easscan counterpart, and revokedAt is a Creditcoin
 * timestamp while revocationTime is an Ethereum one — comparing those would
 * produce a spurious FAIL on a correct mirror, so they are reported as
 * not-comparable and excluded.
 */
export async function verifyUid(chainKey: ChainKey, uid: string): Promise<VerifyResult> {
  const registryAddress = await resolveRegistryAddress();
  const easPromise = fetchAttestation(chainKey, uid);

  let record: MirroredAttestation | null = null;
  let isValid: boolean | null = null;
  let blocked: string | undefined;

  if (!registryAddress) {
    blocked = 'The registry address is not configured yet, so there is no Creditcoin-side record to diff against.';
  } else {
    try {
      record = await readAttestation(chainKey, uid);
      isValid = record ? await readIsValid(chainKey, uid) : false;
    } catch (e) {
      if (e instanceof RegistryNotDeployedError) blocked = e.message;
      else blocked = `Creditcoin read failed: ${(e as Error).message}`;
    }
  }

  const eas = await easPromise;

  const rows: DiffRow[] = [];
  const comparable: boolean[] = [];

  const push = (field: string, registryValue: string, easValue: string, verdict: FieldVerdict, mono: boolean, note?: string) => {
    rows.push({ field, registry: registryValue, easscan: easValue, verdict, mono, note });
    if (verdict !== 'not-comparable') comparable.push(verdict === 'match');
  };

  const dash = '—';
  push(
    'uid',
    record?.uid ?? dash,
    eas?.id ?? dash,
    record && eas ? (eq(record.uid, eas.id) ? 'match' : 'mismatch') : 'not-comparable',
    true,
  );
  push(
    'attester',
    record?.attester ?? dash,
    eas?.attester ?? dash,
    record && eas ? (eq(record.attester, eas.attester) ? 'match' : 'mismatch') : 'not-comparable',
    true,
  );
  push(
    'recipient',
    record?.recipient ?? dash,
    eas?.recipient ?? dash,
    record && eas ? (eq(record.recipient, eas.recipient) ? 'match' : 'mismatch') : 'not-comparable',
    true,
  );
  push(
    'schemaUid',
    record?.schemaUid ?? dash,
    eas?.schemaId ?? dash,
    record && eas ? (eq(record.schemaUid, eas.schemaId) ? 'match' : 'mismatch') : 'not-comparable',
    true,
  );
  push(
    'sourceTxHash',
    record?.sourceTxHash ?? dash,
    eas?.txid || dash,
    record && eas?.txid ? (eq(record.sourceTxHash, eas.txid) ? 'match' : 'mismatch') : 'not-comparable',
    true,
  );
  push(
    'revoked',
    record ? String(record.revoked) : dash,
    eas ? String(eas.revoked) : dash,
    record && eas ? (record.revoked === eas.revoked ? 'match' : 'mismatch') : 'not-comparable',
    false,
  );
  push('sourceBlock', record ? String(record.sourceBlock) : dash, 'n/a', 'not-comparable', false, 'easscan does not expose the source block');
  push('mirroredAt', record ? String(record.mirroredAt) : dash, 'n/a', 'not-comparable', false, 'Creditcoin-side timestamp; no counterpart');
  push(
    'revokedAt',
    record ? String(record.revokedAt) : dash,
    eas ? String(eas.revocationTime) : dash,
    'not-comparable',
    false,
    'different clocks: Creditcoin block time vs Ethereum revocationTime',
  );

  const pass = Boolean(record) && Boolean(eas) && comparable.length > 0 && comparable.every(Boolean);

  return { uid, chainKey, registryAddress, record, eas, isValid, rows, pass, blocked };
}
