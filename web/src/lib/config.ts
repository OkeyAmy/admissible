// Every value here was verified live against the network on 2026-09-10 and is
// frozen by SPEC.md §3. Do not re-derive.
import type { ChainKey } from './types';

const env = import.meta.env as Record<string, string | undefined>;

export const CREDITCOIN_RPC = env.VITE_CREDITCOIN_RPC ?? 'https://rpc.cc3-testnet.creditcoin.network';
export const CREDITCOIN_CHAIN_ID = 102031;
export const CREDITCOIN_EXPLORER = 'https://creditcoin-testnet.blockscout.com';
export const ASC_DASHBOARD = 'https://dashboard.cc3-testnet.creditcoin.network/';

export const PROVER_URL = env.VITE_PROVER_URL ?? 'https://proof-gen-api.cc3-testnet.creditcoin.network';

export const CHAIN_INFO_PRECOMPILE = '0x0000000000000000000000000000000000000fd3';
export const BLOCK_PROVER_PRECOMPILE = '0x0000000000000000000000000000000000000FD2';

/** Filled in by the contracts workspace after deploy. Empty until then. */
export const REGISTRY_ADDRESS = (env.VITE_REGISTRY_ADDRESS ?? '').trim();

/**
 * Testnet-only burner key. Deliberately a *separate* variable from the
 * deployer key in the repo .env: anything prefixed VITE_ is compiled into the
 * client bundle and is readable by anyone who opens devtools. If this is unset
 * the app still runs every read path live and stops honestly at submission.
 */
export const DEMO_PRIVATE_KEY = (env.VITE_DEMO_PRIVATE_KEY ?? '').trim();

export interface SourceChain {
  chainKey: ChainKey;
  label: string;
  shortLabel: string;
  easAddress: string;
  rpc: string;
  easscanGraphql: string;
  easscanBase: string;
  etherscan: string;
  /** Documented behaviour of the source chain, surfaced in the UI while waiting. */
  note: string;
}

export const SOURCE_CHAINS: Record<ChainKey, SourceChain> = {
  3: {
    chainKey: 3,
    label: 'Ethereum Mainnet',
    shortLabel: 'mainnet',
    easAddress: '0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587',
    rpc: env.VITE_MAINNET_RPC ?? 'https://ethereum-rpc.publicnode.com',
    easscanGraphql: 'https://easscan.org/graphql',
    easscanBase: 'https://easscan.org',
    etherscan: 'https://etherscan.io',
    note: 'Attestation lag measured at 42 blocks (~8 min).',
  },
  1: {
    chainKey: 1,
    label: 'Ethereum Sepolia',
    shortLabel: 'sepolia',
    easAddress: '0xC2679fBD37d54388Ce493F1DB75320D236e1815e',
    rpc: env.VITE_SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    easscanGraphql: 'https://sepolia.easscan.org/graphql',
    easscanBase: 'https://sepolia.easscan.org',
    etherscan: 'https://sepolia.etherscan.io',
    note: '32-block reorg-protection window before a block can be proven.',
  },
};

/** Mainnet is the default: proving attestations written by strangers is the point. */
export const DEFAULT_CHAIN_KEY: ChainKey = 3;

export const CHAIN_KEYS: ChainKey[] = [3, 1];

// EAS topics, computed with `cast` and confirmed against topic0 observed inside
// real proven txBytes. SPEC.md §3.
export const TOPIC_ATTESTED = '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35';
export const TOPIC_REVOKED = '0xf930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615';
export const TOPIC_REVOKED_OFFCHAIN = '0x92a1f7a41a7c585a8b09e25b195e225b1d43248daca46b0faf9e0792777a2229';

export const EAS_SELECTORS: Record<string, string> = {
  '0xf17325e7': 'attest(...)',
  '0x44adc90e': 'multiAttest(...)',
  '0x46926267': 'revoke(...)',
  '0x4cb7e9e5': 'multiRevoke(...)',
};

/**
 * Real, already-attested Ethereum mainnet EAS attestations, resolved live on
 * 2026-09-10. Their source blocks sit far below the current Attestcoin attested
 * height, so the proof path runs immediately instead of waiting ~8 minutes for
 * a freshly written UID. Written by strangers — we do not control these keys.
 */
export const EXAMPLE_UIDS: { uid: string; chainKey: ChainKey; note: string }[] = [
  {
    uid: '0x0030b0d28d55b2ac1fe177c742f14ecaf87d91e62cedd892c0ba2a7eda922a73',
    chainKey: 3,
    note: 'block 25,946,469 · tx index 442',
  },
  {
    uid: '0xc8a781f858c20cbb234487cf683bc30eb4e3dfc3a049ab2fc0c037757a1d72de',
    chainKey: 3,
    note: 'block 25,935,879 · multiAttest, 20 logs',
  },
  {
    uid: '0x55fc889aeea0a8bd63333d2dadec8bd2396b73cfc0c89506c168afbcaab9b0bd',
    chainKey: 3,
    note: 'block 25,946,409 · tx index 4',
  },
];

/** Measured pre-build baseline, committed in prebuild-evidence/. SPEC.md §3. */
export const BASELINE = {
  sample: 11,
  medianMs: 3560,
  p95Ms: 7300,
  continuityRootsMin: 12,
  continuityRootsMax: 94,
  costFormula: '2.3e-5 + 2.9e-7 × roots',
  costMin: '3.2e-5',
  costMax: '5.0e-5',
};
