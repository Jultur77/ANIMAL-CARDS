// Faux client Supabase pour le test d'interface (tests/ui-smoke.mjs) : AUCUN serveur réel.
// Il imite juste assez l'API (auth, rpc, from().select()…, channel) pour afficher tous les écrans.
(() => {
  const ok = data => ({ data, error: null });
  const iso = (s = 0) => new Date(Date.now() + s * 1000).toISOString();
  const RAR = [[0, 'Commun', '#9ca3af', 10, 4, 5, 0.001, 120, 50], [1, 'Peu commun', '#4ade80', 30, 8, 15, 0.005, 300, 25],
    [2, 'Rare', '#60a5fa', 100, 20, 50, 0.025, 800, 13], [3, 'Épique', '#c084fc', 400, 50, 150, 0.12, 2400, 7],
    [4, 'Légendaire', '#fbbf24', 1500, 120, 500, 0.6, 7500, 3.5], [5, 'Mythique', '#f43f5e', 6000, 300, 2000, 1.8, 22000, 1.2],
    [6, 'Secret', '#22d3ee', 25000, 800, 8000, 5, 70000, 0.3]];
  const rarities = RAR.map(([id, name, color, card_value, income_per_hour, discovery_reward, luck_bonus, booster_price, shop_weight]) =>
    ({ id, code: 'r' + id, name, color, card_value, income_per_hour, discovery_reward, luck_bonus, booster_price, shop_weight, pack_weights: [60, 25, 10, 4, 1, 0, 0] }));
  const EMO = ['🦊', '🐺', '🦁', '🐯', '🐘', '🦒', '🦓', '🦏', '🐼', '🐨', '🦉', '🦅', '🐢', '🐍', '🦖', '🦕'];
  const CAT = ['mammal', 'bird', 'reptile', 'amphibian', 'fish', 'marine', 'insect', 'extinct'];
  const cards = Array.from({ length: 28 }, (_, i) => ({ id: 'animal-' + i, number: i + 1, name: 'Animal au nom assez long ' + (i + 1),
    scientific_name: 'Animalis exemplum ' + i, category: CAT[i % 8], habitat: 'Forêts tempérées', emoji: EMO[i % 16], rarity: Math.min(6, Math.floor(i / 4)), value: 10 * (i + 1) }));
  const me = 'u-me', other = 'u-other';
  let balance = 5000, profile = null;
  const inventory = cards.slice(0, 12).flatMap((c, i) => Array.from({ length: 1 + i % 3 }, (_, k) => ({
    id: `i-${i}-${k}`, card_id: c.id, owner_id: me, lock_kind: i === 2 && k === 1 ? 'listing' : null, lock_id: i === 2 && k === 1 ? 'l3' : null,
    origin: 'starter', acquired_at: iso(-i * 1000) })));
  const listings = [
    { id: 'l1', seller_id: other, seller_name: 'Bob', card_id: cards[20].id, kind: 'auction', price: 500, current_bid: 600, bidder_id: 'u-zoe', bidder_name: 'Zoe', bid_count: 2, status: 'active', ends_at: iso(90), created_at: iso(-60) },
    { id: 'l2', seller_id: other, seller_name: 'Bob', card_id: cards[5].id, kind: 'fixed', price: 120, current_bid: null, bid_count: 0, status: 'active', ends_at: iso(3600), created_at: iso(-30) },
    { id: 'l3', seller_id: me, seller_name: 'Moi', card_id: cards[2].id, kind: 'fixed', price: 50, current_bid: null, bid_count: 0, status: 'active', ends_at: iso(7200), created_at: iso(-10) },
    { id: 's1', seller_id: other, seller_name: 'Bob', card_id: cards[7].id, kind: 'auction', price: 100, status: 'sold', buyer_name: 'Alice', final_price: 130, ends_at: iso(-50), created_at: iso(-500), closed_at: iso(-50) }];
  const trades = [
    { id: 't1', creator_id: other, creator_name: 'Bob', offered_card_id: cards[25].id, wanted_card_id: cards[0].id, status: 'open', created_at: iso(-20) },
    { id: 't2', creator_id: other, creator_name: 'Bob', offered_card_id: cards[26].id, wanted_card_id: cards[27].id, status: 'open', created_at: iso(-15) },
    { id: 't3', creator_id: other, creator_name: 'Bob', acceptor_name: 'Alice', offered_card_id: cards[3].id, wanted_card_id: cards[4].id, status: 'accepted', created_at: iso(-900), closed_at: iso(-800) }];
  const tables = {
    cards, rarities, listings, trades, card_instances: inventory,
    settings: [{ id: 1, shop_refresh_seconds: 300, shop_slots: 6, cards_per_pack: 5, start_balance: 1500, starter_cards: 3, offline_cap_hours: 8,
      market_fee_pct: 5, min_bid_increment_pct: 5, anti_snipe_seconds: 30, max_active_listings: 20, max_open_trades: 20, max_cards: 5000, max_price: 100000000 }],
    discoveries: cards.slice(0, 12).map(c => ({ card_id: c.id, luck_gained: 0.001, reward: 5, discovered_at: iso(-5000) }))
  };
  const query = table => {
    let rows = [...(tables[table] || [])], single = false;
    const q = {
      select: () => q, order: () => q, limit: () => q,
      eq: (col, val) => { rows = rows.filter(r => !(col in r) || r[col] === val); return q; },
      single: () => { single = true; return q; },
      then: (res, rej) => Promise.resolve(ok(single ? rows[0] : rows)).then(res, rej)
    };
    return q;
  };
  const state = () => ({
    server_now: iso(),
    profile: profile && { ...profile, balance, card_count: inventory.length, discovered: 12, shop_next_refresh_at: iso(200) },
    shop_probabilities: [0.5, 0.25, 0.13, 0.07, 0.035, 0.012, 0.003],
    shop: [0, 1, 2, 3, 4, 5].map(s => ({ slot: s, tier: s, price: rarities[s].booster_price, stock: s === 5 ? 0 : s % 2 ? null : 3 }))
  });
  const session = { user: { id: me, email: 'moi@example.com', user_metadata: { username: 'Renard_77' } } };
  window.__calls = [];
  window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session } }),
 onAuthStateChange(cb) { setTimeout(() => cb('INITIAL_SESSION', session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
        signOut: async () => ({ error: null }),
        signInWithPassword: async () => ({ data: { session }, error: null }),
 signUp: async () => ({ data: { session: null }, error: null })
      },
      async rpc(fn, args) {
 window.__calls.push(fn);
        await new Promise(r => setTimeout(r, 30));
        switch (fn) {
          case 'get_state': return ok(state());
          case 'create_profile':
     profile = { id: me, username: args.p_username, luck: 0.5, income_pending: 40, income_per_hour: 96, income_cap: 768 };
     return ok({ created: true });
          case 'claim_income': balance += 40; return ok({ claimed: 40 });
   case 'buy_booster':
     balance -= 300;
     return ok({ tier: 1, price: 300, balance, luck: 0.51, already_applied: false,
       cards: cards.slice(10, 15).map((c, i) => ({ instance_id: 'n' + i, card_id: c.id, is_new: i > 2, luck_gained: 0.005, reward: 15 })) });
   case 'place_bid': return { data: null, error: { message: 'Ton offre doit être d’au moins 630 pièces.' } };
   default: return ok({ card_id: cards[25].id, is_new: true, luck_gained: 0.6, reward: 500, price: 120 });
        }
      },
      from: query,
      channel() { const c = { on: () => c, subscribe: () => c }; return c; },
      removeChannel() {}
    })
  };
})();
