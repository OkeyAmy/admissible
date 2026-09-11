import { Link } from 'react-router-dom';
import {
  ASC_DASHBOARD,
  BASELINE,
  BLOCK_PROVER_PRECOMPILE,
  CHAIN_INFO_PRECOMPILE,
  CREDITCOIN_EXPLORER,
  SOURCE_CHAINS,
} from '../lib/config';
import { formatMs } from '../lib/format';

const FLOW = [
  {
    title: 'Someone writes an attestation on Ethereum.',
    body:
      'A KYC check, a credential, a reputation claim. It is signed and recorded by the Ethereum Attestation Service. A stranger did this, months ago, for their own reasons — and it is already final.',
    meta: (
      <>
        EAS mainnet <span>{SOURCE_CHAINS[3].easAddress}</span>
      </>
    ),
  },
  {
    title: 'Attestcoin attestors attest that Ethereum block onto Creditcoin.',
    body:
      'The Attestcoin Protocol carries Ethereum block digests onto Creditcoin continuously. Nothing about the attestation is re-signed, re-issued or re-asserted; only the block it lives in is committed to.',
    meta: (
      <>
        ChainInfo precompile <span>{CHAIN_INFO_PRECOMPILE}</span> · chainKey 3 = mainnet, 1 = Sepolia
      </>
    ),
  },
  {
    title: 'The proof builder returns a merkle proof and a continuity proof.',
    body:
      'One proof places the transaction inside its block; the other chains that block back to an attested endpoint. Both are produced from public data by a public service, with no key and no permission.',
    meta: (
      <>
        measured over {BASELINE.sample} real mainnet attestations · median{' '}
        <span>{formatMs(BASELINE.medianMs)}</span> · p95 <span>{formatMs(BASELINE.p95Ms)}</span>
      </>
    ),
  },
  {
    title: 'A Creditcoin contract verifies it synchronously.',
    body:
      'AttestationRegistry.execute hands the proof to the BlockProver precompile inside the same transaction. Native speed, no callback, no oracle to trust. The registry then decodes the receipt logs and stores every Attested event the transaction carried.',
    meta: (
      <>
        BlockProver precompile <span>{BLOCK_PROVER_PRECOMPILE}</span>
      </>
    ),
  },
  {
    title: 'Any Creditcoin contract can now read it.',
    body:
      'isValid(chainKey, uid) is one call. A lending pool can gate a loan on an Ethereum KYC attestation without ever asking its holder to sign anything again. Revocation runs the identical path over the Revoked event.',
    meta: (
      <>
        estimated cost <span>{BASELINE.costMin}–{BASELINE.costMax} CTC</span> per verification ·{' '}
        {BASELINE.costFormula}
      </>
    ),
  },
];

export default function Landing() {
  return (
    <div className="landing mood-dark">
      <section className="threshold">
        <div className="threshold-bg">
          <img src="/media/hero-threshold.png" alt="" aria-hidden="true" />
        </div>

        <div className="threshold-inner">
          <div className="wordmark-dark">admissible</div>

          <div className="threshold-copy">
            <h1 className="threshold-headline">They already wrote it.</h1>
            <div className="threshold-rule" />
            <p className="threshold-subline">Ethereum attestations, admissible on Creditcoin.</p>
          </div>

          <div className="threshold-foot">
            <span className="scroll-hint">Scroll</span>
            <Link className="enter-link" to="/app">
              Enter
            </Link>
          </div>
        </div>
      </section>

      <section className="mechanism">
        <div className="mechanism-inner">
          <h2 className="mechanism-lede">
            Ethereum holds millions of attestations. Creditcoin could not read a single one of them — until the
            attestation itself became <em>admissible</em>.
          </h2>
          <p className="mechanism-note">
            Not copied. Not vouched for by a committee. Proved — from the same bytes Ethereum recorded, verified
            by a Creditcoin precompile inside one transaction.
          </p>

          <ol className="flow">
            {FLOW.map((step, i) => (
              <li key={step.title}>
                <span className="flow-index">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <h3 className="flow-title">{step.title}</h3>
                  <p className="flow-body">{step.body}</p>
                  <p className="flow-meta">{step.meta}</p>
                </div>
              </li>
            ))}
          </ol>

          <dl className="dark-facts">
            <div className="dark-fact">
              <dt>proof latency, median</dt>
              <dd className="big">{formatMs(BASELINE.medianMs)}</dd>
            </div>
            <div className="dark-fact">
              <dt>proof latency, p95</dt>
              <dd className="big">{formatMs(BASELINE.p95Ms)}</dd>
            </div>
            <div className="dark-fact">
              <dt>continuity roots observed</dt>
              <dd className="big">
                {BASELINE.continuityRootsMin}–{BASELINE.continuityRootsMax}
              </dd>
            </div>
            <div className="dark-fact">
              <dt>network</dt>
              <dd>Creditcoin CC3 testnet · chain 102031</dd>
            </div>
          </dl>

          <div className="mechanism-close">
            <Link className="enter-link" to="/app">
              Paste a UID
            </Link>
            <nav className="dark-links">
              <Link to="/registry">Registry</Link>
              <Link to="/verify">Verify</Link>
              <Link to="/revocation">Revocation</Link>
              <Link to="/sdk">SDK</Link>
              <Link to="/receipts">Receipts</Link>
              <Link to="/docs">Docs</Link>
              <a href={CREDITCOIN_EXPLORER} target="_blank" rel="noreferrer">
                Explorer ↗
              </a>
              <a href={ASC_DASHBOARD} target="_blank" rel="noreferrer">
                Attestcoin dashboard ↗
              </a>
            </nav>
          </div>

          <p className="attrib">
            Built on the Attestcoin Protocol. EAS is MIT-licensed. @gluwa/asc-contracts and @gluwa/usc-sdk are
            the organizer&rsquo;s. Testnet only.
          </p>
        </div>
      </section>
    </div>
  );
}
