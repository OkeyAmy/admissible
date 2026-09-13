import type { ReceiptRow } from './types';

export interface BenchLatencyStats {
  median: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  n: number;
}

export interface BenchChainStats {
  chainKey: number;
  attestationsAttempted: number;
  mirrored: number;
  alreadyMirrored: number;
  failed: number;
  distinctTransactions: number;
  /** Present only in summary.json regenerated after the distinctUids rollout. */
  distinctUids?: number;
  ctcSpent: string;
  continuityRootsMin?: number | null;
  continuityRootsMax?: number | null;
  proofLatencyMs: BenchLatencyStats;
  submitLatencyMs: BenchLatencyStats;
}

export type BenchOverall = Omit<BenchChainStats, 'chainKey'>;

/** Shape of receipts/summary.json as written by the bench workspace. */
export interface BenchSummary {
  generatedAt: string;
  receiptsFile: string;
  totalLines: number;
  firstTimestamp?: string | null;
  lastTimestamp?: string | null;
  overall: BenchOverall;
  perChainKey: BenchChainStats[];
}

/** A single page of the server-side paged mirror log. */
export interface ReceiptsPage {
  rows: ReceiptRow[];
  page: number;
  pageSize: number;
  totalMatched: number;
  totalLines: number;
  totalPages: number;
  query: string;
}

async function tryFetchText(path: string): Promise<string | null> {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    // A dev server that falls through to index.html would hand back HTML.
    if (text.trimStart().startsWith('<')) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Fetches one page of mirrors.jsonl from the server-side paging endpoint
 * (?page=&pageSize=&q=). The browser only ever parses the current page, never
 * the whole file — see the download link in Receipts.tsx for full history.
 */
export async function loadReceiptsPage(opts: { page: number; pageSize: number; query: string }): Promise<{ page: ReceiptsPage | null; externalSummary: BenchSummary | null; present: string[]; notes: string[] }> {
  const notes: string[] = [];
  const present: string[] = [];

  const params = new URLSearchParams();
  params.set('page', String(opts.page));
  params.set('pageSize', String(opts.pageSize));
  if (opts.query.trim()) params.set('q', opts.query.trim());

  const [jsonText, summaryText] = await Promise.all([
    tryFetchText(`/receipts/mirrors.jsonl?${params.toString()}`),
    tryFetchText('/receipts/summary.json'),
  ]);

  let externalSummary: BenchSummary | null = null;
  if (summaryText) {
    present.push('summary.json');
    try {
      externalSummary = JSON.parse(summaryText) as BenchSummary;
    } catch {
      notes.push('receipts/summary.json is present but is not valid JSON.');
    }
  }

  let paged: ReceiptsPage | null = null;
  if (jsonText) {
    present.push('mirrors.jsonl');
    try {
      paged = JSON.parse(jsonText) as ReceiptsPage;
    } catch {
      notes.push('receipts/mirrors.jsonl paging endpoint returned invalid JSON.');
    }
  }

  return { page: paged, externalSummary, present, notes };
}