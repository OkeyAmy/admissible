import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Shell from '../components/Shell';
import Code from '../components/Code';
import { Hash, Notice, ScrollTable, Working } from '../components/Bits';
import { CHAIN_KEYS, DEFAULT_CHAIN_KEY, SOURCE_CHAINS } from '../lib/config';
import { parseUidInput } from '../lib/parse';
import { verifyUid, type VerifyResult } from '../lib/verify';
import type { ChainKey } from '../lib/types';

export default function Verify() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get('uid') ?? '');
  const [chainKey, setChainKey] = useState<ChainKey>(
    (Number(params.get('chainKey')) as ChainKey) || DEFAULT_CHAIN_KEY,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const run = useCallback(
    (rawValue: string, forcedChainKey?: ChainKey) => {
      const parsed = parseUidInput(rawValue);
      if (!parsed.uid) {
        setError(parsed.error);
        return;
      }
      const key = forcedChainKey ?? parsed.chainKey ?? chainKey;
      setChainKey(key);
      setError(null);
      setLoading(true);
      setResult(null);
      setParams({ uid: parsed.uid, chainKey: String(key) }, { replace: true });
      verifyUid(key, parsed.uid)
        .then(setResult)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [chainKey, setParams],
  );

  useEffect(() => {
    // Only ever auto-run once, on first mount from a shared/linked URL.
    const uid = params.get('uid');
    if (uid) run(uid, (Number(params.get('chainKey')) as ChainKey) || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cliCommand = result ? `npx admissible verify ${result.uid}` : 'npx admissible verify 0x<EAS_UID>';

  return (
    <Shell>
      <section className="page">
        <div className="page-head">
          <span className="eyebrow">Verify</span>
          <h1 className="page-title">Check it yourself.</h1>
          <p className="page-lede">
            The browser twin of <code className="mono">npx admissible verify</code>. Paste a UID and it reads the
            mirrored record from the Creditcoin registry over the public RPC, fetches the same UID from easscan
            GraphQL, and diffs them field by field. The two sides are genuinely independent — one is Creditcoin
            state written through an Attestcoin proof, the other is an Ethereum indexer we do not control.
          </p>
        </div>

        <form
          className="paste-row verify-row"
          onSubmit={(e) => {
            e.preventDefault();
            run(input);
          }}
        >
          <div className="field">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="0x… or easscan.org/…"
              spellCheck={false}
              autoComplete="off"
              aria-label="Attestation UID or easscan URL"
            />
          </div>
          <button type="submit" className="submit-square" aria-label="Verify this attestation" disabled={loading}>
            →
          </button>
        </form>

        {error ? <p className="prompt-error">{error}</p> : null}

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

        {loading ? (
          <div className="section">
            <Working>Reading Creditcoin and easscan…</Working>
          </div>
        ) : null}

        {result ? <VerifyOutcome result={result} /> : null}

        <div className="section">
          <p className="section-note" style={{ marginBottom: '0.6rem' }}>
            The equivalent, with no Admissible code at all:
          </p>
          <Code lang="bash" label="verify from the shell">
            {cliCommand}
          </Code>
        </div>
      </section>
    </Shell>
  );
}

function VerifyOutcome({ result }: { result: VerifyResult }) {
  const { pass, blocked, rows, record, eas, isValid, chainKey, registryAddress } = result;
  const chain = SOURCE_CHAINS[chainKey];

  if (blocked) {
    return (
      <div className="section">
        <Notice warm>{blocked}</Notice>
      </div>
    );
  }

  const comparable = rows.filter((r) => r.verdict !== 'not-comparable');
  const matched = comparable.filter((r) => r.verdict === 'match').length;

  return (
    <div className="section verify-outcome">
      <p className={`verdict-word ${pass ? 'is-pass' : 'is-fail'}`}>{pass ? 'PASS' : 'FAIL'}</p>
      <p className="verdict-note">
        {record && eas
          ? `${matched}/${comparable.length} comparable fields match · ${chain.label} · chainKey ${chainKey}`
          : !record
            ? 'No record in the Creditcoin registry for this (chainKey, uid) pair. It has not been mirrored.'
            : 'easscan has no attestation for this UID on this chain.'}
      </p>
      {record ? (
        <p className="verdict-note">
          registry <code className="mono">isValid(...)</code>: <strong>{String(isValid)}</strong>
        </p>
      ) : null}

      <ScrollTable>
        <table className="data verify-table">
          <thead>
            <tr>
              <th>field</th>
              <th>creditcoin registry</th>
              <th>easscan.org</th>
              <th>verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.field}>
                <td className="mono">{row.field}</td>
                <td className={row.mono ? 'mono' : undefined}>
                  {row.mono ? <Hash value={row.registry === '—' ? null : row.registry} truncate head={12} tail={8} /> : row.registry}
                </td>
                <td className={row.mono ? 'mono' : undefined}>
                  {row.mono ? <Hash value={row.easscan === '—' ? null : row.easscan} truncate head={12} tail={8} /> : row.easscan}
                </td>
                <td>
                  <span className={`verdict-tag verdict-${row.verdict}`}>
                    {row.verdict === 'match' ? 'match' : row.verdict === 'mismatch' ? 'MISMATCH' : 'n/a'}
                  </span>
                  {row.note ? <span className="verdict-tag-note"> · {row.note}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>

      <p className="section-note" style={{ marginTop: '1.2rem' }}>
        registry contract: <Hash value={registryAddress || null} head={10} tail={8} />
      </p>
    </div>
  );
}
