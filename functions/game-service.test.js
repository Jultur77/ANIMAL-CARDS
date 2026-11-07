import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createGameService, GameError } from './game-service.js';
import { CARDS } from './generated/catalog.js';
import { MAX_BALANCE, SHOP_MS, shopOffer, milliseconds } from './generated/game-model.js';

const root = new URL('../', import.meta.url);
const PROJECT = 'demo-animal-cards-functions';
const JAVA = fileURLToPath(new URL('.frst/security-tools/java/jdk-21.0.13+9-jre/bin/java.exe', root));
const JAR = fileURLToPath(new URL('.frst/security-tools/cloud-firestore-emulator-v1.22.0.jar', root));
const RULES = fileURLToPath(new URL('firestore.rules', root));
const checks = [];
const expectedChecks = 13;
let emulator, closed, childClosed = false, launchError, app, db, origin, sequence = 0;
let output = '';
const report = { status: 'running', startedAt: new Date().toISOString(), projectId: PROJECT,
  scope: 'Service serveur avec SDK Admin et émulateur Firestore réel ; pas de déploiement ni de vérification HTTP de Firebase Authentication ou App Check.',
  checks, firestoreTransactionsVerified: false, callableHttpVerified: false, productionVerified: false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const eventId = () => `event_${String(++sequence).padStart(12, '0')}`;
const invoke = (service, uid, kind, data = {}, id = eventId()) => service(uid, { id, kind, data });
const read = async path => (await db.doc(path).get()).data();
function check(label, operation) {
  test(label, { timeout: 20000 }, async () => { await operation(); checks.push(label); });
}
async function rejected(operation, code) {
  await assert.rejects(operation, error => error instanceof GameError && error.code === code);
}
async function fixture() {
  const prefix = `world_${String(++sequence).padStart(6, '0')}`;
  const users = Object.fromEntries(['alice', 'bruno', 'chloe'].map(name => [name, `${prefix}_${name}`]));
  let time = Date.UTC(2026, 10, 4, 12);
  const service = createGameService({ db, now: () => time });
  for (const [name, uid] of Object.entries(users)) await invoke(service, uid, 'register', { username: `Joueur_${name}` });
  return { service, users, advance: delta => { time += delta; }, time: () => time,
    profile: name => read(`players/${users[name]}`) };
}
async function list(world, type = 'fixed', overrides = {}) {
  const listingId = `listing_${String(++sequence).padStart(12, '0')}`;
  await invoke(world.service, world.users.alice, 'list', { listingId, cardId: 'red-fox', type,
    priceMilli: type === 'trade' ? 0 : 50000, wantedCardId: type === 'trade' ? 'rabbit' : '',
    durationSeconds: 300, ...overrides });
  return listingId;
}
function invariants(profile) {
  assert.equal(profile.ownedCount, CARDS.reduce((sum, card) => sum + profile.cards[card.id], 0));
  assert.equal(profile.incomeMilli, CARDS.reduce((sum, card) => sum + profile.cards[card.id] * card.income, 0));
  assert.equal(profile.luckMilliPercent, CARDS.reduce((sum, card) => sum + (profile.discoveries[card.id] ? card.luck : 0), 0));
  assert.ok(Number.isSafeInteger(profile.balanceMilli) && profile.balanceMilli >= 0 && profile.balanceMilli <= MAX_BALANCE);
  for (const card of CARDS) assert.ok(Number.isInteger(profile.available[card.id]) && profile.available[card.id] >= 0 && profile.available[card.id] <= profile.cards[card.id]);
}

before(async () => {
  await mkdir(new URL('.frst/', root), { recursive: true });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(JAR)) hash.update(chunk);
  assert.equal(hash.digest('hex'), '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${port}`;
  process.env.GCLOUD_PROJECT = PROJECT;
  assert.match(PROJECT, /^demo-/);
  emulator = spawn(JAVA, ['-Xmx512m', '-Duser.language=en', '-jar', JAR, '--host', '127.0.0.1',
    '--port', String(port), '--project_id', PROJECT, '--single_project_mode', 'true',
    '--single_project_mode_error', 'true', '--rules', RULES], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const log = chunk => { output = (output + chunk.toString()).slice(-240000); };
  emulator.stdout.on('data', log);
  emulator.stderr.on('data', log);
  emulator.on('error', error => { launchError = error; });
  closed = new Promise(resolve => emulator.once('close', (code, signal) => {
    childClosed = true; report.emulatorExit = { code, signal }; resolve();
  }));
  let ready = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (childClosed) throw new Error(`Émulateur arrêté : ${output}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(600) });
      await response.text(); ready = true; break;
    } catch { await sleep(120); }
  }
  assert.ok(ready, 'Démarrage de l’émulateur non confirmé');
  const compiled = await fetch(`${origin}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: await readFile(RULES, 'utf8') }] } }),
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(compiled.status, 200, await compiled.text());
  app = initializeApp({ projectId: PROJECT }, 'animal-cards-service-tests');
  db = getFirestore(app);
  report.emulatorOrigin = origin;
}, { timeout: 30000 });

after(async () => {
  try {
    if (db) await db.terminate();
    if (app) await deleteApp(app);
  } finally {
    if (emulator && !childClosed) {
      emulator.kill();
      let timer;
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
      clearTimeout(timer);
    }
    report.emulatorStopped = !emulator || childClosed;
    report.status = checks.length === expectedChecks && report.emulatorStopped ? 'passed' : 'failed';
    report.firestoreTransactionsVerified = report.status === 'passed';
    report.finishedAt = new Date().toISOString();
    report.checkCount = checks.length;
    await writeFile(new URL('.frst/functions-emulator-test.log', root), output);
    await writeFile(new URL('.frst/functions-test-result.json', root), JSON.stringify(report, null, 2));
    assert.ok(report.emulatorStopped, 'Arrêt de l’émulateur non confirmé');
  }
}, { timeout: 10000 });

check('Inscription atomique, profil initial et inscription répétée refusée', async () => {
  const world = await fixture();
  const profile = await world.profile('alice');
  assert.equal(profile.ownedCount, 4);
  assert.equal(profile.username, 'Joueur_alice');
  invariants(profile);
  await rejected(invoke(world.service, world.users.alice, 'register', { username: 'Autre_pseudo' }), 'failed-precondition');
  assert.deepEqual(await world.profile('alice'), profile);
});

check('Authentification et paramètres stricts sans autorité fournie par le client', async () => {
  const world = await fixture();
  const beforeProfile = await world.profile('alice');
  await rejected(invoke(world.service, null, 'claim'), 'unauthenticated');
  await rejected(world.service(world.users.alice, { id: eventId(), kind: 'claim', data: {}, actor: world.users.bruno }), 'invalid-argument');
  for (const data of [{ balanceMilli: 99999999 }, { at: world.time() + 86400000 }, { seed: 1 }]) {
    await rejected(invoke(world.service, world.users.alice, 'claim', data), 'invalid-argument');
  }
  await rejected(invoke(world.service, world.users.alice, 'reserve', { slot: 0, tier: 0, cards: ['red-fox'] }), 'invalid-argument');
  assert.deepEqual(await world.profile('alice'), beforeProfile);
});

check('Revenus calculés à l’heure serveur, délai et plafond de vingt-quatre heures', async () => {
  const world = await fixture();
  const initial = await world.profile('alice');
  await rejected(invoke(world.service, world.users.alice, 'claim'), 'failed-precondition');
  world.advance(60001);
  await invoke(world.service, world.users.alice, 'claim');
  const first = await world.profile('alice');
  assert.equal(first.balanceMilli, initial.balanceMilli + Math.floor(initial.incomeMilli * 60001 / 3600000));
  assert.equal(first.remainder, initial.incomeMilli * 60001 % 3600000);
  world.advance(3 * 86400000);
  await invoke(world.service, world.users.alice, 'claim');
  const last = await world.profile('alice');
  assert.equal(last.balanceMilli - first.balanceMilli, first.incomeMilli * 24);
  assert.equal(milliseconds(last.lastClaim), world.time());
  invariants(last);
});

check('Booster payé, tirage privé, ouverture unique et reprise après réponse perdue', async () => {
  const world = await fixture();
  const uid = world.users.alice;
  const initial = await world.profile('alice');
  const reserveId = eventId();
  const result = await invoke(world.service, uid, 'reserve', { slot: 0, tier: 0 }, reserveId);
  assert.deepEqual(result.revealed, []);
  const paid = await world.profile('alice');
  const pack = await read(`packSecrets/${reserveId}`);
  assert.equal(paid.balanceMilli, initial.balanceMilli - shopOffer(initial, 0).priceMilli);
  assert.equal(paid.pendingPack, reserveId);
  assert.equal(pack.cards.length, 4);
  assert.deepEqual((await read(`events/${reserveId}`)).result.revealed, []);
  assert.equal((await invoke(world.service, uid, 'reserve', { tier: 0, slot: 0 }, reserveId)).alreadyApplied, true);
  assert.deepEqual(await read(`packSecrets/${reserveId}`), pack);
  const openId = eventId();
  const opened = await invoke(world.service, uid, 'open', {}, openId);
  assert.deepEqual(opened.revealed, pack.cards);
  const profile = await world.profile('alice');
  assert.equal(profile.ownedCount, initial.ownedCount + 4);
  assert.equal(profile.pendingPack, '');
  assert.equal(await read(`packSecrets/${reserveId}`), undefined);
  assert.deepEqual(await invoke(world.service, uid, 'open', {}, openId), { ...opened, alreadyApplied: true });
  assert.deepEqual(await world.profile('alice'), profile);
  await rejected(invoke(world.service, uid, 'open'), 'failed-precondition');
  invariants(profile);
});

check('Offres de boutique périmées, faux niveaux et solde insuffisant refusés', async () => {
  const world = await fixture();
  const uid = world.users.alice;
  await rejected(invoke(world.service, uid, 'reserve', { slot: 0, tier: 6 }), 'failed-precondition');
  await rejected(invoke(world.service, uid, 'reserve', { slot: 6, tier: 0 }), 'invalid-argument');
  world.advance(SHOP_MS);
  await rejected(invoke(world.service, uid, 'reserve', { slot: 0, tier: 0 }), 'failed-precondition');
  await invoke(world.service, uid, 'refresh');
  const refreshed = await world.profile('alice');
  assert.equal(milliseconds(refreshed.shopAt), world.time());
  await rejected(invoke(world.service, uid, 'refresh'), 'failed-precondition');
  await db.doc(`players/${uid}`).update({ balanceMilli: 0 });
  const empty = await world.profile('alice');
  await rejected(invoke(world.service, uid, 'reserve', { slot: 0, tier: 0 }), 'failed-precondition');
  assert.deepEqual(await world.profile('alice'), empty);
});

check('Deux réservations concurrentes ne débitent qu’un booster', async () => {
  const world = await fixture();
  const initial = await world.profile('alice');
  const results = await Promise.allSettled([0, 1].map(() => invoke(world.service, world.users.alice, 'reserve', { slot: 0, tier: 0 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const profile = await world.profile('alice');
  assert.equal(profile.balanceMilli, initial.balanceMilli - shopOffer(initial, 0).priceMilli);
  assert.equal(profile.shopUsed[0], 1);
  const packs = await db.collection('packSecrets').where('actor', '==', world.users.alice).get();
  assert.equal(packs.size, 1);
});

check('Vente entre profils privés, paiement et carte transférés ensemble', async () => {
  const world = await fixture();
  const sellerBefore = await world.profile('alice'), buyerBefore = await world.profile('bruno');
  const listingId = await list(world);
  assert.equal((await world.profile('alice')).available['red-fox'], 0);
  const id = eventId();
  await invoke(world.service, world.users.bruno, 'buy', { listingId }, id);
  const seller = await world.profile('alice'), buyer = await world.profile('bruno');
  assert.equal(seller.balanceMilli, sellerBefore.balanceMilli + 50000);
  assert.equal(buyer.balanceMilli, buyerBefore.balanceMilli - 50000);
  assert.equal(seller.cards['red-fox'], 0);
  assert.equal(buyer.cards['red-fox'], 2);
  assert.equal((await read(`listings/${listingId}`)).status, 'sold');
  assert.equal((await invoke(world.service, world.users.bruno, 'buy', { listingId }, id)).alreadyApplied, true);
  assert.deepEqual(await world.profile('bruno'), buyer);
  invariants(seller); invariants(buyer);
});

check('Deux acheteurs concurrents produisent une seule vente sans perte de pièces', async () => {
  const world = await fixture();
  const initial = await Promise.all(Object.keys(world.users).map(name => world.profile(name)));
  const listingId = await list(world);
  const results = await Promise.allSettled(['bruno', 'chloe'].map(name => invoke(world.service, world.users[name], 'buy', { listingId })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const profiles = await Promise.all(Object.keys(world.users).map(name => world.profile(name)));
  assert.equal(profiles.reduce((sum, profile) => sum + profile.balanceMilli, 0), initial.reduce((sum, profile) => sum + profile.balanceMilli, 0));
  assert.equal(profiles.reduce((sum, profile) => sum + profile.cards['red-fox'], 0), 3);
  profiles.forEach(invariants);
});

check('Échange atomique et carte déjà réservée non réutilisable', async () => {
  const world = await fixture();
  const listingId = await list(world, 'trade');
  const lockedListing = `listing_${String(++sequence).padStart(12, '0')}`;
  await invoke(world.service, world.users.bruno, 'list', { listingId: lockedListing, cardId: 'rabbit', type: 'fixed', priceMilli: 1000, wantedCardId: '', durationSeconds: 300 });
  const beforeProfile = await world.profile('alice');
  await rejected(invoke(world.service, world.users.bruno, 'trade', { listingId }), 'failed-precondition');
  assert.deepEqual(await world.profile('alice'), beforeProfile);
  assert.equal((await read(`listings/${listingId}`)).status, 'active');
  await invoke(world.service, world.users.bruno, 'cancel', { listingId: lockedListing });
  await invoke(world.service, world.users.bruno, 'trade', { listingId });
  const seller = await world.profile('alice'), buyer = await world.profile('bruno');
  assert.equal(seller.cards.rabbit, 2); assert.equal(seller.cards['red-fox'], 0);
  assert.equal(buyer.cards.rabbit, 0); assert.equal(buyer.cards['red-fox'], 2);
  invariants(seller); invariants(buyer);
});

check('Enchères, surenchère différentielle, remboursement et clôture réservée aux participants', async () => {
  const world = await fixture();
  const listingId = await list(world, 'auction');
  const initial = await world.profile('bruno');
  await invoke(world.service, world.users.bruno, 'bid', { listingId, amountMilli: 50000 });
  await invoke(world.service, world.users.bruno, 'bid', { listingId, amountMilli: 60000 });
  assert.equal((await world.profile('bruno')).balanceMilli, initial.balanceMilli - 60000);
  await rejected(invoke(world.service, world.users.alice, 'cancel', { listingId }), 'failed-precondition');
  await invoke(world.service, world.users.chloe, 'bid', { listingId, amountMilli: 70000 });
  assert.equal((await world.profile('bruno')).balanceMilli, initial.balanceMilli);
  await rejected(invoke(world.service, world.users.bruno, 'settle', { listingId }), 'permission-denied');
  await rejected(invoke(world.service, world.users.alice, 'settle', { listingId }), 'failed-precondition');
  world.advance(300000);
  await invoke(world.service, world.users.alice, 'settle', { listingId });
  assert.equal((await world.profile('chloe')).cards['red-fox'], 2);
  assert.equal((await read(`listings/${listingId}`)).buyerId, world.users.chloe);
  const seller = await world.profile('alice');
  await rejected(invoke(world.service, world.users.chloe, 'settle', { listingId }), 'failed-precondition');
  assert.deepEqual(await world.profile('alice'), seller);
  invariants(seller); invariants(await world.profile('chloe'));
});

check('Annulation et expiration sans acheteur rendent la carte une seule fois', async () => {
  const world = await fixture();
  const listingId = await list(world);
  await rejected(invoke(world.service, world.users.bruno, 'cancel', { listingId }), 'failed-precondition');
  await invoke(world.service, world.users.alice, 'cancel', { listingId });
  assert.equal((await world.profile('alice')).available['red-fox'], 1);
  const auctionId = await list(world, 'auction');
  world.advance(300000);
  await invoke(world.service, world.users.alice, 'settle', { listingId: auctionId });
  assert.equal((await read(`listings/${auctionId}`)).status, 'expired');
  assert.equal((await world.profile('alice')).available['red-fox'], 1);
  await rejected(invoke(world.service, world.users.alice, 'settle', { listingId: auctionId }), 'failed-precondition');
});

check('Identifiant rejoué avec un autre auteur ou contenu refusé sans modification', async () => {
  const world = await fixture();
  const id = eventId();
  await invoke(world.service, world.users.alice, 'reserve', { slot: 0, tier: 0 }, id);
  const alice = await world.profile('alice'), bruno = await world.profile('bruno');
  await rejected(invoke(world.service, world.users.bruno, 'reserve', { slot: 0, tier: 0 }, id), 'already-exists');
  await rejected(invoke(world.service, world.users.alice, 'reserve', { slot: 1, tier: 0 }, id), 'already-exists');
  await rejected(invoke(world.service, world.users.alice, 'open', {}, id), 'already-exists');
  assert.deepEqual(await world.profile('alice'), alice);
  assert.deepEqual(await world.profile('bruno'), bruno);
});

check('Plafond monétaire atomique et identifiants de profil sans collision de prototype', async () => {
  const world = await fixture();
  await db.doc(`players/${world.users.alice}`).update({ balanceMilli: MAX_BALANCE });
  const beforeProfile = await world.profile('alice');
  world.advance(60000);
  const id = eventId();
  await rejected(invoke(world.service, world.users.alice, 'claim', {}, id), 'failed-precondition');
  assert.deepEqual(await world.profile('alice'), beforeProfile);
  assert.equal(await read(`events/${id}`), undefined);
  await rejected(invoke(world.service, '__proto__', 'register', { username: 'Profil_special' }), 'unauthenticated');
  await rejected(invoke(world.service, world.users.bruno, 'claim', {}, '__reserved__'), 'invalid-argument');
  await rejected(invoke(world.service, world.users.bruno, 'cancel', { listingId: '__reserved__' }), 'invalid-argument');
  await invoke(world.service, 'constructor', 'register', { username: 'Profil_special' });
  const special = await read('players/constructor');
  assert.equal(special.uid, 'constructor');
  invariants(special);
});
