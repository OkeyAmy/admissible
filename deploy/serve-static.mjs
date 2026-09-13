#!/usr/bin/env node
// Admissible — static server for web/dist on :80 with relayer proxy.
// No dependencies, replaces nginx on the micro instance.
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const DIST = normalize(join(here, '..', 'web', 'dist'));
const PORT = Number(process.env.WEB_PORT ?? 80);
const RELAYER_HOST = process.env.RELAYER_HOST ?? '127.0.0.1';
const RELAYER_PORT = Number(process.env.RELAYER_PORT ?? 8787);

// These three are also copied into web/dist at build time (sync-assets.mjs),
// but that copy is a snapshot — it only updates on the next rebuild. Bench
// and the contracts workspace write their canonical files continuously, so
// serve directly from those paths instead: no rebuild needed for these to
// reflect current state.
const LIVE_FILES = {
  '/receipts/mirrors.jsonl': join(here, '..', 'receipts', 'mirrors.jsonl'),
  '/receipts/summary.json': join(here, '..', 'receipts', 'summary.json'),
  '/deployments.json': join(here, '..', 'contracts', 'deployments.json'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function serveStatic(req, res, pathname) {
  const rel = normalize(pathname).replace(/^[/\\]+/, '');
  const abs = normalize(join(DIST, rel));
  if (!abs.startsWith(DIST)) { res.writeHead(403); res.end('Forbidden'); return; }
  const file = existsSync(abs) && statSync(abs).isDirectory()
    ? join(abs, 'index.html')
    : abs;
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback: client routes (/app, /verify, /docs, …) have no file on disk.
    const index = join(DIST, 'index.html');
    if (!existsSync(index)) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Cache-Control': 'no-cache',
    });
    createReadStream(index).pipe(res);
    return;
  }
  const st = statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

function proxy(req, res, pathname) {
  const upstream = httpRequest(
    { host: RELAYER_HOST, port: RELAYER_PORT, method: req.method, path: pathname,
      headers: { ...req.headers, host: `${RELAYER_HOST}:${RELAYER_PORT}` } },
    (resp) => {
      res.writeHead(resp.statusCode ?? 502, resp.headers);
      resp.pipe(res);
    },
  );
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Bad Gateway'); });
  req.pipe(upstream);
}

function serveLive(res, absPath) {
  if (!existsSync(absPath)) { res.writeHead(404); res.end('Not Found'); return; }
  const st = statSync(absPath);
  res.writeHead(200, {
    'Content-Type': extname(absPath) === '.json' ? MIME['.json'] : 'application/x-ndjson; charset=utf-8',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(absPath).pipe(res);
}

const DEFAULT_TAIL = 200;
const MAX_TAIL = 2000;
const WINDOW_PER_LINE = 4096; // generous byte budget per requested line — avg ReceiptLine is ~700 B
const MIN_WINDOW_BYTES = 64 * 1024;
const MAX_WINDOW_BYTES = 8 * 1024 * 1024;

// /receipts/mirrors.jsonl?tail=N — streams only the trailing N complete lines.
// Reads one bounded byte window from the end of the file (snapshotting size at
// request start, so an in-flight append is simply not part of this response and
// the next poll picks it up). The first fragment is discarded when the window
// starts mid-file (it is a partial line, possibly splitting a multi-byte UTF-8
// sequence — decode the whole buffer BEFORE splitting, then throw it away), and
// the final fragment is discarded when it isn't newline-terminated (partial
// write-in-progress). The full-file path (/receipts/mirrors.jsonl, no query)
// is unchanged and still served by serveLive() for download/inspection.
function serveTail(res, absPath, rawN) {
  if (!existsSync(absPath)) { res.writeHead(404); res.end('Not Found'); return; }
  const size = statSync(absPath).size;
  if (size === 0) {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Length': 0,
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }
  const n = Math.min(Math.max(parseInt(rawN, 10) || DEFAULT_TAIL, 1), MAX_TAIL);
  const windowBytes = Math.min(size, Math.min(Math.max(n * WINDOW_PER_LINE, MIN_WINDOW_BYTES), MAX_WINDOW_BYTES));
  const start = Math.max(0, size - windowBytes);
  const end = size - 1;

  const chunks = [];
  createReadStream(absPath, { start, end })
    .on('data', (c) => chunks.push(c))
    .on('error', () => {
      if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
    })
    .on('end', () => {
      const buf = Buffer.concat(chunks);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      if (lines.length && (lines[lines.length - 1] === '' || buf[buf.length - 1] !== 0x0a)) lines.pop();
      const picked = lines.slice(-n);
      const body = picked.join('\n') + (picked.length ? '\n' : '');
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const MAX_PAGE = 100000;

// /receipts/mirrors.jsonl?page=N&pageSize=M&q=SEARCH — server-side paging over
// the FULL mirrors.jsonl, the same plain-fs-only discipline as serveTail (no
// subprocesses). Reads the entire file once per request, splits into lines,
// case-insensitive substring-matches the optional query against the raw line
// (so searching a uid/hash/status/chainKey/timestamp all work), and returns a
// JSON envelope with the requested page plus totals so the client can render
// "x–y of z" and prev/next. `rows` come back newest-first (the file is
// append-ordered oldest→newest, so we walk the matched slice from the end).
function servePage(res, absPath, url) {
  if (!existsSync(absPath)) { res.writeHead(404); res.end('Not Found'); return; }
  const size = statSync(absPath).size;
  if (size === 0) {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Length': 0, 'Cache-Control': 'no-store' });
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
  if (q) {
    // Decode each line ONCE; a malformed line still matches on its raw text.
    for (const line of lines) if (line.toLowerCase().includes(q)) matched.push(line);
  }
  const totalMatched = matched.length;
  const totalPages = Math.max(1, Math.ceil(totalMatched / pageSize));
  // Walk newest-first: the file is append-ordered, so the last matching line is
  // the newest receipt.
  const start = Math.max(0, totalMatched - (clampedPage + 1) * pageSize);
  const end = Math.max(0, totalMatched - clampedPage * pageSize);
  const slice = matched.slice(start, end);

  const rows = [];
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
  res.writeHead(200, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (pathname === '/health' || pathname === '/mirror') { proxy(req, res, pathname); return; }
  if (pathname === '/receipts/mirrors.jsonl' && url.searchParams.has('page')) {
    servePage(res, LIVE_FILES[pathname], url);
    return;
  }
  if (pathname === '/receipts/mirrors.jsonl' && url.searchParams.has('tail')) {
    serveTail(res, LIVE_FILES[pathname], url.searchParams.get('tail') ?? '');
    return;
  }
  if (pathname in LIVE_FILES) { serveLive(res, LIVE_FILES[pathname]); return; }
  serveStatic(req, res, pathname);
}).listen(PORT, () => {
  console.log(`admissible-web: serving ${DIST} on :${PORT}, proxying /health /mirror -> ${RELAYER_HOST}:${RELAYER_PORT}`);
});