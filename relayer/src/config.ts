export const PORT = Number(process.env.RELAYER_PORT ?? 8787);

/**
 * Hard ceiling on the gas limit forwarded to `submit(...)`, regardless of what
 * `planGas` estimates or what the client asked for. `planGas`'s own fallback
 * is `400_000 + continuityRoots * 6_000` (packages/sdk/src/submit.ts); the
 * worst continuityRoots count seen in receipts/mirrors.jsonl so far is 776
 * (~5.06M gas), so the default ceiling sits comfortably above that without
 * being unbounded.
 */
export const GAS_CEILING = BigInt(process.env.RELAYER_GAS_CEILING ?? 8_000_000);

/** Max JSON body size accepted on POST /mirror, to bound memory per request. */
export const MAX_BODY_BYTES = Number(process.env.RELAYER_MAX_BODY_BYTES ?? 512 * 1024);

/**
 * CORS: permissive on purpose. This relayer's write surface (POST /mirror) is
 * not gated by request origin — it is gated by server-side re-verification of
 * the proof against the prover service, a fixed action allowlist, a gas
 * ceiling, a per-process spend ceiling, and per-IP rate limiting (see
 * rateLimit.ts / spendGuard.ts / index.ts). Origin checking would add no real
 * boundary here — anyone can already curl this endpoint directly — so CORS is
 * left open the way a public read-mostly testnet service reasonably would be,
 * rather than pretending an origin allowlist is a security control it is not.
 */
export function applyCors(res: { setHeader: (name: string, value: string) => void }): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
