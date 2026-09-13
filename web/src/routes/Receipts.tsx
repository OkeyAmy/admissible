import { useEffect, useMemo, useRef, useState } from 'react';
import Shell from '../components/Shell';
import { Empty, Hash, Notice, ScrollTable, Stat, Working } from '../components/Bits';
import { CREDITCOIN_EXPLORER } from '../lib/config';
import { easscanAttestationUrl } from '../lib/easscan';
import { formatInt, formatIso, formatMs } from '../lib/format';
import { loadReceiptsPage, type BenchSummary, type ReceiptsPage } from '../lib/receipts';
import type { ChainKey } from '../lib/types';

const PAGE_SIZES = [50, 100, 200, 500] as const;
const DEFAULT_PAGE_SIZE = PAGE_SIZES[0];
const POLL_MS = 60_000;
/** Debounce the search box so a keystroke-per-keystroke reload of the server-side scan doesn't fire. */
const QUERY_DEBOUNCE_MS = 400;
/** Consecutive empty polls (including the initial one) before the "no receipts committed" state is shown. */
const EMPTY_CONFIRM_POLLS = 2;

export default function Receipts() {
  const [paged, setPaged] = useState<ReceiptsPage | null>(null);
  const [externalSummary, setExternalSummary] = useState<BenchSummary | null>(null);
  const [present, setPresent] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);
  const refreshingRef = useRef(false);
  const emptyStreakRef = useRef(0);

  // Debounce the search box; the server scans the whole file per request.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Reset to page 0 whenever the search or page size changes the result set.
  useEffect(() => {
    setPage(0);
  }, [debouncedQuery, pageSize]);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      // Overlap guard: never run two fetches at once.
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      try {
        const r = await loadReceiptsPage({ page, pageSize, query: debouncedQuery });
        if (live) {
          setPaged(r.page);
          setExternalSummary(r.externalSummary);
          setPresent(r.present);
          setNotes(r.notes);
          // A transient (e.g. a dev server restart or a file mid-rollover) can
          // make the first request come back empty. Don't claim "no receipts
          // committed yet" until polling has confirmed it over a few ticks.
          emptyStreakRef.current = r.page && r.page.totalLines > 0 ? 0 : emptyStreakRef.current + 1;
        }
      } finally {
        refreshingRef.current = false;
      }
    };
    setLoading(true);
    refresh().finally(() => {
      if (live) setLoading(false);
    });
    const t = setInterval(refresh, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [page, pageSize, debouncedQuery]);

  const overall = externalSummary?.overall;
  const perChain = (key: number) => externalSummary?.perChainKey.find((c) => c.chainKey === key);
  const mainnet = perChain(3);
  const sepolia = perChain(1);
  const rangeStart = externalSummary?.firstTimestamp ?? null;
  const rangeEnd = externalSummary?.lastTimestamp ?? null;
  const totalLines = paged?.totalLines ?? 0;

  const rows = useMemo(() => paged?.rows ?? [], [paged]);
  const pageCount = useMemo(() => (paged ? Math.max(1, paged.totalPages) : 1), [paged]);
  const clampedPage = Math.min(page, pageCount - 1);
  const matched = paged?.totalMatched ?? 0;

  return (
    <Shell>
      <section className="page">
        <div className="page-head">
          <span className="eyebrow">Receipts</span>
          <h1 className="page-title">The evidence.</h1>
          <p className="page-lede">
            One line in <code className="mono">receipts/mirrors.jsonl</code> per attempt, failures included — a
            file with only successes would be less credible. Proof generation (free) and on-chain submission
            (costs CTC) are kept as separate latency fields because they have different cost profiles and
            different failure modes.
          </p>
        </div>

        {loading ? (
          <div className="page-loading">
            <Working>Reading receipts/…</Working>
          </div>
        ) : !paged ? (
          emptyStreakRef.current >= EMPTY_CONFIRM_POLLS ? (
            <Empty title="No receipts committed yet.">
              <p>
                This page reads <code className="mono">receipts/summary.json</code> and{' '}
                <code className="mono">receipts/mirrors.jsonl</code> directly — nothing here is invented. Neither
                file was present at build time{notes.length ? ':' : '.'}
              </p>
              {notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
              <p>Run the bench workspace to generate evidence, then rebuild the web app.</p>
            </Empty>
          ) : (
            <div className="page-loading">
              <Working>Waiting for evidence…</Working>
              <p className="section-note" style={{ marginTop: '0.5rem' }}>
                No rows fetched yet — retrying every 60 s before declaring the receipts empty.
              </p>
            </div>
          )
        ) : totalLines === 0 ? (
          emptyStreakRef.current >= EMPTY_CONFIRM_POLLS ? (
            <Empty title="No receipts committed yet.">
              <p>
                <code className="mono">receipts/mirrors.jsonl</code> is present but empty.
                {present.includes('summary.json') ? ' Run the bench workspace to generate evidence.' : ''}
              </p>
              {notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </Empty>
          ) : (
            <div className="page-loading">
              <Working>Waiting for evidence…</Working>
              <p className="section-note" style={{ marginTop: '0.5rem' }}>
                No rows yet — retrying every 60 s before declaring the receipts empty.
              </p>
            </div>
          )
        ) : (
          <>
            <div className="stats">
              <Stat label="attempts" value={formatInt(overall?.attestationsAttempted)} />
              <Stat
                label="mirrored"
                value={formatInt(overall?.mirrored)}
                sub={overall ? `${formatInt(overall.failed)} failed · ${formatInt(overall.alreadyMirrored)} already-mirrored` : undefined}
              />
              <Stat label="distinct UIDs" value={formatInt(overall?.distinctUids)} />
              <Stat label="creditcoin txs" value={formatInt(overall?.distinctTransactions)} />
              <Stat
                label="proof latency"
                value={formatMs(overall?.proofLatencyMs.median)}
                sub={overall ? `p95 ${formatMs(overall.proofLatencyMs.p95)}` : undefined}
                mono
              />
              <Stat
                label="submit latency"
                value={formatMs(overall?.submitLatencyMs.median)}
                sub={overall ? `p95 ${formatMs(overall.submitLatencyMs.p95)}` : undefined}
                mono
              />
              <Stat
                label="continuity roots"
                value={overall?.continuityRootsMin != null && overall?.continuityRootsMax != null ? `${overall.continuityRootsMin}–${overall.continuityRootsMax}` : '—'}
                mono
              />
              <Stat label="total CTC spent" value={overall?.ctcSpent != null ? Number(overall.ctcSpent).toFixed(6) : '—'} mono />
            </div>

            <div className="section">
              <p className="section-note">
                {overall ? (
                  <>
                    Aggregates as of {formatIso(externalSummary?.generatedAt)} · regenerated every 30 min by the bench
                    timer · rows below read live from <code className="mono">receipts/mirrors.jsonl</code> and refresh
                    every 60 s
                  </>
                ) : null}
              </p>
              <p className="section-note">
                {externalSummary ? (
                  <>
                    {formatInt(mainnet?.attestationsAttempted ?? 0)} on Ethereum mainnet (chainKey 3) ·{' '}
                    {formatInt(sepolia?.attestationsAttempted ?? 0)} on Sepolia (chainKey 1)
                    {rangeStart && rangeEnd ? (
                      <>
                        {' '}
                        · {formatIso(rangeStart)} – {formatIso(rangeEnd)}
                      </>
                    ) : null}
                  </>
                ) : (
                  <>Every row in {formatInt(totalLines)} lines of mirrors.jsonl — no summary.json present.</>
                )}
              </p>
              {notes.length ? (
                <div style={{ marginTop: '0.9rem' }}>
                  {notes.map((n) => (
                    <Notice key={n}>{n}</Notice>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="section">
              <h2 className="section-title">
                All {formatInt(totalLines)} attempts{debouncedQuery ? ` matching “${debouncedQuery}”` : ''}
              </h2>
              <div className="receipts-controls" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', margin: '0.75rem 0' }}>
                <div className="field" style={{ flex: '1 1 260px' }}>
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`search all ${formatInt(totalLines)} rows — uid, tx hash, status…`}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Search receipts"
                  />
                </div>
                <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <span className="section-note" style={{ margin: 0 }}>
                    rows/page
                  </span>
                  <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="select">
                    {PAGE_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="section-note">
                {debouncedQuery
                  ? `${formatInt(matched)} of ${formatInt(totalLines)} rows match “${debouncedQuery}”.`
                  : `${formatInt(totalLines)} rows in the file — full history is paginated below.`}{' '}
                Page {clampedPage + 1} of {pageCount}.
              </p>
              <p className="section-note">
                <a className="hash-link" href="/receipts/mirrors.jsonl" download>
                  Download the full mirrors.jsonl ({formatInt(totalLines)} lines)
                </a>{' '}
                — finish the full file locally if you need to grep it field by field.
              </p>
              <ScrollTable>
                <table className="data">
                  <thead>
                    <tr>
                      <th>status</th>
                      <th>easUid</th>
                      <th>chainKey</th>
                      <th>sourceBlock</th>
                      <th>continuity roots</th>
                      <th>proof ms</th>
                      <th>submit ms</th>
                      <th>ctc cost</th>
                      <th>creditcoin tx</th>
                      <th>timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.easUid}-${r.timestamp}-${i}`}>
                        <td>
                          <span className={r.status === 'mirrored' ? 'pill pill-live' : r.status === 'failed' || r.status === 'error' ? 'pill pill-warn' : 'pill'}>
                            {r.status}
                          </span>
                        </td>
                        <td>
                          <Hash
                            value={r.easUid}
                            href={easscanAttestationUrl((r.sourceChainKey as ChainKey) ?? 3, r.easUid)}
                            head={8}
                            tail={6}
                          />
                        </td>
                        <td>{r.sourceChainKey === 3 ? '3 · mainnet' : '1 · sepolia'}</td>
                        <td>{formatInt(r.sourceBlock)}</td>
                        <td>{r.continuityRoots ?? '—'}</td>
                        <td>{formatMs(r.proofLatencyMs)}</td>
                        <td>{formatMs(r.submitLatencyMs)}</td>
                        <td className="mono">{r.ctcCost ?? '—'}</td>
                        <td>
                          {r.creditcoinTxHash ? (
                            <Hash value={r.creditcoinTxHash} href={`${CREDITCOIN_EXPLORER}/tx/${r.creditcoinTxHash}`} head={8} tail={6} dim />
                          ) : (
                            <span className="hash-dim">—</span>
                          )}
                        </td>
                        <td className="mono">{formatIso(r.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
              {rows.length === 0 ? (
                <p className="section-note" style={{ marginTop: '0.9rem' }}>
                  No rows match “{debouncedQuery}”.
                </p>
              ) : (
                <div className="load-more" style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={clampedPage <= 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    ← newer
                  </button>
                  <span className="section-note" style={{ margin: 0 }}>
                    page {clampedPage + 1} / {pageCount}
                  </span>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={clampedPage >= pageCount - 1}
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  >
                    older →
                  </button>
                </div>
              )}
            </div>

            {externalSummary ? (
              <div className="section">
                <h2 className="section-title">Bench summary.json</h2>
                <p className="section-note">Written by the bench workspace independently of this page&rsquo;s own aggregation above.</p>
                <ScrollTable>
                  <table className="data">
                    <tbody>
                      {Object.entries(externalSummary).map(([k, v]) => (
                        <tr key={k}>
                          <td className="mono">{k}</td>
                          <td className="mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollTable>
              </div>
            ) : null}
          </>
        )}
      </section>
    </Shell>
  );
}