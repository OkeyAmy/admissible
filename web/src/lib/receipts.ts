import { median, percentile } from './format';
import type { ReceiptRow } from './types';

export interface ReceiptsSummary {
  attempts: number;
  mirrored: number;
  failed: number;
  other: number;
  distinctUids: number;
  distinctCreditcoinTxs: number;
  proofMedianMs: number | null;
  proofP95Ms: number | null;
  submitMedianMs: number | null;
  submitP95Ms: number | null;
  continuityRootsMin: number | null;
  continuityRootsMax: number | null;
  totalCtc: number | null;
  byChainKey: Record<number, number>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export interface ReceiptsPayload {
  rows: ReceiptRow[];
  summary: ReceiptsSummary | null;
  /** summary.json as written by the bench workspace, if present. */
  externalSummary: Record<string, unknown> | null;
  present: string[];
  /** Non-fatal notes: malformed lines, missing files. */
  notes: string[];
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

export async function loadReceipts(): Promise<ReceiptsPayload> {
  const notes: string[] = [];
  const present: string[] = [];

  const [jsonlText, summaryText] = await Promise.all([
    tryFetchText('/receipts/mirrors.jsonl'),
    tryFetchText('/receipts/summary.json'),
  ]);

  let externalSummary: Record<string, unknown> | null = null;
  if (summaryText) {
    present.push('summary.json');
    try {
      externalSummary = JSON.parse(summaryText) as Record<string, unknown>;
    } catch {
      notes.push('receipts/summary.json is present but is not valid JSON.');
    }
  }

  const rows: ReceiptRow[] = [];
  if (jsonlText) {
    present.push('mirrors.jsonl');
    let bad = 0;
    for (const line of jsonlText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed) as ReceiptRow);
      } catch {
        bad += 1;
      }
    }
    if (bad) notes.push(`${bad} line(s) in mirrors.jsonl could not be parsed and were skipped.`);
  }

  return {
    rows,
    summary: rows.length ? summarise(rows) : null,
    externalSummary,
    present,
    notes,
  };
}

export function summarise(rows: ReceiptRow[]): ReceiptsSummary {
  const mirrored = rows.filter((r) => r.status === 'mirrored');
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'error');
  const proof = rows.map((r) => r.proofLatencyMs).filter((v): v is number => typeof v === 'number');
  const submit = mirrored.map((r) => r.submitLatencyMs).filter((v): v is number => typeof v === 'number');
  const roots = rows.map((r) => r.continuityRoots).filter((v): v is number => typeof v === 'number');
  const costs = rows.map((r) => Number(r.ctcCost)).filter((v) => Number.isFinite(v));
  const timestamps = rows.map((r) => r.timestamp).filter(Boolean).sort();

  const byChainKey: Record<number, number> = {};
  for (const r of rows) byChainKey[r.sourceChainKey] = (byChainKey[r.sourceChainKey] ?? 0) + 1;

  return {
    attempts: rows.length,
    mirrored: mirrored.length,
    failed: failed.length,
    other: rows.length - mirrored.length - failed.length,
    distinctUids: new Set(rows.map((r) => r.easUid?.toLowerCase()).filter(Boolean)).size,
    distinctCreditcoinTxs: new Set(mirrored.map((r) => r.creditcoinTxHash?.toLowerCase()).filter(Boolean)).size,
    proofMedianMs: median(proof),
    proofP95Ms: percentile(proof, 95),
    submitMedianMs: median(submit),
    submitP95Ms: percentile(submit, 95),
    continuityRootsMin: roots.length ? Math.min(...roots) : null,
    continuityRootsMax: roots.length ? Math.max(...roots) : null,
    totalCtc: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    byChainKey,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps[timestamps.length - 1] ?? null,
  };
}
