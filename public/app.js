const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = (value, digits = 2) => Number(value).toLocaleString('fr-FR', { maximumFractionDigits: digits });
const coins = milli => number(milli / 1000);
const bonus = milli => `+${number(milli / 1000, 3)} %`;
const titles = { boutique: 'Boutique', inventaire: 'Inventaire', encheres: 'Enchères', index: 'Index' };
const model = {
  catalog: null, cards: new Map(), images: {}, state: null, csrf: '', tab: 'boutique', auth: 'register',
  busy: false, syncing: false, revision: 0, offset: 0, pending: null, opening: null, marketSequence: 0,
  marketType: 'fixed', marketPage: 0, mine: false, market: null, inventoryLimit: 60, lastShopSync: 0,
  filters: { inventaire: { search: '', rarity: '' }, index: { search: '', rarity: '' }, encheres: { search: '', rarity: '' } }
};
class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}
async function request(path, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'X-Animal-Client': '1', 'X-CSRF-Token': model.csrf },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    let data;
    try { data = await response.json(); } catch { throw new ApiError('Réponse illisible du serveur.', response.ok ? 0 : response.status); }
    if (!response.ok) throw new ApiError(data.error || `Erreur HTTP ${response.status}.`, response.status);
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError' ? 'Le serveur met trop de temps à répondre.' : 'Connexion interrompue. Vérifie ton réseau.');
  } finally { clearTimeout(timeout); }
}
function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toasts').append(element);
  setTimeout(() => element.remove(), 6500);
}
function connection(message = '') {
  $('#sync-warning').hidden = !message;
  $('#sync-warning').textContent = message;
  $('#connection-label').textContent = message ? 'Synchronisation interrompue' : 'Serveur connecté';
  $('.connection').classList.toggle('offline', Boolean(message));
}
function pendingStorageKey() { return `animal-cards.pending.${model.state.user.id}`; }
function readPending() {
  const raw = localStorage.getItem(pendingStorageKey());
  if (!raw) return null;
  const pending = JSON.parse(raw);
  if (!pending || typeof pending.key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(pending.key) || typeof pending.kind !== 'string' || !pending.data || typeof pending.data !== 'object' || Array.isArray(pending.data)) throw new Error('Transaction sauvegardée illisible. Ne vide pas le stockage avant vérification.');
  return pending;
}
function transactionButtons() {
  const blocked = model.busy || Boolean(model.pending);
  $$('[data-transaction]').forEach(button => { button.disabled = blocked || button.dataset.unavailable === 'true'; });
  $('#pending-banner').hidden = !model.pending;
  $('#retry-pending').disabled = model.busy;
}
function transactionButton(label, command, attributes = '', unavailable = false, style = 'primary') {
  return `<button class="button ${style}" data-command="${command}" data-transaction data-unavailable="${unavailable}" ${attributes} ${unavailable || model.busy || model.pending ? 'disabled' : ''}>${escapeHTML(label)}</button>`;
}
function cardHTML(card, { interactive = false, itemId = '', count = 0, locked = '', unknown = false, mini = false } = {}) {
  const tag = interactive ? 'button' : 'div';
  const photo = model.images[card.id];
  const src = typeof photo?.src === 'string' && /^\/animals\/[a-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(photo.src) ? photo.src : '';
  return `<${tag} class="card r${card.rarity}${unknown ? ' undiscovered' : ''}${mini ? ' mini' : ''}" ${interactive ? `type="button" data-card-id="${card.id}" data-item-id="${escapeHTML(itemId)}" aria-label="${escapeHTML(card.name)}, ${escapeHTML(model.catalog.rarities[card.rarity].name)}${unknown ? ', non découvert' : ''}"` : ''}>
    <div class="card-inner"><div class="card-art"><span class="card-emoji" aria-hidden="true">${card.emoji}</span>${src && !unknown ? `<img src="${src}" alt="" loading="lazy" decoding="async">` : ''}<span class="card-number">#${String(card.number).padStart(3, '0')}</span><span class="card-badge">${escapeHTML(model.catalog.rarities[card.rarity].name)}</span></div><div class="card-body"><div class="card-name">${escapeHTML(card.name)}</div><div class="card-meta"><span>${unknown ? 'À découvrir' : `${coins(card.income)} / h`}</span><b>◈ ${number(card.value, 0)}</b></div></div></div>${count > 1 ? `<span class="card-count">×${count}</span>` : ''}${locked ? `<span class="card-lock">${locked === 'trade' ? 'Réservée · échange' : 'Réservée · vente'}</span>` : ''}<span class="holo" aria-hidden="true"></span></${tag}>`;
}
function pageHead(eyebrow, title, description, extra = '') {
  return `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${extra}</div>`;
}
function filterToolbar(tab) {
  const filter = model.filters[tab];
  return `<div class="toolbar"><input type="search" id="filter-search" data-filter="search" aria-label="Rechercher un animal" placeholder="Rechercher un animal…" maxlength="80" value="${escapeHTML(filter.search)}"><select id="filter-rarity" data-filter="rarity" aria-label="Filtrer par rareté"><option value="">Toutes les raretés</option>${model.catalog.rarities.map((rarity, index) => `<option value="${index}" ${filter.rarity === String(index) ? 'selected' : ''}>${escapeHTML(rarity.name)}</option>`).join('')}</select>${tab === 'encheres' ? `<label class="row"><input type="checkbox" id="filter-mine" ${model.mine ? 'checked' : ''}> Mes offres et participations</label>` : ''}</div>`;
}
function matches(card, filter) {
  return card.name.toLocaleLowerCase('fr').includes(filter.search.toLocaleLowerCase('fr')) && (filter.rarity === '' || card.rarity === Number(filter.rarity));
}
function probabilitiesHTML(probabilities) {
  return `<div class="prob-bars">${model.catalog.rarities.map((rarity, index) => `<div class="prob-row r${index}"><span>${escapeHTML(rarity.name)}</span><span class="bar"><i style="width:${Math.max(0.2, probabilities[index] * 100)}%"></i></span><b>${number(probabilities[index] * 100, 3)} %</b></div>`).join('')}</div>`;
}
function renderChrome() {
  if (!model.state) return;
  const { user, discoveredIds, inventory } = model.state;
  $('#wallet-balance').textContent = coins(user.balanceMilli);
  $('#wallet-luck').textContent = bonus(user.luckMilliPercent);
  $('#profile-name').textContent = user.username;
  $('#avatar').textContent = [...user.username][0].toLocaleUpperCase('fr');
  $('#nav-count').textContent = number(inventory.length, 0);
  $('#side-discovered').textContent = `${discoveredIds.length} / ${model.catalog.cards.length}`;
  $('#side-progress').max = model.catalog.cards.length;
  $('#side-progress').value = discoveredIds.length;
  $('#page-label').textContent = titles[model.tab];
  $$('[data-tab]').forEach(button => {
    const active = button.dataset.tab === model.tab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  transactionButtons();
}
function renderShop() {
  const { shop, user } = model.state;
  $('#main-content').innerHTML = pageHead('UNE NOUVELLE RENCONTRE T’ATTEND', 'La boutique sauvage.', 'Six offres personnelles. Quatre cartes par booster. Une découverte à chaque ouverture.', '<button class="button subtle" data-command="refresh">↻ Actualiser</button>') +
    `<div class="shop-hero"><div><div class="eyebrow">PROCHAIN RENOUVELLEMENT</div><div class="countdown" data-countdown="${shop.expiresAt}">--:--</div><span class="muted">Les stocks sont propres à ton compte.</span></div><div><div class="eyebrow">CHANCE UTILISÉE POUR CETTE BOUTIQUE</div><div class="big-luck">${bonus(shop.luckUsedMilliPercent)}</div><span class="muted">Prochain tirage : ${bonus(user.luckMilliPercent)}</span></div></div>
    <div class="shop-grid">${shop.offers.map(offer => {
      const rarity = model.catalog.rarities[offer.rarity];
      const unavailable = offer.stock < 1 || user.balanceMilli < offer.priceMilli || shop.expiresAt <= serverNow();
      return `<article class="pack r${offer.rarity}${offer.stock < 1 ? ' soldout' : ''}"><div class="pack-art" aria-hidden="true"><span class="pack-logo">✦</span><span class="pack-title">ANIMAL CARDS</span></div><div class="pack-info"><h3>Booster ${escapeHTML(rarity.name)}</h3><span class="stock ${offer.stock <= 2 ? 'low' : ''}">×${offer.stock}</span></div><div class="price">◈ ${coins(offer.priceMilli)}</div><div class="odds">4 cartes · Au moins une ${escapeHTML(rarity.name.toLocaleLowerCase('fr'))} ou supérieure.</div>${transactionButton(offer.stock < 1 ? 'Épuisé' : user.balanceMilli < offer.priceMilli ? 'Solde insuffisant' : 'Ouvrir ce booster ↗', 'buy-pack', `data-id="${offer.id}"`, unavailable)}<button class="text-button" data-command="pack-odds" data-tier="${offer.rarity}">Voir les probabilités</button></article>`;
    }).join('')}</div><details class="panel" style="margin-top:20px"><summary>Probabilités d’apparition des boosters dans cette boutique</summary><p class="muted">La première offre est toujours commune. Les cinq autres utilisent ces probabilités. La chance améliore l’apparition des boosters rares, pas le contenu d’un booster donné.</p>${probabilitiesHTML(shop.probabilities)}</details>`;
}
function renderInventory() {
  const { inventory, user } = model.state;
  const species = new Set(inventory.map(item => item.cardId));
  const value = inventory.reduce((sum, item) => sum + model.cards.get(item.cardId).value, 0);
  $('#main-content').innerHTML = pageHead('TA PROPRE RÉSERVE NATURELLE', 'Ta collection prend vie.', 'Les cartes possédées, même réservées, produisent un revenu passif.', '<button class="button subtle" data-command="help">ⓘ Comment jouer</button>') + `<div class="stats"><div class="stat"><small>Cartes possédées</small><strong>${number(inventory.length, 0)}</strong></div><div class="stat"><small>Espèces présentes</small><strong>${species.size}</strong></div><div class="stat"><small>Revenu passif</small><strong>◈ ${coins(user.incomeMilliPerHour)} / h</strong></div><div class="stat"><small>Valeur indicative</small><strong>◈ ${number(value, 0)}</strong></div></div>${filterToolbar('inventaire')}<div id="inventory-results"></div>`;
  renderInventoryResults();
}
function renderInventoryResults() {
  const groups = new Map();
  for (const item of model.state.inventory) {
    const card = model.cards.get(item.cardId);
    if (!matches(card, model.filters.inventaire)) continue;
    if (!groups.has(card.id)) groups.set(card.id, { card, items: [] });
    groups.get(card.id).items.push(item);
  }
  const entries = [...groups.values()].sort((a, b) => b.card.rarity - a.card.rarity || a.card.number - b.card.number);
  $('#inventory-results').innerHTML = entries.length ? `<div class="card-grid">${entries.slice(0, model.inventoryLimit).map(({ card, items }) => {
    const item = items.find(copy => !copy.locked) || items[0];
    return cardHTML(card, { interactive: true, itemId: item.id, count: items.length, locked: item.locked });
  }).join('')}</div>${entries.length > model.inventoryLimit ? '<div class="pager"><button class="button" data-command="more-inventory">Afficher la suite</button></div>' : ''}` : '<div class="empty">Aucune carte ne correspond à cette recherche. La boutique t’attend pour de nouvelles rencontres.</div>';
}
function renderIndex() {
  const { discoveredIds, user, shop } = model.state;
  $('#main-content').innerHTML = pageHead('LE CARNET D’EXPLORATION', 'Chaque rencontre compte.', `${discoveredIds.length} espèces découvertes sur ${model.catalog.cards.length}. Les découvertes restent acquises, même après une vente.`) + `<div class="luck-panel"><div class="panel"><div class="eyebrow">TON BONUS PERMANENT</div><div class="big-luck">${bonus(user.luckMilliPercent)}</div><p class="muted">Une première découverte offre des pièces et de la chance. Les doublons ne donnent pas de nouveau bonus. Ta chance est appliquée au prochain renouvellement de boutique.</p></div><div class="panel"><h3>Probabilités du prochain renouvellement</h3>${probabilitiesHTML(shop.nextProbabilities)}</div></div>${filterToolbar('index')}<div id="index-results"></div>`;
  renderIndexResults();
}
function renderIndexResults() {
  const discovered = new Set(model.state.discoveredIds);
  $('#index-results').innerHTML = model.catalog.rarities.map((rarity, index) => {
    const cards = model.catalog.cards.filter(card => card.rarity === index && matches(card, model.filters.index));
    if (!cards.length) return '';
    return `<section class="rarity-section r${index}"><div class="rarity-head"><h2>${escapeHTML(rarity.name)}</h2><span class="line"></span><span>${model.catalog.cards.filter(card => card.rarity === index && discovered.has(card.id)).length} / 8</span></div><div class="card-grid">${cards.map(card => cardHTML(card, { interactive: true, unknown: !discovered.has(card.id) })).join('')}</div></section>`;
  }).join('') || '<div class="empty">Aucun animal ne correspond à ta recherche.</div>';
}
function renderMarket() {
  $('#main-content').innerHTML = pageHead('LE RENDEZ-VOUS DES COLLECTIONNEURS', 'Le marché des joueurs.', 'Des offres réelles, des échanges directs et des enchères réglées par le serveur.', '<button class="button subtle" data-command="refresh">↻ Actualiser</button>') + `<div class="segmented" role="group" aria-label="Type de marché" style="margin-bottom:18px">${[['fixed', 'Ventes'], ['auction', 'Enchères'], ['trade', 'Échanges'], ['history', 'Historique']].map(([type, label]) => `<button data-market-type="${type}" class="${model.marketType === type ? 'active' : ''}" aria-pressed="${model.marketType === type}">${label}</button>`).join('')}</div>${filterToolbar('encheres')}<p class="muted">Pour proposer une carte, ouvre-la depuis ton inventaire. Une carte réservée ne peut pas être engagée deux fois.</p><div id="market-results" aria-live="polite"></div>`;
  void loadMarket();
}
async function loadMarket() {
  if (!model.state || model.tab !== 'encheres') return;
  const sequence = ++model.marketSequence;
  const userId = model.state.user.id;
  const type = model.marketType;
  const filter = model.filters.encheres;
  const target = $('#market-results');
  if (!target) return;
  target.setAttribute('aria-busy', 'true');
  if (!target.children.length) target.innerHTML = '<div class="empty">Recherche des offres…</div>';
  const query = new URLSearchParams({ type, search: filter.search, rarity: filter.rarity, page: String(model.marketPage), mine: String(model.mine) });
  try {
    const market = await request(`/api/market?${query}`);
    if (sequence !== model.marketSequence || model.state?.user.id !== userId || model.tab !== 'encheres') return;
    model.market = market;
    target.innerHTML = market.entries.length ? `<div class="market-list">${market.entries.map(entry => marketRow(entry, type)).join('')}</div>` : '<div class="empty">Aucune offre pour le moment. Les offres apparaîtront quand de vrais joueurs proposeront leurs cartes.</div>';
    target.innerHTML += `<div class="pager"><button class="button small" data-command="market-page" data-direction="-1" ${market.page < 1 ? 'disabled' : ''}>← Précédent</button><span>${number(market.total, 0)} offre(s) · Page ${market.page + 1}</span><button class="button small" data-command="market-page" data-direction="1" ${(market.page + 1) * 24 >= market.total ? 'disabled' : ''}>Suivant →</button></div>`;
    transactionButtons();
  } catch (error) {
    if (sequence !== model.marketSequence || model.tab !== 'encheres') return;
    target.innerHTML = `<div class="empty">${escapeHTML(error.message)}<p><button class="button" data-command="refresh">Réessayer</button></p></div>`;
    if (error.status === 401) showGuest();
  } finally { target.removeAttribute('aria-busy'); }
}
function marketRow(entry, type) {
  const card = model.cards.get(entry.cardId);
  const mine = entry.sellerId === model.state.user.id;
  let detail = `<span>Par ${escapeHTML(entry.seller)}</span>`;
  let actions = '';
  if (type === 'history') {
    detail = `<span>${escapeHTML(entry.seller)} → ${escapeHTML(entry.buyer)}</span><span>${new Date(entry.createdAt).toLocaleString('fr-FR')}</span>`;
    actions = `<strong class="price">◈ ${coins(entry.priceMilli)}</strong>`;
  } else if (type === 'trade') {
    const wanted = model.cards.get(entry.wantedCardId);
    detail += `<span>Recherche : ${escapeHTML(wanted.name)}</span>`;
    const eligible = model.state.inventory.some(item => item.cardId === entry.wantedCardId && !item.locked);
    actions = mine ? transactionButton('Annuler', 'cancel-trade', `data-id="${entry.id}"`, false, 'subtle') : transactionButton(eligible ? 'Échanger' : 'Carte demandée absente', 'accept-trade', `data-id="${entry.id}"`, !eligible);
  } else {
    if (type === 'auction') detail += `<span>Fin dans <b data-countdown="${entry.endsAt}">--:--</b></span><span>${entry.bidder ? `Meilleure offre : ${escapeHTML(entry.bidder)}` : 'Aucune offre'}</span>`;
    actions = `<strong class="price">◈ ${coins(entry.priceMilli)}</strong>`;
    if (mine) actions += transactionButton(entry.bidderId ? 'Offre reçue' : 'Annuler', 'cancel-listing', `data-id="${entry.id}"`, Boolean(entry.bidderId), 'subtle');
    else if (type === 'fixed') actions += transactionButton('Acheter', 'buy', `data-id="${entry.id}"`, model.state.user.balanceMilli < entry.priceMilli);
    else actions += transactionButton(entry.bidderId === model.state.user.id ? 'Surenchérir' : 'Enchérir', 'bid', `data-id="${entry.id}"`, false, 'gold');
  }
  return `<article class="market-row"><div>${cardHTML(card, { mini: true })}</div><div><h4>${escapeHTML(card.name)} ${mine ? '<span class="tag me">Ton offre</span>' : ''}${entry.bidderId === model.state.user.id ? '<span class="tag win">Tu mènes</span>' : ''}</h4><div class="sub">${detail}</div></div><div class="actions">${actions}</div></article>`;
}
function renderPage() {
  if (!model.state) return;
  renderChrome();
  if (model.tab === 'boutique') renderShop();
  else if (model.tab === 'inventaire') renderInventory();
  else if (model.tab === 'index') renderIndex();
  else renderMarket();
  updateCountdowns();
}
function acceptState(state) {
  model.state = state;
  model.offset = state.serverTime - Date.now();
  model.revision++;
  renderChrome();
}
function showGame(session) {
  model.csrf = session.csrf;
  acceptState(session.state);
  try { model.pending = readPending(); } catch (error) { model.pending = { unreadable: true }; connection(error.message); }
  $('#loading').hidden = true;
  $('#guest').hidden = true;
  $('#game').hidden = false;
  model.tab = titles[location.hash.slice(1)] ? location.hash.slice(1) : 'boutique';
  renderPage();
}
function showGuest() {
  model.state = null;
  model.csrf = '';
  model.pending = null;
  model.revision++;
  model.marketSequence++;
  closeModal();
  $('#loading').hidden = true;
  $('#game').hidden = true;
  $('#guest').hidden = false;
  if (model.catalog) $('#landing-cards').innerHTML = ['red-fox', 'tiger', 'wolf'].map(id => model.cards.get(id)).filter(Boolean).map(card => cardHTML(card)).join('');
}
function serverNow() { return Date.now() + model.offset; }
function updateCountdowns() {
  $$('[data-countdown]').forEach(element => {
    const seconds = Math.max(0, Math.ceil((Number(element.dataset.countdown) - serverNow()) / 1000));
    const hours = Math.floor(seconds / 3600);
    element.textContent = `${hours ? `${hours}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    element.classList.toggle('soon', seconds < 30);
  });
  if (model.state && !document.hidden && model.state.shop.expiresAt <= serverNow() && Date.now() - model.lastShopSync > 10000) {
    model.lastShopSync = Date.now();
    void sync();
  }
}
async function sync() {
  if (!model.state || model.syncing || model.busy) return;
  const revision = model.revision;
  const userId = model.state.user.id;
  model.syncing = true;
  try {
    const state = await request('/api/state');
    if (model.state?.user.id !== userId || model.revision !== revision || model.busy) return;
    const previousShop = model.state.shop.expiresAt;
    acceptState(state);
    if (!model.pending?.unreadable) connection();
    const editing = $('#main-content').contains(document.activeElement) && document.activeElement.matches('input,select,button');
    if (!$('#modal').open && !editing) renderPage();
    else if (previousShop !== state.shop.expiresAt && model.tab === 'boutique') toast('Une nouvelle boutique est disponible. Actualise la vue.');
  } catch (error) {
    if (model.state?.user.id !== userId) return;
    if (error.status === 401) { showGuest(); toast('Ta session a expiré. Reconnecte-toi.'); }
    else connection(error.message);
  } finally { model.syncing = false; }
}
function openModal(html) {
  model.opening = null;
  $('#modal-content').innerHTML = html;
  if (!$('#modal').open) $('#modal').showModal();
  transactionButtons();
}
function closeModal() {
  model.opening = null;
  if ($('#modal').open) $('#modal').close();
}
function detail(cardId, itemId = '') {
  const card = model.cards.get(cardId);
  if (!card || !model.state) return;
  const item = model.state.inventory.find(copy => copy.id === itemId);
  const discovered = model.state.discoveredIds.includes(cardId);
  const count = model.state.inventory.filter(copy => copy.cardId === cardId).length;
  openModal(`<div class="detail">${cardHTML(card, { unknown: !discovered })}<div><div class="eyebrow">${escapeHTML(model.catalog.rarities[card.rarity].name)} · #${String(card.number).padStart(3, '0')}</div><h2 id="modal-title">${escapeHTML(card.name)}</h2><p class="muted">${escapeHTML(card.habitat)}</p><dl class="kv"><dt>Valeur indicative</dt><dd>◈ ${number(card.value, 0)}</dd><dt>Revenu par carte</dt><dd>◈ ${coins(card.income)} / h</dd><dt>Première découverte</dt><dd>◈ ${coins(card.reward)}</dd><dt>Chance permanente</dt><dd>${bonus(card.luck)}</dd><dt>Dans l’inventaire</dt><dd>${count} exemplaire(s)</dd><dt>Index</dt><dd>${discovered ? 'Découvert définitivement' : 'Pas encore découvert'}</dd></dl></div></div>${item && !item.locked ? `<div class="row" style="margin-top:18px">${transactionButton('Vendre ou mettre aux enchères', 'list-form', `data-id="${item.id}"`)}${transactionButton('Proposer un échange', 'trade-form', `data-id="${item.id}"`, false, 'subtle')}</div>` : item?.locked ? '<p class="muted">Cet exemplaire est réservé. Retrouve ton offre dans le marché avec le filtre « Mes offres et participations ».</p>' : '<p class="muted">Ouvre un exemplaire depuis l’inventaire pour le proposer au marché.</p>'}<p class="muted">La valeur est indicative, pas un prix de rachat garanti. Les ventes nécessitent un autre joueur.</p>`);
}
function showListingForm(itemId) {
  const item = model.state.inventory.find(copy => copy.id === itemId && !copy.locked);
  if (!item) return toast('Cette carte n’est plus disponible.', 'error');
  const card = model.cards.get(item.cardId);
  openModal(`<h2 id="modal-title">Proposer ${escapeHTML(card.name)}</h2><form class="form-grid" id="listing-form" data-item-id="${item.id}"><label for="listing-kind">Type de vente</label><select id="listing-kind" name="kind"><option value="fixed">Vente à prix fixe</option><option value="auction">Enchère</option></select><label for="listing-price">Prix fixe ou mise de départ, en pièces</label><input id="listing-price" name="price" type="number" min="1" max="1000000000" step="1" value="${card.value}" required><label for="listing-duration">Durée, pour une enchère</label><select id="listing-duration" name="duration"><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="60" selected>1 heure</option><option value="360">6 heures</option><option value="1440">24 heures</option></select><p class="muted">La carte sera réservée. Une enchère ayant reçu une offre ne peut plus être annulée. Sans offre, la carte est libérée à la fin.</p><p class="form-error" id="transaction-error" role="alert"></p><button class="button primary" type="submit" data-transaction>Confirmer la mise en vente</button></form>`);
}
function showTradeForm(itemId) {
  const item = model.state.inventory.find(copy => copy.id === itemId && !copy.locked);
  if (!item) return toast('Cette carte n’est plus disponible.', 'error');
  const card = model.cards.get(item.cardId);
  openModal(`<h2 id="modal-title">Échanger ${escapeHTML(card.name)}</h2><form class="form-grid" id="trade-form" data-item-id="${item.id}"><label for="wanted-card">L’espèce que tu souhaites recevoir</label><select id="wanted-card" name="wantedCardId">${model.catalog.cards.filter(candidate => candidate.id !== card.id).map(candidate => `<option value="${candidate.id}">${escapeHTML(candidate.name)} · ${escapeHTML(model.catalog.rarities[candidate.rarity].name)}</option>`).join('')}</select><p class="muted">Un exemplaire contre un exemplaire. Le transfert des deux cartes est simultané et n’utilise aucune pièce.</p><p class="form-error" id="transaction-error" role="alert"></p><button class="button primary" type="submit" data-transaction>Publier la proposition</button></form>`);
}
function marketConfirmation(command, id) {
  const entry = model.market?.entries.find(candidate => candidate.id === id);
  if (!entry) return toast('Actualise le marché pour retrouver cette offre.', 'error');
  const card = model.cards.get(entry.cardId);
  if (command === 'bid') {
    const minimum = entry.bidderId ? Math.max(entry.priceMilli / 1000 + 1, Math.ceil(entry.priceMilli * 1.05 / 1000)) : entry.priceMilli / 1000;
    openModal(`<h2 id="modal-title">Enchérir sur ${escapeHTML(card.name)}</h2><form class="form-grid" id="bid-form" data-id="${id}"><label for="bid-amount">Ton offre, en pièces</label><input id="bid-amount" name="amount" type="number" min="${minimum}" max="1000000000" step="1" value="${minimum}" required><p class="muted">Les pièces sont réservées immédiatement, puis rendues si un autre joueur te dépasse. Une offre est définitive. Le minimum peut évoluer avant la confirmation.</p><p class="form-error" id="transaction-error" role="alert"></p><button class="button gold" type="submit" data-transaction>Confirmer mon enchère</button></form>`);
    return;
  }
  let description;
  let attributes = `data-kind="${command}" data-id="${id}"`;
  if (command === 'buy') description = `Acheter ${escapeHTML(card.name)} pour ◈ ${coins(entry.priceMilli)} auprès de ${escapeHTML(entry.seller)} ?`;
  else if (command === 'accept-trade') {
    const item = model.state.inventory.find(copy => copy.cardId === entry.wantedCardId && !copy.locked);
    if (!item) return toast('Tu ne possèdes plus d’exemplaire disponible de la carte demandée.', 'error');
    description = `Donner un exemplaire de ${escapeHTML(model.cards.get(entry.wantedCardId).name)} pour recevoir ${escapeHTML(card.name)} ?`;
    attributes += ` data-item-id="${item.id}"`;
  } else description = 'Annuler cette proposition et libérer ta carte ?';
  openModal(`<h2 id="modal-title">Confirmer la transaction</h2><p>${description}</p><p class="muted">Le serveur vérifie la disponibilité et le solde au moment de la confirmation.</p><p class="form-error" id="transaction-error" role="alert"></p>${transactionButton('Confirmer', 'confirm-action', attributes)}`);
}
function packOdds(tier) {
  const weights = model.catalog.packWeights[tier];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const firstThree = weights.map(weight => weight / total);
  const last = weights.map((weight, index) => index < tier ? 0 : index === tier ? weights.slice(0, tier + 1).reduce((sum, value) => sum + value, 0) / total : weight / total);
  openModal(`<h2 id="modal-title">Booster ${escapeHTML(model.catalog.rarities[tier].name)}</h2><p class="muted">Probabilités par carte, pas probabilité de tout le booster. Chaque espèce d’une même rareté est équiprobable. Les doublons sont possibles.</p><h3>Chacune des trois premières cartes</h3>${probabilitiesHTML(firstThree)}<h3>Quatrième carte : rareté minimale garantie</h3>${probabilitiesHTML(last)}`);
}
function showPack(result) {
  openModal(`<h2 id="modal-title">Une rencontre t’attend.</h2><p class="muted">Les quatre cartes sont déjà enregistrées dans ton inventaire.</p><div class="pack r${result.rarity}"><div class="pack-art" aria-hidden="true"><span class="pack-logo">✦</span><span class="pack-title">ANIMAL CARDS</span></div></div><p class="row"><button class="button gold wide" data-command="open-sealed">Découvrir mes quatre cartes ✦</button></p>`);
  model.opening = result;
}
function revealPack() {
  const result = model.opening;
  if (!result) return;
  $('#modal-content').innerHTML = `<h2 id="modal-title">À toi de les découvrir.</h2><p class="muted">Retourne chaque carte, ou révèle-les toutes.</p><div class="reveal-row">${result.cards.map((item, index) => {
    const card = model.cards.get(item.cardId);
    return `<button type="button" class="reveal r${card.rarity}${card.rarity >= 4 ? ' big' : ''}" data-command="flip" data-index="${index}" aria-label="Révéler la carte ${index + 1}" aria-pressed="false" style="animation-delay:${index * 0.08}s;padding:0;border:0;background:none"><span class="back" aria-hidden="true">✦</span><span class="face" aria-hidden="true">${cardHTML(card)}</span>${item.discovery ? '<span class="new-badge" aria-hidden="true">NOUVELLE ESPÈCE</span>' : ''}</button>`;
  }).join('')}</div><p id="reveal-info" class="reveal-info muted" aria-live="polite">Quatre rencontres à découvrir.</p><div class="row"><button class="button gold" data-command="reveal-all">Tout révéler</button><button class="button subtle" data-command="finish-opening">Retrouver ma collection →</button></div>`;
}
function flip(button) {
  if (button.classList.contains('flipped') || !model.opening) return;
  const item = model.opening.cards[Number(button.dataset.index)];
  const card = model.cards.get(item.cardId);
  button.classList.add('flipped');
  button.setAttribute('aria-pressed', 'true');
  button.setAttribute('aria-label', `${card.name}, ${model.catalog.rarities[card.rarity].name}${item.discovery ? ', nouvelle espèce' : ', doublon'}`);
  $('.face', button).setAttribute('aria-hidden', 'false');
  $('#reveal-info').textContent = `${card.name} · ${model.catalog.rarities[card.rarity].name}${item.discovery ? ` · Nouvelle découverte : +${coins(item.discovery.rewardMilli)} pièces et ${bonus(item.discovery.luckMilliPercent)} de chance !` : ' · Un nouvel exemplaire rejoint ta collection.'}`;
}
async function performAction(kind, data, retry = false) {
  if (!model.state || model.busy) return;
  model.busy = true;
  model.revision++;
  transactionButtons();
  const run = async () => {
    try {
      const saved = readPending();
      if (saved && !retry) { model.pending = saved; toast('Vérifie d’abord la transaction en attente.', 'error'); return; }
      if (retry && !saved) { model.pending = null; toast('Aucune transaction en attente. Les données vont être actualisées.'); return; }
      const bytes = new Uint8Array(24);
      if (!saved) crypto.getRandomValues(bytes);
      const pending = saved || { key: [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''), kind, data };
      if (!saved) localStorage.setItem(pendingStorageKey(), JSON.stringify(pending));
      model.pending = pending;
      transactionButtons();
      let response;
      try { response = await request('/api/action', pending); }
      catch (error) {
        if (error.status >= 400 && error.status < 500 && error.status !== 408) {
          localStorage.removeItem(pendingStorageKey());
          model.pending = null;
          if ($('#transaction-error')) $('#transaction-error').textContent = error.message;
          toast(error.message, 'error');
          if (error.status === 401) showGuest();
        } else {
          connection('La transaction peut avoir été enregistrée. Utilise « Vérifier la transaction » : le même identifiant sera réutilisé, sans double achat.');
          toast(error.message, 'error');
        }
        return;
      }
      acceptState(response.state);
      localStorage.removeItem(pendingStorageKey());
      model.pending = null;
      connection();
      renderPage();
      if (pending.kind === 'buy-pack') showPack(response.result);
      else {
        closeModal();
        const labels = { list: 'Carte mise en vente.', buy: 'Carte achetée et ajoutée à ton inventaire.', bid: 'Enchère enregistrée. Les pièces sont réservées.', trade: 'Proposition d’échange publiée.', 'accept-trade': 'Échange effectué. Les deux cartes ont été transférées.', 'cancel-trade': 'Échange annulé. Carte libérée.', 'cancel-listing': 'Vente annulée. Carte libérée.' };
        toast(labels[pending.kind] || 'Transaction confirmée.', 'success');
      }
    } catch (error) {
      connection(`Transaction non résolue : ${error.message}`);
      toast('Le stockage local doit être accessible pour sécuriser les transactions.', 'error');
    }
  };
  try {
    if (navigator.locks) await navigator.locks.request(`animal-cards-action-${model.state.user.id}`, run);
    else await run();
  } finally {
    model.busy = false;
    model.revision++;
    transactionButtons();
    if (model.state && !model.pending) void sync();
  }
}
function showHelp() {
  openModal('<h2 id="modal-title">Bienvenue dans Animal Cards.</h2><ol><li>Ouvre des boosters dans la boutique. Chaque offre contient quatre cartes et au moins une carte de la rareté annoncée.</li><li>Retrouve tes exemplaires dans l’inventaire. Ils produisent des pièces, calculées par le serveur à chaque synchronisation, avec un maximum de 24 heures par période d’absence.</li><li>Découvre une espèce pour recevoir un bonus de pièces et de chance permanent. Vendre une carte ne supprime pas sa découverte.</li><li>Depuis une carte de l’inventaire, crée une vente, une enchère ou un échange. Il faut un autre joueur pour conclure une transaction.</li><li>Les offres de la boutique changent toutes les cinq minutes. La chance influence leur rareté au prochain renouvellement.</li></ol><p class="muted">Tout utilise une monnaie virtuelle, sans achat en argent réel. Une transaction incertaine se vérifie avec le même identifiant. Aucun faux joueur, aucune vente simulée.</p>');
}
function showCredits() {
  const safeURL = value => { try { const url = new URL(value); return url.protocol === 'https:' ? escapeHTML(url.href) : ''; } catch { return ''; } };
  const entries = Object.entries(model.images).filter(([, image]) => image && typeof image === 'object');
  openModal(`<h2 id="modal-title">Crédits des illustrations</h2><p class="muted">Les symboles d’animaux sont des emoji rendus par ton système. Les photographies disponibles sont stockées localement ; leurs crédits sont indiqués ci-dessous.</p>${entries.length ? `<div class="form-grid">${entries.map(([id, image]) => `<div><strong>${escapeHTML(model.cards.get(id)?.name || id)}</strong><p class="muted">${escapeHTML(image.author || 'Auteur non renseigné')} · ${escapeHTML(image.license || 'Licence non renseignée')}${safeURL(image.source) ? ` · <a href="${safeURL(image.source)}" target="_blank" rel="noopener noreferrer">Source et licence ↗</a>` : ''}</p></div>`).join('')}</div>` : '<p>Aucune photographie téléchargée pour le moment. Le jeu reste jouable avec ses illustrations emoji.</p>'}`);
}
let filterTimer;
document.addEventListener('input', event => {
  const field = event.target;
  if (!field.matches('[data-filter]') || !model.filters[model.tab]) return;
  model.filters[model.tab][field.dataset.filter] = field.value;
  model.inventoryLimit = 60;
  if (model.tab === 'inventaire') renderInventoryResults();
  else if (model.tab === 'index') renderIndexResults();
  else {
    model.marketPage = 0;
    model.marketSequence++;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { void loadMarket(); }, 300);
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'filter-mine') { model.mine = event.target.checked; model.marketPage = 0; void loadMarket(); }
});
document.addEventListener('error', event => {
  if (event.target instanceof HTMLImageElement) event.target.remove();
}, true);
document.addEventListener('pointermove', event => {
  const card = event.target.closest('.card');
  if (!card || event.pointerType === 'touch' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = card.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width;
  const y = (event.clientY - box.top) / box.height;
  card.style.setProperty('--rx', `${(0.5 - y) * 9}deg`);
  card.style.setProperty('--ry', `${(x - 0.5) * 9}deg`);
  card.style.setProperty('--mx', `${x * 100}%`);
  card.style.setProperty('--my', `${y * 100}%`);
});
document.addEventListener('pointerout', event => {
  const card = event.target.closest('.card');
  if (card && !card.contains(event.relatedTarget)) { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.tab) { location.hash = button.dataset.tab; if (model.tab === button.dataset.tab) renderPage(); return; }
  if (button.dataset.auth) {
    model.auth = button.dataset.auth;
    $$('[data-auth]').forEach(tab => { tab.classList.toggle('active', tab.dataset.auth === model.auth); tab.setAttribute('aria-pressed', String(tab.dataset.auth === model.auth)); });
    $('#password').autocomplete = model.auth === 'register' ? 'new-password' : 'current-password';
    $('#auth-submit').textContent = model.auth === 'register' ? 'Commencer ma collection ↗' : 'Retrouver ma collection ↗';
    $('#auth-error').textContent = '';
    return;
  }
  if (button.dataset.marketType) { model.marketType = button.dataset.marketType; model.marketPage = 0; model.market = null; renderMarket(); return; }
  if (button.dataset.cardId) { detail(button.dataset.cardId, button.dataset.itemId); return; }
  const command = button.dataset.command;
  if (command === 'help') showHelp();
  else if (command === 'credits') showCredits();
  else if (command === 'restart') location.reload();
  else if (command === 'refresh') { await sync(); if (model.state) renderPage(); }
  else if (command === 'pack-odds') packOdds(Number(button.dataset.tier));
  else if (command === 'buy-pack') await performAction('buy-pack', { offerId: button.dataset.id });
  else if (command === 'list-form') showListingForm(button.dataset.id);
  else if (command === 'trade-form') showTradeForm(button.dataset.id);
  else if (['buy', 'bid', 'accept-trade', 'cancel-listing', 'cancel-trade'].includes(command)) marketConfirmation(command, button.dataset.id);
  else if (command === 'confirm-action') {
    const kind = button.dataset.kind;
    const data = kind === 'accept-trade' ? { tradeId: button.dataset.id, itemId: button.dataset.itemId } : kind === 'cancel-trade' ? { tradeId: button.dataset.id } : { listingId: button.dataset.id };
    await performAction(kind, data);
  } else if (command === 'more-inventory') { model.inventoryLimit += 60; renderInventoryResults(); }
  else if (command === 'market-page') { model.marketPage = Math.max(0, model.marketPage + Number(button.dataset.direction)); void loadMarket(); }
  else if (command === 'open-sealed') revealPack();
  else if (command === 'flip') flip(button);
  else if (command === 'reveal-all') $$('[data-command="flip"]').forEach(flip);
  else if (command === 'finish-opening') { closeModal(); location.hash = 'inventaire'; if (model.tab === 'inventaire') renderPage(); }
});
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#auth-submit');
  if (button.disabled) return;
  button.disabled = true;
  $$('[data-auth]').forEach(tab => { tab.disabled = true; });
  $('#auth-error').textContent = '';
  try {
    const session = await request(`/api/${model.auth}`, { username: $('#username').value.trim(), password: $('#password').value });
    $('#password').value = '';
    connection();
    showGame(session);
    toast('Bienvenue dans ta collection !', 'success');
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { button.disabled = false; $$('[data-auth]').forEach(tab => { tab.disabled = false; }); }
});
$('#modal-content').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity() || model.busy || model.pending) return;
  const values = new FormData(form);
  if (form.id === 'listing-form') await performAction('list', { itemId: form.dataset.itemId, kind: values.get('kind'), price: Number(values.get('price')), durationMinutes: Number(values.get('duration')) });
  else if (form.id === 'trade-form') await performAction('trade', { itemId: form.dataset.itemId, wantedCardId: values.get('wantedCardId') });
  else if (form.id === 'bid-form') await performAction('bid', { listingId: form.dataset.id, amount: Number(values.get('amount')) });
});
$('#close-modal').addEventListener('click', closeModal);
$('#modal').addEventListener('close', () => { model.opening = null; });
$('#retry-pending').addEventListener('click', () => { if (model.pending?.unreadable) toast('Le stockage de la transaction est illisible. Ne crée pas de nouvelle transaction avant vérification.', 'error'); else void performAction('', {}, true); });
const logoutButtons = document.querySelectorAll('#logout, #logout-mobile');
logoutButtons.forEach(button => button.addEventListener('click', async () => {
  if (model.busy || model.pending) return toast('Vérifie la transaction en attente avant de te déconnecter.', 'error');
  logoutButtons.forEach(control => { control.disabled = true; });
  try { await request('/api/logout', {}); showGuest(); } catch (error) { toast(error.message, 'error'); }
  finally { logoutButtons.forEach(control => { control.disabled = false; }); }
}));
window.addEventListener('hashchange', () => {
  if (!model.state) return;
  const tab = location.hash.slice(1);
  model.tab = titles[tab] ? tab : 'boutique';
  model.marketSequence++;
  clearTimeout(filterTimer);
  renderPage();
  $('#main-content').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
});
window.addEventListener('storage', event => {
  if (!model.state || event.key !== pendingStorageKey()) return;
  try { model.pending = readPending(); } catch (error) { model.pending = { unreadable: true }; connection(error.message); }
  transactionButtons();
  if (!model.pending) void sync();
});
window.addEventListener('online', () => { void sync(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
async function boot() {
  try {
    const [catalog, session, manifest] = await Promise.all([request('/api/catalog'), request('/api/session'), request('/animals/manifest.json').catch(() => ({ images: {} }))]);
    model.catalog = catalog;
    model.cards = new Map(catalog.cards.map(card => [card.id, card]));
    model.images = manifest.images && typeof manifest.images === 'object' && !Array.isArray(manifest.images) ? manifest.images : {};
    if (session.authenticated) showGame(session); else showGuest();
  } catch (error) {
    $('#loading').innerHTML = `<strong>La connexion n’a pas abouti.</strong><p class="muted">${escapeHTML(error.message)}</p><button class="button primary" data-command="restart">Réessayer</button>`;
  }
}
setInterval(updateCountdowns, 1000);
setInterval(() => { if (!document.hidden) void sync(); }, 15000);
void boot();
