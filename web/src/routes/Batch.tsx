import { useCallback, useEffect, useRef, useState } from 'react';
import Shell from '../components/Shell';
import { Empty, Hash, Notice, Stat, Working } from '../components/Bits';
import {
  MAX_BLOCK_SPAN,
  MAX_TXS_PER_BATCH,
  planSchemaMirror,
  runSchemaMirror,
  type BatchPlan,
  type BatchState,
  type RunSummary,
} from '../lib/batch';
import { CHAIN_KEYS, CREDITCOIN_EXPLORER, DEFAULT_CHAIN_KEY, SOURCE_CHAINS } from '../lib/config';
import { fetchActiveSchemas, type EasSchemaSummary } from '../lib/easscan';
import { elapsedLabel, formatInt, formatMs } from '../lib/format';
import { hasSigner } from '../lib/mirror';
import type { ChainKey } from '../lib/types';

const STATUS_LABEL: Record<BatchState['status'], string> = {
  planned: 'planned',
  waiting: 'waiting for attestation',
  proving: 'building proof',
  submitting: 'submitting',
  done: 'mirrored',
  'needs-signer': 'proof built',
  failed: 'failed',
};

export default function Batch() {
  const [chainKey, setChainKey] = useState<ChainKey>(DEFAULT_CHAIN_KEY);
  const [schemaUid, setSchemaUid] = useState('');
  const [limit, setLimit] = useState(50);
  const [schemas, setSchemas] = useState<EasSchemaSummary[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(true);

  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [planNote, setPlanNote] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [batchStates, setBatchStates] = useState<BatchState[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    setSchemasLoading(true);
    fetchActiveSchemas(chainKey)
      .then((s) => {
        if (live) setSchemas(s);
      })
      .catch(() => {
        if (live) setSchemas([]);
      })
      .finally(() => {
        if (live) setSchemasLoading(false);
      });
    return () => {
      live = false;
    };
  }, [chainKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const runPlan = useCallback(() => {
    if (!schemaUid.trim()) {
      setPlanError('Pick or paste a schema UID.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    setSummary(null);
    setBatchStates([]);
    setPlanNote(null);

    planSchemaMirror({
      chainKey,
      schemaUid: schemaUid.trim(),
      limit,
      onNote: setPlanNote,
      signal: controller.signal,
    })
      .then((p) => {
        setPlan(p);
        setBatchStates(p.batches.map((b) => ({ ...b, status: 'planned', creditcoinTxHashes: [] })));
      })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return;
        setPlanError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setPlanning(false));
  }, [chainKey, schemaUid, limit]);

  const runBatches = useCallback(() => {
    if (!plan) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setSummary(null);

    runSchemaMirror({
      plan,
      onBatch: (state) => {
        setBatchStates((prev) => {
          const next = prev.slice();
          next[state.index] = state;
          return next;
        });
      },
      signal: controller.signal,
    })
      .then(setSummary)
      .finally(() => setRunning(false));
  }, [plan]);

  const signerConfigured = hasSigner();

  return (
    <Shell>
      <section className="page">
        <div className="page-head">
          <span className="eyebrow">Batch</span>
          <h1 className="page-title">Mirror a whole schema.</h1>
          <p className="page-lede">
            Drives the SDK&rsquo;s <code className="mono">mirrorSchema(schemaUid, chainKey, {'{ limit, onProgress }'})</code>.
            Recent attestations for a schema are pulled from easscan, grouped by source transaction, and packed
            into batches of at most {MAX_TXS_PER_BATCH} transactions spanning at most {formatInt(MAX_BLOCK_SPAN)}{' '}
            Ethereum blocks — the two hard limits the Attestcoin batch prover enforces. Each batch shares one
            continuity proof across every transaction in it, which is what makes batching cheaper than N single
            mirrors.
          </p>
        </div>

        <div className="section batch-controls">
          <div className="prompt-controls">
            <span className="label">source chain</span>
            <div className="chain-toggle">
              {CHAIN_KEYS.map((key) => (
                <button key={key} type="button" aria-pressed={chainKey === key} onClick={() => setChainKey(key)}>
                  {SOURCE_CHAINS[key].label} · {key}
                </button>
              ))}
            </div>
          </div>

          <div className="field batch-schema-field">
            <input
              value={schemaUid}
              onChange={(e) => setSchemaUid(e.target.value)}
              placeholder="0x… schema UID"
              spellCheck={false}
              autoComplete="off"
              aria-label="Schema UID"
            />
          </div>

          <label className="batch-limit">
            <span className="label">attestations to consider</span>
            <input
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              className="batch-limit-input"
            />
          </label>

          <button type="button" className="btn btn-lime" onClick={runPlan} disabled={planning || running}>
            {planning ? 'Planning…' : 'Plan batches'}
          </button>
        </div>

        {!schemasLoading && schemas.length > 0 ? (
          <div className="section">
            <p className="section-note" style={{ marginBottom: '0.7rem' }}>
              Active schemas on {SOURCE_CHAINS[chainKey].label}, by attestation count — click to select:
            </p>
            <div className="schema-list">
              {schemas.slice(0, 8).map((s) => (
                <button key={s.id} type="button" className="schema-row" onClick={() => setSchemaUid(s.id)}>
                  <span className="uid">{s.id}</span>
                  <span className="note">
                    {formatInt(s.attestationCount)} attestations · {s.schema.slice(0, 60)}
                    {s.schema.length > 60 ? '…' : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {planNote ? (
          <div className="section">
            <Working>{planNote}</Working>
          </div>
        ) : null}
        {planError ? (
          <div className="section">
            <Notice warm>{planError}</Notice>
          </div>
        ) : null}

        {plan ? (
          <div className="section">
            <div className="stats">
              <Stat label="attestations found" value={formatInt(plan.attestations.length)} />
              <Stat label="on-chain (provable)" value={formatInt(plan.onchainAttestations)} sub={plan.offchainSkipped ? `${plan.offchainSkipped} off-chain skipped` : undefined} />
              <Stat label="distinct transactions" value={formatInt(plan.txs.length)} />
              <Stat label="batches" value={formatInt(plan.batches.length)} />
            </div>

            {!signerConfigured ? (
              <div style={{ marginTop: '1.2rem' }}>
                <Notice>
                  No signer is configured in this browser build — proofs will be built and verified against the
                  deployed registry for real, but submission will stop at{' '}
                  <span className="pill pill-warn" style={{ marginInline: '0.2rem' }}>
                    proof built
                  </span>{' '}
                  rather than spending CTC from a key embedded in client code.
                </Notice>
              </div>
            ) : null}

            <div className="section-inline-head">
              <h2 className="section-title">Batch plan</h2>
              <button type="button" className="btn btn-lime" onClick={runBatches} disabled={running || plan.batches.length === 0}>
                {running ? 'Running…' : 'Run batches'}
              </button>
            </div>

            {plan.batches.length === 0 ? (
              <Empty title="Nothing to batch.">
                <p>No on-chain transactions for this schema resolved on the public RPC within the requested limit.</p>
              </Empty>
            ) : (
              <ol className="batch-list">
                {batchStates.map((b) => (
                  <li key={b.index} className={`batch-item is-${b.status}`}>
                    <div className="batch-item-head">
                      <span className="batch-index">batch {String(b.index + 1).padStart(2, '0')}</span>
                      <span className={`pill ${b.status === 'done' ? 'pill-live' : b.status === 'failed' ? 'pill-warn' : ''}`}>
                        {STATUS_LABEL[b.status]}
                      </span>
                      <span className="batch-meta">
                        {b.txs.length} tx · {formatInt(b.attestationCount)} attestations · blocks {formatInt(b.fromBlock)}–{formatInt(b.toBlock)}
                      </span>
                    </div>
                    {b.note ? <p className="stage-desc">{b.note}</p> : null}
                    {(b.continuityRoots !== undefined || b.proofCount !== undefined) ? (
                      <dl className="facts" style={{ marginTop: '0.6rem' }}>
                        <div>
                          <dt className="fact-label">proof count</dt>
                          <dd className="fact-value">{b.proofCount ?? '—'}</dd>
                        </div>
                        <div>
                          <dt className="fact-label">continuity roots</dt>
                          <dd className="fact-value">{b.continuityRoots ?? '—'}</dd>
                        </div>
                        <div>
                          <dt className="fact-label">proof latency</dt>
                          <dd className="fact-value">{formatMs(b.proofLatencyMs)}</dd>
                        </div>
                      </dl>
                    ) : null}
                    {b.creditcoinTxHashes.length > 0 ? (
                      <div className="batch-tx-list">
                        {b.creditcoinTxHashes.map((tx) => (
                          <Hash key={tx} value={tx} href={`${CREDITCOIN_EXPLORER}/tx/${tx}`} head={10} tail={8} />
                        ))}
                      </div>
                    ) : null}
                    {b.error ? <p className="stage-error">{b.error}</p> : null}
                  </li>
                ))}
              </ol>
            )}

            {summary ? (
              <div className="verdict">
                <p className="verdict-word">
                  {summary.submitted
                    ? `${formatInt(summary.attestationsMirrored)} attestations mirrored in ${formatInt(summary.creditcoinTransactions)} transactions`
                    : `${formatInt(summary.attestationsProven)} attestations proven across ${formatInt(summary.batchesCompleted)} batches`}
                </p>
                <p className="verdict-note">
                  {summary.submitted
                    ? `Completed in ${elapsedLabel(0, summary.elapsedMs)}. ${summary.batchesFailed} batch(es) failed.`
                    : `${summary.stoppedReason ?? 'Submission did not run.'} Proof generation took ${elapsedLabel(0, summary.elapsedMs)} total, real and unmocked.`}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </Shell>
  );
}
