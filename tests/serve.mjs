// Petit serveur statique pour tester docs/ en local : npm run serve puis http://localhost:8080/
// Il sert le site sous /ANIMAL-CARDS/ pour reproduire le sous-chemin de GitHub Pages.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../docs/', import.meta.url));
const base = '/ANIMAL-CARDS/';
const port = Number(process.env.PORT) || 8080;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === base.slice(0, -1)) { res.writeHead(302, { location: base }); return res.end(); }
  if (!url.pathname.startsWith(base)) { res.writeHead(404); return res.end('Introuvable'); }
  let rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(root, rel));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Introuvable');
  }
}).listen(port, () => console.log(`ANIMAL CARDS : http://localhost:${port}${base}`));
