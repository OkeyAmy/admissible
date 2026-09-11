import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

writeFileSync(join(root, 'dist/cjs/package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
writeFileSync(join(root, 'dist/esm/package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

const bin = join(root, 'dist/cjs/bin/admissible.js');
if (existsSync(bin)) chmodSync(bin, 0o755);

console.log('fixup: wrote dist/{cjs,esm}/package.json, chmod +x dist/cjs/bin/admissible.js');
