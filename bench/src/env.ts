/** Loads the repo-root `.env` regardless of the process's cwd (pnpm --filter
 *  runs scripts with cwd set to the package directory, not the repo root). */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setDefaultResultOrder } from 'node:dns';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../.env') });

/**
 * This sandbox has a broken/absent IPv6 route (`ENETUNREACH` on every IPv6
 * destination) but Node's fetch (undici) still races an IPv6 connection
 * attempt against IPv4 (Happy Eyeballs) and, observed live, that IPv6 leg
 * doesn't fail fast — it stalls the whole attempt until the IPv4 leg times
 * out too (`ETIMEDOUT`), even though a plain `curl` to the same host over
 * IPv4 succeeds in ~1-2s. `curl` gets an immediate "Network is unreachable"
 * on the IPv6 leg and falls back instantly; Node's does not. Forcing IPv4
 * first (or IPv4-only, effectively — there's no reachable IPv6 here) fixes
 * it, verified by comparing `node -e "fetch(...)"` with and without this
 * before/after this line in a fresh process. Without this, easscan/prover
 * calls fail non-deterministically with `TypeError: fetch failed` under
 * `ETIMEDOUT`/`ENETUNREACH`, indistinguishable from a real outage.
 */
setDefaultResultOrder('ipv4first');
