import { useEffect, useMemo, useState } from 'react';
import Shell from '../components/Shell';
import { Empty, Hash, Notice, ScrollTable, Stat, Working } from '../components/Bits';
import { CREDITCOIN_EXPLORER } from '../lib/config';
import { easscanAttestationUrl } from '../lib/easscan';
import { formatInt, formatIso, formatMs } from '../lib/format';
import { loadReceipts, type ReceiptsPayload } from '../lib/receipts';
import type { ChainKey } from '../lib/types';

const PAGE_SIZES = [50, 100, 200] as const;

export default function Receipts() {
  const [payload, setPayload] = useState<ReceiptsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let live = true;
    loadReceipts()
      .then((p) => {
        if (live) setPayload(p);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const s = payload?.summary;

  const filteredRows = useMemo(() => {
    const rows = payload?.rows ?? [];
    const q = query.trim().toLowerCase();
    const matched = q
      ? rows.filter(
          (r) =>
            r.easUid.toLowerCase().includes(q) ||
            r.status.toLowerCase().includes(q) ||
            (r.creditcoinTxHash ?? '').toLowerCase().includes(q) ||
            String(r.sourceBlock ?? '').includes(q),
        )
      : rows;
    return [...matched].reverse();
  }, [payload, query]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = filteredRows.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  useEffect(() => {
    setPage(0);
  }, [query, pageSize]);

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
        ) : !payload || payload.rows.length === 0 ? (
          <Empty title="No receipts committed yet.">
            <p>
              This page reads <code className="mono">receipts/summary.json</code> and{' '}
              <code className="mono">receipts/mirrors.jsonl</code> directly — nothing here is invented. Neither
              file was present at build time
              {payload?.notes.length ? ':' : '.'}
            </p>
            {payload?.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
            <p>Run the bench workspace to generate evidence, then rebuild the web app.</p>
          </Empty>
        ) : (
          <>
            <div className="stats">
              <Stat label="attempts" value={formatInt(s?.attempts)} />
              <Stat label="mirrored" value={formatInt(s?.mirrored)} sub={s ? `${s.failed} failed · ${s.other} other` : undefined} />
              <Stat label="distinct UIDs" value={formatInt(s?.distinctUids)} />
              <Stat label="creditcoin txs" value={formatInt(s?.distinctCreditcoinTxs)} />
              <Stat label="proof latency" value={formatMs(s?.proofMedianMs)} sub={s ? `p95 ${formatMs(s.proofP95Ms)}` : undefined} mono />
              <Stat label="submit latency" value={formatMs(s?.submitMedianMs)} sub={s ? `p95 ${formatMs(s.submitP95Ms)}` : undefined} mono />
              <Stat
                label="continuity roots"
                value={s?.continuityRootsMin !== null && s?.continuityRootsMax !== null ? `${s?.continuityRootsMin}–${s?.continuityRootsMax}` : '—'}
                mono
              />
              <Stat label="total CTC spent" value={s?.totalCtc !== null && s?.totalCtc !== undefined ? s.totalCtc.toFixed(6) : '—'} mono />
            </div>

            <div className="section">
              <p className="section-note">
                {s ? (
                  <>
                    {formatInt(s.byChainKey[3] ?? 0)} on Ethereum mainnet (chainKey 3) ·{' '}
                    {formatInt(s.byChainKey[1] ?? 0)} on Sepolia (chainKey 1)
                    {s.firstTimestamp ? (
                      <>
                        {' '}
                        · {formatIso(s.firstTimestamp)} – {formatIso(s.lastTimestamp)}
                      </>
                    ) : null}
                  </>
                ) : null}
              </p>
              {payload.notes.length ? (
                <div style={{ marginTop: '0.9rem' }}>
                  {payload.notes.map((n) => (
                    <Notice key={n}>{n}</Notice>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="section">
              <h2 className="section-title">Every attempt</h2>
              <div className="receipts-controls" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', margin: '0.75rem 0' }}>
                <div className="field" style={{ flex: '1 1 260px' }}>
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="search UID, status, tx hash, block…"
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
                {query
                  ? `${formatInt(filteredRows.length)} of ${formatInt(payload.rows.length)} rows match “${query}”.`
                  : `All ${formatInt(payload.rows.length)} rows.`}{' '}
                Page {clampedPage + 1} of {pageCount}.
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
                    {pageRows.map((r, i) => (
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
              {filteredRows.length === 0 ? (
                <p className="section-note" style={{ marginTop: '0.9rem' }}>
                  No rows match “{query}”.
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

            {payload.externalSummary ? (
              <div className="section">
                <h2 className="section-title">Bench summary.json</h2>
                <p className="section-note">Written by the bench workspace independently of this page&rsquo;s own aggregation above.</p>
                <ScrollTable>
                  <table className="data">
                    <tbody>
                      {Object.entries(payload.externalSummary).map(([k, v]) => (
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
