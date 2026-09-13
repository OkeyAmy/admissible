import { Contract, type Signer, ZeroHash } from 'ethers';
import { POOL_ABI, POOL_WRITE_ABI } from './abi';
import { creditcoinProvider } from './chain';
import { pickAddress } from './registry';
import type { ChainKey } from './types';

/**
 * CredentialGatedPool address, resolved the same way the registry is:
 * `/deployments.json` at runtime (copied out of contracts/ by
 * scripts/sync-assets.mjs), never hardcoded in this file.
 */
let runtimePoolAddress: string | null = null;
let poolAddressProbe: Promise<string> | null = null;

export async function resolvePoolAddress(): Promise<string> {
  if (runtimePoolAddress !== null) return runtimePoolAddress;
  if (!poolAddressProbe) {
    poolAddressProbe = (async () => {
      try {
        const res = await fetch('/deployments.json', { cache: 'no-store' });
        if (!res.ok) return '';
        const json = (await res.json()) as Record<string, unknown>;
        const candidate = pickAddress(json, 'pool') ?? pickAddress(json, 'CredentialGatedPool') ?? '';
        runtimePoolAddress = candidate;
        return candidate;
      } catch {
        runtimePoolAddress = '';
        return '';
      }
    })();
  }
  return poolAddressProbe;
}

export class PoolNotDeployedError extends Error {
  constructor() {
    super('CredentialGatedPool address not found in /deployments.json.');
    this.name = 'PoolNotDeployedError';
  }
}

async function poolContract(): Promise<Contract> {
  const address = await resolvePoolAddress();
  if (!address) throw new PoolNotDeployedError();
  return new Contract(address, POOL_ABI, creditcoinProvider());
}

/**
 * A second, wildcard CredentialGatedPool (requiredAttester/requiredSchema
 * both zero, chainKey = 1 / Sepolia) deployed 2026-09-13 specifically so a
 * visitor with their own wallet can complete presentCredential → borrow →
 * repay for real, with a credential they self-issue on Sepolia. The main
 * `pool` stays pinned to a real mainnet issuer for the credibility story;
 * this one exists purely so the contract's full lifecycle is demonstrable
 * by anyone, not just the one real mainnet holder nobody here controls the
 * key for.
 */
let runtimeSandboxPoolAddress: string | null = null;
let sandboxPoolAddressProbe: Promise<string> | null = null;

export async function resolveSandboxPoolAddress(): Promise<string> {
  if (runtimeSandboxPoolAddress !== null) return runtimeSandboxPoolAddress;
  if (!sandboxPoolAddressProbe) {
    sandboxPoolAddressProbe = (async () => {
      try {
        const res = await fetch('/deployments.json', { cache: 'no-store' });
        if (!res.ok) return '';
        const json = (await res.json()) as Record<string, unknown>;
        const candidate = pickAddress(json, 'poolSandbox') ?? '';
        runtimeSandboxPoolAddress = candidate;
        return candidate;
      } catch {
        runtimeSandboxPoolAddress = '';
        return '';
      }
    })();
  }
  return sandboxPoolAddressProbe;
}

export async function sandboxPoolContract(signerOrProvider?: Signer): Promise<Contract> {
  const address = await resolveSandboxPoolAddress();
  if (!address) throw new PoolNotDeployedError();
  return new Contract(address, POOL_WRITE_ABI, signerOrProvider ?? creditcoinProvider());
}

export async function readSandboxPoolConfig(): Promise<PoolConfig> {
  const c = await sandboxPoolContract();
  const [chainKey, requiredAttester, requiredSchema, borrowCap, totalDeposits, totalDebt, availableLiquidity] =
    await Promise.all([
      c.chainKey(), c.requiredAttester(), c.requiredSchema(), c.borrowCap(),
      c.totalDeposits(), c.totalDebt(), c.availableLiquidity(),
    ]);
  return {
    address: await resolveSandboxPoolAddress(),
    chainKey: Number(chainKey) as ChainKey,
    requiredAttester, requiredSchema, borrowCap, totalDeposits, totalDebt, availableLiquidity,
  };
}

export async function checkSandboxEligibility(address: string, uid: string): Promise<EligibilityResult> {
  const c = await sandboxPoolContract();
  const [presentedUid, deposits, debt] = await Promise.all([
    c.credentialOf(address), c.deposits(address), c.debt(address),
  ]);
  const [status, reason, headroom] = await c.eligibilityOf(address, uid);
  return {
    status: Number(status), label: ELIGIBILITY_LABELS[Number(status)] ?? 'unknown',
    reason, headroom, checkedUid: uid, presentedUid, deposits, debt,
  };
}

export const ELIGIBILITY_LABELS = [
  'Eligible',
  'Not mirrored',
  'Revoked',
  'Wrong attester',
  'Wrong schema',
  'Not the recipient',
  'At borrow cap',
] as const;

export interface PoolConfig {
  address: string;
  chainKey: ChainKey;
  requiredAttester: string;
  requiredSchema: string;
  borrowCap: bigint;
  totalDeposits: bigint;
  totalDebt: bigint;
  availableLiquidity: bigint;
}

export async function readPoolConfig(): Promise<PoolConfig> {
  const c = await poolContract();
  const [chainKey, requiredAttester, requiredSchema, borrowCap, totalDeposits, totalDebt, availableLiquidity] =
    await Promise.all([
      c.chainKey(),
      c.requiredAttester(),
      c.requiredSchema(),
      c.borrowCap(),
      c.totalDeposits(),
      c.totalDebt(),
      c.availableLiquidity(),
    ]);
  return {
    address: await resolvePoolAddress(),
    chainKey: Number(chainKey) as ChainKey,
    requiredAttester,
    requiredSchema,
    borrowCap,
    totalDeposits,
    totalDebt,
    availableLiquidity,
  };
}

export interface EligibilityResult {
  status: number;
  label: string;
  reason: string;
  headroom: bigint;
  /** Set only when a specific UID was checked via eligibilityOf. */
  checkedUid?: string;
  /** The UID this address has on file with the pool (credentialOf), if any. */
  presentedUid: string;
  deposits: bigint;
  debt: bigint;
}

/**
 * Checks an address's real, current eligibility — nothing here is hardcoded.
 * If `uid` is given, calls `eligibilityOf(address, uid)` directly (the same
 * check `borrow(uid, amount)` performs). Otherwise falls back to whatever
 * credential that address has already presented via `presentCredential`.
 */
export async function checkEligibility(address: string, uid?: string): Promise<EligibilityResult> {
  const c = await poolContract();
  const [presentedUid, deposits, debt] = await Promise.all([
    c.credentialOf(address),
    c.deposits(address),
    c.debt(address),
  ]);

  if (uid && uid !== ZeroHash) {
    const [status, reason, headroom] = await c.eligibilityOf(address, uid);
    return {
      status: Number(status),
      label: ELIGIBILITY_LABELS[Number(status)] ?? 'unknown',
      reason,
      headroom,
      checkedUid: uid,
      presentedUid,
      deposits,
      debt,
    };
  }

  const [reason, [status, headroom]] = await Promise.all([c.eligibilityReason(address), c.eligibilityStatus(address)]);
  return {
    status: Number(status),
    label: ELIGIBILITY_LABELS[Number(status)] ?? 'unknown',
    reason,
    headroom,
    presentedUid,
    deposits,
    debt,
  };
}
