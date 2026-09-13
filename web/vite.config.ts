import { defineConfig, type Connect, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// The docs pages read markdown that lives at ../docs and ../README.md, outside
// web/. Vite must be allowed to serve those in dev; the build inlines them.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'serve-live-receipts',
      configureServer: serveDevReceipts,
    },
  ],
  server: {
    fs: { allow: ['..', '../..'] },
    // Mirrors serve-static.mjs's production behavior: RELAYER_URL resolves to
    // the page's own origin, so /mirror must be same-origin here too rather
    // than requiring a dev-only VITE_RELAYER_URL override.
    proxy: {
      '/mirror': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});

// Dev parity for /receipts/mirrors.jsonl. serve-static.mjs serves the live file
// from receipts/ with a bounded ?tail=N byte-window read; sync-assets deliberately
// does NOT copy mirrors.jsonl into web/public, so without this middleware vite dev
// would 404 and the Receipts page would render empty. Full file (no query) is
// streamed untouched; ?tail=N returns only the trailing N complete lines — same
// window math as serveTail() in deploy/serve-static.mjs.
// Vite transpiles vite.config.ts before importing it, so import.meta.url points
// at a temp bundle, not this file. The dev script always runs from web/, so
// process.cwd() here is web/ — use it as the anchor.
const MIRRORS_PATH = join(resolve(process.cwd(), '..'), 'receipts', 'mirrors.jsonl');

const DEFAULT_TAIL = 200;
const MAX_TAIL = 2000;
const WINDOW_PER_LINE = 4096;
const MIN_WINDOW_BYTES = 64 * 1024;
const MAX_WINDOW_BYTES = 8 * 1024 * 1024;

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const MAX_PAGE = 100000;

// Dev parity for /receipts/mirrors.jsonl?page=…&pageSize=…&q=… (the server-side
// paging endpoint). Same plain-fs whole-file scan + newest-first slice as
// servePage() in deploy/serve-static.mjs; keeping it inline here avoids a
// required-module mismatch between vite dev and the deployed static server.
function serveReceiptsPage(res: ServerResponse, url: URL, absPath: string): void {
  if (!existsSync(absPath)) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }
  const size = statSync(absPath).size;
  if (size === 0) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end('{"rows":[],"page":0,"pageSize":0,"totalMatched":0,"totalLines":0,"query":""}');
    return;
  }
  const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
  const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('pageSize') ?? '', 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const clampedPage = Math.min(page, MAX_PAGE);

  const lines = readFileSync(absPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const totalLines = lines.length;
  const matched = q ? [] : lines;
  if (q) for (const line of lines) if (line.toLowerCase().includes(q)) matched.push(line);
  const totalMatched = matched.length;
  const totalPages = Math.max(1, Math.ceil(totalMatched / pageSize));
  const start = Math.max(0, totalMatched - (clampedPage + 1) * pageSize);
  const end = Math.max(0, totalMatched - clampedPage * pageSize);
  const slice = matched.slice(start, end);

  const rows: unknown[] = [];
  for (const line of slice) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  rows.reverse();

  const body = JSON.stringify({
    rows,
    page: clampedPage,
    pageSize,
    totalMatched,
    totalLines,
    totalPages,
    query: url.searchParams.get('q') ?? '',
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function serveDevReceipts(server: ViteDevServer): void {
  server.middlewares.use((req, res, next: Connect.NextFunction) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/receipts/mirrors.jsonl') return next();
    if (!existsSync(MIRRORS_PATH)) {
      console.warn(`[serve-live-receipts] missing ${MIRRORS_PATH}`);
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const size = statSync(MIRRORS_PATH).size;
    if (url.searchParams.has('page')) {
      serveReceiptsPage(res, url, MIRRORS_PATH);
      return;
    }
    if (!url.searchParams.has('tail')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Length', size);
      res.setHeader('Cache-Control', 'no-store');
      createReadStream(MIRRORS_PATH).pipe(res);
      return;
    }
    if (size === 0) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Length', 0);
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }
    const n = Math.min(Math.max(parseInt(url.searchParams.get('tail') ?? '', 10) || DEFAULT_TAIL, 1), MAX_TAIL);
    const windowBytes = Math.min(size, Math.min(Math.max(n * WINDOW_PER_LINE, MIN_WINDOW_BYTES), MAX_WINDOW_BYTES));
    const start = Math.max(0, size - windowBytes);
    const end = size - 1;
    const chunks: Buffer[] = [];
    createReadStream(MIRRORS_PATH, { start, end })
      .on('data', (c) => chunks.push(c as Buffer))
      .on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal Server Error');
        }
      })
      .on('end', () => {
        const buf = Buffer.concat(chunks);
        const lines = buf.toString('utf8').split('\n');
        if (start > 0) lines.shift();
        if (lines.length && (lines[lines.length - 1] === '' || buf[buf.length - 1] !== 0x0a)) lines.pop();
        const picked = lines.slice(-n);
        const body = picked.join('\n') + (picked.length ? '\n' : '');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
  });
}