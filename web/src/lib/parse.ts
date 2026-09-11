import type { ChainKey } from './types';

export interface ParsedInput {
  uid: string | null;
  /** Set when the pasted URL itself identifies the chain. */
  chainKey: ChainKey | null;
  error: string | null;
}

const UID_RE = /0x[0-9a-fA-F]{64}/;

/**
 * Accepts a raw 0x UID or a pasted easscan URL such as
 * https://easscan.org/attestation/view/0x… (mainnet) or
 * https://sepolia.easscan.org/attestation/view/0x… (Sepolia).
 */
export function parseUidInput(raw: string): ParsedInput {
  const value = raw.trim();
  if (!value) return { uid: null, chainKey: null, error: 'Enter an attestation UID.' };

  let chainKey: ChainKey | null = null;
  if (/sepolia\.easscan\.org/i.test(value)) chainKey = 1;
  else if (/(^|\/\/)(www\.)?easscan\.org/i.test(value)) chainKey = 3;

  const match = value.match(UID_RE);
  if (!match) {
    return {
      uid: null,
      chainKey,
      error: 'No 32-byte UID found. Expected 0x followed by 64 hex characters.',
    };
  }
  return { uid: match[0].toLowerCase(), chainKey, error: null };
}

export function isUid(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}
