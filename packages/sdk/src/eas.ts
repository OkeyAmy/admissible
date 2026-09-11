import { CHAIN_KEYS, resolveEasscanUrl, sourceChain } from './config.js';
import { sourceProvider } from './providers.js';
import type { ChainKey, EasAttestation, ResolvedUid } from './types.js';

/**
 * easscan GraphQL client — unauthenticated, live, and the judge's independent
 * cross-check surface. `verify` diffs the Creditcoin registry against this.
 *
 *   mainnet: https://easscan.org/graphql
 *   sepolia: https://sepolia.easscan.org/graphql
 */

const ATTESTATION_FIELDS = 'id txid time attester recipient schemaId revoked revocationTime isOffchain';

export class EasQueryError extends Error {
  constructor(
    message: string,
    readonly chainKey: ChainKey,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = 'EasQueryError';
  }
}

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export interface EasOptions {
  easscanUrl?: string;
  sourceRpc?: string;
  timeoutMs?: number;
}

async function gql<T>(
  chainKey: ChainKey,
  query: string,
  variables: Record<string, unknown>,
  opts: EasOptions = {},
): Promise<T> {
  const endpoint = resolveEasscanUrl(chainKey, opts.easscanUrl);
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 429/5xx are worth another attempt; 4xx are not.
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        throw new EasQueryError(`easscan returned HTTP ${res.status}`, chainKey, endpoint);
      }
      const body = (await res.json()) as GqlResponse<T>;
      if (body.errors?.length) {
        throw new EasQueryError(`easscan GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`, chainKey, endpoint);
      }
      if (!body.data) throw new EasQueryError('easscan returned no data', chainKey, endpoint);
      return body.data;
    } catch (err) {
      if (err instanceof EasQueryError) throw err;
      lastErr = err;
      await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new EasQueryError(`easscan request failed after 4 attempts: ${String(lastErr)}`, chainKey, endpoint);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RawAttestation {
  id: string;
  txid: string | null;
  time: number;
  attester: string;
  recipient: string;
  schemaId: string;
  revoked: boolean;
  revocationTime: number;
  isOffchain: boolean;
}

/**
 * Some easscan rows carry no L1 transaction. On mainnet the field comes back as
 * an empty string rather than null (verified live), so both are normalised to
 * `null` — there is no transaction to prove for those UIDs.
 */
function normalise(raw: RawAttestation): EasAttestation {
  const txid = raw.txid && /^0x[0-9a-fA-F]{64}$/.test(raw.txid) ? raw.txid : null;
  return {
    uid: raw.id,
    txid,
    time: Number(raw.time ?? 0),
    attester: raw.attester,
    recipient: raw.recipient,
    schemaId: raw.schemaId,
    revoked: Boolean(raw.revoked),
    revocationTime: Number(raw.revocationTime ?? 0),
    isOffchain: Boolean(raw.isOffchain),
  };
}

/** Fetch one attestation by UID. Returns `null` if this chain has never seen it. */
export async function getAttestation(uid: string, chainKey: ChainKey, opts: EasOptions = {}): Promise<EasAttestation | null> {
  const data = await gql<{ attestation: RawAttestation | null }>(
    chainKey,
    `query($id: String!) { attestation(where: { id: $id }) { ${ATTESTATION_FIELDS} } }`,
    { id: uid },
    opts,
  );
  return data.attestation ? normalise(data.attestation) : null;
}

/**
 * `resolveUid(uid, chainKey)` → the easscan row plus source-chain coordinates.
 *
 * easscan does not expose the block number, so the attesting transaction's
 * receipt is fetched from the source-chain RPC to obtain `block` and `txIndex`.
 * When `txid` is null (offchain attestation) both are `null` and the caller
 * must report that there is nothing on L1 to prove.
 */
export async function resolveUid(uid: string, chainKey: ChainKey, opts: EasOptions = {}): Promise<ResolvedUid | null> {
  const att = await getAttestation(uid, chainKey, opts);
  if (!att) return null;

  if (!att.txid) {
    return { ...att, chainKey, block: null, txIndex: null };
  }

  const provider = sourceProvider(chainKey, opts.sourceRpc);
  try {
    const receipt = await provider.getTransactionReceipt(att.txid);
    if (!receipt) return { ...att, chainKey, block: null, txIndex: null };
    return { ...att, chainKey, block: receipt.blockNumber, txIndex: receipt.index };
  } catch {
    // The easscan record stands on its own. A source-RPC hiccup costs us the
    // block number, not the whole lookup — callers report `block: null`.
    return { ...att, chainKey, block: null, txIndex: null };
  } finally {
    provider.destroy();
  }
}

/** Find which of the two source chains knows this UID. */
export async function detectChainKey(uid: string, opts: EasOptions = {}): Promise<ChainKey | null> {
  const results = await Promise.all(
    CHAIN_KEYS.map(async (k) => {
      try {
        return { k, found: (await getAttestation(uid, k, opts)) !== null };
      } catch {
        return { k, found: false };
      }
    }),
  );
  // Mainnet wins a (vanishingly unlikely) tie — it is the credibility surface.
  const hit = results.find((r) => r.found && r.k === 3) ?? results.find((r) => r.found);
  return hit ? hit.k : null;
}

export interface ListOptions extends EasOptions {
  skip?: number;
  /** Only rows written at or below this source block time (unix seconds). */
  beforeTime?: number;
}

/** Most recent attestations, newest first. Used by the bench and the worker. */
export async function listRecent(chainKey: ChainKey, take: number, opts: ListOptions = {}): Promise<EasAttestation[]> {
  const data = await gql<{ attestations: RawAttestation[] }>(
    chainKey,
    `query($take: Int!, $skip: Int!) {
       attestations(take: $take, skip: $skip, orderBy: { time: desc }) { ${ATTESTATION_FIELDS} }
     }`,
    { take, skip: opts.skip ?? 0 },
    opts,
  );
  return data.attestations.map(normalise);
}

/** Most recently revoked attestations, newest revocation first. */
export async function listRevoked(chainKey: ChainKey, take: number, opts: ListOptions = {}): Promise<EasAttestation[]> {
  const data = await gql<{ attestations: RawAttestation[] }>(
    chainKey,
    `query($take: Int!, $skip: Int!) {
       attestations(
         take: $take, skip: $skip,
         orderBy: { revocationTime: desc },
         where: { revoked: { equals: true } }
       ) { ${ATTESTATION_FIELDS} }
     }`,
    { take, skip: opts.skip ?? 0 },
    opts,
  );
  return data.attestations.map(normalise);
}

/** Recent attestations for one schema — backs `mirrorSchema()`. */
export async function listBySchema(
  schemaUid: string,
  chainKey: ChainKey,
  take: number,
  opts: ListOptions = {},
): Promise<EasAttestation[]> {
  const data = await gql<{ attestations: RawAttestation[] }>(
    chainKey,
    `query($schema: String!, $take: Int!, $skip: Int!) {
       attestations(
         take: $take, skip: $skip,
         orderBy: { time: desc },
         where: { schemaId: { equals: $schema } }
       ) { ${ATTESTATION_FIELDS} }
     }`,
    { schema: schemaUid, take, skip: opts.skip ?? 0 },
    opts,
  );
  return data.attestations.map(normalise);
}

/** Every attestation easscan records for one attesting transaction. */
export async function listByTxid(txid: string, chainKey: ChainKey, opts: ListOptions = {}): Promise<EasAttestation[]> {
  const data = await gql<{ attestations: RawAttestation[] }>(
    chainKey,
    `query($txid: String!) {
       attestations(take: 1000, orderBy: { time: asc }, where: { txid: { equals: $txid } }) { ${ATTESTATION_FIELDS} }
     }`,
    { txid },
    opts,
  );
  return data.attestations.map(normalise);
}

/** Schemas ordered by attestation count — the bench uses this to find volume. */
export async function listSchemas(chainKey: ChainKey, take: number, opts: EasOptions = {}): Promise<
  Array<{ id: string; index: string; schema: string; attestationCount: number }>
> {
  const data = await gql<{
    schemata: Array<{ id: string; index: string; schema: string; _count: { attestations: number } }>;
  }>(
    chainKey,
    `query($take: Int!) {
       schemata(take: $take, orderBy: { attestations: { _count: desc } }) {
         id index schema _count { attestations }
       }
     }`,
    { take },
    opts,
  );
  return data.schemata.map((s) => ({
    id: s.id,
    index: s.index,
    schema: s.schema,
    attestationCount: s._count?.attestations ?? 0,
  }));
}

export interface TxGroup {
  txid: string;
  chainKey: ChainKey;
  uids: string[];
  /** Populated by `hydrateBlocks`. */
  block?: number;
  txIndex?: number;
}

/** Group easscan rows by attesting transaction. One `multiAttest` transaction is
 *  ONE query on Creditcoin carrying MANY attestations — the registry's dedupe
 *  key is per transaction, so this grouping is what makes volume cheap. */
export function groupByTx(attestations: EasAttestation[], chainKey: ChainKey): TxGroup[] {
  const map = new Map<string, TxGroup>();
  for (const a of attestations) {
    if (!a.txid || a.isOffchain) continue;
    let g = map.get(a.txid);
    if (!g) {
      g = { txid: a.txid, chainKey, uids: [] };
      map.set(a.txid, g);
    }
    g.uids.push(a.uid);
  }
  return [...map.values()];
}

/** Attach block numbers + tx indices to tx groups via the source-chain RPC. */
export async function hydrateBlocks(groups: TxGroup[], chainKey: ChainKey, opts: EasOptions = {}): Promise<TxGroup[]> {
  if (groups.length === 0) return groups;
  const provider = sourceProvider(chainKey, opts.sourceRpc);
  try {
    const CONCURRENCY = 6;
    const out: TxGroup[] = [];
    for (let i = 0; i < groups.length; i += CONCURRENCY) {
      const slice = groups.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        slice.map(async (g) => {
          try {
            const r = await provider.getTransactionReceipt(g.txid);
            if (!r) return null;
            return { ...g, block: r.blockNumber, txIndex: r.index };
          } catch {
            return null;
          }
        }),
      );
      for (const s of settled) if (s) out.push(s);
    }
    return out;
  } finally {
    provider.destroy();
  }
}

/** Current head of the source chain — used to respect the reorg window. */
export async function sourceHead(chainKey: ChainKey, opts: EasOptions = {}): Promise<number> {
  const provider = sourceProvider(chainKey, opts.sourceRpc);
  try {
    return await provider.getBlockNumber();
  } finally {
    provider.destroy();
  }
}

export function easscanLink(uid: string, chainKey: ChainKey): string {
  return `${sourceChain(chainKey).easscanWeb}/attestation/view/${uid}`;
}

/** Accepts a bare UID or a pasted easscan URL. */
export function parseUid(input: string): string | null {
  const trimmed = input.trim();
  const direct = /^0x[0-9a-fA-F]{64}$/.exec(trimmed);
  if (direct) return trimmed.toLowerCase();
  const inUrl = /0x[0-9a-fA-F]{64}/.exec(trimmed);
  return inUrl ? inUrl[0].toLowerCase() : null;
}
