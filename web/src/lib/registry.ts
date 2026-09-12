import { Contract, Interface, id as keccakId, zeroPadValue, toBeHex } from 'ethers';
import { REGISTRY_ABI } from './abi';
import { REGISTRY_ADDRESS } from './config';
import { creditcoinProvider } from './chain';
import type { ChainKey, MirroredAttestation } from './types';

/**
 * The registry address comes from VITE_REGISTRY_ADDRESS at build time, or from
 * /deployments.json (copied out of contracts/ by scripts/sync-assets.mjs) at
 * runtime. Neither is imported statically: a missing artifact must never break
 * the type-check.
 */
let runtimeAddress: string | null = null;
let addressProbe: Promise<string> | null = null;

export async function resolveRegistryAddress(): Promise<string> {
  if (REGISTRY_ADDRESS) return REGISTRY_ADDRESS;
  if (runtimeAddress !== null) return runtimeAddress;
  if (!addressProbe) {
    addressProbe = (async () => {
      try {
        const res = await fetch('/deployments.json', { cache: 'no-store' });
        if (!res.ok) return '';
        const json = (await res.json()) as Record<string, unknown>;
        const candidate =
          pickAddress(json, 'AttestationRegistry') ??
          pickAddress(json, 'registry') ??
          pickAddress(json, 'AdmissibleRegistry') ??
          '';
        runtimeAddress = candidate;
        return candidate;
      } catch {
        runtimeAddress = '';
        return '';
      }
    })();
  }
  return addressProbe;
}

/**
 * The block the registry was deployed at — scanning below it can never find
 * an AttestationMirrored/AttestationRevoked event (the contract didn't exist
 * yet), so event scans floor here instead of walking all the way to genesis.
 */
let deploymentBlock: number | null = null;
let deploymentBlockProbe: Promise<number> | null = null;

async function resolveDeploymentBlock(): Promise<number> {
  if (deploymentBlock !== null) return deploymentBlock;
  if (!deploymentBlockProbe) {
    deploymentBlockProbe = (async () => {
      try {
        const res = await fetch('/deployments.json', { cache: 'no-store' });
        if (!res.ok) return 0;
        const json = (await res.json()) as Record<string, unknown>;
        const n = pickDeploymentBlock(json);
        deploymentBlock = n ?? 0;
        return deploymentBlock;
      } catch {
        deploymentBlock = 0;
        return 0;
      }
    })();
  }
  return deploymentBlockProbe;
}

function pickDeploymentBlock(obj: Record<string, unknown>): number | null {
  const direct = obj['blockNumber'];
  if (typeof direct === 'number' && direct > 0) return direct;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = pickDeploymentBlock(value as Record<string, unknown>);
      if (inner) return inner;
    }
  }
  return null;
}

function pickAddress(obj: Record<string, unknown>, key: string): string | null {
  const direct = obj[key];
  if (typeof direct === 'string' && /^0x[0-9a-fA-F]{40}$/.test(direct)) return direct;
  if (direct && typeof direct === 'object') {
    const nested = (direct as Record<string, unknown>).address;
    if (typeof nested === 'string' && /^0x[0-9a-fA-F]{40}$/.test(nested)) return nested;
  }
  // deployments.json may be keyed by network first.
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = pickAddress(value as Record<string, unknown>, key);
      if (inner) return inner;
    }
  }
  return null;
}

export class RegistryNotDeployedError extends Error {
  constructor() {
    super('The registry address is not configured yet.');
    this.name = 'RegistryNotDeployedError';
  }
}

export async function registryContract(): Promise<Contract> {
  const address = await resolveRegistryAddress();
  if (!address) throw new RegistryNotDeployedError();
  return new Contract(address, [...REGISTRY_ABI], creditcoinProvider());
}

export async function registryIsConfigured(): Promise<boolean> {
  return Boolean(await resolveRegistryAddress());
}

export interface RegistryTotals {
  mirrored: number;
  revoked: number;
  address: string;
}

export async function readTotals(): Promise<RegistryTotals> {
  const c = await registryContract();
  const [mirrored, revoked] = await Promise.all([c.totalMirrored(), c.totalRevoked()]);
  return { mirrored: Number(mirrored), revoked: Number(revoked), address: await resolveRegistryAddress() };
}

export async function readAttestation(chainKey: ChainKey, uid: string): Promise<MirroredAttestation | null> {
  const c = await registryContract();
  const r = await c.attestationOf(chainKey, uid);
  const exists = Boolean(r[10]);
  if (!exists) return null;
  return {
    chainKey: Number(r[0]) as ChainKey,
    uid: String(r[1]),
    schemaUid: String(r[2]),
    attester: String(r[3]),
    recipient: String(r[4]),
    sourceBlock: Number(r[5]),
    sourceTxHash: String(r[6]),
    mirroredAt: Number(r[7]),
    revoked: Boolean(r[8]),
    revokedAt: Number(r[9]),
    exists: true,
  };
}

export async function readIsValid(chainKey: ChainKey, uid: string): Promise<boolean> {
  const c = await registryContract();
  return Boolean(await c.isValid(chainKey, uid));
}

export async function readEasAddress(chainKey: ChainKey): Promise<string> {
  const c = await registryContract();
  return String(await c.easAddress(chainKey));
}

// ---------------------------------------------------------------------------
// Enumeration.
//
// IAdmissibleRegistry (SPEC §7b) exposes no list getter — there is no
// attestationAt(i) and no count-indexed accessor. The only way to browse what
// has been mirrored is to read the AttestationMirrored event stream from the
// Creditcoin RPC and hydrate each row with attestationOf() for authoritative
// state (revoked is not carried on the mirror event).
//
// Measured live on 2026-09-10: cc3-testnet eth_getLogs answers a 10,000-block
// window and times out at 100,000, so the scan walks backwards in windows.
// ---------------------------------------------------------------------------

export const LOG_WINDOW = 9_000;
// Floor for the shrinking-window retry below. The 9,000-block figure was
// measured live on 2026-09-10 against an idle RPC; under load (many
// concurrent worker/bench/relayer submissions hitting the same public
// endpoint) the same call can time out, observed live on 2026-09-11. Rather
// than hard-fail the whole scan, retry the failing window at a smaller size.
const MIN_LOG_WINDOW = 500;

const iface = new Interface([...REGISTRY_ABI]);
export const TOPIC_MIRRORED = keccakId(
  'AttestationMirrored(uint64,bytes32,bytes32,address,address,uint64,bytes32)',
);
export const TOPIC_REVOKED_EVENT = keccakId('AttestationRevoked(uint64,bytes32,uint64,bytes32)');

export interface MirrorEventRow {
  chainKey: ChainKey;
  uid: string;
  schemaUid: string;
  attester: string;
  recipient: string;
  sourceBlock: number;
  queryId: string;
  creditcoinBlock: number;
  creditcoinTxHash: string;
  logIndex: number;
}

export interface ScanResult {
  rows: MirrorEventRow[];
  /** Lowest Creditcoin block reached so far; the next scan continues below it. */
  scannedFrom: number;
  /** Highest Creditcoin block covered. */
  scannedTo: number;
  /** True when the scan hit block 0 and there is nothing older to read. */
  exhausted: boolean;
}

export interface ScanOptions {
  chainKey?: ChainKey | null;
  /** Stop once this many rows have been collected. */
  limit?: number;
  /** Scan strictly below this Creditcoin block. Defaults to the chain tip. */
  before?: number | null;
  /** Hard ceiling on how many windows to walk in one call. */
  maxWindows?: number;
  onWindow?: (from: number, to: number, found: number) => void;
  signal?: AbortSignal;
}

export async function scanMirrorEvents(opts: ScanOptions = {}): Promise<ScanResult> {
  const address = await resolveRegistryAddress();
  if (!address) throw new RegistryNotDeployedError();
  const provider = creditcoinProvider();
  const tip = opts.before ?? (await provider.getBlockNumber());
  const limit = opts.limit ?? 60;
  const maxWindows = opts.maxWindows ?? 8;
  const floor = await resolveDeploymentBlock();

  const chainKeyTopic =
    opts.chainKey === null || opts.chainKey === undefined
      ? null
      : zeroPadValue(toBeHex(opts.chainKey), 32);

  const rows: MirrorEventRow[] = [];
  let to = tip;
  let windows = 0;
  let exhausted = false;
  let window = LOG_WINDOW;

  while (rows.length < limit && windows < maxWindows && to >= floor) {
    if (opts.signal?.aborted) break;
    let from = Math.max(floor, to - window);
    let logs;
    for (;;) {
      try {
        logs = await provider.getLogs({
          address,
          fromBlock: from,
          toBlock: to,
          topics: chainKeyTopic ? [TOPIC_MIRRORED, chainKeyTopic] : [TOPIC_MIRRORED],
        });
        break;
      } catch (err) {
        if (window <= MIN_LOG_WINDOW) throw err;
        window = Math.max(MIN_LOG_WINDOW, Math.floor(window / 3));
        from = Math.max(floor, to - window);
      }
    }
    for (const log of logs.reverse()) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      rows.push({
        chainKey: Number(parsed.args[0]) as ChainKey,
        uid: String(parsed.args[1]),
        schemaUid: String(parsed.args[2]),
        attester: String(parsed.args[3]),
        recipient: String(parsed.args[4]),
        sourceBlock: Number(parsed.args[5]),
        queryId: String(parsed.args[6]),
        creditcoinBlock: log.blockNumber,
        creditcoinTxHash: log.transactionHash,
        logIndex: log.index,
      });
    }
    opts.onWindow?.(from, to, rows.length);
    windows += 1;
    if (from <= floor) {
      exhausted = true;
      to = floor - 1;
      break;
    }
    to = from - 1;
  }

  return {
    rows: rows.slice(0, limit),
    scannedFrom: Math.max(0, to + 1),
    scannedTo: tip,
    exhausted,
  };
}

export interface HydratedRow extends MirrorEventRow {
  revoked: boolean;
  revokedAt: number;
  mirroredAt: number;
  sourceTxHash: string;
  /** Set when attestationOf() could not be read for this row. */
  hydrationError?: string;
}

export async function hydrateRows(rows: MirrorEventRow[]): Promise<HydratedRow[]> {
  const c = await registryContract();
  const out: HydratedRow[] = [];
  // Sequential in small batches: the public RPC rejects large JSON-RPC batches.
  for (let i = 0; i < rows.length; i += 6) {
    const slice = rows.slice(i, i + 6);
    const settled = await Promise.all(
      slice.map(async (row) => {
        try {
          const r = await c.attestationOf(row.chainKey, row.uid);
          return {
            ...row,
            revoked: Boolean(r[8]),
            revokedAt: Number(r[9]),
            mirroredAt: Number(r[7]),
            sourceTxHash: String(r[6]),
          } satisfies HydratedRow;
        } catch (e) {
          return {
            ...row,
            revoked: false,
            revokedAt: 0,
            mirroredAt: 0,
            sourceTxHash: '',
            hydrationError: (e as Error).message,
          } satisfies HydratedRow;
        }
      }),
    );
    out.push(...settled);
  }
  return out;
}

export interface RevocationEventRow {
  chainKey: ChainKey;
  uid: string;
  revokedAt: number;
  queryId: string;
  creditcoinBlock: number;
  creditcoinTxHash: string;
}

export async function scanRevocationEvents(opts: ScanOptions = {}): Promise<RevocationEventRow[]> {
  const address = await resolveRegistryAddress();
  if (!address) throw new RegistryNotDeployedError();
  const provider = creditcoinProvider();
  const tip = opts.before ?? (await provider.getBlockNumber());
  const maxWindows = opts.maxWindows ?? 8;
  const limit = opts.limit ?? 40;
  const floor = await resolveDeploymentBlock();
  const rows: RevocationEventRow[] = [];
  let to = tip;
  let windows = 0;
  let window = LOG_WINDOW;

  while (rows.length < limit && windows < maxWindows && to >= floor) {
    let from = Math.max(floor, to - window);
    let logs;
    for (;;) {
      try {
        logs = await provider.getLogs({
          address,
          fromBlock: from,
          toBlock: to,
          topics: [TOPIC_REVOKED_EVENT],
        });
        break;
      } catch (err) {
        if (window <= MIN_LOG_WINDOW) throw err;
        window = Math.max(MIN_LOG_WINDOW, Math.floor(window / 3));
        from = Math.max(floor, to - window);
      }
    }
    for (const log of logs.reverse()) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      rows.push({
        chainKey: Number(parsed.args[0]) as ChainKey,
        uid: String(parsed.args[1]),
        revokedAt: Number(parsed.args[2]),
        queryId: String(parsed.args[3]),
        creditcoinBlock: log.blockNumber,
        creditcoinTxHash: log.transactionHash,
      });
    }
    windows += 1;
    if (from <= floor) break;
    to = from - 1;
  }
  return rows.slice(0, limit);
}
