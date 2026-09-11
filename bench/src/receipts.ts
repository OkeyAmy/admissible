/**
 * receipts/mirrors.jsonl writer — SPEC.md §9 schema, one line per attempt.
 *
 * Granularity decision: one line PER UID, not per submit() call. A `multiAttest`
 * source transaction is one Creditcoin submission carrying many attestations;
 * sharing `queryId` / `creditcoinTxHash` / `batchIndex` across every UID in that
 * group means attestation count is derivable as line count, and transaction
 * count is derivable as the number of distinct `creditcoinTxHash` values (or
 * distinct `batchIndex` for attempts that never reached submission).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const RECEIPTS_DIR = resolve(here, '../../receipts');
export const MIRRORS_PATH = resolve(RECEIPTS_DIR, 'mirrors.jsonl');

mkdirSync(RECEIPTS_DIR, { recursive: true });

export interface ReceiptLine {
  easUid: string;
  sourceChainKey: 1 | 3;
  sourceTxHash: string | null;
  sourceBlock: number | null;
  continuityRoots: number | null;
  merkleSiblings: number | null;
  queryId: string | null;
  batchIndex: number;
  creditcoinTxHash: string | null;
  gasUsed: string | null;
  ctcCost: string | null;
  proofLatencyMs: number | null;
  submitLatencyMs: number | null;
  status: 'mirrored' | 'already-mirrored' | 'failed';
  error: string | null;
  /** Extra, additive fields — a superset of SPEC.md §9, not a replacement. */
  attestationsWritten: number | null;
  proofAttempts: number | null;
  batchTxCount: number;
  producedBy: 'bench' | 'worker';
  action: 'mirror' | 'revoke';
  timestamp: string;
}

let writeQueue: Promise<void> = Promise.resolve();

/** Serialised so concurrent workers never interleave partial JSON lines. */
export function appendReceipt(line: ReceiptLine): Promise<void> {
  writeQueue = writeQueue.then(() => {
    appendFileSync(MIRRORS_PATH, JSON.stringify(line) + '\n', 'utf8');
  });
  return writeQueue;
}

export function nowIso(): string {
  return new Date().toISOString();
}
