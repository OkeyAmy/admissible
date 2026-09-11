/** Body validation for POST /mirror. Rejects anything that does not shape up
 *  before any network call is made — the prover fetch and the eth_call both
 *  cost time an attacker can spend for free otherwise. */

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x[0-9a-fA-F]*$/;

export interface MirrorRequestBody {
  action: 0 | 1;
  chainKey: 1 | 3;
  blockHeight: number;
  sourceTxHash: string;
  encodedTransaction: string;
  merkleProof: {
    root: string;
    siblings: { hash: string; isLeft: boolean }[];
  };
  continuityProof: {
    lowerEndpointDigest: string;
    roots: string[];
  };
}

export class ValidationError extends Error {}

function fail(msg: string): never {
  throw new ValidationError(msg);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Known action discriminators only — SPEC.md §7b: 0 = Mirror, 1 = Revoke. */
const KNOWN_ACTIONS = new Set([0, 1]);
const KNOWN_CHAIN_KEYS = new Set([1, 3]);

export function parseMirrorRequest(raw: unknown): MirrorRequestBody {
  if (!isPlainObject(raw)) fail('body must be a JSON object');

  const action = Number(raw.action);
  if (!Number.isInteger(action) || !KNOWN_ACTIONS.has(action)) {
    fail(`action must be 0 (Mirror) or 1 (Revoke); got ${JSON.stringify(raw.action)}`);
  }

  const chainKey = Number(raw.chainKey);
  if (!Number.isInteger(chainKey) || !KNOWN_CHAIN_KEYS.has(chainKey)) {
    fail(`chainKey must be 1 (Sepolia) or 3 (Ethereum Mainnet); got ${JSON.stringify(raw.chainKey)}`);
  }

  const blockHeight = Number(raw.blockHeight);
  if (!Number.isInteger(blockHeight) || blockHeight < 0) {
    fail(`blockHeight must be a non-negative integer; got ${JSON.stringify(raw.blockHeight)}`);
  }

  const sourceTxHash = String(raw.sourceTxHash ?? '');
  if (!HEX32.test(sourceTxHash)) fail('sourceTxHash must be a 32-byte 0x-hex string');

  const encodedTransaction = String(raw.encodedTransaction ?? '');
  if (!HEX_BYTES.test(encodedTransaction) || encodedTransaction.length < 4 || encodedTransaction.length % 2 !== 0) {
    fail('encodedTransaction must be an even-length 0x-hex byte string');
  }

  const merkleProofRaw = raw.merkleProof;
  if (!isPlainObject(merkleProofRaw)) fail('merkleProof must be an object');
  const root = String(merkleProofRaw.root ?? '');
  if (!HEX32.test(root)) fail('merkleProof.root must be a 32-byte 0x-hex string');
  const siblingsRaw = merkleProofRaw.siblings;
  if (!Array.isArray(siblingsRaw)) fail('merkleProof.siblings must be an array');
  const siblings = siblingsRaw.map((s, i) => {
    if (!isPlainObject(s)) fail(`merkleProof.siblings[${i}] must be an object`);
    const hash = String(s.hash ?? '');
    if (!HEX32.test(hash)) fail(`merkleProof.siblings[${i}].hash must be a 32-byte 0x-hex string`);
    if (typeof s.isLeft !== 'boolean') fail(`merkleProof.siblings[${i}].isLeft must be a boolean`);
    return { hash, isLeft: s.isLeft };
  });

  const continuityProofRaw = raw.continuityProof;
  if (!isPlainObject(continuityProofRaw)) fail('continuityProof must be an object');
  const lowerEndpointDigest = String(continuityProofRaw.lowerEndpointDigest ?? '');
  if (!HEX32.test(lowerEndpointDigest)) fail('continuityProof.lowerEndpointDigest must be a 32-byte 0x-hex string');
  const rootsRaw = continuityProofRaw.roots;
  if (!Array.isArray(rootsRaw)) fail('continuityProof.roots must be an array');
  const roots = rootsRaw.map((r, i) => {
    const v = String(r);
    if (!HEX32.test(v)) fail(`continuityProof.roots[${i}] must be a 32-byte 0x-hex string`);
    return v;
  });

  return {
    action: action as 0 | 1,
    chainKey: chainKey as 1 | 3,
    blockHeight,
    sourceTxHash,
    encodedTransaction,
    merkleProof: { root, siblings },
    continuityProof: { lowerEndpointDigest, roots },
  };
}
