import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

// Tests locaux exclusivement. Aucun SDK, identifiant réel ou service distant.
// Ce premier périmètre vérifie le socle fermé, pas les transactions du jeu.
const PROJECT = 'demo-animal-cards-security';
const JAVA = resolve('.frst/security-tools/java/jdk-21.0.13+9-jre/bin/java.exe');
const JAR = resolve('.frst/security-tools/cloud-firestore-emulator-v1.22.0.jar');
const JAR_SHA256 = '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c';
const RULES = resolve('firestore.rules');
const reportPath = '.frst/firestore-rules-test-result.json';
const logPath = '.frst/firestore-emulator-test.log';
const OWNER = Symbol('Emulator seed context only');
const checks = [];
const report = {
  status: 'running', startedAt: new Date().toISOString(), projectId: PROJECT,
  scope: 'Règles clientes fermées : lectures cloisonnées, tirages privés et refus de toutes les écritures clientes. Les transitions économiques du service serveur sont testées séparément.',
  baselineRulesVerified: false, gameWriteRulesVerified: false,
  firebaseTransactionsVerified: false, checks
};
let emulator, closed, childClosed = false, launchError, emulatorExit;
let output = '', origin = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function log(chunk) { output = (output + chunk.toString()).slice(-240000); }
function passed(label) { checks.push(label); console.log(`OK ${checks.length} - ${label}`); }

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function mockToken(uid) {
  assert.ok(typeof uid === 'string' && uid.length > 0);
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', type: 'JWT' })}.${encode({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
    iat: now, exp: now + 3600, auth_time: now, sub: uid, user_id: uid,
    firebase: { sign_in_provider: 'custom', identities: {} }
  })}.`;
}
function field(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value));
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(field) } };
  assert.ok(value && typeof value === 'object');
  return { mapValue: { fields: fields(value) } };
}
function fields(value) { return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, field(item)])); }
function documentName(path) {
  assert.match(path, /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/);
  return `projects/${PROJECT}/databases/(default)/documents/${path}`;
}
const documents = () => `/v1/projects/${PROJECT}/databases/(default)/documents`;
const update = (path, data) => ({ update: { name: documentName(path), fields: fields(data) } });
const deletion = path => ({ delete: documentName(path) });
async function request(method, route, uid = null, body) {
  assert.match(PROJECT, /^demo-/);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const url = new URL(route, origin);
  assert.equal(url.origin, origin, 'Interdiction de contacter une origine distante');
  assert.ok(url.pathname.includes(`/projects/${PROJECT}`), 'Projet de test obligatoire');
  const headers = { 'Content-Type': 'application/json' };
  // Le jeton owner est exclusivement utilisé pour les fixtures de cet émulateur.
  if (uid !== null) headers.Authorization = `Bearer ${uid === OWNER ? 'owner' : mockToken(uid)}`;
  const response = await fetch(url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000)
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Réponse non JSON : HTTP ${response.status} ${text.slice(0, 300)}`); }
  return { status: response.status, data };
}
async function allowed(operation, label) {
  const result = await operation;
  assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}
async function denied(operation, label) {
  const result = await operation;
  assert.equal(result.status, 403, `${label}: ${JSON.stringify(result.data)}`);
  assert.equal(result.data?.error?.status, 'PERMISSION_DENIED', label);
}
const get = (path, uid) => request('GET', `${documents()}/${path}`, uid);
const commit = (writes, uid) => request('POST', `${documents()}:commit`, uid, { writes });
function query(collectionId, uid, limit) {
  const structuredQuery = { from: [{ collectionId }] };
  if (limit !== undefined) structuredQuery.limit = limit;
  return request('POST', `${documents()}:runQuery`, uid, { structuredQuery });
}

try {
  await mkdir('.frst', { recursive: true });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(JAR)) hash.update(chunk);
  assert.equal(hash.digest('hex'), JAR_SHA256, 'Empreinte de l’émulateur incorrecte');
  const rules = await readFile(RULES, 'utf8');
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  report.emulatorOrigin = origin;
  emulator = spawn(JAVA, [
    '-Xmx512m', '-Duser.language=en', '-jar', JAR,
    '--host', '127.0.0.1', '--port', String(port), '--project_id', PROJECT,
    '--single_project_mode', 'true', '--single_project_mode_error', 'true', '--rules', RULES
  ], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: false });
  emulator.on('error', error => { launchError = error; });
  emulator.stdout.on('data', log);
  emulator.stderr.on('data', log);
  closed = new Promise(resolve => emulator.once('close', (code, signal) => {
    childClosed = true; emulatorExit = { code, signal }; resolve();
  }));
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (childClosed) throw new Error(`Émulateur arrêté au démarrage : ${JSON.stringify(emulatorExit)}\n${output}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(600) });
      await response.text();
      ready = true; break;
    } catch { await sleep(120); }
  }
  assert.ok(ready, 'L’émulateur ne répond pas dans le délai de démarrage');
  await allowed(request('PUT', `/emulator/v1/projects/${PROJECT}:securityRules`, null, {
    rules: { files: [{ name: 'firestore.rules', content: rules }] }
  }), 'Compilation des règles');
  passed('Émulateur local démarré et règles compilées');

  await allowed(commit([
    update('players/alice', { uid: 'alice', balanceMilli: 10000, privateMarker: 'alice-only' }),
    update('players/bruno', { uid: 'bruno', balanceMilli: 20000, privateMarker: 'bruno-only' }),
    update('events/receipt_alice_0001', { actor: 'alice', kind: 'claim' }),
    update('events/receipt_bruno_0001', { actor: 'bruno', kind: 'claim' }),
    update('listings/listing_fixture_01', { sellerId: 'bruno', status: 'active', priceMilli: 5000 }),
    update('private/secret_fixture_01', { marker: 'never-public' })
  ], OWNER), 'Création des fixtures locales');
  const own = await allowed(get('players/alice', 'alice'), 'Lecture du profil personnel');
  assert.equal(own.fields.privateMarker.stringValue, 'alice-only');
  assert.equal(own.fields.balanceMilli.integerValue, '10000');
  passed('Fixtures confirmées et profil personnel lisible');

  for (const path of ['players/alice', 'events/receipt_alice_0001', 'listings/listing_fixture_01']) {
    await denied(get(path, null), `Lecture anonyme ${path}`);
  }
  await denied(query('listings', null, 40), 'Catalogue du marché anonyme');
  passed('Lectures privées et marché refusés aux visiteurs non authentifiés');

  await denied(get('players/bruno', 'alice'), 'Profil d’un autre joueur');
  await denied(get('players/absent', 'alice'), 'Profil étranger absent');
  await denied(query('players', 'alice', 10), 'Énumération des profils');
  passed('Autres profils et énumération des joueurs inaccessibles');

  const receipt = await allowed(get('events/receipt_alice_0001', 'alice'), 'Reçu personnel');
  assert.equal(receipt.fields.actor.stringValue, 'alice');
  await denied(get('events/receipt_bruno_0001', 'alice'), 'Reçu d’un autre joueur');
  await denied(query('events', 'alice', 10), 'Énumération des reçus');
  const missing = await get('events/receipt_absent_0001', 'alice');
  assert.equal(missing.status, 404, JSON.stringify(missing.data));
  assert.equal(missing.data?.error?.status, 'NOT_FOUND');
  passed('Reçus cloisonnés et recherche explicite d’un reçu absent autorisée');

  await allowed(get('listings/listing_fixture_01', 'alice'), 'Offre du marché');
  const market = await allowed(query('listings', 'alice', 40), 'Marché limité à quarante offres');
  assert.ok(Array.isArray(market) && market.some(row => row.document?.name.endsWith('/listings/listing_fixture_01')));
  await denied(query('listings', 'alice'), 'Requête de marché sans limite');
  await denied(query('listings', 'alice', 41), 'Requête de marché dépassant la limite');
  passed('Marché authentifié lisible avec une limite obligatoire de quarante résultats');

  for (const [label, write] of [
    ['solde personnel falsifié', update('players/alice', { uid: 'alice', balanceMilli: 999999999 })],
    ['solde étranger falsifié', update('players/bruno', { uid: 'bruno', balanceMilli: 0 })],
    ['profil inventé', update('players/created_by_client', { uid: 'alice', balanceMilli: 1 })],
    ['reçu inventé', update('events/forged_receipt_01', { actor: 'alice', kind: 'claim' })],
    ['reçu réécrit', update('events/receipt_alice_0001', { actor: 'alice', kind: 'register' })],
    ['offre inventée', update('listings/forged_listing_01', { sellerId: 'alice', priceMilli: 1 })],
    ['offre réécrite', update('listings/listing_fixture_01', { sellerId: 'alice', priceMilli: 0 })],
    ['profil supprimé', deletion('players/alice')],
    ['reçu supprimé', deletion('events/receipt_alice_0001')],
    ['offre supprimée', deletion('listings/listing_fixture_01')]
  ]) await denied(commit([write], 'alice'), label);
  await denied(commit([update('players/alice', { balanceMilli: 1 })], null), 'Écriture anonyme');
  passed('Créations, falsifications et suppressions clientes toutes refusées par le socle fermé');

  await allowed(commit([
    update('packSecrets/reservation_fixture_01', { actor: 'alice', tier: 0, cards: ['red-fox', 'rabbit', 'clownfish', 'monarch'] })
  ], OWNER), 'Préparation du tirage privé dans l’émulateur');
  for (const uid of [null, 'alice', 'bruno']) {
    await denied(get('packSecrets/reservation_fixture_01', uid), 'Tirage privé inaccessible même à son acheteur');
    await denied(query('packSecrets', uid, 10), 'Énumération des tirages privés interdite');
  }
  await denied(commit([update('packSecrets/reservation_fixture_01', { actor: 'alice', cards: ['forged'] })], 'alice'), 'Tirage privé non modifiable par le client');
  await denied(commit([deletion('packSecrets/reservation_fixture_01')], 'alice'), 'Tirage privé non supprimable par le client');
  await denied(get('private/secret_fixture_01', 'alice'), 'Document hors collections prévues');
  await denied(query('private', 'alice', 10), 'Énumération hors collections prévues');
  await denied(commit([update('private/client_invention', { marker: 'forged' })], 'alice'), 'Écriture hors collections prévues');
  passed('Collections non prévues protégées par le refus général');

  await denied(commit([
    update('players/alice', { uid: 'alice', balanceMilli: 0 }),
    update('events/atomic_forgery_01', { actor: 'alice', kind: 'claim' })
  ], 'alice'), 'Commit atomique frauduleux');
  const unchanged = await allowed(get('players/alice', 'alice'), 'Profil après les attaques');
  assert.deepEqual(unchanged.fields, own.fields, 'Une tentative refusée a modifié le profil');
  const absentForgery = await get('events/atomic_forgery_01', 'alice');
  assert.equal(absentForgery.status, 404, 'Un reçu frauduleux a été créé');
  passed('Écritures atomiques frauduleuses refusées sans modification partielle');

  report.baselineRulesVerified = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (emulator && !childClosed) {
    emulator.kill();
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
    if (!childClosed) {
      report.status = 'failed';
      report.cleanupError = 'Arrêt du processus émulateur non confirmé.';
      process.exitCode = 1;
    }
  }
  report.emulatorStopped = !emulator || childClosed;
  report.emulatorExit = emulatorExit;
  report.finishedAt = new Date().toISOString();
  report.checkCount = checks.length;
  await mkdir('.frst', { recursive: true });
  await writeFile(logPath, output);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`FIRESTORE_BASELINE_RESULT ${report.status} ${checks.length}/9 ${reportPath}`);
  console.log('GAME_WRITE_RULES_VERIFIED false — socle fermé uniquement, jeu Firebase non finalisé.');
}
