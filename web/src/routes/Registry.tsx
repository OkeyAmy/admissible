import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Shell from '../components/Shell';
import { Empty, Hash, Notice, ScrollTable, Stat, Working } from '../components/Bits';
import { CHAIN_KEYS, CREDITCOIN_EXPLORER, SOURCE_CHAINS } from '../lib/config';
import { easscanAttestationUrl, easscanSchemaUrl } from '../lib/easscan';
import { formatInt, formatUnixSeconds } from '../lib/format';
import {
  hydrateRows,
  readTotals,
  RegistryNotDeployedError,
  scanMirrorEvents,
  type HydratedRow,
  type RegistryTotals,
} from '../lib/registry';
import type { ChainKey } from '../lib/types';

type RevokedFilter = 'all' | 'active' | 'revoked';

export default function Registry() {
  const [totals, setTotals] = useState<RegistryTotals | null>(null);
  const [totalsError, setTotalsError] = useState<string | null>(null);
  const [rows, setRows] = useState<HydratedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [chainFilter, setChainFilter] = useState<ChainKey | null>(null);
  const [revokedFilter, setRevokedFilter] = useState<RevokedFilter>('all');
  const [windowNote, setWindowNote] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback((chainKey: ChainKey | null, before: number | null, append: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setRows([]);
    }
    setError(null);

    scanMirrorEvents({
      chainKey,
      limit: 40,
      before: before ?? undefined,
      maxWindows: 10,
      onWindow: (from, to) => setWindowNote(`scanning Creditcoin blocks ${formatInt(from)} – ${formatInt(to)}…`),
      signal: controller.signal,
    })
      .then(async (scan) => {
        setWindowNote(null);
        const hydrated = await hydrateRows(scan.rows);
        if (controller.signal.aborted) return;
        setRows((prev) => (append ? [...prev, ...hydrated] : hydrated));
        setExhausted(scan.exhausted);
        setNextBefore(scan.exhausted ? null : scan.scannedFrom - 1);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return;
        setWindowNote(null);
        setError(e instanceof RegistryNotDeployedError ? e.message : (e as Error).message);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setLoadingMore(false);
      });
  }, []);

  useEffect(() => {
    readTotals()
      .then(setTotals)
      .catch((e: unknown) => setTotalsError(e instanceof RegistryNotDeployedError ? e.message : (e as Error).message));
  }, []);

  useEffect(() => {
    load(chainFilter, null, false);
    return () => controllerRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainFilter]);

  const filtered = rows.filter((r) => {
    if (revokedFilter === 'active') return !r.revoked;
    if (revokedFilter === 'revoked') return r.revoked;
    return true;
  });

  return (
    <Shell>
      <section className="page">
        <div className="page-head">
          <span className="eyebrow">Registry</span>
          <h1 className="page-title">What has been mirrored.</h1>
          <p className="page-lede">
            Every row here was written by a permissionless call to{' '}
            <code className="mono">AttestationRegistry.submit(...)</code> on Creditcoin CC3 testnet, accepted
            only because the BlockProver precompile verified an Attestcoin proof. <code className="mono">submit</code>{' '}
            exists because <code className="mono">ASCBase.execute</code> is <code className="mono">external</code>{' '}
            but not <code className="mono">virtual</code> and does not forward <code className="mono">chainKey</code>;
            <code className="mono">submit</code> records the context then self-calls the inherited{' '}
            <code className="mono">execute</code>, so verification and dedupe stay the base class&rsquo;s. The
            registry exposes no list getter, so this page walks the{' '}
            <code className="mono">AttestationMirrored</code> event log backwards in windows and reads each record
            back with <code className="mono">attestationOf(...)</code>.
          </p>
        </div>

        {totalsError ? (
          <Notice warm>{totalsError}</Notice>
        ) : (
          <div className="stats">
            <Stat label="total mirrored" value={totals ? formatInt(totals.mirrored) : '—'} />
            <Stat label="total revoked" value={totals ? formatInt(totals.revoked) : '—'} />
            <Stat
              label="registry"
              value={totals ? <Hash value={totals.address} head={8} tail={6} /> : '—'}
              mono
              sub={totals ? 'source: totalMirrored() / totalRevoked()' : undefined}
            />
          </div>
        )}

        <div className="section">
          <div className="filters">
            <span className="label">source chain</span>
            <div className="filter-toggle">
              <button type="button" aria-pressed={chainFilter === null} onClick={() => setChainFilter(null)}>
                all
              </button>
              {CHAIN_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={chainFilter === key}
                  onClick={() => setChainFilter(key)}
                >
                  {SOURCE_CHAINS[key].shortLabel}
                </button>
              ))}
            </div>

            <span className="label">status</span>
            <div className="filter-toggle">
              {(['all', 'active', 'revoked'] as const).map((f) => (
                <button key={f} type="button" aria-pressed={revokedFilter === f} onClick={() => setRevokedFilter(f)}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="page-loading">
              <Working>{windowNote ?? 'Reading the registry…'}</Working>
            </div>
          ) : error ? (
            <Notice warm>{error}</Notice>
          ) : filtered.length === 0 ? (
            <Empty title="Nothing mirrored yet.">
              <p>
                No <code className="mono">AttestationMirrored</code> events were found in the scanned range.
                Mirror one from <Link to="/app">the paste page</Link> to see it appear here.
              </p>
            </Empty>
          ) : (
            <>
              <ScrollTable>
                <table className="data">
                  <thead>
                    <tr>
                      <th>chainKey</th>
                      <th>uid</th>
                      <th>schema</th>
                      <th>attester</th>
                      <th>recipient</th>
                      <th>sourceBlock</th>
                      <th>mirroredAt</th>
                      <th>revoked</th>
                      <th>mirror tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => (
                      <tr key={`${row.chainKey}-${row.uid}`}>
                        <td>{row.chainKey === 3 ? '3 · mainnet' : '1 · sepolia'}</td>
                        <td>
                          <Hash value={row.uid} href={easscanAttestationUrl(row.chainKey, row.uid)} head={10} tail={6} />
                        </td>
                        <td>
                          <Hash
                            value={row.schemaUid}
                            href={easscanSchemaUrl(row.chainKey, row.schemaUid)}
                            head={8}
                            tail={6}
                            dim
                          />
                        </td>
                        <td>
                          <Hash value={row.attester} head={8} tail={6} dim />
                        </td>
                        <td>
                          <Hash value={row.recipient} head={8} tail={6} dim />
                        </td>
                        <td>{formatInt(row.sourceBlock)}</td>
                        <td>{row.mirroredAt ? formatUnixSeconds(row.mirroredAt) : '—'}</td>
                        <td>
                          <span className={row.revoked ? 'pill pill-warn' : 'pill'}>
                            {row.revoked ? 'revoked' : 'active'}
                          </span>
                        </td>
                        <td>
                          <Hash
                            value={row.creditcoinTxHash}
                            href={`${CREDITCOIN_EXPLORER}/tx/${row.creditcoinTxHash}`}
                            head={8}
                            tail={6}
                            dim
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>

              {!exhausted ? (
                <div className="load-more">
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={loadingMore}
                    onClick={() => nextBefore !== null && load(chainFilter, nextBefore, true)}
                  >
                    {loadingMore ? 'Scanning…' : 'Scan older blocks'}
                  </button>
                </div>
              ) : (
                <p className="section-note" style={{ marginTop: '1.2rem' }}>
                  Reached the block the registry was deployed at. Nothing older to scan — the contract
                  didn&rsquo;t exist yet.
                </p>
              )}
            </>
          )}
        </div>
      </section>
    </Shell>
  );
}
