import { useCallback, useState } from 'react';
import { Contract, formatEther, parseEther, ZeroHash } from 'ethers';
import Shell from '../components/Shell';
import { Empty, Hash, Notice, Stat, Working } from '../components/Bits';
import { CREDITCOIN_EXPLORER, SANDBOX_SCHEMA, SOURCE_CHAINS } from '../lib/config';
import { EAS_ATTEST_ABI } from '../lib/abi';
import { mirror as runMirror, type MirrorOutcome } from '../lib/mirror';
import { readSandboxPoolConfig, sandboxPoolContract, type PoolConfig } from '../lib/pool';
import { connectWallet, hasInjectedWallet, NoWalletError, switchToCreditcoin, switchToSepolia } from '../lib/wallet';
import type { MirrorProgressDetail } from '../lib/types';

type StepState = 'idle' | 'working' | 'done' | 'error';

export default function Sandbox() {
  const [address, setAddress] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [attestState, setAttestState] = useState<StepState>('idle');
  const [attestError, setAttestError] = useState<string | null>(null);
  const [attestTx, setAttestTx] = useState<string | null>(null);
  const [uid, setUid] = useState<string | null>(null);

  const [mirrorState, setMirrorState] = useState<StepState>('idle');
  const [mirrorProgress, setMirrorProgress] = useState<MirrorProgressDetail | null>(null);
  const [mirrorOutcome, setMirrorOutcome] = useState<MirrorOutcome | null>(null);

  const [presentState, setPresentState] = useState<StepState>('idle');
  const [presentError, setPresentError] = useState<string | null>(null);
  const [presentTx, setPresentTx] = useState<string | null>(null);

  const [borrowAmount, setBorrowAmount] = useState('1');
  const [borrowState, setBorrowState] = useState<StepState>('idle');
  const [borrowError, setBorrowError] = useState<string | null>(null);
  const [borrowTx, setBorrowTx] = useState<string | null>(null);

  const [repayState, setRepayState] = useState<StepState>('idle');
  const [repayError, setRepayError] = useState<string | null>(null);
  const [repayTx, setRepayTx] = useState<string | null>(null);

  const [poolConfig, setPoolConfig] = useState<PoolConfig | null>(null);

  const connect = useCallback(async () => {
    setConnectError(null);
    try {
      const { address: addr } = await connectWallet();
      setAddress(addr);
      readSandboxPoolConfig().then(setPoolConfig).catch(() => undefined);
    } catch (e) {
      setConnectError(e instanceof NoWalletError ? e.message : (e as Error).message);
    }
  }, []);

  const doAttest = useCallback(async () => {
    if (!address) return;
    setAttestState('working');
    setAttestError(null);
    try {
      await switchToSepolia();
      const { signer } = await connectWallet();
      const eas = new Contract(SOURCE_CHAINS[1].easAddress, EAS_ATTEST_ABI, signer);
      const tx = await eas.attest({
        schema: SANDBOX_SCHEMA,
        data: {
          recipient: address,
          expirationTime: 0n,
          revocable: true,
          refUID: ZeroHash,
          data: '0x0000000000000000000000000000000000000000000000000000000000000001',
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      setAttestTx(tx.hash);
      // EAS Attested(recipient indexed, attester indexed, uid, schemaUID indexed) — uid is the
      // sole non-indexed word, so it is the log's data field, not a topic.
      const log = receipt.logs.find((l: { address: string }) => l.address.toLowerCase() === SOURCE_CHAINS[1].easAddress.toLowerCase());
      const newUid = log?.data && log.data !== '0x' ? log.data : null;
      if (!newUid) throw new Error('Attestation succeeded but no Attested log was found to read the UID from.');
      setUid(newUid);
      setAttestState('done');
    } catch (e) {
      setAttestError((e as Error).message);
      setAttestState('error');
    }
  }, [address]);

  const doMirror = useCallback(async () => {
    if (!uid) return;
    setMirrorState('working');
    setMirrorProgress(null);
    try {
      const outcome = await runMirror({
        uid,
        chainKey: 1,
        onProgress: setMirrorProgress,
      });
      setMirrorOutcome(outcome);
      setMirrorState(outcome.stage === 'mirrored' ? 'done' : 'error');
    } catch (e) {
      setMirrorOutcome({ stage: 'failed', error: (e as Error).message });
      setMirrorState('error');
    }
  }, [uid]);

  const doPresent = useCallback(async () => {
    if (!uid) return;
    setPresentState('working');
    setPresentError(null);
    try {
      await switchToCreditcoin();
      const { signer } = await connectWallet();
      const pool = await sandboxPoolContract(signer);
      const tx = await pool.presentCredential(uid);
      await tx.wait();
      setPresentTx(tx.hash);
      setPresentState('done');
    } catch (e) {
      setPresentError((e as Error).message);
      setPresentState('error');
    }
  }, [uid]);

  const doBorrow = useCallback(async () => {
    if (!uid) return;
    setBorrowState('working');
    setBorrowError(null);
    try {
      await switchToCreditcoin();
      const { signer } = await connectWallet();
      const pool = await sandboxPoolContract(signer);
      const tx = await pool.borrow(uid, parseEther(borrowAmount || '0'));
      await tx.wait();
      setBorrowTx(tx.hash);
      setBorrowState('done');
      readSandboxPoolConfig().then(setPoolConfig).catch(() => undefined);
    } catch (e) {
      setBorrowError((e as Error).message);
      setBorrowState('error');
    }
  }, [uid, borrowAmount]);

  const doRepay = useCallback(async () => {
    setRepayState('working');
    setRepayError(null);
    try {
      await switchToCreditcoin();
      const { signer, address: addr } = await connectWallet();
      const pool = await sandboxPoolContract(signer);
      const owed: bigint = await pool.debt(addr);
      if (owed === 0n) throw new Error('Nothing owed — nothing to repay.');
      const tx = await pool.repay({ value: owed });
      await tx.wait();
      setRepayTx(tx.hash);
      setRepayState('done');
      readSandboxPoolConfig().then(setPoolConfig).catch(() => undefined);
    } catch (e) {
      setRepayError((e as Error).message);
      setRepayState('error');
    }
  }, []);

  return (
    <Shell>
      <section className="page">
        <div className="page-head">
          <span className="eyebrow">Sandbox</span>
          <h1 className="page-title">Try the full loan cycle yourself.</h1>
          <p className="page-lede">
            A second, wildcard pool on Sepolia so your own wallet can self-issue a credential and run the real
            loan cycle — present, borrow, repay. Every transaction below is signed by you, not us.
          </p>
        </div>

        {!hasInjectedWallet() ? (
          <Notice warm>No injected wallet detected. Install MetaMask (or any EIP-1193 wallet) to continue.</Notice>
        ) : !address ? (
          <div className="section">
            <button type="button" className="btn btn-lime" onClick={connect}>
              Connect wallet
            </button>
            {connectError ? <p className="prompt-error">{connectError}</p> : null}
          </div>
        ) : (
          <>
            <div className="section">
              <p className="section-note">
                connected: <Hash value={address} head={8} tail={6} />
              </p>
              {poolConfig ? (
                <div className="stats">
                  <Stat label="sandbox pool" value={<Hash value={poolConfig.address} head={8} tail={6} />} />
                  <Stat label="chainKey" value={`${poolConfig.chainKey} · sepolia`} />
                  <Stat label="available liquidity" value={`${formatEther(poolConfig.availableLiquidity)} CTC`} mono />
                  <Stat label="borrow cap" value={`${formatEther(poolConfig.borrowCap)} CTC`} mono />
                </div>
              ) : null}
            </div>

            <div className="section">
              <h2 className="section-title">1. Self-issue a Sepolia credential</h2>
              {attestState === 'done' && uid ? (
                <Notice>
                  Issued — UID <Hash value={uid} head={10} tail={6} />, tx{' '}
                  <a
                    className="hash-link"
                    href={`${SOURCE_CHAINS[1].etherscan}/tx/${attestTx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {attestTx ? `${attestTx.slice(0, 10)}…` : ''}
                  </a>
                </Notice>
              ) : (
                <button type="button" className="btn btn-quiet" onClick={doAttest} disabled={attestState === 'working'}>
                  {attestState === 'working' ? <Working>Signing…</Working> : 'Self-attest on Sepolia'}
                </button>
              )}
              {attestError ? <p className="prompt-error">{attestError}</p> : null}
            </div>

            <div className="section">
              <h2 className="section-title">2. Mirror it onto Creditcoin</h2>
              {mirrorState === 'done' ? (
                <Notice>
                  Mirrored — tx{' '}
                  {mirrorOutcome?.creditcoinTxHash ? (
                    <Hash
                      value={mirrorOutcome.creditcoinTxHash}
                      href={`${CREDITCOIN_EXPLORER}/tx/${mirrorOutcome.creditcoinTxHash}`}
                      head={10}
                      tail={6}
                    />
                  ) : (
                    'already mirrored'
                  )}
                </Notice>
              ) : (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={doMirror}
                  disabled={!uid || mirrorState === 'working'}
                >
                  {mirrorState === 'working' ? <Working>{mirrorProgress?.stage ?? 'starting…'}</Working> : 'Mirror onto Creditcoin'}
                </button>
              )}
              {mirrorState === 'working' && mirrorProgress?.stage === 'awaiting-attestation' ? (
                <p className="section-note" style={{ marginTop: '0.6rem' }}>
                  Waiting for attestation — block {mirrorProgress.targetBlock}, at {mirrorProgress.attestedHeight}
                  {mirrorProgress.targetBlock && mirrorProgress.attestedHeight
                    ? ` (${mirrorProgress.targetBlock - mirrorProgress.attestedHeight} behind)`
                    : ''}
                  . Usually a few minutes.
                </p>
              ) : null}
              {mirrorState === 'error' ? <p className="prompt-error">{mirrorOutcome?.error}</p> : null}
            </div>

            <div className="section">
              <h2 className="section-title">3. Present the credential</h2>
              {presentState === 'done' ? (
                <Notice>
                  Presented — tx{' '}
                  <Hash value={presentTx ?? ''} href={`${CREDITCOIN_EXPLORER}/tx/${presentTx}`} head={10} tail={6} />
                </Notice>
              ) : (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={doPresent}
                  disabled={mirrorState !== 'done' || presentState === 'working'}
                >
                  {presentState === 'working' ? <Working>Signing…</Working> : 'Present credential'}
                </button>
              )}
              {presentError ? <p className="prompt-error">{presentError}</p> : null}
            </div>

            <div className="section">
              <h2 className="section-title">4. Borrow</h2>
              <div className="paste-row">
                <div className="field">
                  <input
                    value={borrowAmount}
                    onChange={(e) => setBorrowAmount(e.target.value)}
                    placeholder="amount in CTC"
                    inputMode="decimal"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={doBorrow}
                  disabled={presentState !== 'done' || borrowState === 'working'}
                >
                  {borrowState === 'working' ? <Working>Signing…</Working> : 'Borrow'}
                </button>
              </div>
              {borrowState === 'done' ? (
                <Notice>
                  Borrowed — tx <Hash value={borrowTx ?? ''} href={`${CREDITCOIN_EXPLORER}/tx/${borrowTx}`} head={10} tail={6} />
                </Notice>
              ) : null}
              {borrowError ? <p className="prompt-error">{borrowError}</p> : null}
            </div>

            <div className="section">
              <h2 className="section-title">5. Repay</h2>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={doRepay}
                disabled={borrowState !== 'done' || repayState === 'working'}
              >
                {repayState === 'working' ? <Working>Signing…</Working> : 'Repay in full'}
              </button>
              {repayState === 'done' ? (
                <Notice>
                  Repaid — tx <Hash value={repayTx ?? ''} href={`${CREDITCOIN_EXPLORER}/tx/${repayTx}`} head={10} tail={6} />
                </Notice>
              ) : null}
              {repayError ? <p className="prompt-error">{repayError}</p> : null}
            </div>
          </>
        )}

        {!address && hasInjectedWallet() ? (
          <div className="section">
            <Empty title="Connect a wallet to start.">
              <p>Every step signs with your own key.</p>
            </Empty>
          </div>
        ) : null}
      </section>
    </Shell>
  );
}
