import { Timestamp } from 'firebase-admin/firestore';
import { drawPack } from './generated/catalog.js';
import { CARD_BY_ID, transition, timestamp, milliseconds } from './generated/game-model.js';

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

const idPattern = /^(?!__.*__$)[a-zA-Z0-9_-]{10,80}$/;
const marketKinds = new Set(['list', 'cancel', 'buy', 'trade', 'bid', 'settle']);
const schemas = new Map([
  ['register', ['username']], ['refresh', []], ['reserve', ['slot', 'tier']],
  ['open', []], ['claim', []],
  ['list', ['listingId', 'cardId', 'type', 'priceMilli', 'wantedCardId', 'durationSeconds']],
  ['cancel', ['listingId']], ['buy', ['listingId']], ['trade', ['listingId']],
  ['bid', ['listingId', 'amountMilli']], ['settle', ['listingId']]
]);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function requireCondition(condition, code, message) {
  if (!condition) throw new GameError(code, message);
}
function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function canonical(data) {
  return JSON.stringify(Object.fromEntries(Object.keys(data).sort().map(key => [key, data[key]])));
}
function validate(uid, input) {
  requireCondition(typeof uid === 'string' && uid.length > 0 && uid.length <= 128
    && !uid.includes('/') && uid !== '.' && uid !== '..' && !/^__.*__$/.test(uid), 'unauthenticated', 'Identifiant de connexion non pris en charge.');
  requireCondition(exactKeys(input, ['id', 'kind', 'data']) && typeof input.id === 'string'
    && idPattern.test(input.id) && schemas.has(input.kind), 'invalid-argument', 'Action ou identifiant invalide.');
  const { id, kind, data } = input;
  requireCondition(exactKeys(data, schemas.get(kind)), 'invalid-argument', 'Les paramètres de cette action sont invalides.');
  const check = (condition, message) => requireCondition(condition, 'invalid-argument', message);
  if (kind === 'register') check(typeof data.username === 'string' && /^[\p{L}\p{N}_-]{3,24}$/u.test(data.username), 'Pseudo invalide.');
  if (kind === 'reserve') check(integer(data.slot, 0, 5) && integer(data.tier, 0, 6), 'Offre de booster invalide.');
  if (marketKinds.has(kind)) check(typeof data.listingId === 'string' && idPattern.test(data.listingId), 'Identifiant d’offre invalide.');
  if (kind === 'bid') check(integer(data.amountMilli, 1000, 1_000_000_000), 'Montant d’enchère invalide.');
  if (kind === 'list') {
    check(CARD_BY_ID.has(data.cardId) && ['fixed', 'auction', 'trade'].includes(data.type), 'Carte ou type d’offre invalide.');
    check(integer(data.durationSeconds, 300, 86_400), 'Durée d’offre invalide.');
    check(data.type === 'trade'
      ? data.priceMilli === 0 && CARD_BY_ID.has(data.wantedCardId) && data.wantedCardId !== data.cardId
      : integer(data.priceMilli, 1000, 1_000_000_000) && data.wantedCardId === '', 'Prix ou carte d’échange invalide.');
  }
  return { id, kind, data: { ...data } };
}
function firestoreValues(value) {
  if (Array.isArray(value)) return value.map(firestoreValues);
  if (value && typeof value === 'object') {
    if (Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) return new Timestamp(value.seconds, value.nanoseconds);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, firestoreValues(item)]));
  }
  return value;
}

export function createGameService({ db, now = Date.now, draw = drawPack }) {
  if (!db || typeof db.runTransaction !== 'function') throw new TypeError('Une base transactionnelle est nécessaire.');
  return async function gameAction(uid, input) {
    const action = validate(uid, input);
    const { id, kind, data } = action;
    let reservedCards;
    return db.runTransaction(async transaction => {
      const receiptRef = db.doc(`events/${id}`);
      const receiptSnapshot = await transaction.get(receiptRef);
      if (receiptSnapshot.exists) {
        const receipt = receiptSnapshot.data();
        requireCondition(receipt.actor === uid && receipt.kind === kind && canonical(receipt.data) === canonical(data),
          'already-exists', 'Cet identifiant correspond à une autre transaction.');
        requireCondition(receipt.result?.id === id, 'failed-precondition', 'Le reçu existant nécessite une vérification.');
        return { ...receipt.result, alreadyApplied: true };
      }
      let listing = null;
      let listingRef;
      if (marketKinds.has(kind)) {
        listingRef = db.doc(`listings/${data.listingId}`);
        const snapshot = await transaction.get(listingRef);
        listing = snapshot.exists ? snapshot.data() : null;
        if (kind !== 'list') requireCondition(listing !== null, 'not-found', 'Cette offre est introuvable.');
        if (kind === 'settle') requireCondition(listing.sellerId === uid || listing.bidderId === uid,
          'permission-denied', 'Seuls les participants peuvent clôturer cette enchère.');
      }
      const participants = new Set([uid]);
      if (listing?.sellerId) participants.add(listing.sellerId);
      if (listing?.bidderId) participants.add(listing.bidderId);
      const profiles = Object.create(null);
      for (const participant of participants) {
        const snapshot = await transaction.get(db.doc(`players/${participant}`));
        if (snapshot.exists) profiles[participant] = snapshot.data();
      }
      if (kind !== 'register') requireCondition(Boolean(profiles[uid]), 'failed-precondition', 'Crée ton profil de collectionneur avant de jouer.');
      let reservation = null;
      let packRef;
      let openedCards = [];
      if (kind === 'open') {
        const packId = profiles[uid].pendingPack;
        requireCondition(typeof packId === 'string' && idPattern.test(packId), 'failed-precondition', 'Aucun booster acheté n’attend son ouverture.');
        packRef = db.doc(`packSecrets/${packId}`);
        const reservationSnapshot = await transaction.get(db.doc(`events/${packId}`));
        const packSnapshot = await transaction.get(packRef);
        reservation = reservationSnapshot.exists ? reservationSnapshot.data() : null;
        const pack = packSnapshot.exists ? packSnapshot.data() : null;
        requireCondition(reservation?.actor === uid && reservation.kind === 'reserve'
          && pack?.id === packId && pack.actor === uid && pack.tier === reservation.data.tier
          && Array.isArray(pack.cards) && pack.cards.length === 4 && pack.cards.every(cardId => CARD_BY_ID.has(cardId)),
        'failed-precondition', 'La réservation du booster nécessite une vérification.');
        openedCards = [...pack.cards];
      }
      const serverTime = now();
      requireCondition(integer(serverTime, 0, 8_640_000_000_000_000), 'internal', 'Horloge serveur indisponible.');
      const at = timestamp(serverTime);
      for (const profile of Object.values(profiles)) {
        requireCondition(milliseconds(profile.lastClaim) <= serverTime, 'failed-precondition', 'L’horloge du profil est en avance. Réessaie dans un instant.');
      }
      let prepared;
      try {
        prepared = transition({ kind, actor: uid, eventId: id, at, data, profiles, listing, reservation,
          draw: () => openedCards.map(cardId => CARD_BY_ID.get(cardId)) });
      } catch (error) {
        if (error.constructor === Error) throw new GameError('failed-precondition', error.message);
        throw error;
      }
      if (kind === 'reserve') {
        reservedCards ??= draw(data.tier).map(card => card.id);
        requireCondition(reservedCards.length === 4 && reservedCards.every(cardId => CARD_BY_ID.has(cardId)),
          'internal', 'Le tirage du booster a échoué.');
        transaction.create(db.doc(`packSecrets/${id}`), firestoreValues({
          version: 1, id, actor: uid, tier: data.tier, cards: reservedCards, createdAt: at
        }));
      }
      for (const [participant, profile] of Object.entries(prepared.profiles)) {
        const ref = db.doc(`players/${participant}`);
        if (kind === 'register') transaction.create(ref, firestoreValues(profile));
        else transaction.set(ref, firestoreValues(profile));
      }
      if (marketKinds.has(kind) && prepared.listing) transaction.set(listingRef, firestoreValues(prepared.listing));
      if (kind === 'open') transaction.delete(packRef);
      const result = { id, kind, alreadyApplied: false, revealed: openedCards };
      transaction.create(receiptRef, firestoreValues({
        version: 1, id, actor: uid, kind, at, clockAt: at, data, result
      }));
      return result;
    }, { maxAttempts: 5 });
  };
}
