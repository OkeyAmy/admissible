/**
 * Reads receipts/mirrors.jsonl (every line real, one per attempt — successes
 * AND failures) and writes receipts/summary.json: real counts, median/p95
 * latencies computed from the recorded numbers, CTC spent, per-chainKey
 * breakdown. No number here is estimated.
 *
 * Run standalone any time with: pnpm -F @admissible/bench summary
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RECEIPTS_DIR, MIRRORS_PATH, type ReceiptLine } from './receipts.js';

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

interface ChainStats {
  chainKey: number;
  attestationsAttempted: number;
  mirrored: number;
  alreadyMirrored: number;
  failed: number;
  distinctTransactions: number;
  ctcSpent: string;
  proofLatencyMs: { median: number | null; p95: number | null; min: number | null; max: number | null; n: number };
  submitLatencyMs: { median: number | null; p95: number | null; min: number | null; max: number | null; n: number };
}

function statsFor(lines: ReceiptLine[]): Omit<ChainStats, 'chainKey'> {
  const mirrored = lines.filter((l) => l.status === 'mirrored');
  const already = lines.filter((l) => l.status === 'already-mirrored');
  const failed = lines.filter((l) => l.status === 'failed');
  const txHashes = new Set(lines.map((l) => l.creditcoinTxHash).filter((h): h is string => !!h));
  const batchIndices = new Set(lines.map((l) => l.batchIndex));

  const proofLat = lines.map((l) => l.proofLatencyMs).filter((v): v is number => typeof v === 'number');
  const submitLat = lines.map((l) => l.submitLatencyMs).filter((v): v is number => typeof v === 'number');
  const proofSorted = [...proofLat].sort((a, b) => a - b);
  const submitSorted = [...submitLat].sort((a, b) => a - b);

  let ctcSpentWei = 0n;
  for (const l of lines) {
    if (!l.ctcCost) continue;
    // formatCtc-style string "whole.frac" -> wei, summed once per distinct tx (cost is per-tx, shared across UIDs in a group)
  }
  // Sum CTC cost once per distinct creditcoinTxHash (a multi-UID group shares one cost).
  const costByTx = new Map<string, string>();
  for (const l of lines) {
    if (l.creditcoinTxHash && l.ctcCost) costByTx.set(l.creditcoinTxHash, l.ctcCost);
  }
  let total = 0n;
  for (const cost of costByTx.values()) {
    const [whole, frac = '0'] = cost.split('.');
    const fracPadded = frac.padEnd(18, '0').slice(0, 18);
    total += BigInt(whole) * 10n ** 18n + BigInt(fracPadded || '0');
  }
  void ctcSpentWei;
  const ctcSpent = formatWei(total);

  return {
    attestationsAttempted: lines.length,
    mirrored: mirrored.length,
    alreadyMirrored: already.length,
    failed: failed.length,
    distinctTransactions: txHashes.size,
    ctcSpent,
    proofLatencyMs: {
      median: median(proofLat),
      p95: percentile(proofSorted, 95),
      min: proofSorted[0] ?? null,
      max: proofSorted[proofSorted.length - 1] ?? null,
      n: proofLat.length,
    },
    submitLatencyMs: {
      median: median(submitLat),
      p95: percentile(submitSorted, 95),
      min: submitSorted[0] ?? null,
      max: submitSorted[submitSorted.length - 1] ?? null,
      n: submitLat.length,
    },
  };
  function formatWei(wei: bigint): string {
    const whole = wei / 10n ** 18n;
    const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '') || '0';
    return `${whole}.${frac}`;
  }
}

async function main() {
  if (!existsSync(MIRRORS_PATH)) {
    console.error(`no receipts file at ${MIRRORS_PATH} — run the bench first.`);
    process.exit(1);
  }
  const raw = readFileSync(MIRRORS_PATH, 'utf8').trim();
  const lines: ReceiptLine[] = raw.length === 0 ? [] : raw.split('\n').map((l) => JSON.parse(l));

  const byChain = new Map<number, ReceiptLine[]>();
  for (const l of lines) {
    const arr = byChain.get(l.sourceChainKey) ?? [];
    arr.push(l);
    byChain.set(l.sourceChainKey, arr);
  }

  const perChain: ChainStats[] = [...byChain.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chainKey, rows]) => ({ chainKey, ...statsFor(rows) }));

  const overall = statsFor(lines);

  const summary = {
    generatedAt: new Date().toISOString(),
    receiptsFile: 'receipts/mirrors.jsonl',
    totalLines: lines.length,
    overall,
    perChainKey: perChain,
  };

  const outPath = resolve(RECEIPTS_DIR, 'summary.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`wrote ${outPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
