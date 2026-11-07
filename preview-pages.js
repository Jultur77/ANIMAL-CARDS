import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const directory = `dist${args.includes('--cdn') ? '-cdn' : ''}${args.includes('--emulators') ? '-emulators' : ''}`;
const root = await realpath(fileURLToPath(new URL(`./${directory}/`, import.meta.url)));
const prefix = '/ANIMAL-CARDS/';
const portIndex = args.indexOf('--port');
const port = portIndex === -1 ? 4173 : Number(args[portIndex + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port de prévisualisation invalide.');
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'], ['.webp', 'image/webp'], ['.avif', 'image/avif'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2']
]);
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/' || pathname === prefix.slice(0, -1)) {
      response.writeHead(302, { Location: prefix });
      response.end();
      return;
    }
    if (!pathname.startsWith(prefix)) throw Object.assign(new Error('Introuvable'), { status: 404 });
    const relative = pathname.slice(prefix.length) || 'index.html';
    if (relative.includes('\\') || relative.split('/').some(part => part.startsWith('.'))) throw Object.assign(new Error('Introuvable'), { status: 404 });
    const candidate = resolve(root, relative);
    if (!candidate.startsWith(root + sep) || !types.has(extname(candidate))) throw Object.assign(new Error('Introuvable'), { status: 404 });
    const path = await realpath(candidate);
    if (!path.startsWith(root + sep)) throw Object.assign(new Error('Introuvable'), { status: 404 });
    const info = await stat(path);
    if (!info.isFile()) throw Object.assign(new Error('Introuvable'), { status: 404 });
    const content = request.method === 'HEAD' ? null : await readFile(path);
    response.writeHead(200, { 'Content-Type': types.get(extname(path)), 'Content-Length': info.size });
    response.end(content);
  } catch (error) {
    const status = error.status || (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : error instanceof URIError ? 400 : 500);
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(status === 500 ? 'Erreur de prévisualisation.' : 'Ressource indisponible.');
    if (status === 500) console.error(error);
  }
});
server.on('error', error => { console.error(error); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`PREVIEW_READY http://127.0.0.1:${port}${prefix} (${join(root, 'index.html')})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
