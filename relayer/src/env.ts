/** Loads the repo-root `.env` regardless of the process's cwd (pnpm --filter
 *  runs scripts with cwd set to the package directory, not the repo root).
 *  Byte-for-byte the same loader worker/bench use, so PRIVATE_KEY resolves
 *  identically no matter which of the three processes reads it. */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../.env') });
