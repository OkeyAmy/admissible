import { useEffect, useState } from 'react';
import Shell from '../components/Shell';
import { Empty, Hash, Notice, ScrollTable, Working } from '../components/Bits';
import { CREDITCOIN_EXPLORER } from '../lib/config';
import { easscanAttestationUrl } from '../lib/easscan';
import { formatUnixSeconds } from '../lib/format';
import {
  RegistryNotDeployedError,
  scanMirrorEvents,
  scanRevocationEvents,
  type RevocationEventRow,
} from '../lib/registry';
import type { ChainKey } from '../lib/types';

interface RevocationDisplayRow extends RevocationEventRow {
  mirrorTxHash?: string | null;
  mirrorTxLoading: boolean;
}

/**
 * The registry records revoked = true / revokedAt on the same struct as the
 * mirror, but does not itself store the Creditcoin tx that performed the
 * original mirror. That tx has to be found by walking AttestationMirrored
 * events for the same (chainKey, uid) — bounded, since the registry was only
 * just deployed and there is not yet deep history to walk.
 */
async function findMirrorTxHash(chainKey: ChainKey, uid: string): Promise<string | null> {
  let before: number | null = null;
  for (let i = 0; i < 6; i += 1) {
    const scan = await scanMirrorEvents({ chainKey, limit: 400, maxWindows: 8, before: before ?? undefined });
    const hit = scan.rows.find((r) => r.uid.toLowerCase() === uid.toLowerCase());
    if (hit) return hit.creditcoinTxHash;
    if (scan.exhausted) return null;
    before = scan.scannedFrom - 1;
  }
  return null;
}

export default function Revocation() {
  const [rows, setRows] = useState<RevocationDisplayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    scanRevocationEvents({ limit: 20, maxWindows: 15 })
      .then((revocations) => {
        if (!live) return;
        const initial = revocations.map((r) => ({ ...r, mirrorTxLoading: true }));
        setRows(initial);
        setLoading(false);
        // Resolve each row's original mirror tx hash independently, in the
        // background, so the revocation facts render immediately.
        initial.forEach((row, i) => {
          findMirrorTxHash(row.chainKey, row.uid)
            .then((mirrorTxHash) => {
              if (!live) return;
              setRows((prev) => {
                const next = prev.slice();
                if (next[i]) next[i] = { ...next[i], mirrorTxHash, mirrorTxLoading: false };
                return next;
              });
            })
            .catch(() => {
              if (!live) return;
              setRows((prev) => {
                const next = prev.slice();
                if (next[i]) next[i] = { ...next[i], mirrorTxHash: null, mirrorTxLoading: false };
                return next;
              });
            });
        });
      })
      .catch((e: unknown) => {
        if (!live) return;
        setLoading(false);
        setError(e instanceof RegistryNotDeployedError ? e.message : (e as Error).message);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <Shell>
      <section className="page">
        <div className="page-head">
          <span className="eyebrow">Revocation</span>
          <h1 className="page-title">Withdrawing it, too.</h1>
          <p className="page-lede">
            Same pipeline as mirroring, over EAS's <code className="mono">Revoked</code> event. The registry flips{' '}
            <code className="mono">revoked = true</code> — any contract calling{' '}
            <code className="mono">isValid(...)</code> starts returning false immediately, no migration.
          </p>
        </div>

        <Notice warm>
          Organic EAS revocations are rare — a 15,000-block Sepolia sweep found zero. The row below is a
          self-issued attestation, revoked to demonstrate the mechanism, disclosed as such.
        </Notice>

        <div className="section">
          <h2 className="section-title">Live from the registry</h2>

          {loading ? (
            <div className="page-loading">
              <Working>Reading revocation events…</Working>
            </div>
          ) : error ? (
            <Notice warm>{error}</Notice>
          ) : rows.length === 0 ? (
            <Empty title="No revocations mirrored yet." />
          ) : (
            <ScrollTable>
              <table className="data">
                <thead>
                  <tr>
                    <th>chainKey</th>
                    <th>uid</th>
                    <th>revokedAt</th>
                    <th>mirror tx (action 0)</th>
                    <th>revoke tx (action 1)</th>
                    <th>queryId</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.chainKey}-${row.uid}`}>
                      <td>{row.chainKey === 3 ? '3 · mainnet' : '1 · sepolia'}</td>
                      <td>
                        <Hash value={row.uid} href={easscanAttestationUrl(row.chainKey, row.uid)} head={10} tail={6} />
                      </td>
                      <td>{formatUnixSeconds(row.revokedAt)}</td>
                      <td>
                        {row.mirrorTxLoading ? (
                          <span className="hash-dim">locating…</span>
                        ) : row.mirrorTxHash ? (
                          <Hash value={row.mirrorTxHash} href={`${CREDITCOIN_EXPLORER}/tx/${row.mirrorTxHash}`} head={8} tail={6} />
                        ) : (
                          <span className="hash-dim">not found in scanned range</span>
                        )}
                      </td>
                      <td>
                        <Hash value={row.creditcoinTxHash} href={`${CREDITCOIN_EXPLORER}/tx/${row.creditcoinTxHash}`} head={8} tail={6} />
                      </td>
                      <td>
                        <Hash value={row.queryId} head={8} tail={6} dim />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTable>
          )}
        </div>

      </section>
    </Shell>
  );
}
