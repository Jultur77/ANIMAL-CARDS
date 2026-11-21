// Tutoriel de prise en main : 6 étapes illustrées, montré à la première connexion
// puis accessible à tout moment via le bouton « ? » de la barre du haut.
import { esc, $, $$, coins } from './ui.js';
import { boosterSVG, scribbleArrow } from './art.js';

const KEY = id => `animal-cards.tuto.${id}`;   // simple préférence d'affichage
export const tutorialSeen = userId => {
  try { return localStorage.getItem(KEY(userId)) === '1'; } catch { return true; }
};

const mini = (emoji, color, rot, extra = '') =>
  `<span class="tuto-mini" style="--rc:${color};--rot:${rot}deg" ${extra}><span>${emoji}</span><i></i></span>`;

function steps({ username, settings: s, rarities, total }) {
  const col = i => rarities[Math.min(i, rarities.length - 1)]?.color || '#C6FB00';
  const rare = rarities[Math.min(3, rarities.length - 1)] || { id: 3, name: 'Épique', color: '#C6FB00' };
  return [
    {
      nav: 'inventaire', kicker: 'Bienvenue', title: `Salut ${esc(username || 'toi')}&nbsp;!`,
      text: `<p>Le but du jeu : trouver les <b>${total} animaux</b>, du plus commun au plus rare.</p>
 <p>Pour démarrer, tu as <b>${coins(s.start_balance)} 🪙</b> et <b>${s.starter_cards} cartes</b>. Elles sont déjà rangées dans ton <b>Inventaire</b>.</p>`,
      art: `<div class="tuto-fan">${mini('🦊', col(0), -14)}${mini('🐢', col(2), 2)}${mini('🦉', col(4), 16)}</div>
 <p class="note">tes premières cartes</p>`
    },
    {
      nav: 'boutique', kicker: 'Étape 1', title: 'Ouvre des boosters',
      text: `<p>La <b>Boutique</b> te propose ${s.shop_slots} boosters tirés au sort rien que pour toi. Ils changent toutes les ${Math.round(s.shop_refresh_seconds / 60)} minutes.</p>
        <p>Un booster contient <b>${s.cards_per_pack} cartes</b>. La dernière est toujours au moins de la rareté du booster. Le bouton <b>Contenu</b> affiche les chances.</p>`,
      art: `<div class="booster tuto-booster" style="--rc:${rare.color}">${boosterSVG(rare, { cards: s.cards_per_pack })}<span class="booster-foil"></span></div>
 <p class="note">touche-le pour le déchirer</p>`
    },
    {
      nav: 'inventaire', kicker: 'Étape 2', title: 'Ta collection rapporte',
      text: `<p>Chaque carte que tu possèdes rapporte des pièces <b>toutes les heures</b>, même quand tu n’es pas connecté (jusqu’à ${s.offline_cap_hours} h d’absence).</p>
        <p>Pense à cliquer sur <b>Récupérer</b> dans l’Inventaire pour les encaisser.</p>`,
      art: `<svg class="tuto-coins" viewBox="0 0 160 140" aria-hidden="true">
   ${[0, 1, 2, 3, 4].map(i => `<g transform="translate(${50 + (i % 2) * 4} ${110 - i * 16})"><ellipse rx="34" ry="11" cy="6" fill="#141414"/><ellipse rx="34" ry="11" fill="#C6FB00" stroke="#141414" stroke-width="3"/></g>`).join('')}
          <g transform="translate(118 52) rotate(14)"><ellipse rx="26" ry="26" fill="#141414" cx="3" cy="3"/><circle r="26" fill="#C6FB00" stroke="#141414" stroke-width="3"/><text y="9" text-anchor="middle" font-size="26" font-family="Archivo Black, sans-serif" fill="#141414">+</text></g>
 </svg><p class="note">des pièces toutes les heures</p>`
    },
    {
      nav: 'index', kicker: 'Étape 3', title: 'Complète l’Index',
      text: `<p>L’<b>Index</b> montre tous les animaux du jeu. Chaque <b>nouvelle espèce</b> te rapporte des pièces bonus et augmente ta <b>chance 🍀</b> pour toujours.</p>
 <p>Plus ta chance est grande, plus tu tombes sur des boosters et des cartes rares.</p>`,
      art: `<div class="tuto-dex">${Array.from({ length: 9 }, (_, i) => i < 4
   ? mini(['🐼', '🦒', '🐙', '🦜'][i], col(i), 0) : '<span class="tuto-slot">?</span>').join('')}</div>
        <p class="note">4 / ${total}… continue !</p>`
    },
    {
      nav: 'marche', kicker: 'Étape 4', title: 'Vends & échange',
      text: `<p>Clique sur une carte de ton inventaire pour la <b>vendre</b>, à prix fixe ou aux <b>enchères</b>.</p>
        <p>Au <b>Marché</b>, tu peux acheter les cartes des autres joueurs, enchérir ou accepter des <b>échanges</b> carte contre carte. Le vendeur paie une taxe de ${s.market_fee_pct}&nbsp;%.</p>`,
      art: `<div class="tuto-trade">${mini('🐊', col(2), -8)}
   ${scribbleArrow({ from: [8, 40], c1: [40, 10], c2: [80, 10], to: [112, 38], seed: 21, cls: 'ta' })}
   ${scribbleArrow({ from: [112, 62], c1: [80, 92], c2: [40, 92], to: [8, 64], seed: 8, cls: 'tb' })}
          ${mini('🦩', col(4), 8)}</div><p class="note">avec de vrais joueurs</p>`
    },
    {
      nav: null, kicker: 'C’est parti', title: 'À toi de jouer&nbsp;!',
      text: `<p>Pour bien démarrer :</p>
        <ol class="tuto-todo"><li>récupère tes pièces dans l’<b>Inventaire</b>,</li><li>achète un booster pas trop cher dans la <b>Boutique</b>,</li><li>regarde dans l’<b>Index</b> ce qui te manque.</li></ol>
        <p class="muted small">Tu peux revoir ce guide à tout moment avec le bouton <b>?</b> en haut.</p>`,
      art: `<div class="tuto-stamp"><span>GO</span><small>bonne chasse</small></div>`
    }
  ];
}

export function showTutorial({ userId, username, settings, rarities, go, total = 126 }) {
  const list = steps({ username, settings, rarities, total });
  let i = 0;
  const previous = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'tuto-backdrop';
  wrap.innerHTML = `<div class="tuto" role="dialog" aria-modal="true" aria-labelledby="tuto-title" aria-describedby="tuto-text">
      <button class="tuto-skip" data-tuto-skip>Passer le tutoriel</button>
      <div class="tuto-art" aria-hidden="true"></div>
      <div class="tuto-body">
        <p class="tuto-kicker"></p><h2 id="tuto-title"></h2><div id="tuto-text" class="tuto-text"></div>
        <div class="tuto-dots" aria-hidden="true">${list.map(() => '<i></i>').join('')}</div>
        <p class="sr-only" aria-live="polite" data-tuto-pos></p>
        <div class="tuto-actions"><button class="btn btn-ghost" data-tuto-prev>Retour</button>
   <button class="btn btn-primary" data-tuto-next>Suivant</button></div>
      </div></div>`;

  const spot = nav => {
    $$('.tuto-spot').forEach(a => a.classList.remove('tuto-spot'));
    if (nav) $(`[data-nav="${nav}"]`)?.classList.add('tuto-spot');
  };
  const show = (n, dir = 1) => {
    i = Math.max(0, Math.min(list.length - 1, n));
    const st = list[i], box = $('.tuto', wrap);
    box.style.setProperty('--dir', dir);
    box.classList.remove('turn'); void box.offsetWidth; box.classList.add('turn');
    $('.tuto-art', wrap).innerHTML = st.art;
    $('.tuto-kicker', wrap).textContent = `${st.kicker} · ${i + 1}/${list.length}`;
    $('#tuto-title', wrap).innerHTML = st.title;
    $('#tuto-text', wrap).innerHTML = st.text;
    $('[data-tuto-pos]', wrap).textContent = `Étape ${i + 1} sur ${list.length}`;
    $$('.tuto-dots i', wrap).forEach((d, k) => d.classList.toggle('on', k <= i));
    $('[data-tuto-prev]', wrap).hidden = i === 0;
    $('[data-tuto-next]', wrap).textContent = i === list.length - 1 ? 'Aller à la boutique' : 'Suivant';
    spot(st.nav);
  };
  const close = (toShop = false) => {
    try { localStorage.setItem(KEY(userId), '1'); } catch { /* navigation privée */ }
    spot(null);
    document.body.classList.remove('tuto-open');
    document.removeEventListener('keydown', onKey);
    wrap.classList.add('out');
    setTimeout(() => wrap.remove(), 220);
    if (toShop) go('boutique'); else previous?.focus?.();
  };
  const onKey = e => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' && !e.target.closest('input')) i < list.length - 1 && show(i + 1, 1);
    else if (e.key === 'ArrowLeft' && !e.target.closest('input')) show(i - 1, -1);
    else if (e.key === 'Tab') {
      const items = $$('button:not([hidden])', wrap);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  };
  wrap.addEventListener('click', e => {
    if (e.target.closest('[data-tuto-skip]')) return close();
    if (e.target.closest('[data-tuto-prev]')) return show(i - 1, -1);
    if (e.target.closest('[data-tuto-next]')) return i === list.length - 1 ? close(true) : show(i + 1, 1);
  });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  document.body.classList.add('tuto-open');
  show(0);
  $('[data-tuto-next]', wrap).focus();
}
