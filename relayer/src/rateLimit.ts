/**
 * Token-bucket rate limiter, per remote IP, in-memory.
 *
 * This is a public-facing port holding a funded key, so every POST /mirror
 * pays a token before any prover/RPC work starts. Capacity and refill are
 * both env-configurable; defaults are deliberately a few requests per minute
 * — this is a demo relayer, not a production indexer.
 */

const CAPACITY = Number(process.env.RELAYER_RATE_LIMIT_BURST ?? 5);
const REFILL_PER_MIN = Number(process.env.RELAYER_RATE_LIMIT_PER_MIN ?? 5);
const REFILL_INTERVAL_MS = 60_000 / Math.max(REFILL_PER_MIN, 1);

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

const buckets = new Map<string, Bucket>();

function refill(bucket: Bucket, now: number): void {
  const elapsed = now - bucket.lastRefillAt;
  if (elapsed <= 0) return;
  const grant = elapsed / REFILL_INTERVAL_MS;
  if (grant >= 1) {
    bucket.tokens = Math.min(CAPACITY, bucket.tokens + Math.floor(grant));
    bucket.lastRefillAt = now;
  }
}

/** Returns true and consumes a token if the caller may proceed. */
export function takeToken(ip: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: CAPACITY, lastRefillAt: now };
    buckets.set(ip, bucket);
  }
  refill(bucket, now);
  if (bucket.tokens > 0) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: REFILL_INTERVAL_MS };
}

/** Occasional cleanup so the map does not grow unbounded across a long-lived process. */
export function sweepStaleBuckets(maxAgeMs = 30 * 60_000): void {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now - bucket.lastRefillAt > maxAgeMs && bucket.tokens >= CAPACITY) buckets.delete(ip);
  }
}

export const RATE_LIMIT_CAPACITY = CAPACITY;
export const RATE_LIMIT_PER_MIN = REFILL_PER_MIN;
