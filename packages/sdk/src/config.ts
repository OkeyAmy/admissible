import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

import type { ChainKey } from './types.js';

/**
 * Every endpoint below is a verified fact from SPEC.md §3, baked in as a
 * DEFAULT — not read from the environment. `npx vouchsafe verify <uid>` has to
 * work for a judge with no API key, no `.env` and no local state, so the
 * defaults are the source of truth and the environment is only an override.
 *
 * Overrides are read from `process.env` and are ignored when empty.
 */

export const CREDITCOIN_RPC = 'https://rpc.cc3-testnet.creditcoin.network';
export const CREDITCOIN_CHAIN_ID = 102031;
export const CREDITCOIN_EXPLORER = 'https://creditcoin-testnet.blockscout.com';
export const PROVER_URL = 'https://proof-gen-api.cc3-testnet.creditcoin.network';
export const CHAIN_INFO_PRECOMPILE = '0x0000000000000000000000000000000000000fd3';
export const BLOCK_PROVER_PRECOMPILE = '0x0000000000000000000000000000000000000FD2';

/** Hard limits of the prover's batch endpoint. Verified live: exceeding the
 *  span returns `{"code":"BatchSpanTooLarge", "retriable":false}`. */
export const MAX_BATCH_PROOFS = 10;
export const MAX_BATCH_BLOCK_SPAN = 1000;

export interface SourceChain {
  chainKey: ChainKey;
  name: string;
  shortName: string;
  eas: string;
  rpc: string;
  easscan: string;
  easscanWeb: string;
  explorer: string;
  /** Reorg-protection window the prover enforces before a block is provable. */
  reorgWindow: number;
}

export const SOURCE_CHAINS: Record<ChainKey, SourceChain> = {
  1: {
    chainKey: 1,
    name: 'Ethereum Sepolia',
    shortName: 'sepolia',
    eas: '0xC2679fBD37d54388Ce493F1DB75320D236e1815e',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    easscan: 'https://sepolia.easscan.org/graphql',
    easscanWeb: 'https://sepolia.easscan.org',
    explorer: 'https://sepolia.etherscan.io',
    reorgWindow: 32,
  },
  3: {
    chainKey: 3,
    name: 'Ethereum Mainnet',
    shortName: 'mainnet',
    eas: '0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587',
    rpc: 'https://ethereum-rpc.publicnode.com',
    easscan: 'https://easscan.org/graphql',
    easscanWeb: 'https://easscan.org',
    explorer: 'https://etherscan.io',
    reorgWindow: 32,
  },
};

export const CHAIN_KEYS: ChainKey[] = [1, 3];

export function isChainKey(v: unknown): v is ChainKey {
  return v === 1 || v === 3;
}

export function sourceChain(chainKey: ChainKey): SourceChain {
  const c = SOURCE_CHAINS[chainKey];
  if (!c) throw new Error(`Unsupported chainKey ${chainKey}. Supported: 1 (Sepolia), 3 (Ethereum Mainnet).`);
  return c;
}

/**
 * EAS topic0 values, computed with `cast` and cross-checked against topic0
 * observed inside real proven `txBytes` (SPEC.md §3).
 */
export const EAS_TOPICS = {
  Attested: '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35',
  Revoked: '0xf930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615',
  RevokedOffchain: '0x92a1f7a41a7c585a8b09e25b195e225b1d43248daca46b0faf9e0792777a2229',
} as const;

export const EAS_SELECTORS = {
  attest: '0xf17325e7',
  multiAttest: '0x44adc90e',
  revoke: '0x46926267',
  multiRevoke: '0x4cb7e9e5',
} as const;

/**
 * Fallback registry address, baked in so `npx vouchsafe verify` needs no state.
 * Resolution order: explicit option → REGISTRY_ADDRESS env → repo
 * `contracts/deployments.json` → this constant.
 */
export const DEFAULT_REGISTRY_ADDRESS = '0xA972422a821F622bcC1a72d0B19242F1ae2C6047';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/** Walk up from this module looking for a repo marker directory/file. */
function findUp(relative: string): string | null {
  let dir = __dirnameCompat();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function __dirnameCompat(): string {
  // Works under both the CJS and the ESM build output.
  if (typeof __dirname !== 'undefined') return __dirname;
  return resolvePath(process.cwd());
}

let deploymentsCache: Record<string, unknown> | null | undefined;

export interface Deployments {
  chainId?: number;
  registry?: string;
  AttestationRegistry?: string;
  address?: string;
  [k: string]: unknown;
}

/** Reads `contracts/deployments.json` from the repo, if this SDK lives in it. */
export function readDeployments(): Deployments | null {
  if (deploymentsCache !== undefined) return deploymentsCache as Deployments | null;
  const p = findUp('contracts/deployments.json');
  if (!p) {
    deploymentsCache = null;
    return null;
  }
  try {
    deploymentsCache = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    deploymentsCache = null;
  }
  return deploymentsCache as Deployments | null;
}

function pickRegistryFromDeployments(d: Deployments | null): string | undefined {
  if (!d) return undefined;
  const direct = d.registry ?? d.AttestationRegistry ?? d.address;
  if (typeof direct === 'string' && direct.startsWith('0x')) return direct;
  // Tolerate a nested shape such as { "102031": { "AttestationRegistry": "0x.." } }.
  for (const value of Object.values(d)) {
    if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>;
      for (const key of ['registry', 'AttestationRegistry', 'address', 'attestationRegistry']) {
        const v = nested[key];
        if (typeof v === 'string' && v.startsWith('0x')) return v;
      }
    }
  }
  return undefined;
}

export interface Endpoints {
  creditcoinRpc: string;
  proverUrl: string;
  registryAddress: string;
  registrySource: 'option' | 'env' | 'deployments.json' | 'baked-in' | 'unset';
}

export function resolveEndpoints(opts: {
  creditcoinRpc?: string;
  proverUrl?: string;
  registryAddress?: string;
} = {}): Endpoints {
  let registryAddress = '';
  let registrySource: Endpoints['registrySource'] = 'unset';

  if (opts.registryAddress) {
    registryAddress = opts.registryAddress;
    registrySource = 'option';
  } else if (env('REGISTRY_ADDRESS')) {
    registryAddress = env('REGISTRY_ADDRESS')!;
    registrySource = 'env';
  } else {
    const fromFile = pickRegistryFromDeployments(readDeployments());
    if (fromFile) {
      registryAddress = fromFile;
      registrySource = 'deployments.json';
    } else if (DEFAULT_REGISTRY_ADDRESS) {
      registryAddress = DEFAULT_REGISTRY_ADDRESS;
      registrySource = 'baked-in';
    }
  }

  return {
    creditcoinRpc: opts.creditcoinRpc ?? env('CREDITCOIN_RPC') ?? CREDITCOIN_RPC,
    proverUrl: opts.proverUrl ?? env('PROVER_URL') ?? PROVER_URL,
    registryAddress,
    registrySource,
  };
}

export function resolveSourceRpc(chainKey: ChainKey, override?: string): string {
  if (override) return override;
  const key = chainKey === 1 ? 'SEPOLIA_RPC' : 'MAINNET_RPC';
  return env(key) ?? sourceChain(chainKey).rpc;
}

export function resolveEasscanUrl(chainKey: ChainKey, override?: string): string {
  if (override) return override;
  const key = chainKey === 1 ? 'EASSCAN_SEPOLIA' : 'EASSCAN_MAINNET';
  return env(key) ?? sourceChain(chainKey).easscan;
}

/** Repo root, when the SDK is running from inside the monorepo. */
export function repoRoot(): string | null {
  const marker = findUp('SPEC.md');
  return marker ? dirname(marker) : null;
}
