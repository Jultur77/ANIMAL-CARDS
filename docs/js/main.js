// ANIMAL CARDS : écrans, routage par hash (#/inventaire…), synchronisation temps réel.
// Le navigateur n'est jamais une source de vérité : toutes les actions passent par des
// fonctions SQL côté serveur, et on recharge l'état après chacune d'elles.
import { configured, auth, api } from './api.js';
import { esc, $, $$, coins, pct, duration, dateTime, toast, modal, confirmBox, busy } from './ui.js';
import { cardHTML, enableTilt, biomeLabel, boosterSVG, scribbleArrow } from './art.js';
import { sound, openPack } from './fx.js';
import { showTutorial, tutorialSeen } from './tutorial.js';

const app = $('#app');
const COIN = '🪙';
const S = {
  user: null, profile: null, shop: [], probs: [], fetchedAt: 0, offset: 0,
  cards: [], byId: new Map(), rarities: [], settings: null,
  inventory: [], discoveries: new Map(),
  listings: [], sales: [], trades: [], tradeHistory: [],
  view: 'inventaire', marketTab: 'ventes',
  inv: { q: '', rarity: 'all', sort: 'rarity' },
  mk: { q: '', rarity: 'all', kind: 'all', max: '', sort: 'ends', onlyAcceptable: false },
  dex: { rarity: 'all', show: 'all' },
  unwatch: null, timer: 0, lastStateAt: 0, lastSettleAt: 0
};
const now = () => Date.now() + S.offset; // heure du serveur estimée
const R = id => S.rarities[id];
const wait = ms => new Promise(r => setTimeout(r, ms));
const uuid = () => crypto.randomUUID?.() ??
  ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
const plural = (n, word) => `${coins(n)} ${word}${Math.abs(n) > 1 ? 's' : ''}`;
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const lookup = id => { const card = S.byId.get(id); return { card, rarity: R(card.rarity) }; };
const rarityOptions = selected => `<option value="all">Toutes les raretés</option>` +
  S.rarities.map(r => `<option value="${r.id}" ${String(selected) === String(r.id) ? 'selected' : ''}>${esc(r.name)}</option>`).join('');

/* ---------------------------------------------------------------- démarrage */
function boot() {
  enableTilt(document);
  if (!configured) return renderNotConfigured();
  window.addEventListener('hashchange', route);
  document.addEventListener('click', globalClick);
  auth.onChange((event, session) => {
    // Ne pas appeler Supabase directement dans ce rappel (recommandation de la bibliothèque).
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') return askNewPassword();
      if (event === 'SIGNED_OUT' || !session) { stop(); return renderAuth(); }
      if (session.user.id !== S.user?.id) start(session);
    }, 0);
  });
}

function renderNotConfigured() {
  app.innerHTML = `<main class="center-screen"><div class="panel narrow">
    <div class="brand big">🐾 ANIMAL CARDS</div>
    <h1>Configuration requise</h1>
    <p>Le jeu n’est pas encore relié à sa base de données Supabase.</p>
    <ol class="steps">
      <li>Crée un projet gratuit sur <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a>.</li>
      <li>Exécute <code>supabase/schema.sql</code> puis <code>supabase/seed.sql</code> dans le SQL Editor.</li>
      <li>Renseigne l’URL et la clé <strong>anon</strong> dans <code>docs/config.js</code>.</li>
    </ol>
    <p class="muted">Tout est expliqué pas à pas dans le fichier README.md.</p>
  </div></main>`;
}

const loading = text => `<main class="center-screen" aria-busy="true"><div class="loader" aria-hidden="true">🐾</div><p>${esc(text)}</p></main>`;

async function start(session) {
  S.user = session.user;
  app.innerHTML = loading('Chargement de ta collection…');
  try {
    if (!S.cards.length) await loadCatalog();
    const first = await api.getState();
    if (!first.profile) await askUsername();
    await Promise.all([refreshState(), loadInventory(), loadMarket()]);
    renderShell();
    route();
    S.unwatch?.();
    S.unwatch = api.watchMarket(onMarketChange);
    clearInterval(S.timer);
    S.timer = setInterval(tick, 1000);
    if (!tutorialSeen(S.user.id)) tutorial();
  } catch (error) {
    app.innerHTML = `<main class="center-screen"><div class="panel narrow">
      <h1>Impossible de charger le jeu</h1><p>${esc(error.message)}</p>
      <div class="row"><button class="btn btn-primary" data-reload>Réessayer</button>
      <button class="btn btn-ghost" data-logout>Se déconnecter</button></div></div></main>`;
  }
}
function stop() {
  S.unwatch?.(); S.unwatch = null;
  clearInterval(S.timer);
  S.user = null; S.profile = null;
}

/* ------------------------------------------------------------ chargements */
async function loadCatalog() {
  const [cards, rarities, settings] = await api.catalog();
  S.cards = cards; S.rarities = rarities; S.settings = settings;
  S.byId = new Map(cards.map(c => [c.id, c]));
  if (!cards.length) throw new Error('Le catalogue est vide : exécute supabase/seed.sql (voir README).');
}
async function refreshState() {
  const st = await api.getState();
  S.offset = Date.parse(st.server_now) - Date.now();
  S.profile = st.profile;
  S.shop = st.shop || [];
  S.probs = (st.shop_probabilities || []).map(Number);
  S.fetchedAt = now();
  S.lastStateAt = Date.now();
}
async function loadInventory() {
  const [inv, disc] = await Promise.all([api.inventory(S.user.id), api.discoveries(S.user.id)]);
  S.inventory = inv;
  S.discoveries = new Map(disc.map(d => [d.card_id, d]));
}
async function loadMarket() {
  const [listings, sales, trades, tradeHistory] = await Promise.all([
    api.activeListings(), api.salesHistory(), api.openTrades(), api.tradeHistory()]);
  Object.assign(S, { listings, sales, trades, tradeHistory });
}
// Recharge ce qui a pu changer puis met l'écran à jour sans perdre les filtres.
async function sync({ state = true, inv = true, market = false } = {}) {
  await Promise.all([state && refreshState(), inv && loadInventory(), market && loadMarket()].filter(Boolean));
  renderStats();
  updateView();
}

/* -------------------------------------------------------- authentification */
function renderAuth(mode = 'login') {
  const signup = mode === 'signup';
  app.innerHTML = `<main class="auth-screen">
    <section class="hero" aria-labelledby="hero-title">
      <div class="brand"><span class="brand-logo" aria-hidden="true">🐾</span><span class="brand-text">ANIMAL <b>CARDS</b></span></div>
      <h1 class="hero-title" id="hero-title"><span class="hash" aria-hidden="true">#</span>Collecte<br>Échange<br>Domine</h1>
      <p class="hero-sub">126 vrais animaux à collectionner. Ouvre des boosters, enchéris et échange avec de vrais joueurs.</p>
      <div class="hero-stickers" aria-hidden="true">
        <div class="sticker s1"><i class="tape"></i><span>🦁</span><b>Lion</b><small>Légendaire</small></div>
        <div class="sticker s2"><i class="tape"></i><span>🦈</span><b>Requin blanc</b><small>Mythique</small></div>
 <div class="sticker s3"><i class="tape"></i><span>🦖</span><b>T-Rex</b><small>Secret</small></div>
        <p class="note n1">la plus rare&nbsp;!</p>
        ${scribbleArrow({ from: [8, 30], c1: [40, 4], c2: [70, 20], to: [104, 70], seed: 11, cls: 'q1' })}
 <p class="note n2">ça commence ici</p>
 ${scribbleArrow({ from: [10, 20], c1: [30, 85], c2: [80, 90], to: [112, 52], seed: 5, cls: 'q2' })}
      </div>
      <div class="spin-badge" aria-hidden="true">
        <svg viewBox="0 0 100 100"><defs><path id="badge-circle" d="M50,50 m-38,0 a38,38 0 1,1 76,0 a38,38 0 1,1 -76,0"/></defs>
   <text><textPath href="#badge-circle">GRATUIT ✦ MULTIJOUEUR ✦ 126 ANIMAUX ✦</textPath></text></svg>
        <span>↗</span>
      </div>
    </section>
    <div class="panel auth-card">
      <p class="auth-kicker">${signup ? 'Rejoins la partie' : 'Content de te revoir'}</p>
      <div class="segmented" role="tablist" aria-label="Connexion ou inscription">
 <button role="tab" aria-selected="${!signup}" data-mode="login">Connexion</button>
 <button role="tab" aria-selected="${signup}" data-mode="signup">Inscription</button>
      </div>
      <form id="auth-form" class="form" novalidate>
        ${signup ? `<label>Pseudo <input name="username" required minlength="3" maxlength="20"
   pattern="[A-Za-z0-9_\\-]{3,20}" autocomplete="nickname" placeholder="ex : Renard_77"></label>` : ''}
        <label>E-mail <input name="email" type="email" required autocomplete="email"></label>
        <label>Mot de passe <input name="password" type="password" required minlength="${signup ? 8 : 1}"
   autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
 <p class="form-error" role="alert" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">${signup ? 'Créer mon compte' : 'Se connecter'}</button>
      </form>
      ${signup ? '<p class="muted small">Pseudo : 3 à 20 caractères (lettres, chiffres, _ ou -). Mot de passe : 8 caractères minimum.</p>'
 : '<button class="link-btn" data-forgot>Mot de passe oublié ?</button>'}
    </div>
    <section class="how" aria-labelledby="how-title">
      <h2 id="how-title">Comment on joue&nbsp;?</h2>
      <ol class="how-steps">
 <li><b>01</b><h3>Crée ton compte</h3><p>C’est gratuit. Tu reçois tout de suite des pièces 🪙 et quelques cartes pour démarrer.</p></li>
        <li><b>02</b><h3>Ouvre des boosters</h3><p>Dans la <em>Boutique</em>, chaque booster contient plusieurs cartes. Plus il est rare, meilleures sont les cartes.</p></li>
        <li><b>03</b><h3>Complète l’Index</h3><p>Chaque nouvel animal découvert augmente ta <em>chance</em> pour toujours. Ta collection te rapporte aussi des pièces chaque heure.</p></li>
        <li><b>04</b><h3>Vends &amp; échange</h3><p>Au <em>Marché</em>, avec de vrais joueurs : prix fixe, enchères ou échange carte contre carte.</p></li>
      </ol>
    </section></main>`;
  $$('[data-mode]').forEach(b => b.addEventListener('click', () => renderAuth(b.dataset.mode)));
  $('[data-forgot]')?.addEventListener('click', forgotPassword);
  const form = $('#auth-form');
  $('input', form).focus();
  form.addEventListener('submit', e => {
    e.preventDefault();
    const error = $('.form-error', form);
    error.hidden = true;
    const bad = [...form.elements].find(el => el.willValidate && !el.checkValidity());
    if (bad) {
      error.textContent = bad.name === 'username' ? 'Pseudo invalide : 3 à 20 caractères (lettres, chiffres, _ ou -).'
        : bad.name === 'email' ? 'Adresse e-mail invalide.' : 'Mot de passe trop court (8 caractères minimum).';
      error.hidden = false; bad.focus(); return;
    }
    const f = Object.fromEntries(new FormData(form));
    busy($('button[type=submit]', form), async () => {
      if (!signup) return auth.signIn(f.email.trim(), f.password);
      const data = await auth.signUp(f.email.trim(), f.password, f.username.trim());
      if (!data.session) {
 $('.auth-card').innerHTML = `<div class="brand big">📬</div><h1>Vérifie tes e-mails</h1>
   <p>Un lien de confirmation a été envoyé à <strong>${esc(f.email)}</strong>. Clique dessus puis reviens te connecter.</p>
   <button class="btn btn-primary btn-block" data-mode-login>Retour à la connexion</button>`;
        $('[data-mode-login]').addEventListener('click', () => renderAuth('login'));
      }
    });
  });
}

async function forgotPassword() {
  await modal({
    title: 'Mot de passe oublié',
    body: `<form class="form" id="forgot"><p>Tu recevras un lien pour choisir un nouveau mot de passe.</p>
      <label>E-mail <input name="email" type="email" required autocomplete="email" autofocus></label></form>`,
    actions: [{ label: 'Annuler' }, {
      label: 'Envoyer le lien', kind: 'primary', onClick: async (close, wrap) => {
        const form = $('form', wrap);
        if (!form.reportValidity()) return;
        const ok = await busy(null, async () => { await auth.resetPassword(form.email.value.trim()); return true; });
        if (ok) { close(); toast('Si un compte existe, un e-mail vient d’être envoyé.', 'success'); }
      }
    }],
    onOpen: wrap => $('form', wrap).addEventListener('submit', e => { e.preventDefault(); $('footer .btn-primary', wrap).click(); })
  });
}
async function askNewPassword() {
  await modal({
    title: 'Nouveau mot de passe',
    body: `<form class="form"><label>Nouveau mot de passe (8 caractères minimum)
      <input name="password" type="password" minlength="8" required autocomplete="new-password" autofocus></label></form>`,
    actions: [{ label: 'Plus tard' }, {
      label: 'Enregistrer', kind: 'primary', onClick: async (close, wrap) => {
 const form = $('form', wrap);
        if (!form.reportValidity()) return;
 const ok = await busy(null, async () => { await auth.updatePassword(form.password.value); return true; });
        if (ok) { close(); toast('Mot de passe modifié.', 'success'); }
      }
    }],
    onOpen: wrap => $('form', wrap).addEventListener('submit', e => { e.preventDefault(); $('footer .btn-primary', wrap).click(); })
  });
}

function askUsername() {
  return new Promise(resolve => {
    const suggested = String(S.user.user_metadata?.username || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
    app.innerHTML = `<main class="center-screen"><div class="panel narrow">
      <div class="brand big">🐾 ANIMAL CARDS</div>
      <h1>Choisis ton pseudo</h1>
      <p class="muted">Il sera visible des autres joueurs sur le marché. 3 à 20 caractères : lettres, chiffres, _ ou -.</p>
      <form id="pseudo-form" class="form">
        <label>Pseudo <input name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_\\-]{3,20}"
          value="${esc(suggested)}" autocomplete="nickname"></label>
 <button class="btn btn-primary btn-block" type="submit">Commencer l’aventure</button>
      </form>
      <button class="link-btn" data-logout>Se déconnecter</button></div></main>`;
    const form = $('#pseudo-form');
    form.username.focus();
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      busy($('button', form), async () => {
        await api.createProfile(form.username.value.trim());
        toast(`Bienvenue ! Tu reçois ${coins(S.settings.start_balance)} ${COIN} et ${S.settings.starter_cards} cartes de départ.`, 'success', 6000);
        resolve();
      });
    });
  });
}

/* --------------------------------------------------------- structure */
const VIEWS = {
  inventaire: { title: 'Inventaire', icon: '🗂️', render: renderInventory, update: updateInventory },
  boutique:   { title: 'Boutique',   icon: '🛒', render: renderShop,      update: null },
  marche:     { title: 'Marché',     icon: '⚖️', render: renderMarket,    update: updateMarket },
  index:      { title: 'Index',      icon: '📖', render: renderIndex,     update: updateIndex }
};

function renderShell() {
  app.innerHTML = `<a class="skip-link" href="#view" data-skip>Aller au contenu</a>
    <header class="topbar">
      <a class="brand" href="#/inventaire" aria-label="ANIMAL CARDS, accueil"><span class="brand-logo" aria-hidden="true">🐾</span><span class="brand-text">ANIMAL <b>CARDS</b></span></a>
      <nav class="tabs" aria-label="Navigation principale">
 ${Object.entries(VIEWS).map(([key, v]) => `<a href="#/${key}" data-nav="${key}">
          <span class="tab-icon" aria-hidden="true">${v.icon}</span><span class="tab-label">${v.title}</span></a>`).join('')}
      </nav>
      <div class="stats" id="stats" aria-live="polite"></div>
      <div class="top-actions">
        <button class="icon-btn" data-sound aria-pressed="${sound.on}" aria-label="Son">${sound.on ? '🔊' : '🔇'}</button>
        <button class="icon-btn help-btn" data-help aria-label="Comment jouer ?" title="Comment jouer ?">?</button>
        <button class="icon-btn" data-account aria-label="Mon compte">👤</button>
      </div>
    </header>
    <div class="ticker" aria-hidden="true"><div class="ticker-track">${
      Array(2).fill(['Ouvre des boosters', 'Enchéris', 'Échange', 'Complète l’Index', 'Booste ta chance', 'Trouve les Secrets']
 .map(t => `<span>${t}</span><i>✦</i>`).join('')).join('')}</div></div>
    <main id="view" tabindex="-1"></main>`;
  renderStats();
}

// Tutoriel : s'affiche à la première connexion, puis via le bouton « ? ».
function tutorial() {
  return showTutorial({
    userId: S.user.id, username: S.profile?.username, settings: S.settings, rarities: S.rarities, total: S.cards.length,
    go: view => { location.hash = `#/${view}`; }
  });
}

function renderStats() {
  const p = S.profile, el = $('#stats');
  if (!p || !el) return;
  el.innerHTML = `
    <div class="stat" title="Ton solde de pièces"><span class="stat-label">Solde</span><strong>${COIN} ${coins(p.balance)}</strong></div>
    <div class="stat" title="Bonus de chance obtenu grâce à l’Index"><span class="stat-label">Chance</span><strong>🍀 +${pct(p.luck)}</strong></div>
    <div class="stat hide-sm" title="Revenu passif de ta collection"><span class="stat-label">Revenu</span><strong>${coins(p.income_per_hour)}/h</strong></div>`;
}

function route() {
  const name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (!VIEWS[name]) history.replaceState(null, '', '#/inventaire');
  const changed = S.view !== (VIEWS[name] ? name : 'inventaire');
  S.view = VIEWS[name] ? name : 'inventaire';
  if (!$('#view')) return;
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = `${VIEWS[S.view].title} · ANIMAL CARDS`;
  renderView();
  if (changed) { scrollTo({ top: 0 }); $('#view').focus({ preventScroll: true }); }
}
function renderView() {
  const view = $('#view');
  if (!view) return;
  view.innerHTML = VIEWS[S.view].render();
  VIEWS[S.view].update?.(true);   // true = premier affichage : branche les filtres
  tick(true);
}
// Après un changement de données : ne redessine que les listes pour garder la saisie en cours.
function updateView() {
  const v = VIEWS[S.view];
  if (!v.update || !$(`#view [data-view="${S.view}"]`)) return renderView();
  v.update(false);
  tick(true);
}

/* ---------------------------------------------------- clics globaux */
async function globalClick(e) {
  const t = e.target;
  if (t.closest('[data-logout]')) { stop(); await auth.signOut(); return renderAuth(); }
  if (t.closest('[data-reload]')) return location.reload();
  if (t.closest('[data-skip]')) { e.preventDefault(); return $('#view')?.focus(); }
  if (t.closest('[data-sound]')) {
    sound.on = !sound.on;
    const b = t.closest('[data-sound]');
    b.textContent = sound.on ? '🔊' : '🔇'; b.setAttribute('aria-pressed', sound.on);
    return toast(sound.on ? 'Son activé' : 'Son coupé');
  }
  if (t.closest('[data-account]')) return accountModal();
  if (t.closest('[data-help]')) return tutorial();
  if (!t.closest('#view')) return;

  const el = sel => t.closest(sel);
  if (el('[data-claim]')) return claim(el('[data-claim]'));
  if (el('[data-buy]')) return buyBooster(Number(el('[data-buy]').dataset.buy), el('[data-buy]'));
  if (el('[data-odds]')) return boosterOdds(Number(el('[data-odds]').dataset.odds));
  if (el('[data-mtab]')) { S.marketTab = el('[data-mtab]').dataset.mtab; return renderView(); }
  if (el('[data-buy-listing]')) return buyListing(el('[data-buy-listing]').dataset.buyListing, el('[data-buy-listing]'));
  if (el('[data-bid]')) return bid(el('[data-bid]').dataset.bid);
  if (el('[data-cancel-listing]')) return cancelListing(el('[data-cancel-listing]').dataset.cancelListing, el('[data-cancel-listing]'));
  if (el('[data-accept-trade]')) return acceptTrade(el('[data-accept-trade]').dataset.acceptTrade, el('[data-accept-trade]'));
  if (el('[data-cancel-trade]')) return cancelTrade(el('[data-cancel-trade]').dataset.cancelTrade, el('[data-cancel-trade]'));
  const card = el('button[data-card]');
  if (card) return cardDetail(card.dataset.card);
}

function accountModal() {
  const p = S.profile;
  modal({
    title: 'Mon compte',
    body: `<dl class="facts">
      <dt>Pseudo</dt><dd>${esc(p.username)}</dd>
      <dt>E-mail</dt><dd>${esc(S.user.email)}</dd>
      <dt>Cartes</dt><dd>${coins(p.card_count)}</dd>
      <dt>Espèces découvertes</dt><dd>${p.discovered} / ${S.cards.length}</dd>
      <dt>Chance</dt><dd>+${pct(p.luck)}</dd></dl>`,
    actions: [
      { label: 'Changer de mot de passe', onClick: close => { close(); askNewPassword(); } },
      { label: 'Se déconnecter', kind: 'danger', onClick: async close => { close(); stop(); await auth.signOut(); renderAuth(); } }
    ]
  });
}

/* --------------------------------------------- minuteur & temps réel */
function pendingIncome() {
  const p = S.profile;
  if (!p) return 0;
  const estimate = Number(p.income_pending) + Number(p.income_per_hour) * (now() - S.fetchedAt) / 3600000;
  return Math.floor(Math.min(estimate, Number(p.income_cap) || 0));
}
function tick(displayOnly = false) {
  const t = now();
  if (!displayOnly && S.profile) {
    // Boutique arrivée à échéance : le serveur la régénère lors de get_state.
    if (Date.parse(S.profile.shop_next_refresh_at) <= t && Date.now() - S.lastStateAt > 5000) {
      S.lastStateAt = Date.now();
      refreshState().then(() => { renderStats(); if (S.view !== 'marche') updateView(); }).catch(() => {});
    }
    // Enchère ou annonce expirée : on demande au serveur de la clôturer (pg_cron le fait aussi).
    if (S.listings.some(l => Date.parse(l.ends_at) <= t) && Date.now() - S.lastSettleAt > 8000) {
      S.lastSettleAt = Date.now();
      api.refreshMarket().then(() => sync({ market: true })).catch(() => {});
    }
  }
  for (const el of $$('[data-ends]')) {
    const ms = Date.parse(el.dataset.ends) - t;
    el.textContent = ms > 0 ? duration(ms) : 'Terminé';
    el.classList.toggle('soon', ms > 0 && ms < 60000);
  }
  const pending = pendingIncome(), cap = Number(S.profile?.income_cap) || 0;
  for (const el of $$('[data-income]')) el.textContent = `${COIN} ${coins(pending)}`;
  for (const el of $$('[data-income-bar]')) el.style.width = `${cap ? Math.min(100, pending / cap * 100) : 0}%`;
  for (const el of $$('[data-claim]')) if (!el.dataset.busy) el.disabled = pending < 1;
}

let marketTimer = 0, marketMine = false;
function onMarketChange(payload) {
  const me = S.user?.id;
  if (!me) return;
  const row = payload.new || {}, before = S.listings.find(l => l.id === row.id);
  if (before?.bidder_id === me && row.bidder_id && row.bidder_id !== me) {
    toast(`Tu as été surenchéri sur ${S.byId.get(row.card_id)?.name ?? 'une carte'}. Tes pièces t’ont été rendues.`, 'warning', 6000);
    marketMine = true;
  }
  if ([row.seller_id, row.bidder_id, row.buyer_id, row.creator_id, row.acceptor_id].includes(me)) marketMine = true;
  if (before?.seller_id === me && row.status === 'sold') toast(`Vendu : ${S.byId.get(row.card_id)?.name} pour ${coins(row.final_price)} ${COIN} !`, 'success', 6000);
  clearTimeout(marketTimer);
  marketTimer = setTimeout(() => {
    const mine = marketMine; marketMine = false;
    sync({ state: mine, inv: mine, market: true }).catch(() => {});
  }, 400);
}

/* ---------------------------------------------------------- inventaire */
function groups() {
  const map = new Map();
  for (const inst of S.inventory) {
    let g = map.get(inst.card_id);
    if (!g) map.set(inst.card_id, g = { card: S.byId.get(inst.card_id), items: [], free: [], locked: 0, last: inst.acquired_at });
    g.items.push(inst);
    if (inst.lock_kind) g.locked++; else g.free.push(inst);
    if (inst.acquired_at > g.last) g.last = inst.acquired_at;
  }
  return [...map.values()].filter(g => g.card);
}
function freeInstances(cardId) {
  return S.inventory.filter(i => i.card_id === cardId && !i.lock_kind)
    .sort((a, b) => a.acquired_at.localeCompare(b.acquired_at));
}

function renderInventory() {
  const f = S.inv;
  return `<section class="view" data-view="inventaire" aria-labelledby="h-inv">
    <div class="view-head"><h1 id="h-inv">Inventaire</h1><p class="muted" id="inv-summary"></p></div>
    <div class="panel income-panel" id="income"></div>
    <div class="toolbar" role="search">
      <input type="search" id="inv-q" placeholder="Rechercher un animal…" value="${esc(f.q)}" aria-label="Rechercher dans l’inventaire">
      <select id="inv-rarity" aria-label="Filtrer par rareté">${rarityOptions(f.rarity)}</select>
      <select id="inv-sort" aria-label="Trier les cartes">
        ${[['rarity', 'Rareté'], ['value', 'Valeur'], ['name', 'Nom (A→Z)'], ['recent', 'Plus récentes'], ['count', 'Quantité']]
   .map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>Trier : ${l}</option>`).join('')}
      </select>
    </div>
    <div id="list" class="card-grid"></div>
  </section>`;
}
function updateInventory(first) {
  if (first) {
    $('#inv-q').addEventListener('input', e => { S.inv.q = e.target.value; inventoryList(); });
    $('#inv-rarity').addEventListener('change', e => { S.inv.rarity = e.target.value; inventoryList(); });
    $('#inv-sort').addEventListener('change', e => { S.inv.sort = e.target.value; inventoryList(); });
  }
  const p = S.profile, rate = Number(p.income_per_hour);
  $('#income').innerHTML = `
    <div class="income-rate"><span class="label">Revenus passifs</span>
      <strong>${COIN} ${coins(rate)} / h</strong>
      <span class="muted small">soit ${(rate / 60).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} / min · chaque carte rapporte selon sa rareté</span></div>
    <div class="income-pending"><span class="label">En attente</span><strong data-income></strong>
      <div class="bar" aria-hidden="true"><span data-income-bar></span></div>
      <span class="muted small">Plafond : ${COIN} ${coins(p.income_cap)} (${S.settings.offline_cap_hours} h d’absence)</span></div>
    <button class="btn btn-primary" data-claim>Récupérer</button>`;
  inventoryList();
}
function inventoryList() {
  const f = S.inv, q = norm(f.q.trim());
  const all = groups();
  let list = all.filter(g => (f.rarity === 'all' || String(g.card.rarity) === f.rarity) &&
    (!q || norm(g.card.name).includes(q) || norm(g.card.scientific_name).includes(q)));
  const sorters = {
    rarity: (a, b) => b.card.rarity - a.card.rarity || b.card.value - a.card.value,
    value: (a, b) => b.card.value - a.card.value,
    name: (a, b) => a.card.name.localeCompare(b.card.name, 'fr'),
    recent: (a, b) => b.last.localeCompare(a.last),
    count: (a, b) => b.items.length - a.items.length || b.card.rarity - a.card.rarity
  };
  list.sort(sorters[f.sort] || sorters.rarity);
  const total = all.reduce((s, g) => s + g.items.length, 0);
  const value = all.reduce((s, g) => s + g.card.value * g.items.length, 0);
  $('#inv-summary').textContent = `${plural(total, 'carte')} · ${plural(all.length, 'espèce')} · valeur de référence ${coins(value)} ${COIN}`;
  $('#list').innerHTML = list.length
    ? list.map(g => cardHTML(g.card, R(g.card.rarity), { count: g.items.length, locked: g.locked })).join('')
    : `<div class="empty">${all.length ? 'Aucune carte ne correspond à ta recherche.'
      : 'Ta collection est vide. Va à la <a href="#/boutique">Boutique</a> pour ouvrir ton premier booster !'}</div>`;
}

async function claim(button) {
  const res = await busy(button, () => api.claimIncome());
  if (!res) return;
  toast(Number(res.claimed) > 0 ? `+${coins(res.claimed)} ${COIN} récupérées !` : 'Rien à récupérer pour l’instant.', 'success');
  await sync({ inv: false }).catch(e => toast(e.message, 'error'));
}

function cardDetail(cardId) {
  const card = S.byId.get(cardId);
  if (!card) return;
  const r = R(card.rarity), disc = S.discoveries.get(cardId);
  const g = groups().find(x => x.card.id === cardId);
  const owned = g?.items.length || 0, free = g?.free.length || 0;
  const onSale = S.listings.filter(l => l.card_id === cardId);
  const cheapest = onSale.filter(l => l.kind === 'fixed').sort((a, b) => a.price - b.price)[0];
  modal({
    title: card.name, wide: true,
    body: `<div class="detail">
      <div class="detail-card">${cardHTML(card, r, { tag: 'div', count: owned, locked: g?.locked || 0 })}</div>
      <div class="detail-info">
 <p class="sci"><em>${esc(card.scientific_name)}</em></p>
        <dl class="facts">
   <dt>Rareté</dt><dd><span class="pill" style="--rc:${r.color}">${esc(r.name)}</span></dd>
   <dt>Catégorie</dt><dd>${esc(biomeLabel(card.category))}</dd>
   <dt>Habitat</dt><dd>${esc(card.habitat)}</dd>
          <dt>Valeur de référence</dt><dd>${COIN} ${coins(card.value)}</dd>
          <dt>Revenu passif</dt><dd>${COIN} ${coins(r.income_per_hour)} / h par exemplaire</dd>
   <dt>Bonus de découverte</dt><dd>+${pct(r.luck_bonus)} de chance${disc ? ` · obtenu le ${dateTime(disc.discovered_at)}` : ''}</dd>
          <dt>Exemplaires</dt><dd>${owned} (${free} libre${free > 1 ? 's' : ''}${g?.locked ? `, ${g.locked} en vente ou en échange` : ''})</dd>
   <dt>Sur le marché</dt><dd>${onSale.length ? `${onSale.length} annonce(s)${cheapest ? `, dès ${coins(cheapest.price)} ${COIN}` : ''}` : 'aucune annonce'}</dd>
 </dl>
        ${free ? '' : `<p class="muted small">${owned ? 'Tous tes exemplaires sont déjà en vente ou en échange.' : 'Tu ne possèdes pas cette carte.'}</p>`}
      </div></div>`,
    actions: free ? [
      { label: 'Proposer un échange', onClick: close => { close(); tradeForm(cardId); } },
      { label: 'Vendre', kind: 'primary', onClick: close => { close(); sellForm(cardId); } }
    ] : [{ label: 'Fermer' }]
  });
}

const DURATIONS = {
  fixed: [[10, '10 min'], [60, '1 h'], [360, '6 h'], [1440, '24 h'], [4320, '3 jours'], [10080, '7 jours']],
  auction: [[5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 h'], [180, '3 h'], [720, '12 h'], [1440, '24 h']]
};
function sellForm(cardId) {
  const card = S.byId.get(cardId), fee = S.settings.market_fee_pct;
  const durations = kind => DURATIONS[kind].map(([m, l]) =>
    `<option value="${m}" ${m === (kind === 'fixed' ? 1440 : 60) ? 'selected' : ''}>${l}</option>`).join('');
  modal({
    title: `Vendre : ${card.name}`,
    body: `<form class="form" id="sell-form">
      <fieldset class="segmented"><legend class="sr-only">Type de vente</legend>
        <label><input type="radio" name="kind" value="fixed" checked> Prix fixe</label>
 <label><input type="radio" name="kind" value="auction"> Enchère</label></fieldset>
      <label><span data-price-label>Prix de vente</span>
        <input name="price" type="number" min="1" max="${S.settings.max_price}" step="1" inputmode="numeric" value="${card.value}" required autofocus></label>
      <label>Durée <select name="minutes">${durations('fixed')}</select></label>
      <p class="hint" data-sum></p>
      <p class="muted small">Valeur de référence : ${coins(card.value)} ${COIN}. La carte est bloquée pendant la vente ;
        une enchère sans offre peut être annulée, une enchère avec offre va jusqu’au bout.</p></form>`,
    actions: [{ label: 'Annuler' }, {
      label: 'Mettre en vente', kind: 'primary', onClick: async (close, wrap) => {
 const form = $('form', wrap);
        if (!form.reportValidity()) return;
 const inst = freeInstances(cardId)[0];
        if (!inst) return toast('Aucun exemplaire libre.', 'error');
        const ok = await busy(null, async () => {
   await api.createListing(inst.id, form.kind.value, Number(form.price.value), Number(form.minutes.value)); return true;
        });
        if (!ok) return;
 close();
        toast(form.kind.value === 'fixed' ? 'Carte mise en vente !' : 'Enchère lancée !', 'success');
        sync({ state: false, market: true }).catch(() => {});
      }
    }],
    onOpen: wrap => {
      const form = $('form', wrap);
      const refresh = () => {
 const auction = form.kind.value === 'auction', price = Math.max(0, Math.floor(Number(form.price.value) || 0));
 const tax = Math.floor(price * fee / 100);
        $('[data-price-label]', wrap).textContent = auction ? 'Mise de départ' : 'Prix de vente';
        $('[data-sum]', wrap).innerHTML = `Taxe du marché (${fee} %) : ${coins(tax)} ${COIN} · ` +
   `<strong>Tu recevras ${coins(price - tax)} ${COIN}</strong>${auction ? ' (au minimum, si vendue à la mise de départ)' : ''}`;
      };
      form.addEventListener('change', e => {
        if (e.target.name === 'kind') form.minutes.innerHTML = durations(form.kind.value);
        refresh();
      });
      form.addEventListener('input', refresh);
      form.addEventListener('submit', e => { e.preventDefault(); $('footer .btn-primary', wrap).click(); });
      refresh();
    }
  });
}

function cardOptions(excludeId) {
  return S.rarities.map(r => `<optgroup label="${esc(r.name)}">${S.cards.filter(c => c.rarity === r.id && c.id !== excludeId)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .map(c => `<option value="${c.id}">${esc(c.name)}${S.discoveries.has(c.id) ? ' ✓' : ''}</option>`).join('')}</optgroup>`).join('');
}
function tradeForm(cardId) {
  const card = S.byId.get(cardId);
  modal({
    title: `Échanger : ${card.name}`,
    body: `<form class="form"><p>Tu proposes <strong>1 ${esc(card.name)}</strong>. Le premier joueur qui possède la carte
        demandée et accepte reçoit ta carte, et tu reçois la sienne, en une seule opération.</p>
      <label>Rechercher <input type="search" data-filter placeholder="Filtrer la liste…" autocomplete="off"></label>
      <label>Carte demandée en échange <select name="wanted" required size="8">${cardOptions(cardId)}</select></label>
      <p class="muted small">✓ = espèce déjà découverte. Demander une espèce nouvelle augmente ta chance quand l’échange se fait.</p></form>`,
    actions: [{ label: 'Annuler' }, {
      label: 'Publier l’offre', kind: 'primary', onClick: async (close, wrap) => {
 const wanted = $('select', wrap).value;
 if (!wanted) return toast('Choisis la carte que tu veux recevoir.', 'error');
        const inst = freeInstances(cardId)[0];
        if (!inst) return toast('Aucun exemplaire libre.', 'error');
        const ok = await busy(null, async () => { await api.createTrade(inst.id, wanted); return true; });
        if (!ok) return;
        close();
 toast(`Offre publiée : ${card.name} contre ${S.byId.get(wanted).name}.`, 'success');
        sync({ state: false, market: true }).catch(() => {});
      }
    }],
    onOpen: wrap => {
      const select = $('select', wrap);
      $('[data-filter]', wrap).addEventListener('input', e => {
        const q = norm(e.target.value);
        for (const o of select.options) o.hidden = !!q && !norm(o.textContent).includes(q);
      });
      $('form', wrap).addEventListener('submit', e => e.preventDefault());
    }
  });
}

/* ------------------------------------------------------------ boutique */
function weightsWithLuck(weights, divisor) {
  const luck = Math.min(Number(S.profile.luck), 100);
  const w = weights.map((x, i) => Number(x) * Math.pow(1 + luck / 100, i / divisor));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map(x => x / sum);
}
function renderShop() {
  const p = S.profile;
  const base = S.rarities.map(r => Number(r.shop_weight));
  const baseSum = base.reduce((a, b) => a + b, 0);
  const maxProb = Math.max(...S.probs, 0.0001);
  return `<section class="view" data-view="boutique" aria-labelledby="h-shop">
    <div class="view-head"><h1 id="h-shop">Boutique</h1>
      <p class="muted">Ta boutique personnelle : ${S.settings.shop_slots} boosters tirés au sort pour toi, renouvelés toutes les ${Math.round(S.settings.shop_refresh_seconds / 60)} minutes.</p></div>
    <div class="shop-top">
      <div class="panel big-stat"><span class="label">Renouvellement dans</span>
        <strong class="countdown" data-ends="${esc(p.shop_next_refresh_at)}" aria-live="off"></strong></div>
      <div class="panel big-stat"><span class="label">Ta chance</span><strong>🍀 +${pct(p.luck)}</strong>
 <span class="muted small">Elle augmente à chaque nouvelle espèce découverte (voir l’Index).</span></div>
    </div>
    <div class="shop-grid">
      ${S.shop.length ? S.shop.map(o => {
        const r = R(o.tier), out = o.stock === 0, poor = Number(p.balance) < o.price;
        return `<article class="shop-item r${r.id} ${out ? 'sold-out' : ''}" style="--rc:${r.color}">
          <div class="booster r${r.id}" aria-hidden="true">${boosterSVG(r, { cards: S.settings.cards_per_pack })}<span class="booster-foil"></span></div>
   <div class="shop-meta">
            <h2>Booster ${esc(r.name)}</h2>
     <p class="price">${COIN} ${coins(o.price)}</p>
     <p class="muted small">${S.settings.cards_per_pack} cartes · ${o.stock === null ? 'stock illimité' : out ? 'épuisé' : `${o.stock} en stock`}</p>
          </div>
   <div class="row">
     <button class="btn btn-ghost btn-small" data-odds="${r.id}" aria-label="Contenu du booster ${esc(r.name)}">Contenu</button>
     <button class="btn btn-primary" data-buy="${o.slot}" ${out ? 'disabled' : ''}
       ${poor && !out ? 'aria-describedby="poor"' : ''}>${out ? 'Épuisé' : poor ? 'Trop cher' : 'Acheter'}</button>
          </div></article>`;
      }).join('') : '<div class="empty">La boutique se prépare… elle apparaîtra dans un instant.</div>'}
    </div>
    <span id="poor" class="sr-only">Solde insuffisant</span>
    <div class="panel probs">
      <h2>Chances d’apparition des boosters</h2>
      <p class="muted small">Barre colorée : tes chances actuelles. Trait : chances de base sans bonus.</p>
      <ul class="prob-list">
        ${S.rarities.map((r, i) => `<li style="--rc:${r.color}">
          <span class="prob-name"><span class="rarity-dot"></span>${esc(r.name)}</span>
          <span class="prob-bar"><span style="width:${(S.probs[i] || 0) / maxProb * 100}%"></span>
     <i style="left:${base[i] / baseSum / maxProb * 100}%" title="Base"></i></span>
   <span class="prob-val">${pct((S.probs[i] || 0) * 100, 2)}<small> (base ${pct(base[i] / baseSum * 100, 2)})</small></span></li>`).join('')}
      </ul>
      <p class="muted small">La dernière carte de chaque booster est garantie de la rareté du booster ou mieux.
 Les tirages sont faits par le serveur, jamais dans ton navigateur.</p>
    </div>
  </section>`;
}

function boosterOdds(tier) {
  const r = R(tier), odds = weightsWithLuck(r.pack_weights, 3);
  modal({
    title: `Contenu du booster ${r.name}`,
    body: `<p>${S.settings.cards_per_pack} cartes. Chances pour chaque carte, avec ta chance actuelle (+${pct(S.profile.luck)}) :</p>
      <ul class="prob-list">${S.rarities.map((x, i) => `<li style="--rc:${x.color}">
        <span class="prob-name"><span class="rarity-dot"></span>${esc(x.name)}</span>
        <span class="prob-bar"><span style="width:${odds[i] * 100}%"></span></span>
        <span class="prob-val">${odds[i] ? pct(odds[i] * 100, 2) : '—'}</span></li>`).join('')}</ul>
      <p class="muted small">Garantie : la dernière carte est au moins <strong>${esc(r.name)}</strong>.</p>`,
    actions: [{ label: 'Fermer' }]
  });
}

async function buyBooster(slot, button) {
  const offer = S.shop.find(o => o.slot === slot);
  if (!offer) return;
  const r = R(offer.tier), balance = Number(S.profile.balance);
  if (balance < offer.price) return toast(`Il te manque ${coins(offer.price - balance)} ${COIN}. Récupère tes revenus ou vends des cartes.`, 'error');
  if (offer.tier >= 3 || offer.price > balance * 0.25) {
    const ok = await confirmBox(`Acheter le booster ${esc(r.name)} ?`,
      `Prix : <strong>${coins(offer.price)} ${COIN}</strong>. Solde après l’achat : ${coins(balance - offer.price)} ${COIN}.`, 'Acheter');
    if (!ok) return;
  }
  // Même identifiant de requête en cas de nouvel essai : le serveur ne débite jamais deux fois.
  const requestId = uuid();
  const result = await busy(button, () => api.buyBooster(slot, requestId).catch(async error => {
    if (!/Connexion/.test(error.message)) throw error;
    await wait(1500);
    return api.buyBooster(slot, requestId);
  }));
  if (!result) return;
  S.profile.balance = result.balance;
  renderStats();
  await openPack(result, lookup, R(result.tier));
  const fresh = result.cards.filter(c => c.is_new);
  if (fresh.length) {
    const luck = fresh.reduce((s, c) => s + Number(c.luck_gained), 0), reward = fresh.reduce((s, c) => s + Number(c.reward), 0);
    toast(`${plural(fresh.length, 'nouvelle espèce')} ! +${pct(luck)} de chance et +${coins(reward)} ${COIN}.`, 'success', 6000);
  }
  await sync().catch(e => toast(e.message, 'error'));
}

/* -------------------------------------------------------------- marché */
const MARKET_TABS = [['ventes', 'Ventes et enchères'], ['echanges', 'Échanges'], ['historique', 'Historique'], ['mes', 'Mes annonces']];
function renderMarket() {
  const f = S.mk, tab = S.marketTab;
  const filters = tab === 'ventes' || tab === 'echanges';
  return `<section class="view" data-view="marche" aria-labelledby="h-market">
    <div class="view-head"><h1 id="h-market">Marché</h1>
      <p class="muted">Achats, enchères et échanges entre joueurs, mis à jour en temps réel. Taxe de ${S.settings.market_fee_pct} % payée par le vendeur.</p></div>
    <div class="subtabs" role="tablist" aria-label="Sections du marché">
      ${MARKET_TABS.map(([k, l]) => `<button role="tab" data-mtab="${k}" aria-selected="${tab === k}">${l}<span class="count" data-count="${k}"></span></button>`).join('')}
    </div>
    ${filters ? `<div class="toolbar" role="search">
      <input type="search" id="mk-q" placeholder="Rechercher un animal ou un joueur…" value="${esc(f.q)}" aria-label="Rechercher sur le marché">
      <select id="mk-rarity" aria-label="Filtrer par rareté">${rarityOptions(f.rarity)}</select>
      ${tab === 'ventes' ? `
        <select id="mk-kind" aria-label="Type d’annonce">
          ${[['all', 'Tous les types'], ['fixed', 'Prix fixe'], ['auction', 'Enchères']].map(([v, l]) => `<option value="${v}" ${f.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="number" id="mk-max" min="1" placeholder="Prix max" value="${esc(f.max)}" aria-label="Prix maximum" inputmode="numeric">
 <select id="mk-sort" aria-label="Trier les annonces">
          ${[['ends', 'Fin proche'], ['cheap', 'Prix croissant'], ['dear', 'Prix décroissant'], ['new', 'Plus récentes']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>Trier : ${l}</option>`).join('')}</select>`
      : `<label class="check"><input type="checkbox" id="mk-acceptable" ${f.onlyAcceptable ? 'checked' : ''}> Seulement celles que je peux accepter</label>`}
    </div>` : ''}
    <div id="list"></div>
  </section>`;
}
function updateMarket(first) {
  if (first) {
    const on = (id, ev, fn) => $(id)?.addEventListener(ev, e => { fn(e.target); marketList(); });
    on('#mk-q', 'input', t => { S.mk.q = t.value; });
    on('#mk-rarity', 'change', t => { S.mk.rarity = t.value; });
    on('#mk-kind', 'change', t => { S.mk.kind = t.value; });
    on('#mk-max', 'input', t => { S.mk.max = t.value; });
    on('#mk-sort', 'change', t => { S.mk.sort = t.value; });
    on('#mk-acceptable', 'change', t => { S.mk.onlyAcceptable = t.checked; });
  }
  marketList();
}
const minBid = l => l.current_bid
  ? Number(l.current_bid) + Math.max(1, Math.ceil(Number(l.current_bid) * S.settings.min_bid_increment_pct / 100))
  : Number(l.price);
const mini = id => { const { card, rarity } = lookup(id); return cardHTML(card, rarity, { tag: 'div', attrs: 'data-mini' }); };
function matches(cardId, extra = '') {
  const f = S.mk, card = S.byId.get(cardId), q = norm(f.q.trim());
  return card && (f.rarity === 'all' || String(card.rarity) === f.rarity) &&
    (!q || norm(card.name).includes(q) || norm(extra).includes(q));
}

function listingHTML(l) {
  const me = S.user.id, { card, rarity } = lookup(l.card_id);
  const mine = l.seller_id === me, leading = l.bidder_id === me, auction = l.kind === 'auction';
  const shown = auction ? Number(l.current_bid || l.price) : Number(l.price);
  let action;
  if (mine) action = !auction || !l.bid_count
    ? `<button class="btn btn-ghost btn-small" data-cancel-listing="${l.id}">Retirer</button>`
    : '<span class="muted small">Enchère en cours</span>';
  else if (!auction) action = `<button class="btn btn-primary btn-small" data-buy-listing="${l.id}" ${Number(S.profile.balance) < shown ? 'disabled title="Solde insuffisant"' : ''}>Acheter</button>`;
  else action = leading ? '<span class="badge badge-ok">Tu mènes</span>'
    : `<button class="btn btn-primary btn-small" data-bid="${l.id}">Enchérir</button>`;
  return `<article class="listing" style="--rc:${rarity.color}">
    ${mini(l.card_id)}
    <div class="listing-body">
      <h3>${esc(card.name)}</h3>
      <p class="muted small">${esc(rarity.name)} · ${mine ? 'ton annonce' : `par ${esc(l.seller_name)}`}</p>
      <p class="price">${COIN} ${coins(shown)}</p>
      <p class="small">${auction
        ? `🔨 ${l.bid_count ? `${l.bid_count} offre${l.bid_count > 1 ? 's' : ''} · meilleure : ${esc(l.bidder_name)}` : 'Aucune offre · mise de départ'}`
        : '🏷️ Prix fixe'}</p>
      <p class="small">⏳ <span data-ends="${esc(l.ends_at)}"></span></p>
      <div class="row">${action}</div>
    </div></article>`;
}
function tradeHTML(t) {
  const me = S.user.id, mine = t.creator_id === me;
  const canAccept = !mine && freeInstances(t.wanted_card_id).length > 0;
  const give = S.byId.get(t.offered_card_id), want = S.byId.get(t.wanted_card_id);
  const isNew = !S.discoveries.has(t.offered_card_id);
  return `<article class="trade">
    <div class="trade-cards">${mini(t.offered_card_id)}<span class="trade-arrow" aria-hidden="true">⇄</span>${mini(t.wanted_card_id)}</div>
    <p><strong>${mine ? 'Toi' : esc(t.creator_name)}</strong> donne <strong>${esc(give.name)}</strong> contre <strong>${esc(want.name)}</strong></p>
    ${!mine && isNew ? '<p class="small badge badge-new">Nouvelle espèce pour toi</p>' : ''}
    <div class="row">${mine
      ? `<button class="btn btn-ghost btn-small" data-cancel-trade="${t.id}">Annuler l’offre</button>`
      : `<button class="btn btn-primary btn-small" data-accept-trade="${t.id}" ${canAccept ? '' : 'disabled'}>Accepter</button>
  ${canAccept ? '' : `<span class="muted small">Il te faut un ${esc(want.name)} libre.</span>`}`}</div>
  </article>`;
}

function marketList() {
  const me = S.user.id, f = S.mk, list = $('#list');
  if (!list) return;
  const counts = {
    ventes: S.listings.length, echanges: S.trades.length,
    mes: S.listings.filter(l => l.seller_id === me || l.bidder_id === me).length + S.trades.filter(t => t.creator_id === me).length
  };
  for (const el of $$('[data-count]')) el.textContent = counts[el.dataset.count] ? ` ${counts[el.dataset.count]}` : '';
  const tab = S.marketTab;
  if (tab === 'ventes') {
    const max = Number(f.max) || Infinity, price = l => Number(l.kind === 'auction' ? l.current_bid || l.price : l.price);
    const sorters = { ends: (a, b) => a.ends_at.localeCompare(b.ends_at), cheap: (a, b) => price(a) - price(b),
      dear: (a, b) => price(b) - price(a), new: (a, b) => b.created_at.localeCompare(a.created_at) };
    const items = S.listings.filter(l => matches(l.card_id, l.seller_name) && (f.kind === 'all' || l.kind === f.kind) && price(l) <= max)
      .sort(sorters[f.sort] || sorters.ends);
    list.className = 'market-grid';
    list.innerHTML = items.map(listingHTML).join('') || `<div class="empty">${S.listings.length ? 'Aucune annonce ne correspond aux filtres.'
      : 'Aucune annonce pour le moment. Mets une carte en vente depuis ton Inventaire !'}</div>`;
  } else if (tab === 'echanges') {
    const items = S.trades.filter(t => (matches(t.offered_card_id, t.creator_name) || matches(t.wanted_card_id, t.creator_name)) &&
      (!f.onlyAcceptable || (t.creator_id !== me && freeInstances(t.wanted_card_id).length)));
    list.className = 'market-grid';
    list.innerHTML = items.map(tradeHTML).join('') || `<div class="empty">Aucune offre d’échange${S.trades.length ? ' ne correspond aux filtres' : ' pour le moment'}.
      Ouvre une carte de ton Inventaire pour en proposer une.</div>`;
  } else if (tab === 'historique') {
    const rows = [
      ...S.sales.map(l => ({ at: l.closed_at, html: `<span class="h-icon" aria-hidden="true">${l.kind === 'auction' ? '🔨' : '🏷️'}</span>
        <span><strong>${esc(S.byId.get(l.card_id)?.name)}</strong> vendu par ${esc(l.seller_name)} à ${esc(l.buyer_name || '?')}</span>
 <strong class="h-price">${COIN} ${coins(l.final_price)}</strong>` })),
      ...S.tradeHistory.map(t => ({ at: t.closed_at, html: `<span class="h-icon" aria-hidden="true">⇄</span>
 <span>${esc(t.creator_name)} a échangé <strong>${esc(S.byId.get(t.offered_card_id)?.name)}</strong> contre
        <strong>${esc(S.byId.get(t.wanted_card_id)?.name)}</strong> avec ${esc(t.acceptor_name || '?')}</span><span></span>` }))
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    list.className = '';
    list.innerHTML = rows.length ? `<ol class="history">${rows.map(r => `<li><time datetime="${esc(r.at)}">${dateTime(r.at)}</time>${r.html}</li>`).join('')}</ol>`
      : '<div class="empty">Aucune transaction pour le moment.</div>';
  } else {
    const selling = S.listings.filter(l => l.seller_id === me), bidding = S.listings.filter(l => l.bidder_id === me),
      trades = S.trades.filter(t => t.creator_id === me);
    const block = (title, items, fn, empty) => `<h2 class="section-title">${title}</h2>
      <div class="market-grid">${items.map(fn).join('') || `<div class="empty small">${empty}</div>`}</div>`;
    list.className = '';
    list.innerHTML = block('Mes ventes en cours', selling, listingHTML, 'Aucune vente en cours.') +
      block('Enchères où je mène', bidding, listingHTML, 'Tu ne mènes aucune enchère.') +
      block('Mes offres d’échange', trades, tradeHTML, 'Aucune offre d’échange ouverte.');
  }
}

async function buyListing(id, button) {
  const l = S.listings.find(x => x.id === id);
  if (!l) return;
  const name = S.byId.get(l.card_id).name;
  if (!await confirmBox('Confirmer l’achat', `Acheter <strong>${esc(name)}</strong> à ${esc(l.seller_name)} pour <strong>${coins(l.price)} ${COIN}</strong> ?`, 'Acheter')) return;
  const res = await busy(button, () => api.buyListing(id));
  if (!res) return;
  toast(`${name} rejoint ta collection !${res.is_new ? ` Nouvelle espèce : +${pct(res.luck_gained)} de chance.` : ''}`, 'success', 6000);
  await sync({ market: true }).catch(() => {});
}
function bid(id) {
  const l = S.listings.find(x => x.id === id);
  if (!l) return;
  const name = S.byId.get(l.card_id).name, min = minBid(l);
  modal({
    title: `Enchérir : ${name}`,
    body: `<form class="form">
      <p>${l.current_bid ? `Meilleure offre : <strong>${coins(l.current_bid)} ${COIN}</strong> (${esc(l.bidder_name)})` : `Mise de départ : <strong>${coins(l.price)} ${COIN}</strong>`}
        · fin dans <span data-ends="${esc(l.ends_at)}"></span></p>
      <label>Ton offre (minimum ${coins(min)} ${COIN})
        <input name="amount" type="number" min="${min}" max="${Math.min(S.settings.max_price, Number(S.profile.balance))}" step="1" value="${min}" required inputmode="numeric" autofocus></label>
      <p class="muted small">Ton solde : ${coins(S.profile.balance)} ${COIN}. Le montant est bloqué tout de suite et te sera rendu
 automatiquement si quelqu’un enchérit plus haut. Une offre dans les ${S.settings.anti_snipe_seconds} dernières secondes prolonge l’enchère.</p></form>`,
    actions: [{ label: 'Annuler' }, {
      label: 'Enchérir', kind: 'primary', onClick: async (close, wrap) => {
        const form = $('form', wrap);
        if (!form.reportValidity()) return;
        const ok = await busy(null, async () => { await api.placeBid(id, Number(form.amount.value)); return true; });
        if (!ok) return sync({ state: false, inv: false, market: true }).catch(() => {});
        close();
        toast('Offre enregistrée, tu mènes l’enchère !', 'success');
        sync({ inv: false, market: true }).catch(() => {});
      }
    }],
    onOpen: wrap => { tick(true); $('form', wrap).addEventListener('submit', e => { e.preventDefault(); $('footer .btn-primary', wrap).click(); }); }
  });
}
async function cancelListing(id, button) {
  if (!await confirmBox('Retirer l’annonce', 'La carte reviendra dans ton inventaire.', 'Retirer', 'danger')) return;
  if (await busy(button, async () => { await api.cancelListing(id); return true; })) {
    toast('Annonce retirée.', 'success');
    await sync({ state: false, market: true }).catch(() => {});
  }
}
async function acceptTrade(id, button) {
  const t = S.trades.find(x => x.id === id);
  if (!t) return;
  const give = S.byId.get(t.wanted_card_id).name, get = S.byId.get(t.offered_card_id).name;
  if (!await confirmBox('Accepter l’échange', `Tu donnes <strong>1 ${esc(give)}</strong> et tu reçois <strong>1 ${esc(get)}</strong> de ${esc(t.creator_name)}.`, 'Échanger')) return;
  const res = await busy(button, () => api.acceptTrade(id));
  if (!res) return sync({ state: false, inv: false, market: true }).catch(() => {});
  toast(`Échange réussi : tu as reçu ${get} !${res.is_new ? ` Nouvelle espèce : +${pct(res.luck_gained)} de chance.` : ''}`, 'success', 6000);
  await sync({ market: true }).catch(() => {});
}
async function cancelTrade(id, button) {
  if (!await confirmBox('Annuler l’offre d’échange', 'Ta carte reviendra dans ton inventaire.', 'Annuler l’offre', 'danger')) return;
  if (await busy(button, async () => { await api.cancelTrade(id); return true; })) {
    toast('Offre annulée.', 'success');
    await sync({ state: false, market: true }).catch(() => {});
  }
}

/* --------------------------------------------------------------- index */
function renderIndex() {
  const f = S.dex;
  return `<section class="view" data-view="index" aria-labelledby="h-index">
    <div class="view-head"><h1 id="h-index">Index</h1>
      <p class="muted">Chaque nouvelle espèce découverte te donne un bonus de chance permanent (boutique et boosters) et une récompense en pièces.</p></div>
    <div class="panel dex-progress" id="dex-progress"></div>
    <div class="toolbar">
      <select id="dex-rarity" aria-label="Filtrer par rareté">${rarityOptions(f.rarity)}</select>
      <select id="dex-show" aria-label="Afficher">
        ${[['all', 'Toutes les espèces'], ['found', 'Découvertes'], ['missing', 'À découvrir']].map(([v, l]) => `<option value="${v}" ${f.show === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div id="list"></div>
  </section>`;
}
function updateIndex(first) {
  if (first) {
    $('#dex-rarity').addEventListener('change', e => { S.dex.rarity = e.target.value; updateIndex(); });
    $('#dex-show').addEventListener('change', e => { S.dex.show = e.target.value; updateIndex(); });
  }
  const found = S.discoveries.size, total = S.cards.length;
  const maxLuck = S.cards.reduce((s, c) => s + Number(R(c.rarity).luck_bonus), 0);
  $('#dex-progress').innerHTML = `
    <div><span class="label">Progression</span><strong>${found} / ${total}</strong>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${found}" aria-label="Espèces découvertes"><span style="width:${found / total * 100}%"></span></div></div>
    <div><span class="label">Chance totale</span><strong>🍀 +${pct(S.profile.luck)}</strong>
      <span class="muted small">sur ${pct(maxLuck, 2)} possibles si tu complètes l’Index</span></div>`;
  const f = S.dex;
  $('#list').innerHTML = S.rarities.filter(r => f.rarity === 'all' || String(r.id) === f.rarity).map(r => {
    const cards = S.cards.filter(c => c.rarity === r.id);
    const shown = cards.filter(c => f.show === 'all' || (f.show === 'found') === S.discoveries.has(c.id));
    const have = cards.filter(c => S.discoveries.has(c.id)).length;
    if (!shown.length) return '';
    return `<section class="dex-group" style="--rc:${r.color}">
      <h2 class="section-title"><span class="rarity-dot"></span>${esc(r.name)} <span class="muted">${have} / ${cards.length}</span>
        <small class="muted">+${pct(r.luck_bonus)} de chance et ${coins(r.discovery_reward)} ${COIN} par découverte</small></h2>
      <div class="card-grid small">${shown.map(c => S.discoveries.has(c.id)
        ? cardHTML(c, r)
        : cardHTML(c, r, { hidden: true, tag: 'div', extra: `<span class="dex-bonus">+${pct(r.luck_bonus)}</span>` })).join('')}</div>
    </section>`;
  }).join('') || '<div class="empty">Rien à afficher avec ces filtres.</div>';
}

boot();
