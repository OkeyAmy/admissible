/** Loads the repo-root `.env` regardless of the process's cwd (pnpm --filter
 *  runs scripts with cwd set to the package directory, not the repo root). */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setDefaultResultOrder } from 'node:dns';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../.env') });

/**
 * See bench/src/env.ts for the full write-up: this sandbox has no reachable
 * IPv6 route, and Node's fetch (undici) Happy-Eyeballs racing stalls on the
 * IPv6 leg instead of failing fast the way `curl` does, causing
 * non-deterministic `TypeError: fetch failed` on easscan/prover calls.
 * Forcing IPv4 first fixes it.
 */
setDefaultResultOrder('ipv4first');
