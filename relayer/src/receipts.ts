/**
 * receipts/relayer.jsonl writer — same schema shape as receipts/mirrors.jsonl
 * (SPEC.md §9), written to its own file so relayer-submitted mirrors are
 * distinguishable from bench/worker runs while still following the same
 * evidence discipline: one line per attempt, failures included.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const RECEIPTS_DIR = resolve(here, '../../receipts');
export const RELAYER_RECEIPTS_PATH = resolve(RECEIPTS_DIR, 'relayer.jsonl');

mkdirSync(RECEIPTS_DIR, { recursive: true });

export interface RelayerReceiptLine {
  easUid: string | null;
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
  attestationsWritten: number | null;
  producedBy: 'relayer';
  action: 'mirror' | 'revoke';
  remoteAddress: string | null;
  timestamp: string;
}

let writeQueue: Promise<void> = Promise.resolve();

/** Serialised so concurrent requests never interleave partial JSON lines. */
export function appendRelayerReceipt(line: RelayerReceiptLine): Promise<void> {
  writeQueue = writeQueue.then(() => {
    appendFileSync(RELAYER_RECEIPTS_PATH, JSON.stringify(line) + '\n', 'utf8');
  });
  return writeQueue;
}

export function nowIso(): string {
  return new Date().toISOString();
}
