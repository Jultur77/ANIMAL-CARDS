// Tests du schéma SQL sur un vrai PostgreSQL (PGlite, WebAssembly).
// auth.uid() et les rôles Supabase sont simulés ; tout le reste est le SQL réel.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

async function as(uid, sql, params = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return (await db.query(sql, params)).rows; }
  finally { await db.exec('reset role;'); }
}
const rpc = async (uid, sql, params) => Object.values((await as(uid, sql, params))[0] ?? {})[0];
const admin = async (sql, params = []) => (await db.query(sql, params)).rows;
const balance = async uid => Number((await admin('select balance from profiles where id = $1', [uid]))[0].balance);
const rejects = (promise, pattern) => assert.rejects(promise, pattern);

before(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    insert into auth.users values ('${A}'), ('${B}'), ('${C}');`);
  await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8'));
  await db.exec(`grant execute on function auth.uid() to anon, authenticated;`);
});

test('catalogue : 126 cartes, 7 raretés', async () => {
  const rows = await admin('select rarity, count(*)::int n from cards group by rarity order by rarity');
  assert.deepEqual(rows.map(r => r.n), [30, 26, 22, 18, 14, 10, 6]);
});

test('création des profils, pseudo unique, cartes de départ', async () => {
  assert.equal((await rpc(A, `select create_profile('Alice')`)).created, true);
  assert.equal((await rpc(B, `select create_profile('Bob')`)).created, true);
  await rejects(rpc(C, `select create_profile('alice')`), /déjà pris/);
  await rejects(rpc(C, `select create_profile('<script>')`), /pseudo/);
  assert.equal((await rpc(C, `select create_profile('Chloe')`)).created, true);
  const n = await admin(`select count(*)::int n from card_instances where owner_id = $1`, [A]);
  assert.equal(n[0].n, 3);
  assert.ok(await balance(A) >= 1500);
});

test('client modifié : aucune écriture directe ni fonction interne', async () => {
  await rejects(as(A, `update profiles set balance = 999999999 where id = '${A}'`), /permission denied/);
  await rejects(as(A, `insert into card_instances (card_id, owner_id, origin) values ('lion', '${A}', 'booster')`), /permission denied/);
  await rejects(as(A, `update card_instances set owner_id = '${A}'`), /permission denied/);
  await rejects(as(A, `delete from listings`), /permission denied/);
  await rejects(as(A, `insert into discoveries values ('${A}', 'tyrannosaurus', 5, 0, now())`), /permission denied/);
  await rejects(as(A, `select _grant_card('${A}', 'tyrannosaurus', 'booster')`), /permission denied/);
  await rejects(as(A, `select _add_money('${A}', 1000000)`), /permission denied/);
  await rejects(as(A, `select settle_due_listings(10)`), /permission denied/);
  await rejects(as(A, `select balance from profiles`), /permission denied/);
  await rejects(as(A, `select * from rate_limits`), /permission denied/);
  const others = await as(A, `select * from card_instances where owner_id = '${B}'`);
  assert.equal(others.length, 0, 'les cartes des autres sont invisibles');
  const names = await as(A, `select username from profiles order by username`);
  assert.deepEqual(names.map(r => r.username), ['Alice', 'Bob', 'Chloe']);
});

test('boutique : 6 offres, slot 0 commun, achat idempotent (double requête)', async () => {
  const state = await rpc(A, `select get_state()`);
  assert.equal(state.shop.length, 6);
  assert.equal(state.shop[0].tier, 0);
  await admin(`update profiles set balance = 1000000 where id = $1`, [A]);
  await admin(`update shop_offers set stock = 5, price = 100 where player_id = $1 and slot = 0`, [A]);
  const before = (await admin(`select count(*)::int n from card_instances where owner_id = $1`, [A]))[0].n;
  const req = 'aaaaaaaa-0000-4000-8000-000000000001';
  const first = await rpc(A, `select buy_booster(0, $1)`, [req]);
  const second = await rpc(A, `select buy_booster(0, $1)`, [req]);
  assert.equal(first.cards.length, 5);
  assert.equal(second.already_applied, true);
  assert.deepEqual(second.cards, first.cards);
  const after = (await admin(`select count(*)::int n from card_instances where owner_id = $1`, [A]))[0].n;
  assert.equal(after - before, 5, 'un seul booster ouvert');
  assert.equal((await admin(`select stock from shop_offers where player_id = $1 and slot = 0`, [A]))[0].stock, 4);
});

test('boutique : stock épuisé, solde insuffisant, slot inexistant', async () => {
  await admin(`update shop_offers set stock = 1 where player_id = $1 and slot = 0`, [A]);
  await rpc(A, `select buy_booster(0, gen_random_uuid())`);
  await rejects(rpc(A, `select buy_booster(0, gen_random_uuid())`), /épuisé/);
  await rejects(rpc(A, `select buy_booster(9, gen_random_uuid())`), /n'existe pas/);
  await rpc(B, `select get_state()`);
  await admin(`update profiles set balance = 0 where id = $1`, [B]);
  await rejects(rpc(B, `select buy_booster(0, gen_random_uuid())`), /assez de pièces/);
});

test('boutique : renouvellement après 5 min, même après une longue absence', async () => {
  const gen = async () => (await admin(`select shop_generation g from profiles where id = $1`, [A]))[0].g;
  const g0 = await gen();
  await rpc(A, `select get_state()`);
  assert.equal(await gen(), g0, 'pas de renouvellement avant l’échéance');
  await admin(`update profiles set shop_next_refresh_at = now() - interval '3 days' where id = $1`, [A]);
  await rejects(rpc(A, `select buy_booster(1, gen_random_uuid())`), /renouveler/);
  const state = await rpc(A, `select get_state()`);
  assert.equal(await gen(), g0 + 1);
  const next = new Date(state.profile.shop_next_refresh_at) - new Date(state.server_now);
  assert.ok(Math.abs(next - 300000) < 2000, 'prochaine échéance dans 5 minutes');
});

test('bonus de chance : modifie réellement les probabilités', async () => {
  const p0 = (await admin(`select _shop_probabilities(0) p`))[0].p.map(Number);
  const pMax = (await admin(`select _shop_probabilities(59.27) p`))[0].p.map(Number);
  console.log('  Boutique sans chance :', p0.map(x => (x * 100).toFixed(3) + '%').join(' '));
  console.log('  Boutique chance max   :', pMax.map(x => (x * 100).toFixed(3) + '%').join(' '));
  assert.ok(pMax[6] > p0[6] * 3 && pMax[6] < 0.02, 'secret plus fréquent mais toujours rare');
  assert.ok(pMax[0] < p0[0]);
  // Vérification statistique du tirage réel côté serveur
  const draw = async luck => (await admin(`select count(*) filter (where t >= 4)::int n from
     (select _pick(_luck_weights((select array_agg(shop_weight order by id) from rarities), ${luck}, 2)) t
      from generate_series(1, 20000)) s`))[0].n;
  const low = await draw(0), high = await draw(59.27);
  console.log(`  Tirages légendaire+ sur 20000 : sans chance ${low}, chance max ${high}`);
  assert.ok(high > low * 1.5);
  // La découverte augmente la chance du joueur
  const luck = Number((await admin(`select luck from profiles where id = $1`, [A]))[0].luck);
  const sum = Number((await admin(`select sum(luck_gained) s from discoveries where player_id = $1`, [A]))[0].s);
  assert.equal(luck, sum);
});

async function freeInstance(uid) {
  return (await admin(`select id, card_id from card_instances where owner_id = $1 and lock_id is null order by acquired_at limit 1`, [uid]))[0];
}

test('vente à prix fixe : achat, double achat, propre annonce, annulation', async () => {
  const card = await freeInstance(A);
  await rejects(rpc(A, `select create_listing($1, 'fixed', 0, 60)`, [card.id]), /prix/);
  await rejects(rpc(B, `select create_listing($1, 'fixed', 100, 60)`, [card.id]), /appartient pas/);
  const id = await rpc(A, `select create_listing($1, 'fixed', 100, 60)`, [card.id]);
  await rejects(rpc(A, `select create_listing($1, 'auction', 100, 60)`, [card.id]), /déjà en vente/);
  await rejects(rpc(A, `select create_trade($1, 'lion')`, [card.id]), /déjà en vente/);
  await rejects(rpc(A, `select buy_listing($1)`, [id]), /propre annonce/);
  await admin(`update profiles set balance = 1000 where id in ($1, $2)`, [B, C]);
  const a0 = await balance(A);
  const bought = await rpc(B, `select buy_listing($1)`, [id]);
  await rejects(rpc(C, `select buy_listing($1)`, [id]), /Trop tard/);  // 2e acheteur
  await rejects(rpc(B, `select buy_listing($1)`, [id]), /Trop tard/);  // double clic
  assert.equal(await balance(B), 900 + bought.reward, 'payé une seule fois (+ récompense de découverte éventuelle)');
  assert.equal(await balance(C), 1000);
  assert.equal(await balance(A) - a0, 95, 'vendeur payé moins 5 % de taxe');
  const owner = await admin(`select owner_id, lock_id from card_instances where id = $1`, [card.id]);
  assert.equal(owner[0].owner_id, B);
  assert.equal(owner[0].lock_id, null);
  // annulation
  const card2 = await freeInstance(A);
  const id2 = await rpc(A, `select create_listing($1, 'fixed', 50, 60)`, [card2.id]);
  await rejects(rpc(B, `select cancel_listing($1)`, [id2]), /introuvable/);
  await rpc(A, `select cancel_listing($1)`, [id2]);
  assert.equal((await admin(`select lock_id from card_instances where id = $1`, [card2.id]))[0].lock_id, null);
  await rejects(rpc(B, `select buy_listing($1)`, [id2]), /Trop tard/);
});

test('enchères : séquestre, surenchère, remboursement, clôture', async () => {
  const card = await freeInstance(A);
  const id = await rpc(A, `select create_listing($1, 'auction', 50, 5)`, [card.id]);
  await admin(`update profiles set balance = 1000 where id in ($1, $2)`, [B, C]);
  await rejects(rpc(A, `select place_bid($1, 60)`, [id]), /propre carte/);
  await rejects(rpc(B, `select place_bid($1, 49)`, [id]), /minimale/);
  await rpc(B, `select place_bid($1, 50)`, [id]);
  assert.equal(await balance(B), 950, 'argent bloqué');
  await rejects(rpc(B, `select place_bid($1, 80)`, [id]), /déjà le meilleur/);
  await rejects(rpc(C, `select place_bid($1, 51)`, [id]), /minimale est de 53/);
  await rpc(C, `select place_bid($1, 53)`, [id]);
  assert.equal(await balance(B), 1000, 'surenchéri : remboursé');
  assert.equal(await balance(C), 947);
  await rejects(rpc(A, `select cancel_listing($1)`, [id]), /déjà reçu une offre/);
  const a0 = await balance(A);
  await admin(`update listings set ends_at = now() - interval '1 second' where id = $1`, [id]);
  await rejects(rpc(B, `select place_bid($1, 100)`, [id]), /terminée/);
  assert.equal(await admin(`select settle_due_listings(10) n`).then(r => r[0].n), 1);
  const l = (await admin(`select status, buyer_id, final_price from listings where id = $1`, [id]))[0];
  assert.equal(l.status, 'sold'); assert.equal(l.buyer_id, C); assert.equal(Number(l.final_price), 53);
  assert.equal(await balance(A) - a0, 51, '53 − 5 % de taxe (arrondi en faveur du vendeur)');
  const disc = await admin(`select reward from discoveries where player_id = $1 and card_id = $2 and discovered_at = (select closed_at from listings where id = $3)`, [C, card.card_id, id]);
  assert.equal(await balance(C), 947 + (disc[0]?.reward ?? 0), 'le gagnant ne paie pas deux fois');
  assert.equal((await admin(`select owner_id from card_instances where id = $1`, [card.id]))[0].owner_id, C);
  // sans enchérisseur : la carte revient
  const card2 = await freeInstance(A);
  const id2 = await rpc(A, `select create_listing($1, 'auction', 50, 5)`, [card2.id]);
  await admin(`update listings set ends_at = now() - interval '1 second' where id = $1`, [id2]);
  await rpc(B, `select get_state()`);   // résolution à la demande (sans pg_cron)
  assert.equal((await admin(`select status from listings where id = $1`, [id2]))[0].status, 'expired');
  const back = (await admin(`select owner_id, lock_id from card_instances where id = $1`, [card2.id]))[0];
  assert.equal(back.owner_id, A); assert.equal(back.lock_id, null);
});

test('échanges : refus sans la carte, acceptation atomique, annulation', async () => {
  const mine = await freeInstance(A);
  const wanted = 'giant-squid';
  await rejects(rpc(A, `select create_trade($1, 'licorne')`, [mine.id]), /inconnue/);
  const id = await rpc(A, `select create_trade($1, $2)`, [mine.id, wanted]);
  await rejects(rpc(A, `select accept_trade($1)`, [id]), /propre offre/);
  await rejects(rpc(B, `select accept_trade($1)`, [id]), /ne possèdes pas/);
  const given = (await admin(`select _grant_card($1, $2, 'booster') g`, [B, wanted]))[0].g;
  await rpc(B, `select accept_trade($1)`, [id]);
  await rejects(rpc(C, `select accept_trade($1)`, [id]), /Trop tard/);
  const o1 = (await admin(`select owner_id, lock_id from card_instances where id = $1`, [mine.id]))[0];
  const o2 = (await admin(`select owner_id from card_instances where id = $1`, [given.instance_id]))[0];
  assert.equal(o1.owner_id, B); assert.equal(o1.lock_id, null); assert.equal(o2.owner_id, A);
  assert.equal((await admin(`select count(*)::int n from discoveries where player_id = $1 and card_id = $2`, [A, wanted]))[0].n, 1);
  const other = await freeInstance(A);
  const id2 = await rpc(A, `select create_trade($1, 'lion')`, [other.id]);
  await rpc(A, `select cancel_trade($1)`, [id2]);
  assert.equal((await admin(`select lock_id from card_instances where id = $1`, [other.id]))[0].lock_id, null);
});

test('revenus passifs : calcul serveur plafonné, récupération', async () => {
  await admin(`update profiles set income_pending = 0, income_updated_at = now() - interval '30 hours' where id = $1`, [A]);
  const s = await rpc(A, `select get_state()`);
  const rate = Number(s.profile.income_per_hour);
  assert.ok(rate > 0);
  assert.equal(Number(s.profile.income_pending), rate * 8, 'plafond de 8 h hors ligne');
  const b0 = await balance(A);
  const claimed = Number((await rpc(A, `select claim_income()`)).claimed);
  assert.equal(await balance(A) - b0, claimed);
  assert.equal((await rpc(A, `select claim_income()`)).claimed, 0, 'pas de double récupération');
});

test('limite de fréquence', async () => {
  let blocked = false;
  for (let i = 0; i < 15 && !blocked; i++) {
    try { await rpc(C, `select claim_income()`); } catch (e) { blocked = /Trop d'actions/.test(e.message); }
  }
  assert.ok(blocked);
});
