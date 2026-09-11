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
 * Fix, to be applied in packages/sdk/src/mirror.ts by whoever owns that
 * package: in `submitProof()`, replace
 *
 *   const args = [action, proof.chainKey, proof.headerNumber, proof.txBytes,
 *     proof.merkleProof.root, proof.merkleProof.siblings.map(s => [s.hash, s.isLeft]),
 *     proof.continuityProof.lowerEndpointDigest, proof.continuityProof.roots];
 *   const data = iface.encodeFunctionData('execute', args);
 *   ...
 *   const tx = await registry.contract.execute(...args, { gasLimit, nonce });
 *
 * with the `submit(...)` call shape implemented below (same idea for
 * `submitSharedBatch`, though there is no batch entrypoint on this
 * deployment — see the note in `planBatches`/`getBatchProof` about shared
 * continuity proofs only verifying through the precompile's batch path).
 *
 * Everything else in the SDK (proof fetching, registry connection, gas
 * planning, receipt accounting, dedupe checks) is used as-is. This module
 * does NOT modify packages/sdk/ — bench/ and worker/ own this workaround
 * until the SDK is fixed.
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
