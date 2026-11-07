import { CARDS, RARITIES, SHOP_MS, STARTING_BALANCE, PACK_WEIGHTS, BASE_SHOP_WEIGHTS } from 'animal-catalog';

export { CARDS, RARITIES, SHOP_MS };
export const CARD_BY_ID = new Map(CARDS.map(card => [card.id, card]));
export const MAX_BALANCE = 1_000_000_000_000;
export const MAX_CARDS = 5000;
export const STARTERS = ['red-fox', 'rabbit', 'clownfish', 'monarch'];
export const SHOP_SLOTS = 6;
const MODULUS = 2_147_483_647;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const need = (condition, message) => { if (!condition) throw new Error(message); };
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export const milliseconds = value => value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000);
export const timestamp = value => ({ seconds: Math.floor(value / 1000), nanoseconds: (value % 1000) * 1_000_000 });
export const seedFrom = value => (value.seconds % MODULUS + Math.floor(value.nanoseconds / 1000)) % MODULUS;
export const mix = (seed, salt) => (((seed + salt * 104729) % MODULUS) * 48271) % MODULUS;
export const packWeights = tier => PACK_WEIGHTS[tier].map(weight => Math.round(weight * 1000));
export function pick(weights, roll) {
  let remaining = roll % weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < weights.length; index++) {
    if (remaining < weights[index]) return index;
    remaining -= weights[index];
  }
  throw new Error('Table de probabilités invalide.');
}
export function shopWeights(luck) {
  const capped = Math.min(100_000, Math.max(0, luck));
  return BASE_SHOP_WEIGHTS.map((weight, tier) => Math.floor(Math.round(weight * 1000) * (100_000 + capped * tier) / 100_000));
}
export function shopOffer(profile, slot) {
  need(integer(slot, 0, SHOP_SLOTS - 1), 'Emplacement de boutique invalide.');
  const tier = slot === 0 ? 0 : pick(shopWeights(profile.shopLuck), mix(seedFrom(profile.shopAt), slot + 31));
  return { slot, tier, priceMilli: RARITIES[tier].price * 1000, stock: RARITIES[tier].stock - profile.shopUsed[slot] };
}
export function drawReservedPack(reservation) {
  need(reservation.kind === 'reserve' && integer(reservation.data.tier, 0, 6), 'Réservation de booster invalide.');
  const seed = seedFrom(reservation.at);
  return Array.from({ length: 4 }, (_, index) => {
    const drawn = pick(packWeights(reservation.data.tier), mix(seed, index * 2 + 1));
    const tier = index === 3 ? Math.max(reservation.data.tier, drawn) : drawn;
    return CARDS[tier * 8 + mix(seed, index * 2 + 2) % 8];
  });
}
function copy(profile) {
  return { ...profile, cards: { ...profile.cards }, available: { ...profile.available }, discoveries: { ...profile.discoveries }, shopUsed: [...profile.shopUsed] };
}
function money(profile, delta) {
  const result = profile.balanceMilli + delta;
  need(integer(result, 0, MAX_BALANCE), delta < 0 ? 'Tu n’as pas assez de pièces.' : 'Le plafond de pièces est atteint.');
  profile.balanceMilli = result;
}
// Tous les participants utilisent la même coupure temporelle. Le revenu est
// soldé AVANT le transfert : aucune production rétroactive chez l’acquéreur.
export function accrue(profile, at) {
  const elapsed = milliseconds(at) - milliseconds(profile.lastClaim);
  need(Number.isSafeInteger(elapsed) && elapsed >= 0, 'L’horloge est en retard sur la dernière transaction. Réessaie dans un instant.');
  const numerator = profile.incomeMilli * Math.min(DAY_MS, elapsed) + profile.remainder;
  need(Number.isSafeInteger(numerator), 'Calcul de revenu hors limites.');
  money(profile, Math.floor(numerator / HOUR_MS));
  profile.remainder = numerator % HOUR_MS;
  profile.lastClaim = at;
}
function acquire(profile, cardId) {
  const card = CARD_BY_ID.get(cardId);
  need(card && profile.ownedCount < MAX_CARDS, 'La collection a atteint sa capacité maximale.');
  profile.cards[cardId]++;
  profile.available[cardId]++;
  profile.ownedCount++;
  profile.incomeMilli += card.income;
  if (!profile.discoveries[cardId]) {
    profile.discoveries[cardId] = true;
    profile.luckMilliPercent += card.luck;
    money(profile, card.reward);
  }
}
function release(profile, cardId, locked = false) {
  const card = CARD_BY_ID.get(cardId);
  need(card && profile.cards[cardId] > 0, 'Cette carte ne se trouve plus dans la collection.');
  if (locked) need(profile.cards[cardId] > profile.available[cardId], 'La carte n’est pas réservée pour cette offre.');
  else {
    need(profile.available[cardId] > 0, 'Cette carte est déjà réservée.');
    profile.available[cardId]--;
  }
  profile.cards[cardId]--;
  profile.ownedCount--;
  profile.incomeMilli -= card.income;
}
function listingBase(actor, profile, data, at, eventId) {
  need(typeof data.listingId === 'string' && /^[a-zA-Z0-9_-]{10,80}$/.test(data.listingId), 'Identifiant d’offre invalide.');
  need(CARD_BY_ID.has(data.cardId), 'Espèce inconnue.');
  need(['fixed', 'auction', 'trade'].includes(data.type), 'Type d’offre inconnu.');
  need(integer(data.durationSeconds, 300, 86_400), 'La durée doit être comprise entre cinq minutes et vingt-quatre heures.');
  if (data.type === 'trade') {
    need(data.priceMilli === 0 && CARD_BY_ID.has(data.wantedCardId) && data.wantedCardId !== data.cardId, 'Choisis une autre espèce pour cet échange.');
  } else need(integer(data.priceMilli, 1000, 1_000_000_000) && data.wantedCardId === '', 'Prix de vente invalide.');
  return {
    version: 1, id: data.listingId, sellerId: actor, sellerName: profile.username,
    cardId: data.cardId, type: data.type, priceMilli: data.priceMilli, wantedCardId: data.wantedCardId,
    createdAt: at, endsAt: timestamp(milliseconds(at) + data.durationSeconds * 1000),
    status: 'active', bidderId: '', bidderName: '', bidMilli: 0, buyerId: '', lastEvent: eventId
  };
}
export function initialProfile(uid, username, at, eventId) {
  need(typeof username === 'string' && /^[\p{L}\p{N}_-]{3,24}$/u.test(username), 'Choisis un pseudo de 3 à 24 lettres, chiffres, tirets ou underscores.');
  const counts = Object.fromEntries(CARDS.map(card => [card.id, 0]));
  const profile = {
    version: 1, uid, username, createdAt: at, balanceMilli: STARTING_BALANCE,
    incomeMilli: 0, luckMilliPercent: 0, ownedCount: 0,
    cards: counts, available: { ...counts }, discoveries: {}, lastClaim: at,
    remainder: 0, shopAt: at, shopLuck: 0, shopUsed: [0, 0, 0, 0, 0, 0],
    pendingPack: '', lastEvent: eventId, revision: 1
  };
  STARTERS.forEach(id => acquire(profile, id));
  profile.shopLuck = profile.luckMilliPercent;
  return profile;
}
export function transition({ kind, actor, eventId, at, data = {}, profiles = {}, listing = null, reservation = null, draw = drawReservedPack }) {
  need(typeof actor === 'string' && actor.length > 0, 'Connexion nécessaire.');
  need(typeof eventId === 'string' && /^[a-zA-Z0-9_-]{10,80}$/.test(eventId), 'Identifiant de transaction invalide.');
  const changed = Object.create(null);
  const player = uid => {
    if (!changed[uid]) {
      need(profiles[uid]?.uid === uid, 'Profil de collectionneur introuvable.');
      changed[uid] = copy(profiles[uid]);
      accrue(changed[uid], at);
      changed[uid].revision++;
      changed[uid].lastEvent = eventId;
    }
    return changed[uid];
  };
  let offer = listing ? { ...listing } : null;
  const activeListing = type => {
    need(offer && offer.id === data.listingId && offer.status === 'active', 'Cette offre n’est plus disponible.');
    if (type) need(offer.type === type, 'Cette action ne correspond pas au type d’offre.');
    offer.lastEvent = eventId;
    return offer;
  };
  switch (kind) {
    case 'register':
      need(!profiles[actor], 'Ce profil existe déjà.');
      changed[actor] = initialProfile(actor, data.username, at, eventId);
      break;
    case 'refresh': {
      const profile = player(actor);
      need(milliseconds(at) >= milliseconds(profile.shopAt) + SHOP_MS, 'La boutique n’a pas encore été renouvelée.');
      profile.shopAt = at;
      profile.shopLuck = profile.luckMilliPercent;
      profile.shopUsed = [0, 0, 0, 0, 0, 0];
      break;
    }
    case 'reserve': {
      const profile = player(actor);
      need(!profile.pendingPack, 'Ouvre d’abord le booster déjà acheté.');
      need(milliseconds(at) < milliseconds(profile.shopAt) + SHOP_MS, 'La boutique doit être renouvelée avant cet achat.');
      const selected = shopOffer(profile, data.slot);
      need(data.tier === selected.tier && selected.stock > 0, 'Cette offre a changé ou son stock est épuisé.');
      money(profile, -selected.priceMilli);
      profile.shopUsed[data.slot]++;
      profile.pendingPack = eventId;
      break;
    }
    case 'open': {
      const profile = player(actor);
      need(reservation && reservation.id === profile.pendingPack && reservation.actor === actor && reservation.kind === 'reserve', 'Aucun booster acheté ne correspond à cette ouverture.');
      draw(reservation).forEach(card => acquire(profile, card.id));
      profile.pendingPack = '';
      break;
    }
    case 'claim': {
      need(milliseconds(at) - milliseconds(profiles[actor]?.lastClaim || at) >= 60_000, 'Le revenu peut être récupéré après une minute.');
      player(actor);
      break;
    }
    case 'list': {
      need(!listing, 'Cet identifiant d’offre est déjà utilisé.');
      const profile = player(actor);
      need(profile.available[data.cardId] > 0, 'Cette carte n’est pas disponible.');
      offer = listingBase(actor, profile, data, at, eventId);
      profile.available[data.cardId]--;
      break;
    }
    case 'cancel': {
      activeListing();
      need(offer.sellerId === actor && !offer.bidderId, 'Une enchère ayant reçu une offre ne peut plus être annulée.');
      player(actor).available[offer.cardId]++;
      offer.status = 'cancelled';
      break;
    }
    case 'buy': {
      activeListing('fixed');
      need(offer.sellerId !== actor && milliseconds(at) < milliseconds(offer.endsAt), 'Cette offre est terminée ou t’appartient.');
      const buyer = player(actor), seller = player(offer.sellerId);
      money(buyer, -offer.priceMilli);
      release(seller, offer.cardId, true);
      money(seller, offer.priceMilli);
      acquire(buyer, offer.cardId);
      offer.status = 'sold';
      offer.buyerId = actor;
      break;
    }
    case 'trade': {
      activeListing('trade');
      need(offer.sellerId !== actor && milliseconds(at) < milliseconds(offer.endsAt), 'Cet échange est terminé ou t’appartient.');
      const buyer = player(actor), seller = player(offer.sellerId);
      release(buyer, offer.wantedCardId);
      release(seller, offer.cardId, true);
      acquire(buyer, offer.cardId);
      acquire(seller, offer.wantedCardId);
      offer.status = 'accepted';
      offer.buyerId = actor;
      break;
    }
    case 'bid': {
      activeListing('auction');
      need(offer.sellerId !== actor && milliseconds(at) < milliseconds(offer.endsAt), 'Cette enchère est terminée ou t’appartient.');
      const minimum = offer.bidderId ? offer.bidMilli + 1000 : offer.priceMilli;
      need(integer(data.amountMilli, minimum, 1_000_000_000), 'Le montant de l’enchère est insuffisant ou hors limites.');
      const bidder = player(actor);
      if (offer.bidderId === actor) money(bidder, -(data.amountMilli - offer.bidMilli));
      else {
        money(bidder, -data.amountMilli);
        if (offer.bidderId) money(player(offer.bidderId), offer.bidMilli);
      }
      offer.bidderId = actor;
      offer.bidderName = bidder.username;
      offer.bidMilli = data.amountMilli;
      break;
    }
    case 'settle': {
      activeListing('auction');
      need(milliseconds(at) >= milliseconds(offer.endsAt), 'Cette enchère n’est pas encore terminée.');
      const seller = player(offer.sellerId);
      if (!offer.bidderId) {
        seller.available[offer.cardId]++;
        offer.status = 'expired';
      } else {
        const buyer = player(offer.bidderId);
        release(seller, offer.cardId, true);
        money(seller, offer.bidMilli);
        acquire(buyer, offer.cardId);
        offer.status = 'sold';
        offer.buyerId = offer.bidderId;
      }
      break;
    }
    default: throw new Error('Action de jeu inconnue.');
  }
  for (const profile of Object.values(changed)) {
    need(integer(profile.balanceMilli, 0, MAX_BALANCE) && integer(profile.ownedCount, 0, MAX_CARDS), 'Les limites de la collection seraient dépassées.');
    need(CARDS.every(card => integer(profile.cards[card.id], 0, MAX_CARDS) && integer(profile.available[card.id], 0, profile.cards[card.id])), 'La transaction ne conserve pas correctement les cartes.');
  }
  return { profiles: changed, listing: offer };
}
