/**
 * The deployed `AttestationRegistry` does NOT expose a usable `execute(...)`
 * entrypoint. It wraps `ASCBase.execute` behind `submit(...)`, which stashes
 * `(chainKey, blockHeight, sourceTxHash)` in transient storage before doing a
 * self-call into `execute`; `_processAndEmitEvent` then requires that context
 * to be set (`AttestationRegistry.sol:211`, `"Admissible: call submit(), not
 * execute()"`). A direct `execute()` call reverts before any state is
 * written — see `AttestationRegistry.sol:145-148`.
 *
 * `@admissible/sdk`'s `submitProof()` (packages/sdk/src/mirror.ts:286-312)
 * calls `registry.contract.execute(...)` directly, so it and everything built
 * on it (`mirror`, `mirrorTransaction`, `mirrorBatch`, `mirrorSchema`,
 * `mirrorRevocation`) reverts against THIS deployment. That is a bug in the
 * SDK, not in the contract or in `deployments.json` (which correctly records
 * `submit(...)` as the entrypoint, selector `0xb560a741`).
 *
 * See bench/src/submit-fix.ts for the fix write-up aimed at the SDK owner.
 * This file is a byte-identical copy so both consumers apply the same
 * workaround until packages/sdk/ is fixed upstream — this package does not
 * modify packages/sdk/.
 */

import { Interface } from 'ethers';
import {
  type RegistryHandle,
  type RegistryAction,
  registryAbi,
  planGas,
  waitForReceipt,
  accountForReceipt,
  type SubmissionAccounting,
} from '@admissible/sdk';
import type { ContinuityResponse } from '@admissible/sdk';

/** One `submit()` call carrying one proved source transaction. */
export async function submitViaRegistry(
  registry: RegistryHandle,
  action: RegistryAction,
  proof: ContinuityResponse,
  gasLimitOverride?: bigint,
  nonce?: number,
): Promise<SubmissionAccounting> {
  const iface = new Interface(registryAbi());
  const merkleProofTuple = [proof.merkleProof.root, proof.merkleProof.siblings.map((s) => [s.hash, s.isLeft])];
  const continuityProofTuple = [proof.continuityProof.lowerEndpointDigest, proof.continuityProof.roots];
  const args = [action, proof.chainKey, proof.headerNumber, proof.txHash, proof.txBytes, merkleProofTuple, continuityProofTuple];

  const data = iface.encodeFunctionData('submit', args);
  const from = await registry.signer!.getAddress();
  const gas = await planGas(registry, data, from, proof.continuityProof.roots.length, gasLimitOverride);

  const tx = await registry.contract.submit(
    ...args,
    nonce === undefined ? { gasLimit: gas.gasLimit } : { gasLimit: gas.gasLimit, nonce },
  );
  const receipt = await waitForReceipt(tx);
  return accountForReceipt(receipt, iface);
}
