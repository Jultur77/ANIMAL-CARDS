import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { GameStore, GameError } from './store.js';
import { createGameServer, hashPassword, verifyPassword } from './server.js';
import { CARDS, RARITIES, SHOP_MS, shopProbabilities, drawPack } from './catalog.js';

function fixture(t) {
  let now = 1_800_000_000_000;
  const store = new GameStore(':memory:', { now: () => now });
  t.after(() => store.close());
  const alice = store.createUser('Alice', 'test-hash');
  const bob = store.createUser('Bob', 'test-hash');
  const clara = store.createUser('Clara', 'test-hash');
  const act = (id, kind, data, key = randomUUID()) => store.action(id, key, kind, data);
  const item = (id, cardId = 'red-fox') => store.one("SELECT id FROM inventory WHERE owner_id = ? AND card_id = ? AND locked = ''", id, cardId).id;
  const balance = id => store.one('SELECT balance FROM users WHERE id = ?', id).balance;
  return { store, alice, bob, clara, act, item, balance, advance: ms => { now += ms; }, time: () => now };
}

test('catalogue complet, raretés ordonnées et probabilités normalisées', () => {
  assert.equal(CARDS.length, 56);
  assert.equal(new Set(CARDS.map(c => c.id)).size, 56);
  assert.equal(RARITIES.length, 7);
  assert.deepEqual(CARDS.map(c => c.rarity), [...CARDS.map(c => c.rarity)].sort((a, b) => a - b));
  for (const luck of [0, 1, 5000, 100000]) {
    const probabilities = shopProbabilities(luck);
    assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    assert.ok(probabilities.every(p => p > 0));
  }
  const low = shopProbabilities(0);
  const high = shopProbabilities(5000);
  assert.ok(high[0] < low[0]);
  assert.ok(high[6] > low[6]);
  assert.ok(high.slice(4).reduce((a, b) => a + b) > low.slice(4).reduce((a, b) => a + b));
});

test('chaque booster contient quatre cartes et une rareté minimale garantie', () => {
  for (let tier = 0; tier < 7; tier++) {
    for (let repeat = 0; repeat < 40; repeat++) {
      const cards = drawPack(tier);
      assert.equal(cards.length, 4);
      assert.ok(cards.every(card => CARDS.some(c => c.id === card.id)));
      assert.ok(cards[3].rarity >= tier);
    }
  }
});

test('inscription sans joueurs artificiels et découverte unique', t => {
  const { store, alice, balance } = fixture(t);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM users').n, 3);
  assert.equal(store.state(alice).inventory.length, 4);
  assert.equal(store.state(alice).discoveredIds.length, 4);
  assert.equal(store.luck(alice), 8);
  const initial = balance(alice);
  assert.equal(store.discover(alice, 'red-fox'), null);
  assert.equal(balance(alice), initial);
  assert.throws(() => store.createUser('alice', 'test'), GameError);
  assert.throws(() => store.createUser('<script>', 'test'), GameError);
});

test('boutique personnelle persistante, stock limité et renouvellement de cinq minutes', t => {
  const { store, alice, bob, act, advance, balance } = fixture(t);
  const first = store.state(alice);
  const second = store.state(alice);
  assert.deepEqual(first.shop, second.shop);
  assert.equal(first.shop.offers.length, 6);
  assert.equal(first.shop.expiresAt % SHOP_MS, 0);
  assert.notDeepEqual(first.shop.offers.map(o => o.id), store.state(bob).shop.offers.map(o => o.id));
  const offer = first.shop.offers.find(o => o.rarity === 0);
  const before = balance(alice);
  const opened = act(alice, 'buy-pack', { offerId: offer.id });
  assert.equal(opened.cards.length, 4);
  assert.equal(store.state(alice).inventory.length, 8);
  assert.equal(store.one('SELECT stock FROM offers WHERE id = ?', offer.id).stock, offer.stock - 1);
  const rewards = opened.cards.reduce((sum, c) => sum + (c.discovery?.rewardMilli || 0), 0);
  assert.equal(balance(alice), before - offer.priceMilli + rewards);
  assert.throws(() => act(bob, 'buy-pack', { offerId: offer.id }), GameError);
  advance(SHOP_MS);
  const next = store.state(alice);
  assert.notEqual(next.shop.offers[0].id, first.shop.offers[0].id);
  assert.throws(() => act(alice, 'buy-pack', { offerId: offer.id }), GameError);
});

test('idempotence : un achat répété ne retire pas deux fois l’argent et ne duplique pas les cartes', t => {
  const { store, alice, act, balance } = fixture(t);
  const offer = store.state(alice).shop.offers.find(o => o.rarity === 0);
  const key = randomUUID();
  const data = { offerId: offer.id };
  const result = act(alice, 'buy-pack', data, key);
  const after = balance(alice);
  assert.deepEqual(act(alice, 'buy-pack', data, key), result);
  assert.equal(balance(alice), after);
  assert.equal(store.state(alice).inventory.length, 8);
  assert.throws(() => act(alice, 'buy-pack', { offerId: 'different' }, key), GameError);
});

test('échec financier : rollback de l’argent, des stocks et de l’inventaire', t => {
  const { store, alice, act, balance } = fixture(t);
  const offer = store.state(alice).shop.offers[0];
  store.run('UPDATE users SET balance = 0 WHERE id = ?', alice);
  assert.throws(() => act(alice, 'buy-pack', { offerId: offer.id }), /Solde insuffisant/);
  assert.equal(balance(alice), 0);
  assert.equal(store.one('SELECT stock FROM offers WHERE id = ?', offer.id).stock, offer.stock);
  assert.equal(store.state(alice).inventory.length, 4);
});

test('revenus passifs modestes, fractionnaires, sans double collecte et plafonnés à 24 heures', t => {
  const { store, alice, balance, advance } = fixture(t);
  const initial = balance(alice);
  const rate = store.incomeRate(alice);
  advance(3_600_000);
  store.state(alice);
  assert.equal(balance(alice), initial + rate);
  store.state(alice);
  assert.equal(balance(alice), initial + rate);
  advance(72 * 3_600_000);
  store.state(alice);
  assert.equal(balance(alice), initial + rate * 25);
  assert.ok(rate / 1000 < 10);
});

test('vente réelle : transfert unique, conservation monétaire et index permanent', t => {
  const { store, alice, bob, clara, act, item, balance } = fixture(t);
  const id = item(alice);
  const { id: listingId } = act(alice, 'list', { itemId: id, kind: 'fixed', price: 200 });
  const total = balance(alice) + balance(bob);
  assert.throws(() => act(alice, 'trade', { itemId: id, wantedCardId: 'lion' }), /réservée/);
  assert.throws(() => act(alice, 'buy', { listingId }), /propre carte/);
  act(bob, 'buy', { listingId });
  assert.equal(store.one('SELECT owner_id, locked FROM inventory WHERE id = ?', id).owner_id, bob);
  assert.equal(balance(alice) + balance(bob), total);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM sales').n, 1);
  assert.ok(store.state(alice).discoveredIds.includes('red-fox'));
  assert.throws(() => act(clara, 'buy', { listingId }), /plus disponible/);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM inventory').n, 12);
});

test('annulation de vente et protections de propriété et de prix', t => {
  const { store, alice, bob, act, item } = fixture(t);
  const id = item(alice);
  for (const price of [-1, 0, 1.5, '100', Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => act(alice, 'list', { itemId: id, kind: 'fixed', price }), GameError);
  }
  assert.throws(() => act(bob, 'list', { itemId: id, kind: 'fixed', price: 100 }), /appartient/);
  const { id: listingId } = act(alice, 'list', { itemId: id, kind: 'fixed', price: 100 });
  assert.throws(() => act(bob, 'cancel-listing', { listingId }), GameError);
  act(alice, 'cancel-listing', { listingId });
  assert.equal(store.one('SELECT locked FROM inventory WHERE id = ?', id).locked, '');
});

test('enchères : réserve, remboursement, augmentation et clôture automatique', t => {
  const { store, alice, bob, clara, act, item, balance, advance } = fixture(t);
  const id = item(alice);
  const { id: listingId } = act(alice, 'list', { itemId: id, kind: 'auction', price: 100, durationMinutes: 5 });
  const bobInitial = balance(bob);
  const claraInitial = balance(clara);
  const sellerInitial = balance(alice);
  act(bob, 'bid', { listingId, amount: 100 });
  assert.equal(balance(bob), bobInitial - 100_000);
  assert.throws(() => act(clara, 'bid', { listingId, amount: 101 }), /minimale/);
  assert.throws(() => act(alice, 'cancel-listing', { listingId }), /annulée/);
  act(clara, 'bid', { listingId, amount: 110 });
  assert.equal(balance(bob), bobInitial);
  assert.equal(balance(clara), claraInitial - 110_000);
  act(clara, 'bid', { listingId, amount: 120 });
  assert.equal(balance(clara), claraInitial - 120_000);
  advance(300_001);
  assert.equal(store.settleDue(), 1);
  assert.equal(store.one('SELECT owner_id FROM inventory WHERE id = ?', id).owner_id, clara);
  assert.ok(balance(alice) >= sellerInitial + 120_000);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM sales').n, 1);
  assert.equal(store.settleDue(), 0);
  assert.throws(() => act(bob, 'bid', { listingId, amount: 140 }), /terminée/);
});

test('enchère sans offre : carte libérée après expiration', t => {
  const { store, alice, act, item, advance } = fixture(t);
  const id = item(alice);
  act(alice, 'list', { itemId: id, kind: 'auction', price: 100, durationMinutes: 5 });
  advance(300_001);
  store.settleDue();
  assert.equal(store.one('SELECT locked FROM inventory WHERE id = ?', id).locked, '');
  assert.equal(store.one('SELECT COUNT(*) AS n FROM sales').n, 0);
});

test('échange atomique de deux exemplaires : carte exigée, verrous et absence de duplication', t => {
  const { store, alice, bob, clara, act, item } = fixture(t);
  const offered = item(alice, 'red-fox');
  const received = item(bob, 'rabbit');
  const { id: tradeId } = act(alice, 'trade', { itemId: offered, wantedCardId: 'rabbit' });
  assert.throws(() => act(alice, 'accept-trade', { tradeId, itemId: item(alice, 'rabbit') }), /propre échange/);
  assert.throws(() => act(bob, 'accept-trade', { tradeId, itemId: item(bob, 'clownfish') }), /correspond/);
  assert.throws(() => act(alice, 'list', { itemId: offered, kind: 'fixed', price: 10 }), /réservée/);
  act(bob, 'accept-trade', { tradeId, itemId: received });
  assert.equal(store.one('SELECT owner_id FROM inventory WHERE id = ?', offered).owner_id, bob);
  assert.equal(store.one('SELECT owner_id FROM inventory WHERE id = ?', received).owner_id, alice);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM inventory').n, 12);
  assert.throws(() => act(clara, 'accept-trade', { tradeId, itemId: item(clara, 'rabbit') }), /plus disponible/);
});

test('annuler un échange libère uniquement la carte du créateur', t => {
  const { store, alice, bob, act, item } = fixture(t);
  const offered = item(alice);
  const { id: tradeId } = act(alice, 'trade', { itemId: offered, wantedCardId: 'lion' });
  assert.throws(() => act(bob, 'cancel-trade', { tradeId }), GameError);
  act(alice, 'cancel-trade', { tradeId });
  assert.equal(store.one('SELECT locked FROM inventory WHERE id = ?', offered).locked, '');
});

test('marché vide honnête, recherche, filtres, pagination et historique réels', t => {
  const { store, alice, bob, act, item } = fixture(t);
  assert.equal(store.market({}, alice).total, 0);
  const { id } = act(alice, 'list', { itemId: item(alice), kind: 'fixed', price: 100 });
  assert.equal(store.market({ search: 'renard', rarity: '0' }, alice).total, 1);
  assert.equal(store.market({ search: 'lion' }, alice).total, 0);
  assert.equal(store.market({ mine: true }, bob).total, 0);
  assert.equal(store.market({ page: 1 }, alice).entries.length, 0);
  act(bob, 'buy', { listingId: id });
  const history = store.market({ type: 'history' }, alice);
  assert.equal(history.total, 1);
  assert.equal(history.entries[0].buyer, 'Bob');
  assert.equal(history.entries[0].seller, 'Alice');
});

test('sessions opaques, expiration et déconnexion', t => {
  const { store, alice, advance } = fixture(t);
  const session = store.newSession(alice);
  assert.equal(store.session(session.token).userId, alice);
  assert.notEqual(store.one('SELECT token_hash FROM sessions').token_hash, session.token);
  assert.equal(store.session('invalid'), undefined);
  store.endSession(session.token);
  assert.equal(store.session(session.token), undefined);
  const other = store.newSession(alice);
  advance(8 * 86_400_000);
  assert.equal(store.session(other.token), undefined);
});

test('sauvegarde SQLite sur disque après fermeture et réouverture', () => {
  mkdirSync('.frst/test-data', { recursive: true });
  const path = `.frst/test-data/${randomUUID()}.sqlite`;
  let store = new GameStore(path);
  const id = store.createUser('Persistent', 'test');
  const before = store.state(id);
  store.close();
  store = new GameStore(path);
  try {
    const after = store.state(id);
    assert.deepEqual(after.inventory, before.inventory);
    assert.deepEqual(after.discoveredIds, before.discoveredIds);
    assert.equal(after.user.luckMilliPercent, before.user.luckMilliPercent);
    assert.deepEqual(after.shop, before.shop);
  } finally { store.close(); }
});

test('mots de passe scrypt salés et comparaison fiable', async () => {
  const password = 'test-password-long-and-unique';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('incorrect-long-password', first), false);
  assert.equal(await verifyPassword(password, undefined), false);
});

test('API complète : comptes, CSRF, accès privé et achat concurrent', async t => {
  const { server, store } = createGameServer({ dbPath: ':memory:', secure: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, data, session = {}, extra = {}) {
    const response = await fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Animal-Client': '1', ...(session.cookie ? { Cookie: session.cookie } : {}), ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}), ...extra },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/session')).body.authenticated, false);
  const password = 'Browser-test-password-2026';
  const registered = [];
  for (const username of ['HttpAlice', 'HttpBob', 'HttpClara']) {
    const res = await request('/api/register', { username, password });
    assert.equal(res.status, 201);
    assert.ok(res.headers.get('set-cookie').includes('HttpOnly'));
    registered.push({ cookie: res.cookie, csrf: res.body.csrf, id: res.body.state.user.id, state: res.body.state });
  }
  const [alice, bob, clara] = registered;
  assert.equal((await request('/api/login', { username: 'HttpAlice', password: 'wrong-password-long' })).status, 401);
  assert.equal((await request('/api/login', { username: 'HttpAlice', password })).status, 200);
  assert.equal((await request('/api/state', undefined, bob)).status, 200);
  assert.equal((await request('/api/action', { key: randomUUID(), kind: 'list', data: {} }, { cookie: bob.cookie })).status, 403);
  assert.equal((await request('/api/logout', {}, bob, { Origin: 'https://evil.example' })).status, 403);
  const listing = await request('/api/action', { key: randomUUID(), kind: 'list', data: { itemId: alice.state.inventory[0].id, kind: 'fixed', price: 50 } }, alice);
  assert.equal(listing.status, 200);
  const listingId = listing.body.result.id;
  const attempts = await Promise.all([bob, clara].map(session => request('/api/action', { key: randomUUID(), kind: 'buy', data: { listingId } }, session)));
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM sales').n, 1);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM inventory').n, 12);
  assert.equal((await request('/api/logout', {}, bob)).status, 200);
  assert.equal((await request('/api/state', undefined, bob)).status, 401);
  const secret = await fetch(base + '/store.js');
  assert.equal(secret.status, 404);
  assert.ok(secret.headers.get('content-security-policy').includes("object-src 'none'"));
});
