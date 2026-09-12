#!/usr/bin/env node
// Admissible — static server for web/dist on :80 with relayer proxy.
// No dependencies, replaces nginx on the micro instance.
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const DIST = normalize(join(here, '..', 'web', 'dist'));
const PORT = Number(process.env.WEB_PORT ?? 80);
const RELAYER_HOST = process.env.RELAYER_HOST ?? '127.0.0.1';
const RELAYER_PORT = Number(process.env.RELAYER_PORT ?? 8787);

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

createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/health' || pathname === '/mirror') { proxy(req, res, pathname); return; }
  serveStatic(req, res, pathname);
}).listen(PORT, () => {
  console.log(`admissible-web: serving ${DIST} on :${PORT}, proxying /health /mirror -> ${RELAYER_HOST}:${RELAYER_PORT}`);
});