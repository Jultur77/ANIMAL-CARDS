import http from 'node:http';
import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GameStore, GameError } from './store.js';
import { CARDS, RARITIES, PACK_WEIGHTS, SHOP_MS } from './catalog.js';

const scrypt = promisify(scryptCallback);
const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const SESSION_COOKIE = 'animal_session';
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_HASH = '0'.repeat(128);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt-v1:${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, record) {
  const [version, salt, expected] = String(record || `scrypt-v1:${'0'.repeat(32)}:${DUMMY_HASH}`).split(':');
  if (version !== 'scrypt-v1' || !salt || !expected) return false;
  const actual = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  const expectedBytes = Buffer.from(expected, 'hex');
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes) && Boolean(record);
}

function passwordValid(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 && Buffer.byteLength(value) <= 512;
}

async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new GameError('Un corps JSON est nécessaire.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new GameError('Requête trop volumineuse.', 413);
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch { throw new GameError('JSON invalide.'); }
}

function tokenFrom(req) {
  const cookie = (req.headers.cookie || '').split(';').find(part => part.trim().startsWith(`${SESSION_COOKIE}=`));
  return cookie ? cookie.trim().slice(SESSION_COOKIE.length + 1) : '';
}

export function createGameServer({ dbPath = process.env.DATABASE_PATH || 'data/animal-cards.sqlite', store: providedStore, origin = process.env.APP_ORIGIN || '', secure = process.env.NODE_ENV === 'production' } = {}) {
  if (secure && (!origin || !origin.startsWith('https://'))) throw new Error('En production, APP_ORIGIN doit être une origine HTTPS explicite.');
  const allowedOrigin = origin ? new URL(origin).origin : '';
  const store = providedStore || new GameStore(dbPath);
  const buckets = new Map();
  let pendingAuth = 0;

  function limit(req, category, max, interval) {
    const now = Date.now();
    const ip = req.socket.remoteAddress || 'unknown';
    const key = `${category}:${ip}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) bucket = { until: now + interval, count: 0 };
    bucket.count++;
    buckets.set(key, bucket);
    if (bucket.count > max) throw new GameError('Trop de tentatives. Réessaie dans quelques minutes.', 429);
    if (buckets.size > 10_000) {
      for (const [id, entry] of buckets) if (entry.until <= now) buckets.delete(id);
      if (buckets.size > 10_000) throw new GameError('Serveur occupé. Réessaie plus tard.', 503);
    }
  }

  function headers(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function setCookie(res, token, maxAge = 604800) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }

  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      const url = new URL(req.url, 'http://local');
      const pathname = url.pathname;
      if (pathname.startsWith('/api/')) {
        limit(req, 'api', 600, 60_000);
        if (req.method !== 'GET' && req.method !== 'POST') throw new GameError('Méthode non autorisée.', 405);
        if (req.method === 'POST') {
          limit(req, 'writes', 100, 60_000);
          if (req.headers['x-animal-client'] !== '1') throw new GameError('En-tête de sécurité manquant.', 403);
          const requestOrigin = req.headers.origin;
          const expectedOrigin = allowedOrigin || `http://${req.headers.host}`;
          if (requestOrigin && requestOrigin !== expectedOrigin) throw new GameError('Origine non autorisée.', 403);
          if (req.headers['sec-fetch-site'] === 'cross-site') throw new GameError('Requête intersite interdite.', 403);
        }
        if (pathname === '/api/health' && req.method === 'GET') {
          store.one('SELECT 1');
          return json(res, 200, { status: 'ok' });
        }
        if (pathname === '/api/catalog' && req.method === 'GET') return json(res, 200, { cards: CARDS, rarities: RARITIES, packWeights: PACK_WEIGHTS, shopIntervalMs: SHOP_MS, cardsPerPack: 4 });
        if ((pathname === '/api/register' || pathname === '/api/login') && req.method === 'POST') {
          limit(req, 'auth', 25, 900_000);
          if (pendingAuth >= 4) throw new GameError('Connexions en cours. Réessaie dans un instant.', 503);
          const data = await body(req);
          if (typeof data.username !== 'string' || data.username.length > 24 || !passwordValid(data.password)) throw new GameError('Pseudo invalide ou mot de passe hors limites (12 à 128 caractères).');
          let userId;
          pendingAuth++;
          try {
            if (pathname === '/api/register') {
              limit(req, 'register', 8, 3_600_000);
              const hash = await hashPassword(data.password);
              userId = store.createUser(data.username.trim(), hash);
            } else {
              const record = store.authRecord(data.username.trim());
              if (!await verifyPassword(data.password, record?.password_hash)) throw new GameError('Pseudo ou mot de passe incorrect.', 401);
              userId = record.id;
            }
          } finally { pendingAuth--; }
          store.endSession(tokenFrom(req));
          const session = store.newSession(userId);
          setCookie(res, session.token);
          return json(res, pathname === '/api/register' ? 201 : 200, { authenticated: true, csrf: session.csrf, state: store.state(userId) });
        }
        const token = tokenFrom(req);
        const session = store.session(token);
        if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, session ? { authenticated: true, csrf: session.csrf, state: store.state(session.userId) } : { authenticated: false });
        if (!session) throw new GameError('Connecte-toi pour jouer.', 401);
        if (req.method === 'POST' && req.headers['x-csrf-token'] !== session.csrf) throw new GameError('Session de sécurité invalide. Recharge la page.', 403);
        if (pathname === '/api/logout' && req.method === 'POST') {
          store.endSession(token);
          setCookie(res, '', 0);
          return json(res, 200, { ok: true });
        }
        if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, store.state(session.userId));
        if (pathname === '/api/market' && req.method === 'GET') {
          const query = Object.fromEntries(url.searchParams);
          query.mine = query.mine === 'true';
          return json(res, 200, store.market(query, session.userId));
        }
        if (pathname === '/api/action' && req.method === 'POST') {
          const data = await body(req);
          if (typeof data.kind !== 'string' || !data.data || typeof data.data !== 'object' || Array.isArray(data.data)) throw new GameError('Action invalide.');
          const result = store.action(session.userId, data.key, data.kind, data.data);
          return json(res, 200, { result, state: store.state(session.userId) });
        }
        throw new GameError('Route introuvable.', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new GameError('Méthode non autorisée.', 405);
      let decoded;
      try { decoded = decodeURIComponent(pathname); } catch { throw new GameError('Chemin invalide.', 400); }
      if (decoded.includes('\0') || decoded.split(/[\\/]/).some(part => part.startsWith('.'))) throw new GameError('Fichier introuvable.', 404);
      const target = resolve(ROOT, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!target.startsWith(resolve(ROOT) + sep)) throw new GameError('Fichier introuvable.', 404);
      let info;
      try { info = await stat(target); } catch { throw new GameError('Fichier introuvable.', 404); }
      if (!info.isFile() || !MIME[extname(target)]) throw new GameError('Fichier introuvable.', 404);
      const content = await readFile(target);
      res.writeHead(200, { 'Content-Type': MIME[extname(target)], 'Content-Length': content.length, 'Cache-Control': decoded.startsWith('/animals/') ? 'public, max-age=86400' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = error instanceof GameError ? error.status : 500;
      if (status === 500) console.error('Request failed:', error);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Erreur du serveur. Ta transaction n’a pas été confirmée ; actualise avant de réessayer.' : error.message });
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  const maintenance = setInterval(() => {
    try {
      store.settleDue();
      store.run('DELETE FROM sessions WHERE expires_at <= ?', store.now());
      for (const [key, bucket] of buckets) if (bucket.until <= Date.now()) buckets.delete(key);
    } catch (error) { console.error('Settlement failed:', error); }
  }, 1000);
  maintenance.unref();
  server.on('close', () => { clearInterval(maintenance); if (!providedStore) store.close(); });
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { server } = createGameServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => console.log(`ANIMAL CARDS prêt sur http://${host}:${port}`));
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
