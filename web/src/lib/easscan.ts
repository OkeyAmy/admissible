import { SOURCE_CHAINS } from './config';
import type { ChainKey, EasAttestation } from './types';

async function gql<T>(chainKey: ChainKey, query: string, variables?: Record<string, unknown>): Promise<T> {
  const url = SOURCE_CHAINS[chainKey].easscanGraphql;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`easscan ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`easscan: ${json.errors[0].message}`);
  if (!json.data) throw new Error('easscan returned no data');
  return json.data;
}

const ATTESTATION_FIELDS = 'id txid time attester recipient schemaId revoked revocationTime isOffchain';

export async function fetchAttestation(chainKey: ChainKey, uid: string): Promise<EasAttestation | null> {
  const data = await gql<{ attestation: EasAttestation | null }>(
    chainKey,
    `query One($id: String!) { attestation(where: { id: $id }) { ${ATTESTATION_FIELDS} } }`,
    { id: uid },
  );
  return data.attestation ?? null;
}

export async function fetchRecentOnchain(chainKey: ChainKey, take = 20): Promise<EasAttestation[]> {
  const data = await gql<{ attestations: EasAttestation[] }>(
    chainKey,
    `query Recent($take: Int!) {
       attestations(take: $take, orderBy: { time: desc }, where: { txid: { not: { equals: "" } } }) {
         ${ATTESTATION_FIELDS}
       }
     }`,
    { take },
  );
  return data.attestations ?? [];
}

export async function fetchBySchema(chainKey: ChainKey, schemaId: string, take = 50): Promise<EasAttestation[]> {
  const data = await gql<{ attestations: EasAttestation[] }>(
    chainKey,
    `query BySchema($schemaId: String!, $take: Int!) {
       attestations(
         take: $take,
         orderBy: { time: desc },
         where: { schemaId: { equals: $schemaId }, txid: { not: { equals: "" } } }
       ) { ${ATTESTATION_FIELDS} }
     }`,
    { schemaId, take },
  );
  return data.attestations ?? [];
}

export interface EasSchemaSummary {
  id: string;
  schema: string;
  creator: string;
  index: string;
  attestationCount?: number;
}

export async function fetchActiveSchemas(chainKey: ChainKey, take = 12): Promise<EasSchemaSummary[]> {
  const data = await gql<{ schemata: (EasSchemaSummary & { _count?: { attestations: number } })[] }>(
    chainKey,
    `query Schemas($take: Int!) {
       schemata(take: $take, orderBy: { attestations: { _count: desc } }) {
         id schema creator index
         _count { attestations }
       }
     }`,
    { take },
  );
  return (data.schemata ?? []).map((s) => ({
    id: s.id,
    schema: s.schema,
    creator: s.creator,
    index: s.index,
    attestationCount: s._count?.attestations,
  }));
}

export function easscanAttestationUrl(chainKey: ChainKey, uid: string): string {
  return `${SOURCE_CHAINS[chainKey].easscanBase}/attestation/view/${uid}`;
}

export function easscanSchemaUrl(chainKey: ChainKey, schemaUid: string): string {
  return `${SOURCE_CHAINS[chainKey].easscanBase}/schema/view/${schemaUid}`;
}

export function etherscanTxUrl(chainKey: ChainKey, txHash: string): string {
  return `${SOURCE_CHAINS[chainKey].etherscan}/tx/${txHash}`;
}
