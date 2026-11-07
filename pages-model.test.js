import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CARDS, RARITIES, STARTING_BALANCE } from './catalog.js';

const source = await readFile(new URL('./pages/game-model.js', import.meta.url), 'utf8');
assert.equal(source.split("from 'animal-catalog'").length, 2);
const resolvedSource = source.replace("from 'animal-catalog'", `from '${new URL('./catalog.js', import.meta.url).href}'`);
const model = await import(`data:text/javascript;base64,${Buffer.from(resolvedSource).toString('base64')}`);
const { transition, initialProfile, timestamp, milliseconds, shopOffer, drawReservedPack, accrue, STARTERS, SHOP_MS, MAX_BALANCE, MAX_CARDS } = model;
const start = Date.UTC(2026, 10, 3, 12);
let sequence = 0;
const eventId = () => `event_${String(++sequence).padStart(10, '0')}`;
const sum = (profiles, field) => Object.values(profiles).reduce((total, profile) => total + profile[field], 0);
function fixture() {
  return {
    at: timestamp(start),
    profiles: Object.fromEntries(['alice', 'bruno', 'chloe'].map(uid => [uid, initialProfile(uid, `Joueur_${uid}`, timestamp(start), eventId())])),
    listing: null
  };
}
function apply(world, kind, actor, data = {}, at = world.at, extra = {}) {
  const result = transition({ kind, actor, eventId: eventId(), data, at, profiles: world.profiles, listing: world.listing, ...extra });
  Object.assign(world.profiles, result.profiles);
  world.listing = result.listing;
  return result;
}
function list(world, type = 'fixed', overrides = {}) {
  apply(world, 'list', 'alice', { listingId: 'listing_00000001', cardId: 'red-fox', type, priceMilli: type === 'trade' ? 0 : 50_000, wantedCardId: type === 'trade' ? 'rabbit' : '', durationSeconds: 300, ...overrides });
  return world.listing;
}
function rejectWithoutMutation(world, operation, pattern) {
  const previous = structuredClone(world);
  assert.throws(operation, pattern);
  assert.deepEqual(world, previous);
}
function invariants(world) {
  for (const profile of Object.values(world.profiles)) {
    assert.equal(profile.ownedCount, CARDS.reduce((total, card) => total + profile.cards[card.id], 0));
    assert.equal(profile.incomeMilli, CARDS.reduce((total, card) => total + card.income * profile.cards[card.id], 0));
    assert.equal(profile.luckMilliPercent, CARDS.reduce((total, card) => total + (profile.discoveries[card.id] ? card.luck : 0), 0));
    assert.ok(Number.isSafeInteger(profile.balanceMilli) && profile.balanceMilli >= 0 && profile.balanceMilli <= MAX_BALANCE);
    assert.ok(profile.ownedCount <= MAX_CARDS);
    for (const card of CARDS) {
      assert.ok(Number.isInteger(profile.available[card.id]));
      assert.ok(profile.available[card.id] >= 0 && profile.available[card.id] <= profile.cards[card.id]);
    }
  }
}

test('Pages : inscription, quatre cartes initiales et bonus uniques', () => {
  const result = transition({ kind: 'register', actor: 'alice', eventId: eventId(), at: timestamp(start), data: { username: 'Écureuil_77' } });
  const profile = result.profiles.alice;
  assert.equal(profile.username, 'Écureuil_77');
  assert.equal(profile.ownedCount, 4);
  assert.equal(Object.keys(profile.cards).length, 56);
  assert.equal(Object.keys(profile.discoveries).length, 4);
  assert.equal(profile.balanceMilli, STARTING_BALANCE + STARTERS.reduce((total, id) => total + CARDS.find(card => card.id === id).reward, 0));
  assert.equal(profile.shopLuck, profile.luckMilliPercent);
  assert.equal(profile.pendingPack, '');
  assert.equal(result.listing, null);
  invariants({ profiles: result.profiles });
});

test('Pages : identifiants, pseudo et inscription existante refusés', () => {
  const world = fixture();
  rejectWithoutMutation(world, () => apply(world, 'register', 'alice', { username: 'Alice' }), /existe déjà/);
  rejectWithoutMutation(world, () => apply(world, 'register', 'nouveau', { username: '<script>' }), /pseudo/);
  assert.throws(() => transition({ kind: 'register', actor: '', eventId: eventId(), at: world.at, data: { username: 'Alice' } }), /Connexion/);
  assert.throws(() => transition({ kind: 'register', actor: 'nouveau', eventId: '../invalid', at: world.at, data: { username: 'Alice' } }), /Identifiant/);
  rejectWithoutMutation(world, () => apply(world, 'inconnue', 'alice'), /inconnue/);
});

test('Pages : six offres déterministes et renouvellement à cinq minutes', () => {
  const world = fixture();
  const profile = world.profiles.alice;
  const before = structuredClone(profile);
  const offers = Array.from({ length: 6 }, (_, slot) => shopOffer(profile, slot));
  assert.equal(offers[0].tier, 0);
  assert.deepEqual(offers, Array.from({ length: 6 }, (_, slot) => shopOffer(profile, slot)));
  for (const offer of offers) {
    assert.equal(offer.priceMilli, RARITIES[offer.tier].price * 1000);
    assert.equal(offer.stock, RARITIES[offer.tier].stock);
  }
  assert.deepEqual(profile, before);
  assert.throws(() => shopOffer(profile, 6), /Emplacement/);
  rejectWithoutMutation(world, () => apply(world, 'refresh', 'alice', {}, timestamp(start + SHOP_MS - 1)), /pas encore/);
  apply(world, 'refresh', 'alice', {}, timestamp(start + SHOP_MS));
  assert.equal(milliseconds(world.profiles.alice.shopAt), start + SHOP_MS);
  assert.deepEqual(world.profiles.alice.shopUsed, [0, 0, 0, 0, 0, 0]);
  invariants(world);
});

test('Pages : boosters déterministes, quatre cartes et rareté minimale', () => {
  for (let tier = 0; tier < 7; tier++) {
    for (let seed = 0; seed < 100; seed++) {
      const reservation = { kind: 'reserve', at: timestamp(start + seed * 7919), data: { tier } };
      const cards = drawReservedPack(reservation);
      assert.equal(cards.length, 4);
      assert.ok(cards.every(card => CARDS.includes(card)));
      assert.ok(cards[3].rarity >= tier);
      assert.deepEqual(cards, drawReservedPack(reservation));
    }
  }
  assert.throws(() => drawReservedPack({ kind: 'reserve', data: { tier: 7 } }), /invalide/);
});

test('Pages : réservation payée puis ouverture unique sans mutation des entrées', () => {
  const world = fixture();
  const before = world.profiles.alice;
  const oldCopy = structuredClone(before);
  const selected = shopOffer(before, 0);
  const id = eventId();
  apply(world, 'reserve', 'alice', { slot: 0, tier: selected.tier }, world.at, { eventId: id });
  assert.deepEqual(before, oldCopy);
  assert.equal(world.profiles.alice.balanceMilli, before.balanceMilli - selected.priceMilli);
  assert.equal(world.profiles.alice.shopUsed[0], 1);
  assert.equal(world.profiles.alice.pendingPack, id);
  assert.equal(world.profiles.alice.ownedCount, 4);
  rejectWithoutMutation(world, () => apply(world, 'reserve', 'alice', { slot: 0, tier: 0 }), /déjà acheté/);
  const reservation = { id, actor: 'alice', kind: 'reserve', at: world.at, data: { slot: 0, tier: 0 } };
  const drawn = drawReservedPack(reservation);
  apply(world, 'open', 'alice', {}, world.at, { reservation });
  assert.equal(world.profiles.alice.ownedCount, 8);
  assert.equal(world.profiles.alice.pendingPack, '');
  for (const card of CARDS) {
    assert.equal(world.profiles.alice.cards[card.id], before.cards[card.id] + drawn.filter(item => item.id === card.id).length);
  }
  rejectWithoutMutation(world, () => apply(world, 'open', 'alice', {}, world.at, { reservation }), /Aucun booster/);
  invariants(world);
});

test('Pages : refus des achats expirés, falsifiés, sans solde ou sans stock', () => {
  const expired = fixture();
  rejectWithoutMutation(expired, () => apply(expired, 'reserve', 'alice', { slot: 0, tier: 0 }, timestamp(start + SHOP_MS)), /renouvelée/);
  const altered = fixture();
  rejectWithoutMutation(altered, () => apply(altered, 'reserve', 'alice', { slot: 0, tier: 6 }), /offre a changé/);
  const poor = fixture();
  poor.profiles.alice.balanceMilli = 0;
  rejectWithoutMutation(poor, () => apply(poor, 'reserve', 'alice', { slot: 0, tier: 0 }), /assez de pièces/);
  const empty = fixture();
  empty.profiles.alice.shopUsed[0] = RARITIES[0].stock;
  rejectWithoutMutation(empty, () => apply(empty, 'reserve', 'alice', { slot: 0, tier: 0 }), /stock/);
});

test('Pages : revenus fractionnaires conservés, délai et plafond de vingt-quatre heures', () => {
  const profile = fixture().profiles.alice;
  const initial = profile.balanceMilli;
  const whole = structuredClone(profile);
  const split = structuredClone(profile);
  accrue(whole, timestamp(start + 3_600_000));
  for (let minute = 1; minute <= 60; minute++) accrue(split, timestamp(start + minute * 60_000));
  assert.equal(whole.balanceMilli, initial + profile.incomeMilli);
  assert.deepEqual(split, whole);
  const capped = structuredClone(profile);
  accrue(capped, timestamp(start + 3 * 86_400_000));
  assert.equal(capped.balanceMilli, initial + profile.incomeMilli * 24);
  const world = fixture();
  rejectWithoutMutation(world, () => apply(world, 'claim', 'alice', {}, timestamp(start + 59_999)), /une minute/);
  apply(world, 'claim', 'alice', {}, timestamp(start + 60_000));
  assert.equal(milliseconds(world.profiles.alice.lastClaim), start + 60_000);
  rejectWithoutMutation(world, () => apply(world, 'claim', 'alice', {}, timestamp(start + 60_000)), /une minute/);
  rejectWithoutMutation(world, () => apply(world, 'refresh', 'alice', {}, timestamp(start)), /horloge/);
  invariants(world);
});

test('Pages : vente réelle, réserve et conservation des pièces et des cartes', () => {
  const world = fixture();
  const money = sum(world.profiles, 'balanceMilli');
  const count = sum(world.profiles, 'ownedCount');
  const income = sum(world.profiles, 'incomeMilli');
  const listing = list(world);
  assert.equal(world.profiles.alice.available['red-fox'], 0);
  assert.equal(world.profiles.alice.cards['red-fox'], 1);
  apply(world, 'buy', 'bruno', { listingId: listing.id });
  assert.equal(world.listing.status, 'sold');
  assert.equal(world.listing.buyerId, 'bruno');
  assert.equal(world.profiles.alice.cards['red-fox'], 0);
  assert.equal(world.profiles.bruno.cards['red-fox'], 2);
  assert.equal(world.profiles.alice.discoveries['red-fox'], true);
  assert.equal(sum(world.profiles, 'balanceMilli'), money);
  assert.equal(sum(world.profiles, 'ownedCount'), count);
  assert.equal(sum(world.profiles, 'incomeMilli'), income);
  rejectWithoutMutation(world, () => apply(world, 'buy', 'chloe', { listingId: listing.id }), /plus disponible/);
  invariants(world);
});

test('Pages : transfert sans revenu rétroactif pour l’acheteur', () => {
  const world = fixture();
  const listing = list(world, 'fixed', { durationSeconds: 7200 });
  const seller = structuredClone(world.profiles.alice);
  const buyer = structuredClone(world.profiles.bruno);
  apply(world, 'buy', 'bruno', { listingId: listing.id }, timestamp(start + 3_600_000));
  assert.equal(world.profiles.alice.balanceMilli, seller.balanceMilli + seller.incomeMilli + listing.priceMilli);
  assert.equal(world.profiles.bruno.balanceMilli, buyer.balanceMilli + buyer.incomeMilli - listing.priceMilli);
  invariants(world);
});

test('Pages : annulation par le propriétaire, prix valides et carte non duplicable', () => {
  const world = fixture();
  rejectWithoutMutation(world, () => list(world, 'fixed', { priceMilli: -1000 }), /Prix/);
  rejectWithoutMutation(world, () => list(world, 'fixed', { durationSeconds: 299 }), /durée/);
  const listing = list(world);
  rejectWithoutMutation(world, () => apply(world, 'cancel', 'bruno', { listingId: listing.id }), /annulée/);
  rejectWithoutMutation(world, () => apply(world, 'buy', 'alice', { listingId: listing.id }), /appartient/);
  rejectWithoutMutation(world, () => apply(world, 'list', 'alice', { listingId: 'listing_00000002', cardId: 'red-fox' }, world.at, { listing: null }), /disponible/);
  apply(world, 'cancel', 'alice', { listingId: listing.id });
  assert.equal(world.listing.status, 'cancelled');
  assert.equal(world.profiles.alice.available['red-fox'], 1);
  invariants(world);
});

test('Pages : échange atomique de deux espèces et Index permanent', () => {
  const world = fixture();
  const money = sum(world.profiles, 'balanceMilli');
  const listing = list(world, 'trade');
  apply(world, 'trade', 'bruno', { listingId: listing.id });
  assert.equal(world.listing.status, 'accepted');
  assert.equal(world.profiles.alice.cards['red-fox'], 0);
  assert.equal(world.profiles.alice.cards.rabbit, 2);
  assert.equal(world.profiles.bruno.cards['red-fox'], 2);
  assert.equal(world.profiles.bruno.cards.rabbit, 0);
  assert.equal(world.profiles.bruno.discoveries.rabbit, true);
  assert.equal(sum(world.profiles, 'balanceMilli'), money);
  assert.equal(sum(world.profiles, 'ownedCount'), 12);
  invariants(world);
});

test('Pages : échange refusé si la carte demandée est déjà réservée', () => {
  const world = fixture();
  const listing = list(world, 'trade');
  world.profiles.bruno.available.rabbit = 0;
  rejectWithoutMutation(world, () => apply(world, 'trade', 'bruno', { listingId: listing.id }), /réservée/);
  assert.equal(world.listing.status, 'active');
});

test('Pages : enchère, réserve des fonds, surenchère et remboursement', () => {
  const world = fixture();
  const listing = list(world, 'auction');
  const bruno = world.profiles.bruno.balanceMilli;
  const chloe = world.profiles.chloe.balanceMilli;
  apply(world, 'bid', 'bruno', { listingId: listing.id, amountMilli: 50_000 });
  assert.equal(world.profiles.bruno.balanceMilli, bruno - 50_000);
  apply(world, 'bid', 'bruno', { listingId: listing.id, amountMilli: 51_000 });
  assert.equal(world.profiles.bruno.balanceMilli, bruno - 51_000);
  apply(world, 'bid', 'chloe', { listingId: listing.id, amountMilli: 52_000 });
  assert.equal(world.profiles.bruno.balanceMilli, bruno);
  assert.equal(world.profiles.chloe.balanceMilli, chloe - 52_000);
  assert.equal(world.listing.bidderId, 'chloe');
  rejectWithoutMutation(world, () => apply(world, 'cancel', 'alice', { listingId: listing.id }), /annulée/);
  rejectWithoutMutation(world, () => apply(world, 'bid', 'bruno', { listingId: listing.id, amountMilli: 52_999 }), /insuffisant/);
  rejectWithoutMutation(world, () => apply(world, 'bid', 'alice', { listingId: listing.id, amountMilli: 60_000 }), /appartient/);
  invariants(world);
});

test('Pages : clôture unique à expiration et absence de production rétroactive', () => {
  const world = fixture();
  const listing = list(world, 'auction');
  apply(world, 'bid', 'bruno', { listingId: listing.id, amountMilli: 50_000 });
  const before = structuredClone(world.profiles);
  rejectWithoutMutation(world, () => apply(world, 'settle', 'chloe', { listingId: listing.id }, timestamp(start + 299_999)), /pas encore/);
  apply(world, 'settle', 'chloe', { listingId: listing.id }, listing.endsAt);
  assert.equal(world.listing.status, 'sold');
  assert.equal(world.profiles.alice.cards['red-fox'], 0);
  assert.equal(world.profiles.bruno.cards['red-fox'], 2);
  assert.equal(world.profiles.bruno.balanceMilli, before.bruno.balanceMilli + Math.floor(before.bruno.incomeMilli / 12));
  assert.equal(world.profiles.alice.balanceMilli, before.alice.balanceMilli + Math.floor(before.alice.incomeMilli / 12) + 50_000);
  assert.equal(world.profiles.chloe.revision, before.chloe.revision);
  rejectWithoutMutation(world, () => apply(world, 'settle', 'chloe', { listingId: listing.id }, listing.endsAt), /plus disponible/);
  invariants(world);
});

test('Pages : enchère sans acheteur et plafonds sans modification partielle', () => {
  const world = fixture();
  const listing = list(world, 'auction');
  apply(world, 'settle', 'bruno', { listingId: listing.id }, listing.endsAt);
  assert.equal(world.listing.status, 'expired');
  assert.equal(world.profiles.alice.available['red-fox'], 1);
  invariants(world);
  const rich = fixture();
  rich.profiles.alice.balanceMilli = MAX_BALANCE;
  rejectWithoutMutation(rich, () => apply(rich, 'claim', 'alice', {}, timestamp(start + 3_600_000)), /plafond/);
  const full = fixture();
  full.profiles.bruno.ownedCount = MAX_CARDS;
  const offer = list(full);
  rejectWithoutMutation(full, () => apply(full, 'buy', 'bruno', { listingId: offer.id }), /capacité/);
});
