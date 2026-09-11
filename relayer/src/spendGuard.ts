/**
 * Caps total CTC spend for the lifetime of this process. In-memory only — it
 * resets on restart, which is intentional for a demo relayer (SPEC §6 notes
 * the testnet key holds ~10,000 CTC and cost per verification is ~3-5e-5 CTC,
 * so this ceiling exists to bound a single process's blast radius, not because
 * the key is short on funds).
 */

const CEILING_CTC = Number(process.env.RELAYER_SPEND_CEILING_CTC ?? 2);

let spentWei = 0n;

export function ceilingWei(): bigint {
  return BigInt(Math.round(CEILING_CTC * 1e18));
}

export function spentSoFarWei(): bigint {
  return spentWei;
}

/** True when reserving `maxCostWei` (gasLimit × current gas price, worst case) would breach the ceiling. */
export function wouldExceedCeiling(maxCostWei: bigint): boolean {
  return spentWei + maxCostWei > ceilingWei();
}

/** Record actual spend after a submission settles (success or partial — gas is burned either way on a revert). */
export function recordSpend(actualCostWei: bigint): void {
  spentWei += actualCostWei;
}

export const SPEND_CEILING_CTC = CEILING_CTC;
