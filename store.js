import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash, randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CARDS, CARD_BY_ID, RARITIES, SHOP_MS, STARTING_BALANCE, MONEY_SCALE, shopProbabilities, weightedPick, drawPack } from './catalog.js';

export class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const requireThat = (condition, message, status = 400) => { if (!condition) throw new GameError(message, status); };
const digest = value => createHash('sha256').update(value).digest('hex');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_PRICE = 1_000_000_000;

export class GameStore {
  constructor(path = 'data/animal-cards.sqlite', { now = Date.now } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.now = now;
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        balance INTEGER NOT NULL CHECK(balance BETWEEN 0 AND 9000000000000000),
        last_accrual INTEGER NOT NULL, income_remainder INTEGER NOT NULL DEFAULT 0,
        shop_expires INTEGER NOT NULL DEFAULT 0, shop_luck INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        card_id TEXT NOT NULL, locked TEXT NOT NULL DEFAULT '' CHECK(locked IN ('', 'listing', 'trade')),
        acquired_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS inventory_owner ON inventory(owner_id);
      CREATE TABLE IF NOT EXISTS discoveries (
        user_id TEXT NOT NULL REFERENCES users(id), card_id TEXT NOT NULL,
        discovered_at INTEGER NOT NULL, PRIMARY KEY(user_id, card_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        rarity INTEGER NOT NULL CHECK(rarity BETWEEN 0 AND 6),
        price INTEGER NOT NULL CHECK(price > 0), stock INTEGER NOT NULL CHECK(stock >= 0),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS offers_owner ON offers(user_id);
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES inventory(id),
        seller_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK(kind IN ('fixed', 'auction')),
        price INTEGER NOT NULL CHECK(price > 0), bidder_id TEXT REFERENCES users(id),
        ends_at INTEGER, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'sold', 'cancelled', 'expired')),
        created_at INTEGER NOT NULL, settled_at INTEGER
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_listing ON listings(item_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS due_auctions ON listings(status, ends_at);
      CREATE TABLE IF NOT EXISTS bids (
        id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id),
        user_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL CHECK(amount > 0), created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES inventory(id),
        creator_id TEXT NOT NULL REFERENCES users(id), wanted_card_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'accepted', 'cancelled')),
        taker_id TEXT REFERENCES users(id), received_item_id TEXT REFERENCES inventory(id),
        created_at INTEGER NOT NULL, settled_at INTEGER
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_trade ON trades(item_id) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY, listing_id TEXT NOT NULL UNIQUE REFERENCES listings(id),
        card_id TEXT NOT NULL, seller_id TEXT NOT NULL REFERENCES users(id),
        buyer_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL,
        kind TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        delta INTEGER NOT NULL, reason TEXT NOT NULL, reference TEXT, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS actions (
        user_id TEXT NOT NULL REFERENCES users(id), action_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, action_key)
      ) STRICT;
    `);
  }

  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  credit(userId, delta, reason, reference = null) {
    requireThat(Number.isSafeInteger(delta), 'Montant invalide.');
    const changed = this.run('UPDATE users SET balance = balance + ? WHERE id = ? AND balance + ? BETWEEN 0 AND 9000000000000000', delta, userId, delta).changes;
    requireThat(changed === 1, delta < 0 ? 'Solde insuffisant.' : 'Limite de solde atteinte.', 409);
    if (delta) this.run('INSERT INTO ledger VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), userId, delta, reason, reference, this.now());
  }

  incomeRate(userId) {
    return this.all('SELECT card_id, COUNT(*) AS count FROM inventory WHERE owner_id = ? GROUP BY card_id', userId)
      .reduce((total, row) => total + CARD_BY_ID.get(row.card_id).income * row.count, 0);
  }

  accrue(userId, at = this.now()) {
    const user = this.one('SELECT last_accrual, income_remainder FROM users WHERE id = ?', userId);
    requireThat(user, 'Compte introuvable.', 401);
    const elapsed = Math.min(DAY, Math.max(0, at - user.last_accrual));
    const numerator = BigInt(this.incomeRate(userId)) * BigInt(elapsed) + BigInt(user.income_remainder);
    const amount = Number(numerator / BigInt(HOUR));
    this.run('UPDATE users SET last_accrual = ?, income_remainder = ? WHERE id = ?', Math.max(user.last_accrual, at), Number(numerator % BigInt(HOUR)), userId);
    if (amount) this.credit(userId, amount, 'passive');
    return amount;
  }

  discover(userId, cardId) {
    const card = CARD_BY_ID.get(cardId);
    requireThat(card, 'Carte inconnue.');
    const added = this.run('INSERT OR IGNORE INTO discoveries VALUES (?, ?, ?)', userId, cardId, this.now()).changes;
    if (!added) return null;
    this.credit(userId, card.reward, 'discovery', cardId);
    return { cardId, rewardMilli: card.reward, luckMilliPercent: card.luck };
  }

  giveCard(userId, cardId) {
    const id = randomUUID();
    this.run('INSERT INTO inventory (id, owner_id, card_id, acquired_at) VALUES (?, ?, ?, ?)', id, userId, cardId, this.now());
    return { id, cardId, discovery: this.discover(userId, cardId) };
  }

  createUser(username, passwordHash) {
    return this.transaction(() => {
      requireThat(typeof username === 'string' && /^[\p{L}\p{N}_-]{3,24}$/u.test(username), 'Choisis un pseudo de 3 à 24 lettres, chiffres, tirets ou underscores.');
      requireThat(!this.one('SELECT id FROM users WHERE username = ?', username), 'Ce pseudo est déjà utilisé.', 409);
      const id = randomUUID();
      this.run('INSERT INTO users (id, username, password_hash, balance, last_accrual, created_at) VALUES (?, ?, ?, 0, ?, ?)', id, username, passwordHash, this.now(), this.now());
      this.credit(id, STARTING_BALANCE, 'welcome');
      const starters = ['red-fox', 'rabbit', 'clownfish', 'monarch'];
      for (const card of starters) this.giveCard(id, card);
      return id;
    });
  }

  authRecord(username) {
    return typeof username === 'string' ? this.one('SELECT id, password_hash FROM users WHERE username = ?', username) : undefined;
  }

  newSession(userId) {
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    this.run('DELETE FROM sessions WHERE expires_at <= ?', this.now());
    this.run('INSERT INTO sessions VALUES (?, ?, ?, ?)', digest(token), userId, csrf, this.now() + 7 * DAY);
    return { token, csrf };
  }

  session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.one('SELECT user_id AS userId, csrf FROM sessions WHERE token_hash = ? AND expires_at > ?', digest(token), this.now());
  }

  endSession(token) { if (typeof token === 'string') this.run('DELETE FROM sessions WHERE token_hash = ?', digest(token)); }

  luck(userId) {
    return this.all('SELECT card_id FROM discoveries WHERE user_id = ?', userId).reduce((sum, row) => sum + CARD_BY_ID.get(row.card_id).luck, 0);
  }

  ensureShop(userId) {
    const user = this.one('SELECT shop_expires FROM users WHERE id = ?', userId);
    if (user.shop_expires > this.now()) return;
    const expires = (Math.floor(this.now() / SHOP_MS) + 1) * SHOP_MS;
    const luck = this.luck(userId);
    this.run('DELETE FROM offers WHERE user_id = ?', userId);
    const tiers = [0, ...Array.from({ length: 5 }, () => weightedPick(shopProbabilities(luck)))];
    for (const tier of tiers) {
      const config = RARITIES[tier];
      this.run('INSERT INTO offers VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), userId, tier, config.price * MONEY_SCALE, config.stock, expires);
    }
    this.run('UPDATE users SET shop_expires = ?, shop_luck = ? WHERE id = ?', expires, luck, userId);
  }

  item(userId, itemId) {
    const item = this.one('SELECT * FROM inventory WHERE id = ? AND owner_id = ?', itemId, userId);
    requireThat(item, 'Cette carte ne t’appartient pas.', 404);
    requireThat(item.locked === '', 'Cette carte est déjà réservée dans une vente ou un échange.', 409);
    return item;
  }

  price(value) {
    requireThat(Number.isSafeInteger(value) && value >= 1 && value <= MAX_PRICE, `Le prix doit être un nombre entier entre 1 et ${MAX_PRICE} pièces.`);
    return value * MONEY_SCALE;
  }

  transfer(itemId, from, to) {
    const changed = this.run("UPDATE inventory SET owner_id = ?, locked = '', acquired_at = ? WHERE id = ? AND owner_id = ?", to, this.now(), itemId, from).changes;
    requireThat(changed === 1, 'La carte n’est plus disponible.', 409);
  }

  completeSale(listing, buyerId, at = this.now()) {
    const item = this.one('SELECT * FROM inventory WHERE id = ?', listing.item_id);
    requireThat(item && item.owner_id === listing.seller_id && item.locked === 'listing', 'Vente incohérente.', 409);
    this.accrue(listing.seller_id, at);
    this.accrue(buyerId, at);
    this.credit(listing.seller_id, listing.price, 'sale', listing.id);
    this.transfer(item.id, listing.seller_id, buyerId);
    const discovery = this.discover(buyerId, item.card_id);
    this.run("UPDATE listings SET status = 'sold', bidder_id = ?, settled_at = ? WHERE id = ?", buyerId, at, listing.id);
    this.run('INSERT INTO sales VALUES (?, ?, ?, ?, ?, ?, ?, ?)', randomUUID(), listing.id, item.card_id, listing.seller_id, buyerId, listing.price, listing.kind, at);
    return { discovery };
  }

  settleDueInternal() {
    const due = this.all("SELECT * FROM listings WHERE status = 'active' AND kind = 'auction' AND ends_at <= ? ORDER BY ends_at, id", this.now());
    for (const listing of due) {
      if (listing.bidder_id) this.completeSale(listing, listing.bidder_id, listing.ends_at);
      else {
        this.run("UPDATE listings SET status = 'expired', settled_at = ? WHERE id = ?", listing.ends_at, listing.id);
        this.run("UPDATE inventory SET locked = '' WHERE id = ?", listing.item_id);
      }
    }
    return due.length;
  }

  settleDue() { return this.transaction(() => this.settleDueInternal()); }

  state(userId) {
    return this.transaction(() => {
      this.settleDueInternal();
      const passiveEarnedMilli = this.accrue(userId);
      this.ensureShop(userId);
      const user = this.one('SELECT id, username, balance AS balanceMilli, shop_expires, shop_luck, created_at AS createdAt FROM users WHERE id = ?', userId);
      const luck = this.luck(userId);
      return {
        serverTime: this.now(),
        user: { id: user.id, username: user.username, balanceMilli: user.balanceMilli, createdAt: user.createdAt, luckMilliPercent: luck, incomeMilliPerHour: this.incomeRate(userId), passiveEarnedMilli },
        inventory: this.all('SELECT id, card_id AS cardId, locked, acquired_at AS acquiredAt FROM inventory WHERE owner_id = ? ORDER BY acquired_at DESC', userId),
        discoveredIds: this.all('SELECT card_id FROM discoveries WHERE user_id = ?', userId).map(row => row.card_id),
        shop: {
          expiresAt: user.shop_expires, luckUsedMilliPercent: user.shop_luck,
          probabilities: shopProbabilities(user.shop_luck), nextProbabilities: shopProbabilities(luck),
          offers: this.all('SELECT id, rarity, price AS priceMilli, stock FROM offers WHERE user_id = ? ORDER BY rarity, id', userId)
        }
      };
    });
  }

  action(userId, key, kind, data = {}) {
    requireThat(typeof key === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(key), 'Identifiant de transaction manquant.');
    const fingerprint = digest(JSON.stringify({ kind, data }));
    return this.transaction(() => {
      const previous = this.one('SELECT fingerprint, result FROM actions WHERE user_id = ? AND action_key = ?', userId, key);
      if (previous) {
        requireThat(previous.fingerprint === fingerprint, 'Cet identifiant a déjà servi à une autre transaction.', 409);
        return JSON.parse(previous.result);
      }
      this.settleDueInternal();
      this.accrue(userId);
      let result;
      if (kind === 'buy-pack') result = this.buyPack(userId, data);
      else if (kind === 'list') result = this.list(userId, data);
      else if (kind === 'buy') result = this.buy(userId, data);
      else if (kind === 'bid') result = this.bid(userId, data);
      else if (kind === 'cancel-listing') result = this.cancelListing(userId, data);
      else if (kind === 'trade') result = this.createTrade(userId, data);
      else if (kind === 'accept-trade') result = this.acceptTrade(userId, data);
      else if (kind === 'cancel-trade') result = this.cancelTrade(userId, data);
      else throw new GameError('Action inconnue.', 404);
      this.run('INSERT INTO actions VALUES (?, ?, ?, ?, ?)', userId, key, fingerprint, JSON.stringify(result), this.now());
      return result;
    });
  }

  buyPack(userId, { offerId }) {
    this.ensureShop(userId);
    const offer = this.one('SELECT * FROM offers WHERE id = ? AND user_id = ?', offerId, userId);
    requireThat(offer && offer.expires_at > this.now(), 'Ce booster a expiré. Actualise ta boutique.', 409);
    requireThat(offer.stock > 0, 'Ce booster est épuisé.', 409);
    requireThat(this.one('SELECT COUNT(*) AS n FROM inventory WHERE owner_id = ?', userId).n < 100_000, 'Inventaire plein. Vends ou échange des cartes.');
    this.credit(userId, -offer.price, 'pack', offer.id);
    this.run('UPDATE offers SET stock = stock - 1 WHERE id = ?', offer.id);
    return { rarity: offer.rarity, cards: drawPack(offer.rarity).map(card => this.giveCard(userId, card.id)) };
  }

  list(userId, { itemId, kind, price, durationMinutes }) {
    const item = this.item(userId, itemId);
    requireThat(kind === 'fixed' || kind === 'auction', 'Type de vente invalide.');
    const amount = this.price(price);
    requireThat(kind !== 'auction' || [5, 15, 60, 360, 1440].includes(durationMinutes), 'Durée d’enchère invalide.');
    requireThat(this.one("SELECT COUNT(*) AS n FROM listings WHERE seller_id = ? AND status = 'active'", userId).n < 100, 'Maximum 100 ventes actives.');
    const id = randomUUID();
    this.run('INSERT INTO listings (id, item_id, seller_id, kind, price, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, item.id, userId, kind, amount, kind === 'auction' ? this.now() + durationMinutes * 60_000 : null, this.now());
    this.run("UPDATE inventory SET locked = 'listing' WHERE id = ?", item.id);
    return { id };
  }

  buy(userId, { listingId }) {
    const listing = this.one("SELECT * FROM listings WHERE id = ? AND status = 'active' AND kind = 'fixed'", listingId);
    requireThat(listing, 'Cette vente n’est plus disponible.', 409);
    requireThat(listing.seller_id !== userId, 'Tu ne peux pas acheter ta propre carte.');
    this.credit(userId, -listing.price, 'purchase', listing.id);
    return this.completeSale(listing, userId);
  }

  bid(userId, { listingId, amount }) {
    const listing = this.one("SELECT * FROM listings WHERE id = ? AND status = 'active' AND kind = 'auction'", listingId);
    requireThat(listing && listing.ends_at > this.now(), 'Cette enchère est terminée.', 409);
    requireThat(listing.seller_id !== userId, 'Tu ne peux pas enchérir sur ta propre carte.');
    const value = this.price(amount);
    const minimum = listing.bidder_id ? Math.max(listing.price + MONEY_SCALE, Math.ceil(listing.price * 1.05 / MONEY_SCALE) * MONEY_SCALE) : listing.price;
    requireThat(value >= minimum, `L’offre minimale est de ${minimum / MONEY_SCALE} pièces.`, 409);
    if (listing.bidder_id === userId) this.credit(userId, -(value - listing.price), 'bid-increase', listing.id);
    else {
      this.credit(userId, -value, 'bid-reserve', listing.id);
      if (listing.bidder_id) this.credit(listing.bidder_id, listing.price, 'bid-refund', listing.id);
    }
    this.run('UPDATE listings SET price = ?, bidder_id = ? WHERE id = ?', value, userId, listing.id);
    this.run('INSERT INTO bids VALUES (?, ?, ?, ?, ?)', randomUUID(), listing.id, userId, value, this.now());
    return { amountMilli: value, endsAt: listing.ends_at };
  }

  cancelListing(userId, { listingId }) {
    const listing = this.one("SELECT * FROM listings WHERE id = ? AND seller_id = ? AND status = 'active'", listingId, userId);
    requireThat(listing, 'Vente introuvable.', 404);
    requireThat(!listing.bidder_id, 'Une enchère ayant reçu une offre ne peut plus être annulée.', 409);
    this.run("UPDATE listings SET status = 'cancelled', settled_at = ? WHERE id = ?", this.now(), listing.id);
    this.run("UPDATE inventory SET locked = '' WHERE id = ?", listing.item_id);
    return { cancelled: true };
  }

  createTrade(userId, { itemId, wantedCardId }) {
    const item = this.item(userId, itemId);
    requireThat(CARD_BY_ID.has(wantedCardId), 'Carte demandée inconnue.');
    requireThat(item.card_id !== wantedCardId, 'Choisis une autre espèce à recevoir.');
    requireThat(this.one("SELECT COUNT(*) AS n FROM trades WHERE creator_id = ? AND status = 'active'", userId).n < 100, 'Maximum 100 échanges actifs.');
    const id = randomUUID();
    this.run('INSERT INTO trades (id, item_id, creator_id, wanted_card_id, created_at) VALUES (?, ?, ?, ?, ?)', id, item.id, userId, wantedCardId, this.now());
    this.run("UPDATE inventory SET locked = 'trade' WHERE id = ?", item.id);
    return { id };
  }

  acceptTrade(userId, { tradeId, itemId }) {
    const trade = this.one("SELECT * FROM trades WHERE id = ? AND status = 'active'", tradeId);
    requireThat(trade, 'Cet échange n’est plus disponible.', 409);
    requireThat(trade.creator_id !== userId, 'Tu ne peux pas accepter ton propre échange.');
    const received = this.item(userId, itemId);
    requireThat(received.card_id === trade.wanted_card_id, 'La carte proposée ne correspond pas à la demande.');
    const offered = this.one('SELECT * FROM inventory WHERE id = ?', trade.item_id);
    requireThat(offered && offered.owner_id === trade.creator_id && offered.locked === 'trade', 'Carte indisponible.', 409);
    this.accrue(trade.creator_id);
    this.transfer(offered.id, trade.creator_id, userId);
    this.transfer(received.id, userId, trade.creator_id);
    const discovery = this.discover(userId, offered.card_id);
    this.discover(trade.creator_id, received.card_id);
    this.run("UPDATE trades SET status = 'accepted', taker_id = ?, received_item_id = ?, settled_at = ? WHERE id = ?", userId, received.id, this.now(), trade.id);
    return { discovery };
  }

  cancelTrade(userId, { tradeId }) {
    const trade = this.one("SELECT * FROM trades WHERE id = ? AND creator_id = ? AND status = 'active'", tradeId, userId);
    requireThat(trade, 'Échange introuvable.', 404);
    this.run("UPDATE trades SET status = 'cancelled', settled_at = ? WHERE id = ?", this.now(), trade.id);
    this.run("UPDATE inventory SET locked = '' WHERE id = ?", trade.item_id);
    return { cancelled: true };
  }

  market({ type = 'fixed', search = '', rarity = '', page = 0, mine = false } = {}, userId) {
    requireThat(['fixed', 'auction', 'trade', 'history'].includes(type), 'Filtre invalide.');
    const offset = Math.max(0, Math.min(100_000, Number.parseInt(page, 10) || 0));
    const needle = String(search).slice(0, 80).toLocaleLowerCase('fr');
    const matching = CARDS.filter(card => (!needle || card.name.toLocaleLowerCase('fr').includes(needle)) && (rarity === '' || card.rarity === Number(rarity))).map(card => card.id);
    if (!matching.length) return { entries: [], total: 0, page: offset };
    this.settleDue();
    const placeholders = matching.map(() => '?').join(',');
    let from, where, fields;
    const args = [];
    if (type === 'trade') {
      from = 'trades t JOIN inventory i ON i.id = t.item_id JOIN users u ON u.id = t.creator_id';
      where = `t.status = 'active' AND i.card_id IN (${placeholders})`;
      fields = 't.id, t.item_id AS itemId, i.card_id AS cardId, t.creator_id AS sellerId, u.username AS seller, t.wanted_card_id AS wantedCardId, t.created_at AS createdAt';
      args.push(...matching);
      if (mine) { where += ' AND t.creator_id = ?'; args.push(userId); }
    } else if (type === 'history') {
      from = 'sales s JOIN users u ON u.id = s.seller_id JOIN users b ON b.id = s.buyer_id';
      where = `s.card_id IN (${placeholders})`;
      fields = 's.id, s.card_id AS cardId, u.username AS seller, b.username AS buyer, s.amount AS priceMilli, s.kind, s.created_at AS createdAt';
      args.push(...matching);
      if (mine) { where += ' AND (s.seller_id = ? OR s.buyer_id = ?)'; args.push(userId, userId); }
    } else {
      from = 'listings l JOIN inventory i ON i.id = l.item_id JOIN users u ON u.id = l.seller_id LEFT JOIN users b ON b.id = l.bidder_id';
      where = `l.status = 'active' AND l.kind = ? AND i.card_id IN (${placeholders})`;
      fields = 'l.id, l.item_id AS itemId, i.card_id AS cardId, l.seller_id AS sellerId, u.username AS seller, l.price AS priceMilli, l.bidder_id AS bidderId, b.username AS bidder, l.ends_at AS endsAt, l.created_at AS createdAt';
      args.push(type, ...matching);
      if (mine) { where += ' AND (l.seller_id = ? OR l.bidder_id = ?)'; args.push(userId, userId); }
    }
    const total = this.one(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`, ...args).n;
    const entries = this.all(`SELECT ${fields} FROM ${from} WHERE ${where} ORDER BY createdAt DESC LIMIT 24 OFFSET ?`, ...args, offset * 24);
    return { entries, total, page: offset };
  }
}
