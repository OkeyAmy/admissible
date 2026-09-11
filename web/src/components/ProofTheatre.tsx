import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  BLOCK_PROVER_PRECOMPILE,
  CHAIN_INFO_PRECOMPILE,
  CREDITCOIN_EXPLORER,
  SOURCE_CHAINS,
} from '../lib/config';
import { easscanAttestationUrl, etherscanTxUrl } from '../lib/easscan';
import { formatInt, formatMs } from '../lib/format';
import type { ChainKey, MirroredAttestation, MirrorProgressDetail, MirrorStage } from '../lib/types';
import { Hash } from './Bits';

export interface StageTiming {
  startedAt: number;
  endedAt?: number;
}

export interface TheatreState {
  uid: string;
  chainKey: ChainKey;
  progress: MirrorProgressDetail;
  timings: Partial<Record<MirrorStage, StageTiming>>;
  record: MirroredAttestation | null;
  done: boolean;
  outcome: 'mirrored' | 'already-mirrored' | 'needs-signer' | 'failed' | null;
}

const ORDER: MirrorStage[] = ['resolving', 'awaiting-attestation', 'building-proof', 'submitting', 'mirrored'];

const DESCRIPTIONS: Record<string, string> = {
  resolving: 'UID → the Ethereum transaction it was written in, via easscan and a public Ethereum RPC.',
  'awaiting-attestation':
    'Attestcoin attestors must have attested the source block onto Creditcoin before it can be proven.',
  'building-proof':
    'The Attestcoin proof-generation service returns a merkle proof of the transaction plus a continuity proof back to an attested endpoint.',
  submitting:
    'AttestationRegistry.submit(...) on Creditcoin. ASCBase.execute is external but not virtual and does not forward chainKey, so submit records the context (chainKey, blockHeight, sourceTxHash) then self-calls the inherited execute — verification and dedupe stay the base class’s. ASCBase hands the proof to the BlockProver precompile, which verifies it synchronously at native speed.',
  mirrored: 'The registry now holds the attestation. Any Creditcoin contract can read it.',
};

const LABELS: Record<MirrorStage, string> = {
  resolving: 'resolving',
  'awaiting-attestation': 'awaiting attestation',
  'building-proof': 'building proof',
  submitting: 'submitting',
  mirrored: 'mirrored',
  failed: 'failed',
};

function stageStatus(
  stage: MirrorStage,
  state: TheatreState,
): 'pending' | 'active' | 'done' | 'failed' {
  const current = state.progress.stage;
  const idx = ORDER.indexOf(stage);
  const currentIdx = ORDER.indexOf(current);

  if (current === 'failed') {
    const reached = state.timings[stage];
    if (reached && !reached.endedAt) return 'failed';
    return reached ? 'done' : 'pending';
  }
  if (state.outcome === 'needs-signer' && stage === 'submitting') return 'failed';
  if (currentIdx === -1) return 'pending';
  if (idx < currentIdx) return 'done';
  if (idx === currentIdx) return current === 'mirrored' ? 'done' : 'active';
  return 'pending';
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="fact-label">{label}</dt>
      <dd className="fact-value">{children}</dd>
    </div>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export default function ProofTheatre({ state }: { state: TheatreState }) {
  const now = useNow(!state.done);
  const { progress, chainKey, uid } = state;
  const chain = SOURCE_CHAINS[chainKey];

  const elapsedFor = (stage: MirrorStage): string | null => {
    const t = state.timings[stage];
    if (!t) return null;
    const end = t.endedAt ?? now;
    return formatMs(end - t.startedAt);
  };

  return (
    <ol className="stages">
      {ORDER.map((stage, i) => {
        const status = stageStatus(stage, state);
        const elapsed = elapsedFor(stage);
        const show = status !== 'pending';
        return (
          <li key={stage} className={`stage is-${status}`}>
            <div className="stage-rail">
              <span className="stage-dot" />
            </div>
            <div className="stage-body">
              <div className="stage-head">
                <span className="stage-index">{String(i + 1).padStart(2, '0')}</span>
                <span className="stage-name">{LABELS[stage]}</span>
                {elapsed ? <span className="stage-elapsed">{elapsed}</span> : null}
              </div>
              <p className="stage-desc">{DESCRIPTIONS[stage]}</p>

              {show ? (
                <div className="stage-detail">
                  {stage === 'resolving' ? (
                    <dl className="facts">
                      <Fact label="attestation uid">
                        <Hash value={uid} href={easscanAttestationUrl(chainKey, uid)} head={12} tail={10} />
                      </Fact>
                      <Fact label={`source tx · ${chain.shortLabel}`}>
                        {progress.sourceTxHash ? (
                          <Hash
                            value={progress.sourceTxHash}
                            href={etherscanTxUrl(chainKey, progress.sourceTxHash)}
                            head={12}
                            tail={10}
                          />
                        ) : (
                          <span className="hash-dim">reading easscan…</span>
                        )}
                      </Fact>
                      <Fact label="source block">
                        {progress.targetBlock ? formatInt(progress.targetBlock) : '—'}
                      </Fact>
                      <Fact label="tx index">
                        {progress.txIndex !== undefined ? formatInt(progress.txIndex) : '—'}
                      </Fact>
                    </dl>
                  ) : null}

                  {stage === 'awaiting-attestation' ? (
                    <>
                      <div className="counter">
                        <span className="counter-now">{formatInt(progress.attestedHeight)}</span>
                        <span className="counter-sep">/</span>
                        <span className="counter-target">{formatInt(progress.targetBlock)}</span>
                        {progress.attestedHeight !== undefined && progress.targetBlock !== undefined ? (
                          <span className="counter-delta">
                            {progress.attestedHeight >= progress.targetBlock
                              ? 'source block attested'
                              : `${formatInt(progress.targetBlock - progress.attestedHeight)} blocks to go`}
                          </span>
                        ) : null}
                      </div>
                      <p className="precompile-note">
                        Attested height read live from the ChainInfo precompile{' '}
                        <code>{CHAIN_INFO_PRECOMPILE}</code> over the public Creditcoin RPC. {chain.note}
                      </p>
                    </>
                  ) : null}

                  {stage === 'building-proof' ? (
                    <>
                      <dl className="facts">
                        <Fact label="continuity roots">
                          <span className="fact-value big">{formatInt(progress.continuityRoots)}</span>
                        </Fact>
                        <Fact label="merkle siblings">
                          <span className="fact-value big">{formatInt(progress.merkleSiblings)}</span>
                        </Fact>
                        <Fact label="merkle root">
                          <Hash value={progress.merkleRoot} head={12} tail={8} />
                        </Fact>
                        <Fact label="lower endpoint digest">
                          <Hash value={progress.lowerEndpointDigest} head={12} tail={8} />
                        </Fact>
                        <Fact label="foreign tx bytes">
                          {progress.txBytesLength ? `${formatInt(progress.txBytesLength)} bytes` : '—'}
                        </Fact>
                        <Fact label="proof latency">{formatMs(progress.proofLatencyMs)}</Fact>
                      </dl>
                      {progress.waitingForConfirmations ? (
                        <p className="waiting-line">
                          <strong>Waiting for confirmations.</strong> {progress.waitingForConfirmations} The
                          prover will answer once the block clears the reorg-protection window; this is a
                          retry, not a failure.
                        </p>
                      ) : null}
                    </>
                  ) : null}

                  {stage === 'submitting' ? (
                    <>
                      <dl className="facts">
                        <Fact label="block prover precompile">
                          <Hash value={BLOCK_PROVER_PRECOMPILE} truncate={false} />
                        </Fact>
                        <Fact label="action">0 · Mirror (decode Attested logs)</Fact>
                        <Fact label="query id · keccak(chainKey, block, txIndex)">
                          <Hash value={progress.queryId} head={12} tail={8} />
                        </Fact>
                        <Fact label="query already processed">
                          {progress.queryProcessed === undefined ? '—' : String(progress.queryProcessed)}
                        </Fact>
                        <Fact label="creditcoin tx">
                          {progress.creditcoinTxHash ? (
                            <Hash
                              value={progress.creditcoinTxHash}
                              href={`${CREDITCOIN_EXPLORER}/tx/${progress.creditcoinTxHash}`}
                              head={12}
                              tail={10}
                            />
                          ) : (
                            <span className="hash-dim">—</span>
                          )}
                        </Fact>
                      </dl>
                      <p className="precompile-note">
                        Verification is synchronous: <code>ASCBase</code> calls the precompile inside the same
                        transaction, so there is no oracle round-trip and no callback to wait on. Dedupe is per
                        transaction, not per UID — one <code>multiAttest</code> is one query carrying many
                        attestations.
                      </p>

                      {progress.preview?.length ? (
                        <div className="preview">
                          <p className="preview-title">
                            {progress.preview.length} Attested event
                            {progress.preview.length === 1 ? '' : 's'} decoded from the foreign receipt by the
                            deployed registry&rsquo;s <code>previewAttested(...)</code> — a view call, no gas,
                            no key.
                          </p>
                          <div className="scroll-x">
                            <table className="data">
                              <thead>
                                <tr>
                                  <th>uid</th>
                                  <th>attester</th>
                                  <th>recipient</th>
                                  <th>schema</th>
                                </tr>
                              </thead>
                              <tbody>
                                {progress.preview.map((ev) => (
                                  <tr
                                    key={ev.uid}
                                    className={ev.uid.toLowerCase() === uid.toLowerCase() ? 'is-subject' : undefined}
                                  >
                                    <td>
                                      <Hash value={ev.uid} head={10} tail={6} />
                                    </td>
                                    <td>
                                      <Hash value={ev.attester} head={8} tail={6} dim />
                                    </td>
                                    <td>
                                      <Hash value={ev.recipient} head={8} tail={6} dim />
                                    </td>
                                    <td>
                                      <Hash value={ev.schemaUid} head={8} tail={6} dim />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : null}
                      {progress.needsSigner && progress.error ? (
                        <p className="waiting-line">
                          <strong>Stopped before submission.</strong> {progress.error}
                        </p>
                      ) : null}
                    </>
                  ) : null}

                  {stage === 'mirrored' ? (
                    <dl className="facts">
                      <Fact label="creditcoin tx">
                        {progress.creditcoinTxHash ? (
                          <Hash
                            value={progress.creditcoinTxHash}
                            href={`${CREDITCOIN_EXPLORER}/tx/${progress.creditcoinTxHash}`}
                            head={12}
                            tail={10}
                          />
                        ) : state.record ? (
                          <span className="hash-dim">mirrored earlier</span>
                        ) : (
                          <span className="hash-dim">—</span>
                        )}
                      </Fact>
                      <Fact label="registry record">
                        {state.record ? 'exists' : progress.alreadyMirrored ? 'exists' : '—'}
                      </Fact>
                      <Fact label="revoked">
                        {state.record ? String(state.record.revoked) : '—'}
                      </Fact>
                      <Fact label="read it from a contract">
                        <Link className="hash hash-link" to="/sdk">
                          isValid(chainKey, uid)
                        </Link>
                      </Fact>
                    </dl>
                  ) : null}

                  {status === 'failed' && progress.error && stage !== 'submitting' ? (
                    <p className="stage-error">{progress.error}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
