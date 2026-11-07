import { CARDS, RARITIES, SHOP_MS, CARD_BY_ID, shopOffer, milliseconds } from './game-model.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const coins = value => `${number.format((Number(value) || 0) / 1000)} pièces`;
const date = value => value ? new Date(milliseconds(value)).toLocaleString('fr-FR') : '—';
const searchText = value => String(value).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
const state = { gateway: null, user: null, profile: null, known: false, cached: true, working: false, route: '', collectionTab: 'owned', marketType: 'fixed', listings: [], marketKnown: false, marketCached: true, marketError: '', marketKey: '', register: true };
let stopProfile;
let stopMarket;
let authGeneration = 0;
let toastTimer;
let messageFor = error => error?.message || 'Cette opération n’a pas pu être terminée.';

function errorMessage(error) {
  const element = $('#global-error');
  element.textContent = error ? messageFor(error) : '';
  element.hidden = !error;
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}
function openDialog(id) {
  const dialog = $(`#${id}`);
  if (!dialog.open) dialog.showModal();
}
function pendingState() {
  if (!state.gateway || !state.user) return { item: null, error: '' };
  try { return { item: state.gateway.pending(), error: '' }; }
  catch (error) { return { item: null, error: messageFor(error) }; }
}
function writable() {
  const pending = pendingState();
  return Boolean(state.user && state.profile && state.known && !state.cached && navigator.onLine && !state.working && !pending.item && !pending.error);
}
function updateControls() {
  const pending = pendingState();
  $('#pending-banner').hidden = !pending.item && !pending.error;
  $('#pending-message').textContent = pending.error || 'Une action attend sa confirmation. Vérifie cette même transaction avant de recommencer.';
  $('#retry-pending').disabled = !pending.item || state.working || !navigator.onLine;
  document.querySelectorAll('[data-game-control]').forEach(button => { button.disabled = !writable() || button.dataset.unavailable === 'true'; });
  $('#claim-income').disabled = !writable() || Date.now() - milliseconds(state.profile?.lastClaim || { seconds: 0, nanoseconds: 0 }) < 61_500;
  $('#profile-form button').disabled = !state.gateway || !state.user || !state.known || state.cached || state.working || Boolean(pending.item || pending.error) || !navigator.onLine;
  $('#auth-submit').disabled = !state.gateway || state.working;
  $('#reset-password').disabled = !state.gateway || state.working;
  $('#logout').disabled = state.working || Boolean(pending.item || pending.error);
  const online = navigator.onLine;
  $('#status-dot').classList.toggle('offline', !online || Boolean(state.user && state.cached));
  $('#connection-status').textContent = !online ? 'Hors ligne — transactions désactivées.' : !state.gateway ? 'Connexion Firebase indisponible — catalogue consultable.' : !state.user ? 'Catalogue public · connecte-toi pour jouer.' : !state.known ? 'Lecture de ta collection dans Firebase…' : state.cached ? 'Données en cache — confirmation du serveur attendue.' : 'Collection synchronisée avec Firebase.';
}
function cardMarkup(card, mode = 'catalogue') {
  const rarity = RARITIES[card.rarity];
  const profile = state.profile;
  const count = profile?.cards?.[card.id] || 0;
  const available = profile?.available?.[card.id] || 0;
  const discovered = Boolean(profile?.discoveries?.[card.id]);
  return `<article class="animal-card${mode === 'index' && !discovered ? ' undiscovered' : ''}" data-card-id="${escape(card.id)}"><div class="card-art"><span class="card-number">N° ${String(card.number).padStart(3, '0')}</span>${mode !== 'catalogue' ? `<span class="card-count">× ${count}</span>` : ''}<span class="card-emoji" aria-hidden="true">${escape(card.emoji)}</span></div><div class="card-body"><span class="rarity" style="--rarity-color:${rarity.color}">${escape(rarity.name)}</span><h3>${escape(card.name)}</h3><p class="card-habitat">${escape(card.habitat)}</p><div class="card-meta"><span>${coins(card.income)} / h</span><span>Chance +${number.format(card.luck / 1000)} %</span></div>${mode !== 'catalogue' ? `<p class="card-state">${discovered ? 'Découverte enregistrée' : 'Pas encore découverte'} · ${available} disponible(s)</p>${available > 0 ? `<button class="button outline small" type="button" data-list-card="${escape(card.id)}" data-game-control>Proposer au marché</button>` : ''}` : '<p class="card-state">Aperçu du catalogue · carte non attribuée</p>'}</div></article>`;
}
function renderCatalogue() {
  const term = searchText($('#catalogue-search').value);
  const rarity = $('#catalogue-rarity').value;
  const cards = CARDS.filter(card => (rarity === 'all' || String(card.rarity) === rarity) && searchText(`${card.name} ${card.habitat}`).includes(term));
  $('#catalogue-count').textContent = `${cards.length} espèce(s) sur ${CARDS.length}`;
  $('#catalogue-grid').innerHTML = cards.map(card => cardMarkup(card)).join('') || '<p class="muted">Aucune espèce ne correspond à cette recherche.</p>';
}
function renderCollectionCards() {
  const input = $('#collection-search');
  if (!input || !state.profile) return;
  const term = searchText(input.value);
  const cards = CARDS.filter(card => (state.collectionTab === 'index' || state.profile.cards[card.id] > 0) && searchText(`${card.name} ${card.habitat}`).includes(term));
  $('#collection-count').textContent = `${cards.length} espèce(s) affichée(s)`;
  $('#collection-grid').innerHTML = cards.map(card => cardMarkup(card, state.collectionTab)).join('') || '<p class="muted">Aucune carte ne correspond à cette recherche.</p>';
  updateControls();
}
function renderCollection() {
  $('#player-content').innerHTML = `<div class="segmented" role="group" aria-label="Vue de la collection"><button type="button" data-collection-tab="owned" aria-pressed="${state.collectionTab === 'owned'}">Mes cartes</button><button type="button" data-collection-tab="index" aria-pressed="${state.collectionTab === 'index'}">Index des découvertes</button></div><div class="filters"><label class="search-label" for="collection-search">Rechercher une espèce<input id="collection-search" type="search" placeholder="Nom ou habitat"></label></div><p id="collection-count" class="result-count" role="status"></p><div id="collection-grid" class="card-grid"></div>`;
  renderCollectionCards();
}
function renderShop() {
  const profile = state.profile;
  const expired = Date.now() >= milliseconds(profile.shopAt) + SHOP_MS + 1500;
  const offers = Array.from({ length: 6 }, (_, slot) => shopOffer(profile, slot));
  $('#player-content').innerHTML = `${profile.pendingPack ? '<div class="notice"><p>Un booster acheté attend son ouverture. Son contenu ne sera attribué qu’après confirmation de la transaction.</p><button class="button primary" type="button" data-open-pack data-game-control>Ouvrir mon booster</button></div>' : ''}<div class="toolbar"><p>Renouvellement disponible dans <strong data-shop-clock></strong></p><button class="button outline small" type="button" data-refresh-shop data-game-control data-unavailable="${!expired}">Renouveler la boutique</button></div><div class="shop-grid">${offers.map(offer => `<article class="pack-card"><div class="pack-art"><div class="pack-sleeve"><small>ANIMAL CARDS</small><span aria-hidden="true">✳</span><strong>${escape(RARITIES[offer.tier].name)}</strong><small>4 CARTES</small></div></div><div class="pack-body"><span class="rarity" style="--rarity-color:${RARITIES[offer.tier].color}">${escape(RARITIES[offer.tier].name)}</span><h3>Une nouvelle rencontre.</h3><p>Au moins une carte de cette rareté ou supérieure.</p><div class="pack-price"><strong>${coins(offer.priceMilli)}</strong><small>${offer.stock} en stock</small></div><button class="button primary" type="button" data-reserve-slot="${offer.slot}" data-game-control data-unavailable="${expired || offer.stock <= 0 || Boolean(profile.pendingPack) || profile.balanceMilli < offer.priceMilli}">Acheter ce booster</button></div></article>`).join('')}</div>`;
  updateClocks();
}
function stopMarketWatch() {
  stopMarket?.();
  stopMarket = undefined;
  state.marketKey = '';
}
function startMarketWatch() {
  if (!state.gateway || !state.user || !state.profile || state.route !== 'marche') return;
  const key = `${state.user.uid}:${state.marketType}`;
  if (state.marketKey === key) return;
  stopMarketWatch();
  state.marketKey = key;
  state.listings = [];
  state.marketKnown = false;
  state.marketCached = true;
  state.marketError = '';
  stopMarket = state.gateway.watchMarket(state.marketType, (listings, meta) => {
    if (state.marketKey !== key) return;
    state.listings = listings;
    state.marketKnown = true;
    state.marketCached = meta.fromCache;
    renderMarket();
  }, error => {
    if (state.marketKey !== key) return;
    state.marketError = messageFor(error);
    renderMarket();
  });
}
function marketMarkup(listing) {
  const card = CARD_BY_ID.get(listing.cardId);
  if (!card || typeof listing.id !== 'string') return '';
  const mine = listing.sellerId === state.user.uid;
  const expired = Date.now() >= milliseconds(listing.endsAt);
  const active = listing.status === 'active';
  const actionButton = (kind, label) => `<button class="button outline small" type="button" data-market-action="${kind}" data-listing-id="${escape(listing.id)}" data-game-control data-unavailable="${state.marketCached}">${label}</button>`;
  let actions = '';
  if (active && mine && !listing.bidderId) actions += actionButton('cancel', 'Retirer');
  if (active && listing.type === 'auction' && expired) actions += actionButton('settle', 'Clôturer');
  if (active && !mine && !expired) actions += actionButton({ fixed: 'buy', trade: 'trade', auction: 'bid' }[listing.type], { fixed: 'Acheter', trade: 'Échanger', auction: 'Enchérir' }[listing.type]);
  const price = listing.type === 'trade' ? `Contre ${escape(CARD_BY_ID.get(listing.wantedCardId)?.name || 'une espèce inconnue')}` : coins(listing.bidMilli || listing.priceMilli);
  return `<article class="market-entry"><div class="market-animal" aria-hidden="true">${escape(card.emoji)}</div><div class="market-details"><span class="rarity" style="--rarity-color:${RARITIES[card.rarity].color}">${escape(RARITIES[card.rarity].name)}</span><h3>${escape(card.name)}</h3><p>Proposé par ${escape(listing.sellerName)}${mine ? ' · ton offre' : ''}</p><p>Fin : ${escape(date(listing.endsAt))} · ${escape(listing.status)}${expired && active ? ' · délai écoulé' : ''}</p>${listing.bidderId ? `<p>Dernière enchère : ${escape(listing.bidderName)}</p>` : ''}</div><div class="market-price">${price}</div><div class="market-actions">${actions}</div></article>`;
}
function renderMarket() {
  if (state.route !== 'marche' || !state.profile) return;
  const tabs = { fixed: 'Ventes', auction: 'Enchères', trade: 'Échanges', history: 'Historique' };
  const status = state.marketError || (!state.marketKnown ? 'Chargement des propositions réelles…' : state.marketCached ? 'Résultats en cache : leur disponibilité n’est pas confirmée.' : `${state.listings.length} proposition(s) récente(s), au maximum 40.`);
  $('#player-content').innerHTML = `<div class="segmented" role="group" aria-label="Type de marché">${Object.entries(tabs).map(([type, name]) => `<button type="button" data-market-type="${type}" aria-pressed="${state.marketType === type}">${name}</button>`).join('')}</div><p class="result-count" role="status">${escape(status)}</p><div class="market-list">${state.marketError ? '<p class="notice danger">Le marché ne peut pas être lu. Aucune offre fictive ne remplace cette erreur.</p>' : state.listings.map(marketMarkup).join('') || (state.marketKnown && !state.marketCached ? '<div class="empty-state"><h2>Le marché est calme.</h2><p>Aucune proposition dans cette catégorie. Tu peux proposer une carte depuis ta collection.</p></div>' : '')}</div>`;
  updateControls();
}
function render() {
  const guest = !state.user || !state.profile;
  $('#open-auth').hidden = Boolean(state.user);
  $('#signed-account').hidden = !state.user;
  $('#account-name').textContent = state.profile?.username || state.user?.displayName || 'Mon compte';
  $('#profile-setup').hidden = !state.user || !state.known || state.cached || Boolean(state.profile);
  $('#discovery-view').hidden = state.route !== 'decouvrir';
  $('#player-view').hidden = state.route === 'decouvrir' || guest;
  $('#signin-required').hidden = state.route === 'decouvrir' || Boolean(state.user);
  document.querySelectorAll('[data-route]').forEach(link => {
    if (link.dataset.route === state.route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (state.profile) {
    $('#wallet-balance').textContent = coins(state.profile.balanceMilli);
    $('#wallet-income').textContent = `Revenu : ${coins(state.profile.incomeMilli)} / h`;
    $('#owned-count').textContent = number.format(state.profile.ownedCount);
    $('#discovered-count').textContent = `${Object.keys(state.profile.discoveries).length} / ${CARDS.length}`;
    $('#luck-value').textContent = `+${number.format(state.profile.luckMilliPercent / 1000)} %`;
    $('#page-title').textContent = { collection: 'Ma collection.', boutique: 'La boutique.', marche: 'Entre collectionneurs.' }[state.route] || 'Mon carnet.';
    $('#page-description').textContent = state.cached ? 'Données en cache : les actions restent désactivées.' : 'Les données affichées proviennent de ton profil Firebase.';
    try {
      if (state.route === 'collection') renderCollection();
      if (state.route === 'boutique') renderShop();
      if (state.route === 'marche') { startMarketWatch(); renderMarket(); }
    } catch (error) { errorMessage(error); }
  }
  updateControls();
}
function navigate() {
  const route = location.hash.slice(1);
  state.route = ['collection', 'boutique', 'marche'].includes(route) ? route : 'decouvrir';
  if (state.route !== 'marche') stopMarketWatch();
  render();
}
async function run(operation, success) {
  if (state.working) return;
  state.working = true;
  errorMessage(null);
  updateControls();
  try {
    const result = await operation();
    if (success) await success(result);
    return result;
  } catch (error) { errorMessage(error); }
  finally { state.working = false; render(); }
}
function requireWrite(profileRequired = true) {
  if (!state.gateway || !state.user) throw new Error('Connecte-toi pour continuer.');
  if (!navigator.onLine || state.cached || !state.known) throw new Error('Attends la confirmation de Firebase avant cette action.');
  if (profileRequired && !state.profile) throw new Error('Crée d’abord ton profil de collectionneur.');
}
async function act(kind, data = {}) {
  requireWrite(kind !== 'register');
  const result = await state.gateway.action(kind, data);
  if (result.revealed?.length) {
    $('#action-title').textContent = 'Tes nouvelles rencontres.';
    $('#action-content').innerHTML = `<p>Ouverture confirmée par Firebase.</p><div class="reveal-grid">${result.revealed.map(id => CARD_BY_ID.get(id)).filter(Boolean).map(card => cardMarkup(card)).join('')}</div>`;
    openDialog('action-dialog');
  } else {
    $('#action-dialog').close();
    toast(result.alreadyApplied ? 'Cette transaction était déjà enregistrée : elle n’a pas été appliquée une deuxième fois.' : 'Transaction confirmée par Firebase.');
  }
  return result;
}
function listDialog(cardId) {
  if (!writable()) throw new Error('La collection doit être synchronisée avant de proposer une carte.');
  const card = CARD_BY_ID.get(cardId);
  if (!card || !state.profile.available[cardId]) throw new Error('Cette carte n’est pas disponible.');
  $('#action-title').textContent = `Proposer : ${card.name}`;
  $('#action-content').innerHTML = `<form data-action-form="list" data-card-id="${escape(card.id)}"><label for="listing-type">Type de proposition</label><select id="listing-type" name="type"><option value="fixed">Vente à prix fixe</option><option value="auction">Enchère</option><option value="trade">Échange</option></select><div id="listing-price-field"><label for="listing-price">Prix ou enchère de départ (pièces)</label><input id="listing-price" name="price" type="number" min="1" max="1000000" step="0.001" value="${card.value}" required></div><div id="listing-wanted-field" hidden><label for="listing-wanted">Espèce souhaitée</label><select id="listing-wanted" name="wanted">${CARDS.filter(item => item.id !== card.id).map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('')}</select></div><label for="listing-duration">Durée</label><select id="listing-duration" name="duration"><option value="300">5 minutes</option><option value="3600">1 heure</option><option value="86400">24 heures</option></select><p class="field-note">Une carte est réservée jusqu’au retrait ou à la conclusion de l’offre. Une enchère ne se clôture pas automatiquement.</p><button class="button primary wide" type="submit" data-game-control>Confirmer la proposition</button></form>`;
  openDialog('action-dialog');
  updateControls();
}
function marketDialog(kind, id) {
  if (!['buy', 'trade', 'bid', 'cancel', 'settle'].includes(kind)) return;
  const listing = state.listings.find(item => item.id === id);
  if (!listing || !writable() || state.marketCached) throw new Error('Recharge les propositions du marché avant cette action.');
  const card = CARD_BY_ID.get(listing.cardId);
  const minimum = listing.bidderId ? listing.bidMilli + 1000 : listing.priceMilli;
  $('#action-title').textContent = { buy: 'Confirmer cet achat.', trade: 'Confirmer cet échange.', bid: 'Proposer une enchère.', cancel: 'Retirer cette proposition.', settle: 'Clôturer cette enchère.' }[kind];
  $('#action-content').innerHTML = `<form data-action-form="${kind}" data-listing-id="${escape(id)}"><p>${escape(card.name)} · ${kind === 'trade' ? `contre ${escape(CARD_BY_ID.get(listing.wantedCardId)?.name)}` : coins(listing.bidMilli || listing.priceMilli)}</p>${kind === 'bid' ? `<label for="bid-amount">Ton enchère (pièces)</label><input id="bid-amount" name="amount" type="number" min="${minimum / 1000}" max="1000000" step="0.001" value="${minimum / 1000}" required>` : ''}<p class="field-note">Firebase vérifiera à nouveau les données avant de confirmer. Aucune réussite n’est affichée avant cette confirmation.</p><button class="button primary wide" type="submit" data-game-control>Confirmer</button></form>`;
  openDialog('action-dialog');
  updateControls();
}
function parsePrice(raw) {
  if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) throw new Error('Saisis un prix positif avec au maximum trois décimales.');
  const value = Math.round(Number(raw) * 1000);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 1_000_000_000) throw new Error('Le prix doit être compris entre 1 et 1 000 000 pièces.');
  return value;
}
function setAuthMode(register) {
  state.register = register;
  $('#register-name-field').hidden = !register;
  $('#auth-username').required = register;
  $('#auth-password').minLength = register ? 12 : 1;
  $('#auth-password').autocomplete = register ? 'new-password' : 'current-password';
  $('#password-hint').hidden = !register;
  $('#reset-password').hidden = register;
  $('#auth-submit').textContent = register ? 'Créer mon compte' : 'Se connecter';
  $('#choose-register').setAttribute('aria-pressed', String(register));
  $('#choose-login').setAttribute('aria-pressed', String(!register));
  $('#choose-register').classList.toggle('active', register);
  $('#choose-login').classList.toggle('active', !register);
  $('#auth-error').textContent = '';
}
function updateClocks() {
  if (!state.profile) return;
  const remaining = Math.max(0, milliseconds(state.profile.shopAt) + SHOP_MS + 1500 - Date.now());
  const label = remaining ? `${Math.floor(remaining / 60000)} min ${String(Math.ceil(remaining / 1000) % 60).padStart(2, '0')} s` : 'disponible maintenant';
  document.querySelectorAll('[data-shop-clock]').forEach(element => { element.textContent = label; });
  const refresh = $('[data-refresh-shop]');
  if (refresh) refresh.dataset.unavailable = String(remaining > 0);
  if (!remaining) document.querySelectorAll('[data-reserve-slot]').forEach(button => { button.dataset.unavailable = 'true'; });
}

$('#catalogue-rarity').insertAdjacentHTML('beforeend', RARITIES.map((rarity, index) => `<option value="${index}">${escape(rarity.name)}</option>`).join(''));
$('#catalogue-search').addEventListener('input', renderCatalogue);
$('#catalogue-rarity').addEventListener('change', renderCatalogue);
$('#choose-register').addEventListener('click', () => setAuthMode(true));
$('#choose-login').addEventListener('click', () => setAuthMode(false));
for (const id of ['open-auth', 'signin-required-button']) $(`#${id}`).addEventListener('click', () => openDialog('auth-dialog'));
$('#hero-start').addEventListener('click', () => { if (state.user) location.hash = 'collection'; else openDialog('auth-dialog'); });
$('#open-help').addEventListener('click', () => openDialog('help-dialog'));
$('#open-credits').addEventListener('click', () => openDialog('credits-dialog'));
$('#logout').addEventListener('click', () => run(() => state.gateway.logout(), () => { location.hash = 'decouvrir'; toast('Tu es déconnecté.'); }));
$('#claim-income').addEventListener('click', () => run(() => act('claim')));
$('#retry-pending').addEventListener('click', () => run(() => state.gateway.retryPending(), result => {
  if (result.revealed?.length) {
    $('#action-title').textContent = 'Tes nouvelles rencontres.';
    $('#action-content').innerHTML = `<p>Ouverture retrouvée et confirmée par le serveur.</p><div class="reveal-grid">${result.revealed.map(id => CARD_BY_ID.get(id)).filter(Boolean).map(card => cardMarkup(card)).join('')}</div>`;
    openDialog('action-dialog');
  } else {
    toast(result.alreadyApplied ? 'Transaction déjà enregistrée, aucun doublon créé.' : 'Transaction confirmée.');
  }
}));
$('#profile-form').addEventListener('submit', event => {
  event.preventDefault();
  const username = $('#profile-username').value.trim();
  run(() => act('register', { username }));
});
$('#auth-form').addEventListener('submit', event => {
  event.preventDefault();
  const email = $('#auth-email').value;
  const password = $('#auth-password').value;
  const username = $('#auth-username').value.trim();
  run(async () => {
    try {
      if (!state.gateway) throw new Error('La connexion Firebase n’est pas disponible.');
      if (state.register) { await state.gateway.register(email, password, username); $('#profile-username').value = username; }
      else await state.gateway.login(email, password);
      $('#auth-password').value = '';
      $('#auth-dialog').close();
      location.hash = 'collection';
      toast('Compte connecté. La collection est chargée séparément depuis Firebase.');
    } catch (error) { $('#auth-error').textContent = messageFor(error); throw error; }
  });
});
$('#reset-password').addEventListener('click', () => run(async () => {
  if (!$('#auth-email').reportValidity()) return;
  await state.gateway.resetPassword($('#auth-email').value);
  toast('Si un compte correspond à cette adresse, les instructions de réinitialisation peuvent lui être envoyées.');
}));
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  try {
    if (button.hasAttribute('data-close-dialog')) button.closest('dialog').close();
    if (button.dataset.collectionTab) { state.collectionTab = button.dataset.collectionTab; renderCollection(); }
    if (button.dataset.marketType) { state.marketType = button.dataset.marketType; startMarketWatch(); renderMarket(); }
    if (button.dataset.listCard) listDialog(button.dataset.listCard);
    if (button.dataset.marketAction) marketDialog(button.dataset.marketAction, button.dataset.listingId);
    if (button.hasAttribute('data-open-pack')) run(() => act('open'));
    if (button.hasAttribute('data-refresh-shop')) run(() => act('refresh'));
    if (button.hasAttribute('data-reserve-slot')) {
      const slot = Number(button.dataset.reserveSlot);
      const offer = shopOffer(state.profile, slot);
      run(() => act('reserve', { slot, tier: offer.tier }));
    }
  } catch (error) { errorMessage(error); }
});
document.addEventListener('input', event => { if (event.target.id === 'collection-search') renderCollectionCards(); });
document.addEventListener('change', event => {
  if (event.target.id !== 'listing-type') return;
  const trade = event.target.value === 'trade';
  $('#listing-price-field').hidden = trade;
  $('#listing-price').required = !trade;
  $('#listing-wanted-field').hidden = !trade;
});
$('#action-content').addEventListener('submit', event => {
  const form = event.target.closest('[data-action-form]');
  if (!form) return;
  event.preventDefault();
  run(async () => {
    const fields = new FormData(form);
    const kind = form.dataset.actionForm;
    if (kind === 'list') {
      const type = fields.get('type');
      await act('list', { listingId: crypto.randomUUID(), cardId: form.dataset.cardId, type, priceMilli: type === 'trade' ? 0 : parsePrice(fields.get('price')), wantedCardId: type === 'trade' ? fields.get('wanted') : '', durationSeconds: Number(fields.get('duration')) });
    } else {
      const data = { listingId: form.dataset.listingId };
      if (kind === 'bid') data.amountMilli = parsePrice(fields.get('amount'));
      await act(kind, data);
    }
  });
});
window.addEventListener('hashchange', navigate);
window.addEventListener('online', updateControls);
window.addEventListener('offline', updateControls);
setInterval(() => { updateClocks(); updateControls(); }, 1000);
renderCatalogue();
navigate();

async function initialize() {
  try {
    const module = await import('./firebase-client.js');
    messageFor = module.userMessage;
    const gateway = new module.GameGateway();
    await gateway.ready();
    state.gateway = gateway;
    gateway.watchAuth(user => {
      const generation = ++authGeneration;
      stopProfile?.();
      stopMarketWatch();
      state.user = user;
      state.profile = null;
      state.known = false;
      state.cached = true;
      state.listings = [];
      errorMessage(null);
      if (user) {
        stopProfile = gateway.watchProfile((profile, meta) => {
          if (generation !== authGeneration) return;
          state.profile = profile;
          state.known = true;
          state.cached = meta.fromCache;
          if (!$('#profile-username').value) $('#profile-username').value = user.displayName || '';
          render();
        }, error => {
          if (generation !== authGeneration) return;
          state.cached = true;
          errorMessage(error);
          render();
        });
      }
      render();
    });
    render();
  } catch (error) { errorMessage(error); updateControls(); }
}
initialize();
