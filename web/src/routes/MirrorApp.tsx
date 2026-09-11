import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Shell from '../components/Shell';
import ProofTheatre, { type StageTiming, type TheatreState } from '../components/ProofTheatre';
import Code from '../components/Code';
import { Hash } from '../components/Bits';
import { CHAIN_KEYS, CREDITCOIN_EXPLORER, DEFAULT_CHAIN_KEY, EXAMPLE_UIDS, SOURCE_CHAINS } from '../lib/config';
import { easscanAttestationUrl } from '../lib/easscan';
import { mirror } from '../lib/mirror';
import { parseUidInput } from '../lib/parse';
import type { ChainKey, MirrorProgressDetail, MirrorStage } from '../lib/types';
import { useRegistryAddress } from '../hooks/useRegistryAddress';

const ORDER: MirrorStage[] = ['resolving', 'awaiting-attestation', 'building-proof', 'submitting', 'mirrored'];

export default function MirrorApp() {
  const [input, setInput] = useState('');
  const [chainKey, setChainKey] = useState<ChainKey>(DEFAULT_CHAIN_KEY);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<TheatreState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { address: registryAddress } = useRegistryAddress();

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(
    (rawValue: string, forcedChainKey?: ChainKey) => {
      const parsed = parseUidInput(rawValue);
      if (!parsed.uid) {
        setError(parsed.error);
        return;
      }
      const key = forcedChainKey ?? parsed.chainKey ?? chainKey;
      setChainKey(key);
      setError(null);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const timings: Partial<Record<MirrorStage, StageTiming>> = {
        resolving: { startedAt: performance.now() },
      };

      const next: TheatreState = {
        uid: parsed.uid,
        chainKey: key,
        progress: { stage: 'resolving' },
        timings,
        record: null,
        done: false,
        outcome: null,
      };
      setState(next);

      let current: MirrorStage = 'resolving';

      const onProgress = (p: MirrorProgressDetail) => {
        setState((prev) => {
          if (!prev) return prev;
          const t = { ...prev.timings };
          if (p.stage !== current) {
            const prevIdx = ORDER.indexOf(current);
            if (prevIdx !== -1 && t[current] && !t[current]!.endedAt) {
              t[current] = { ...t[current]!, endedAt: performance.now() };
            }
            if (p.stage !== 'failed' && !t[p.stage]) {
              t[p.stage] = { startedAt: performance.now() };
            }
            if (p.stage === 'mirrored' && t.mirrored) {
              t.mirrored = { ...t.mirrored, endedAt: performance.now() };
            }
            current = p.stage;
          }
          return { ...prev, progress: { ...prev.progress, ...p }, timings: t };
        });
      };

      mirror({ uid: parsed.uid, chainKey: key, onProgress, signal: controller.signal })
        .then((outcome) => {
          setState((prev) => {
            if (!prev) return prev;
            const t = { ...prev.timings };
            for (const stage of ORDER) {
              if (t[stage] && !t[stage]!.endedAt) t[stage] = { ...t[stage]!, endedAt: performance.now() };
            }
            return {
              ...prev,
              timings: t,
              record: outcome.record ?? prev.record,
              done: true,
              outcome:
                outcome.stage === 'mirrored'
                  ? prev.progress.alreadyMirrored
                    ? 'already-mirrored'
                    : 'mirrored'
                  : outcome.stage === 'needs-signer'
                    ? 'needs-signer'
                    : 'failed',
            };
          });
        })
        .catch((e: unknown) => {
          if ((e as Error).name === 'AbortError') return;
          const message = e instanceof Error ? e.message : String(e);
          setState((prev) =>
            prev
              ? { ...prev, progress: { ...prev.progress, stage: 'failed', error: message }, done: true, outcome: 'failed' }
              : prev,
          );
        });
    },
    [chainKey],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(null);
    setError(null);
  }, []);

  if (state) {
    return (
      <Shell>
        <section className="mirror-stage theatre">
          <div className="theatre-head">
            <div>
              <h1 className="theatre-title">Proving it.</h1>
              <p className="theatre-subject">
                {SOURCE_CHAINS[state.chainKey].label} · chainKey {state.chainKey} · {state.uid}
              </p>
            </div>
            <div className="theatre-actions">
              <button type="button" className="btn btn-quiet" onClick={reset}>
                Paste another
              </button>
            </div>
          </div>

          <ProofTheatre state={state} />

          {state.done ? <Verdict state={state} registryAddress={registryAddress} /> : null}
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="mirror-stage prompt">
        <h1 className="prompt-title">
          <span className="rise">Paste the</span>
          <span className="rise">UID.</span>
        </h1>

        <form
          className="paste-row"
          onSubmit={(e) => {
            e.preventDefault();
            start(input);
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
          <button type="submit" className="submit-square" aria-label="Mirror this attestation">
            →
          </button>
        </form>

        <p className="prompt-sub">No oracle. No bridge. No new signature.</p>
        {error ? <p className="prompt-error">{error}</p> : null}

        <div className="prompt-controls">
          <span className="label">source chain</span>
          <div className="chain-toggle">
            {CHAIN_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={chainKey === key}
                onClick={() => setChainKey(key)}
              >
                {SOURCE_CHAINS[key].label} · {key}
              </button>
            ))}
          </div>
        </div>

        <div className="examples">
          <p className="examples-title">
            Real mainnet attestations, written by strangers · already attested onto Creditcoin
          </p>
          {EXAMPLE_UIDS.map((ex) => (
            <button
              key={ex.uid}
              type="button"
              className="example-row"
              onClick={() => {
                setInput(ex.uid);
                start(ex.uid, ex.chainKey);
              }}
            >
              <span className="uid">{ex.uid}</span>
              <span className="note">
                {SOURCE_CHAINS[ex.chainKey].label} · {ex.note}
              </span>
            </button>
          ))}
        </div>
      </section>
    </Shell>
  );
}

function Verdict({ state, registryAddress }: { state: TheatreState; registryAddress: string }) {
  const { outcome, uid, chainKey, record } = state;
  const chain = SOURCE_CHAINS[chainKey];
  const cliCommand = `npx admissible verify ${uid}`;

  const word =
    outcome === 'mirrored'
      ? 'Mirrored.'
      : outcome === 'already-mirrored'
        ? 'Already mirrored.'
        : outcome === 'needs-signer'
          ? 'Proof built.'
          : 'Not mirrored.';

  return (
    <div className="verdict">
      <p className="verdict-word">{word}</p>

      {outcome === 'already-mirrored' ? (
        <p className="verdict-note">
          This attestation was already in the registry, so nothing was re-submitted. The record below was read
          from Creditcoin over the public RPC just now.
        </p>
      ) : null}

      {outcome === 'needs-signer' ? (
        <p className="verdict-note">
          Every public step ran for real: the UID resolved to its Ethereum transaction, the source block was
          confirmed attested on the ChainInfo precompile, and the Attestcoin prover returned a complete proof.
          Submitting that proof costs CTC and needs a funded signer, which this browser build deliberately does
          not carry — the key would be readable in the bundle. Run the command below, or the worker, to submit
          it.
        </p>
      ) : null}

      {outcome === 'failed' && state.progress.error ? (
        <p className="verdict-note">{state.progress.error}</p>
      ) : null}

      {record ? (
        <dl className="facts" style={{ marginTop: '1.4rem' }}>
          <div>
            <dt className="fact-label">attester</dt>
            <dd className="fact-value">
              <Hash value={record.attester} head={10} tail={8} />
            </dd>
          </div>
          <div>
            <dt className="fact-label">recipient</dt>
            <dd className="fact-value">
              <Hash value={record.recipient} head={10} tail={8} />
            </dd>
          </div>
          <div>
            <dt className="fact-label">schema uid</dt>
            <dd className="fact-value">
              <Hash value={record.schemaUid} head={10} tail={8} />
            </dd>
          </div>
          <div>
            <dt className="fact-label">source block</dt>
            <dd className="fact-value">{record.sourceBlock.toLocaleString('en-US')}</dd>
          </div>
          <div>
            <dt className="fact-label">mirrored at</dt>
            <dd className="fact-value">{record.mirroredAt.toLocaleString('en-US')}</dd>
          </div>
          <div>
            <dt className="fact-label">revoked</dt>
            <dd className="fact-value">{String(record.revoked)}</dd>
          </div>
        </dl>
      ) : null}

      <div className="verdict-links">
        <a href={easscanAttestationUrl(chainKey, uid)} target="_blank" rel="noreferrer">
          Open the same UID on {chain.easscanBase.replace('https://', '')} ↗
        </a>
        {state.progress.creditcoinTxHash ? (
          <a
            href={`${CREDITCOIN_EXPLORER}/tx/${state.progress.creditcoinTxHash}`}
            target="_blank"
            rel="noreferrer"
          >
            Creditcoin transaction ↗
          </a>
        ) : null}
        {registryAddress ? (
          <a href={`${CREDITCOIN_EXPLORER}/address/${registryAddress}`} target="_blank" rel="noreferrer">
            Registry contract ↗
          </a>
        ) : null}
        <Link to={`/verify?uid=${uid}&chainKey=${chainKey}`}>Diff it field by field →</Link>
      </div>

      <Code lang="bash" label="verify it yourself, no API key, no local state">
        {cliCommand}
      </Code>
    </div>
  );
}
