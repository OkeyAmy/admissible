import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Contract, Interface, JsonRpcProvider, Wallet, type InterfaceAbi, type Signer } from 'ethers';

import { resolveEndpoints, repoRoot } from './config.js';
import { creditcoinProvider } from './providers.js';

/**
 * The frozen interface — SPEC.md §7b — expressed as an ethers ABI, plus the two
 * `ASCBase` members the client needs (`execute`, `processedQueries`).
 *
 * This fragment is the fallback. When `contracts/abi/AttestationRegistry.json`
 * exists it is preferred, so the SDK tracks whatever the deployed contract
 * actually exposes (including any batch entry point the contracts add).
 */
export const REGISTRY_ABI_FRAGMENT = [
  // --- ASCBase ---
  'function execute(uint8 action, uint64 chainKey, uint64 blockHeight, bytes encodedTransaction, bytes32 merkleRoot, tuple(bytes32 hash, bool isLeft)[] siblings, bytes32 lowerEndpointDigest, bytes32[] continuityRoots) returns (bool success)',
  'function processedQueries(bytes32 queryId) view returns (bool)',
  // --- IAdmissibleRegistry ---
  'function attestationOf(uint64 chainKey, bytes32 uid) view returns (tuple(uint64 chainKey, bytes32 uid, bytes32 schemaUid, address attester, address recipient, uint64 sourceBlock, bytes32 sourceTxHash, uint64 mirroredAt, bool revoked, uint64 revokedAt, bool exists))',
  'function isValid(uint64 chainKey, bytes32 uid) view returns (bool)',
  'function isValidFrom(uint64 chainKey, bytes32 uid, address attester, bytes32 schemaUid) view returns (bool)',
  'function totalMirrored() view returns (uint256)',
  'function totalRevoked() view returns (uint256)',
  'function easAddress(uint64 chainKey) view returns (address)',
  'event AttestationMirrored(uint64 indexed chainKey, bytes32 indexed uid, bytes32 indexed schemaUid, address attester, address recipient, uint64 sourceBlock, bytes32 queryId)',
  'event AttestationRevoked(uint64 indexed chainKey, bytes32 indexed uid, uint64 revokedAt, bytes32 queryId)',
] as const;

let cachedAbi: InterfaceAbi | undefined;
let cachedAbiSource: 'contracts/abi/AttestationRegistry.json' | 'inline fragment' | undefined;

function loadGeneratedAbi(): InterfaceAbi | null {
  const root = repoRoot();
  const candidates = root
    ? [
        join(root, 'contracts/abi/AttestationRegistry.json'),
        join(root, 'contracts/out/AttestationRegistry.sol/AttestationRegistry.json'),
      ]
    : [];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      const abi = Array.isArray(parsed) ? parsed : parsed.abi;
      if (Array.isArray(abi) && abi.length > 0) return abi as InterfaceAbi;
    } catch {
      /* fall through to the next candidate */
    }
  }
  return null;
}

/** The ABI actually in use, preferring the generated file from the contracts build. */
export function registryAbi(): InterfaceAbi {
  if (cachedAbi) return cachedAbi;
  const generated = loadGeneratedAbi();
  if (generated) {
    cachedAbi = generated;
    cachedAbiSource = 'contracts/abi/AttestationRegistry.json';
  } else {
    cachedAbi = REGISTRY_ABI_FRAGMENT as unknown as InterfaceAbi;
    cachedAbiSource = 'inline fragment';
  }
  return cachedAbi;
}

export function registryAbiSource(): string {
  registryAbi();
  return cachedAbiSource!;
}

/** Forget the cached ABI — used after the contracts build rewrites the file. */
export function reloadRegistryAbi(): void {
  cachedAbi = undefined;
  cachedAbiSource = undefined;
}

export class RegistryNotDeployedError extends Error {
  constructor() {
    super(
      'No registry address. Pass --registry 0x…, set REGISTRY_ADDRESS, or run from a repo containing contracts/deployments.json.',
    );
    this.name = 'RegistryNotDeployedError';
  }
}

export interface RegistryHandle {
  contract: Contract;
  address: string;
  provider: JsonRpcProvider;
  signer: Signer | null;
  /** Where the address came from — printed by the CLI so nothing is magic. */
  addressSource: string;
  /** True when the ABI exposes a batch submission entry point. */
  hasBatchExecute: boolean;
  batchExecuteName: string | null;
}

const BATCH_EXECUTE_CANDIDATES = ['executeBatch', 'executeMany', 'batchExecute'];

export function getRegistry(opts: { registryAddress?: string; creditcoinRpc?: string; signer?: Signer; privateKey?: string } = {}): RegistryHandle {
  const endpoints = resolveEndpoints({ registryAddress: opts.registryAddress, creditcoinRpc: opts.creditcoinRpc });
  if (!endpoints.registryAddress) throw new RegistryNotDeployedError();

  const provider = creditcoinProvider(endpoints.creditcoinRpc);

  let signer: Signer | null = null;
  if (opts.signer) {
    signer = opts.signer.provider ? opts.signer : opts.signer.connect(provider);
  } else {
    const pk = opts.privateKey ?? process.env.PRIVATE_KEY;
    if (pk && pk.trim().length > 0) signer = new Wallet(pk.trim(), provider);
  }

  const abi = registryAbi();
  const contract = new Contract(endpoints.registryAddress, abi, signer ?? provider);

  const iface = new Interface(abi);
  let batchExecuteName: string | null = null;
  for (const name of BATCH_EXECUTE_CANDIDATES) {
    try {
      if (iface.getFunction(name)) {
        batchExecuteName = name;
        break;
      }
    } catch {
      /* not present */
    }
  }

  return {
    contract,
    address: endpoints.registryAddress,
    provider,
    signer,
    addressSource: endpoints.registrySource,
    hasBatchExecute: batchExecuteName !== null,
    batchExecuteName,
  };
}

/** Where the file lives, for diagnostics. */
export function deploymentsPath(): string | null {
  const root = repoRoot();
  if (!root) return null;
  const p = join(root, 'contracts/deployments.json');
  return existsSync(p) ? p : null;
}

export function abiPath(): string | null {
  const root = repoRoot();
  if (!root) return null;
  const p = join(root, 'contracts/abi/AttestationRegistry.json');
  return existsSync(p) ? p : dirname(p) && null;
}
