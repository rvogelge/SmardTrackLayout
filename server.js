// SmardTrackLayout server: serves the editor, proxies + caches XTrackCAD
// parameter files from SourceForge, and stores layouts on disk.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const SEED = path.join(ROOT, 'seed');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'cache');
const LAYOUTS = path.join(DATA, 'layouts');
const PORT = Number(process.env.PORT || 8080);
const SF_PARAMS = 'https://sourceforge.net/p/xtrkcad-fork/xtrkcad/ci/default/tree/app/lib/params';
const LIST_MAX_AGE = 7 * 24 * 3600 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.ico': 'image/x-icon', '.png': 'image/png',
};

await fs.mkdir(CACHE, { recursive: true });
await fs.mkdir(LAYOUTS, { recursive: true });

// ---------- library list ----------
let libraries = null;

async function loadLibraryList() {
  const listFile = path.join(DATA, 'libraries.json');
  try {
    const st = await fs.stat(listFile);
    libraries = JSON.parse(await fs.readFile(listFile, 'utf8'));
    if (Date.now() - st.mtimeMs < LIST_MAX_AGE) return;
  } catch { /* no cached list yet */ }
  if (!libraries) libraries = JSON.parse(await fs.readFile(path.join(SEED, 'libraries.json'), 'utf8'));
  refreshLibraryList(listFile); // refresh in background
}

async function refreshLibraryList(listFile) {
  try {
    const res = await fetch(SF_PARAMS + '/', { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const names = new Set();
    for (const m of html.matchAll(/href="([^"/?]+\.xtp)"/gi)) names.add(decodeURIComponent(m[1]));
    if (names.size < 50) throw new Error('listing looks incomplete (' + names.size + ')');
    libraries = [...names].sort((a, b) => a.localeCompare(b));
    await fs.writeFile(listFile, JSON.stringify(libraries));
    console.log(`library list refreshed: ${libraries.length} files`);
  } catch (e) {
    console.warn('library list refresh failed, using cached/seed list:', e.message);
  }
}

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

async function getLibrary(name) {
  if (!libraries.includes(name)) return null;
  const cacheFile = path.join(CACHE, name);
  try { return await fs.readFile(cacheFile, 'utf8'); } catch { /* not cached */ }
  try { // bundled seed copy
    const text = await fs.readFile(path.join(SEED, name), 'utf8');
    await fs.writeFile(cacheFile, text);
    return text;
  } catch { /* not seeded */ }
  const res = await fetch(`${SF_PARAMS}/${encodeURIComponent(name)}?format=raw`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`SourceForge returned HTTP ${res.status}`);
  const text = decodeText(new Uint8Array(await res.arrayBuffer()));
  if (/^\s*<!DOCTYPE|^\s*<html/i.test(text)) throw new Error('SourceForge returned an HTML page instead of the file');
  await fs.writeFile(cacheFile, text);
  return text;
}

// ---------- layouts ----------
const safeLayoutName = (n) => (typeof n === 'string' && /^[\p{L}\p{N} _.-]{1,64}$/u.test(n) && !n.startsWith('.')) ? n : null;

async function listLayouts() {
  const files = (await fs.readdir(LAYOUTS)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const st = await fs.stat(path.join(LAYOUTS, f));
    out.push({ name: f.slice(0, -5), modified: st.mtime.toISOString(), size: st.size });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

// ---------- http ----------
function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(data);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { send(res, 404, { error: 'not found' }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/libraries' && req.method === 'GET') return send(res, 200, libraries);
    if (p === '/api/library' && req.method === 'GET') {
      const text = await getLibrary(url.searchParams.get('file') || '');
      return text == null ? send(res, 404, { error: 'unknown library' }) : send(res, 200, text, 'text/plain; charset=utf-8');
    }
    if (p === '/api/layouts' && req.method === 'GET') return send(res, 200, await listLayouts());
    if (p.startsWith('/api/layouts/')) {
      const name = safeLayoutName(decodeURIComponent(p.slice('/api/layouts/'.length)));
      if (!name) return send(res, 400, { error: 'invalid layout name' });
      const file = path.join(LAYOUTS, name + '.json');
      if (req.method === 'GET') {
        try { return send(res, 200, await fs.readFile(file, 'utf8')); } catch { return send(res, 404, { error: 'not found' }); }
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        JSON.parse(body); // validate
        await fs.writeFile(file, body);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') { await fs.rm(file, { force: true }); return send(res, 200, { ok: true }); }
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(req.method, p, e.message);
    send(res, 502, { error: e.message });
  }
});

await loadLibraryList();
server.listen(PORT, () => console.log(`SmardTrackLayout listening on :${PORT}`));
