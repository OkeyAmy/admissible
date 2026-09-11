/**
 * Cursor persistence across restarts. Correctness does NOT depend on this —
 * every submission is preceded by an on-chain `processedQueries` check
 * (`isQueryProcessed`), so a lost or stale cursor costs re-querying easscan,
 * never a double-submit. This file just avoids re-walking the same easscan
 * pages and the same Sepolia log range on every restart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(here, '..'); // worker/
const STATE_PATH = resolve(STATE_DIR, 'state.json');

export interface ChainCursor {
  /** Newest easscan `time` (unix seconds) already considered for Mirror. */
  lastSeenAttestTime: number;
  /** Newest easscan `revocationTime` already considered for Revoke. */
  lastSeenRevokeTime: number;
}

export interface RevokeLogCursor {
  /** Next block to start scanning `Revoked` logs from (Sepolia only — see index.ts). */
  fromBlock: number;
}

export interface WorkerState {
  chains: Record<'1' | '3', ChainCursor>;
  sepoliaRevokeLog: RevokeLogCursor;
  /** Bumped every time the worker completes a poll cycle; informational only. */
  cycles: number;
  updatedAt: string;
}

function defaultState(): WorkerState {
  return {
    chains: {
      '1': { lastSeenAttestTime: 0, lastSeenRevokeTime: 0 },
      '3': { lastSeenAttestTime: 0, lastSeenRevokeTime: 0 },
    },
    sepoliaRevokeLog: { fromBlock: 0 },
    cycles: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function loadState(): WorkerState {
  if (!existsSync(STATE_PATH)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<WorkerState>;
    const base = defaultState();
    return {
      chains: { ...base.chains, ...(parsed.chains ?? {}) },
      sepoliaRevokeLog: { ...base.sepoliaRevokeLog, ...(parsed.sepoliaRevokeLog ?? {}) },
      cycles: parsed.cycles ?? 0,
      updatedAt: parsed.updatedAt ?? base.updatedAt,
    };
  } catch {
    return defaultState();
  }
}

export function saveState(state: WorkerState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
