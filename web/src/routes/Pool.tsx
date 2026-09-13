import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatEther, isAddress, ZeroHash } from 'ethers';
import Shell from '../components/Shell';
import { Empty, Hash, Notice, Stat, Working } from '../components/Bits';
import { CREDITCOIN_EXPLORER, EXAMPLE_POOL_BORROWERS } from '../lib/config';
import {
  checkEligibility,
  PoolNotDeployedError,
  readPoolConfig,
  type EligibilityResult,
  type PoolConfig,
} from '../lib/pool';

export default function Pool() {
  const [config, setConfig] = useState<PoolConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [uid, setUid] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EligibilityResult | null>(null);

  useEffect(() => {
    readPoolConfig()
      .then(setConfig)
      .catch((e: unknown) => setConfigError(e instanceof PoolNotDeployedError ? e.message : (e as Error).message));
  }, []);

  const run = useCallback((rawAddress: string, rawUid: string) => {
    const addr = rawAddress.trim();
    if (!isAddress(addr)) {
      setError('Not a valid address.');
      return;
    }
    const trimmedUid = rawUid.trim();
    if (trimmedUid && !/^0x[0-9a-fA-F]{64}$/.test(trimmedUid)) {
      setError('UID must be a 32-byte hex value, or left blank.');
      return;
    }
    setError(null);
    setLoading(true);
    setResult(null);
    checkEligibility(addr, trimmedUid || undefined)
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof PoolNotDeployedError ? e.message : (e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Shell>
      <section className="page">
        <div className="page-head">
          <span className="eyebrow">Pool</span>
          <h1 className="page-title">The consumer side.</h1>
          <p className="page-lede">
            <code className="mono">CredentialGatedPool</code> lends only to a mirrored, non-revoked EAS credential —
            read live below, nothing here is hardcoded. Read-only: to actually borrow with your own wallet, try{' '}
            <Link className="hash-link" to="/sandbox">/sandbox</Link>.
          </p>
        </div>

        {configError ? (
          <div className="section">
            <Notice warm>{configError}</Notice>
          </div>
        ) : !config ? (
          <div className="page-loading">
            <Working>Reading pool config…</Working>
          </div>
        ) : (
          <>
            <div className="stats">
              <Stat label="pool" value={<Hash value={config.address} head={8} tail={6} />} />
              <Stat label="chainKey" value={String(config.chainKey)} />
              <Stat
                label="required attester"
                value={
                  config.requiredAttester === '0x0000000000000000000000000000000000000000' ? (
                    'any'
                  ) : (
                    <Hash value={config.requiredAttester} head={8} tail={6} />
                  )
                }
              />
              <Stat
                label="required schema"
                value={config.requiredSchema === ZeroHash ? 'any' : <Hash value={config.requiredSchema} head={8} tail={6} />}
              />
              <Stat label="total deposits" value={`${formatEther(config.totalDeposits)} CTC`} mono />
              <Stat label="total debt" value={`${formatEther(config.totalDebt)} CTC`} mono />
              <Stat label="available liquidity" value={`${formatEther(config.availableLiquidity)} CTC`} mono />
              <Stat label="borrow cap" value={`${formatEther(config.borrowCap)} CTC / borrower`} mono />
            </div>

            <div className="section">
              <h2 className="section-title">Check eligibility.</h2>

              <div className="examples">
                <p className="examples-title">Real holders of the required credential</p>
                {EXAMPLE_POOL_BORROWERS.map((ex) => (
                  <button
                    key={ex.address}
                    type="button"
                    className="example-row"
                    onClick={() => {
                      setAddress(ex.address);
                      setUid(ex.uid);
                      run(ex.address, ex.uid);
                    }}
                  >
                    <span className="uid">{ex.address}</span>
                    <span className="note">{ex.note}</span>
                  </button>
                ))}
              </div>

              <form
                className="paste-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(address, uid);
                }}
              >
                <div className="field">
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="0xborrower…"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Borrower address"
                  />
                </div>
                <div className="field">
                  <input
                    value={uid}
                    onChange={(e) => setUid(e.target.value)}
                    placeholder="0xuid… (optional)"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="EAS UID (optional)"
                  />
                </div>
                <button type="submit" className="submit-square" aria-label="Check eligibility" disabled={loading}>
                  →
                </button>
              </form>

              {error ? <p className="prompt-error">{error}</p> : null}
              {loading ? <Working>Reading pool state…</Working> : null}

              {result ? (
                <div className="verify-outcome" style={{ marginTop: '1.2rem' }}>
                  <p className={`verdict-word ${result.status === 0 ? 'is-pass' : 'is-fail'}`}>{result.label}</p>
                  <p className="verdict-note">{result.reason}</p>
                  <p className="verdict-note">
                    deposits <strong>{formatEther(result.deposits)} CTC</strong> · debt{' '}
                    <strong>{formatEther(result.debt)} CTC</strong> · headroom{' '}
                    <strong>{formatEther(result.headroom)} CTC</strong>
                  </p>
                  <p className="verdict-note">
                    {result.checkedUid ? (
                      <>
                        checked UID <Hash value={result.checkedUid} head={10} tail={6} />
                      </>
                    ) : result.presentedUid !== ZeroHash ? (
                      <>
                        presented UID <Hash value={result.presentedUid} head={10} tail={6} />
                      </>
                    ) : (
                      'no credential presented to the pool yet'
                    )}
                  </p>
                </div>
              ) : !loading && !error ? (
                <Empty title="Paste a borrower address to check." />
              ) : null}
            </div>

            <div className="section">
              <p className="section-note" style={{ marginTop: '0.4rem' }}>
                pool contract:{' '}
                <a
                  className="hash-link"
                  href={`${CREDITCOIN_EXPLORER}/address/${config.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Hash value={config.address} head={10} tail={8} />
                </a>
              </p>
            </div>
          </>
        )}
      </section>
    </Shell>
  );
}
