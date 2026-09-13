import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatEther, isAddress, ZeroHash } from 'ethers';
import Shell from '../components/Shell';
import { CopyButton, Empty, Hash, Notice, Stat, Working } from '../components/Bits';
import {
  CREDITCOIN_EXPLORER,
  EXAMPLE_POOL_BORROWERS,
  POOL_REQUIRED_ATTESTER,
  POOL_REQUIRED_SCHEMA,
} from '../lib/config';
import {
  checkEligibility,
  PoolNotDeployedError,
  readPoolConfig,
  type EligibilityResult,
  type PoolConfig,
} from '../lib/pool';

const EASCAN_RECIPE_CURL = `curl -s https://easscan.org/graphql -H 'content-type: application/json' \\
  -d '{"query":"query($t:Int!){attestations(take:$t,orderBy:{time:desc},where:{schemaId:{equals:\\"${POOL_REQUIRED_SCHEMA}\\"},attester:{equals:\\"${POOL_REQUIRED_ATTESTER}\\"},txid:{not:{equals:\\"\\"}}}){id recipient}}","variables":{"t":50}}'`;

/**
 * Which failures are "you pasted a UID this pool doesn't accept" rather than
 * "the system is broken" — these get the plain-language hint below.
 */
const HINTABLE = new Set([1, 3, 4, 5]); // NotMirrored, WrongAttester, WrongSchema, NotRecipient

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

                  {HINTABLE.has(result.status) ? (
                    <div className="verify-outcome-hint">
                      {result.status === 1 ? (
                        <p>
                          <strong>Why “{result.label}” is the right answer:</strong> this pool only accepts
                          credentials that have already been mirrored onto Creditcoin. This UID isn’t on the
                          registry yet — either it was never written in an Ethereum transaction (off-chain
                          attestations have nothing to prove), or it simply hasn’t been mirrored. The{' '}
                          <Link to="/app" className="hash-link">
                            mirror view
                          </Link>{' '}
                          will tell you which.
                        </p>
                      ) : (
                        <p>
                          <strong>Why “{result.label}” is the right answer:</strong> this pool doesn’t accept just
                          any mirrored UID — it lends only to a <em>specific</em> credential on Ethereum mainnet:
                          attester <Hash value={POOL_REQUIRED_ATTESTER} head={8} tail={6} />, schema{' '}
                          <Hash value={POOL_REQUIRED_SCHEMA} head={8} tail={6} />. This UID exists on Creditcoin but
                          fails one of the pool’s gates (wrong issuer, wrong schema, or recipient isn’t this
                          address) — exactly as it should.
                        </p>
                      )}
                      <p>
                        To try the flow with <em>your own</em> credential instead, use{' '}
                        <Link to="/sandbox" className="hash-link">
                          the sandbox pool
                        </Link>{' '}
                        — it accepts any mirrored UID you self-issue on Sepolia.
                      </p>
                    </div>
                  ) : null}
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

            <div className="section">
              <h2 className="section-title">Find a real holder yourself — no samples.</h2>
              <p className="section-note">
                The example buttons above aren’t cherry-picked: they’re the <strong>complete set</strong> of people the
                pinned issuer has ever attested on-chain. Here’s how to confirm that yourself, straight from easscan.
                This query returns every mainnet attestation matching this pool’s exact requirement (
                <code className="mono">POOL_REQUIRED_ATTESTER</code> + <code className="mono">POOL_REQUIRED_SCHEMA</code>
                ), where each row’s <code className="mono">id</code> is the UID and{' '}
                <code className="mono">recipient</code> is the borrower address:
              </p>
              <div className="code">
                <div className="code-head">
                  <span>bash</span>
                  <CopyButton value={EASCAN_RECIPE_CURL} />
                </div>
                <pre>
                  <code>{EASCAN_RECIPE_CURL}</code>
                </pre>
              </div>
              <p className="section-note">
                It should print: <code className="mono">DC5EF2…</code>, <code className="mono">0893990a…</code>,{' '}
                <code className="mono">46fF491D…</code>, <code className="mono">19E00225…</code> — the same four
                addresses as the buttons, cross-checked from a source we don’t control. Paste any returned{' '}
                <code className="mono">recipient</code> + <code className="mono">id</code> pair above and it reads
                “Eligible to borrow”. If you want to try with your own UID, head to{' '}
                <Link to="/sandbox" className="hash-link">
                  /sandbox
                </Link>{' '}
                and self-issue one on Sepolia.
              </p>
            </div>
          </>
        )}
      </section>
    </Shell>
  );
}
