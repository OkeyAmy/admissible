// Copies evidence artifacts produced by other workspaces into web/public so the
// browser can fetch them. Never fails the build: if a file is not there yet the
// /receipts surface renders an honest empty state instead of invented numbers.
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const repoRoot = resolve(webRoot, '..');
const outDir = join(webRoot, 'public', 'receipts');

mkdirSync(outDir, { recursive: true });

const wanted = [
  ['receipts/summary.json', 'summary.json'],
  ['receipts/mirrors.jsonl', 'mirrors.jsonl'],
];

const present = [];
for (const [from, to] of wanted) {
  const src = join(repoRoot, from);
  if (existsSync(src)) {
    copyFileSync(src, join(outDir, to));
    present.push(to);
  }
}

// A manifest so the client knows what to even try fetching.
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ present, syncedAt: new Date().toISOString() }, null, 2));

// Deployment address, if the contracts workspace has produced one.
const deployments = join(repoRoot, 'contracts', 'deployments.json');
if (existsSync(deployments)) {
  copyFileSync(deployments, join(webRoot, 'public', 'deployments.json'));
}

console.log(`[sync-assets] receipts present: ${present.length ? present.join(', ') : '(none yet)'}`);
