// Illustrations SVG originales générées pour chaque carte : décor selon le milieu de
// vie, ornements selon la rareté, animal au centre. Aucune image externe à charger.
import { esc } from './ui.js';

const BIOMES = {
  mammal:    { sky: ['#1d3b2a', '#3f6b3a'], ground: '#24452b', accent: '#9fd36a', label: 'Mammifère' },
  bird:      { sky: ['#123b66', '#5aa2d8'], ground: '#1d4f7d', accent: '#d8f1ff', label: 'Oiseau' },
  reptile:   { sky: ['#4a3215', '#b88a3c'], ground: '#5a4020', accent: '#f3d27a', label: 'Reptile' },
  amphibian: { sky: ['#0f3b3a', '#2f8a72'], ground: '#164a3f', accent: '#8ff0c4', label: 'Amphibien' },
  fish:      { sky: ['#0b3150', '#2a7fb0'], ground: '#0d3a5c', accent: '#9fe2ff', label: 'Poisson' },
  marine:    { sky: ['#06182f', '#0f5486'], ground: '#082a4a', accent: '#6fd6ff', label: 'Animal marin' },
  insect:    { sky: ['#2f3a10', '#8aa12c'], ground: '#3a4a14', accent: '#f6ef7a', label: 'Petite bête' },
  extinct:   { sky: ['#2a0f1f', '#a6452a'], ground: '#3a1416', accent: '#ffb36b', label: 'Espèce disparue' }
};
export const biomeLabel = category => BIOMES[category]?.label ?? '';

function hash(text) { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0; }

function scenery(category, b, seed) {
  const s = n => ((seed >> n) & 31);
  switch (category) {
    case 'marine': case 'fish':
      return `<path d="M0 ${200 + s(1)} Q50 ${185 + s(3)} 100 ${200 + s(5)} T200 ${195 + s(7)} V280 H0Z" fill="${b.ground}" opacity=".9"/>
        ${[0, 1, 2, 3, 4].map(i => `<circle cx="${20 + ((seed >> i * 3) % 160)}" cy="${40 + i * 30}" r="${2 + i % 3}" fill="${b.accent}" opacity=".35"/>`).join('')}
        <path d="M0 230 Q60 215 120 232 T200 228 V280 H0Z" fill="#000" opacity=".25"/>`;
    case 'bird':
      return `<ellipse cx="${40 + s(2)}" cy="70" rx="38" ry="12" fill="#fff" opacity=".18"/>
        <ellipse cx="${150 - s(4)}" cy="105" rx="30" ry="9" fill="#fff" opacity=".14"/>
        <path d="M0 225 Q100 200 200 222 V280 H0Z" fill="${b.ground}"/>`;
    case 'reptile':
      return `<circle cx="${150 - s(3)}" cy="62" r="20" fill="${b.accent}" opacity=".45"/>
 <path d="M0 215 L40 190 L75 208 L120 180 L165 205 L200 192 V280 H0Z" fill="${b.ground}"/>`;
    case 'insect':
      return `<path d="M0 220 Q100 200 200 220 V280 H0Z" fill="${b.ground}"/>
        ${[0, 1, 2, 3, 4, 5].map(i => `<circle cx="${15 + i * 34}" cy="${222 - (i % 2) * 6}" r="4" fill="${i % 2 ? '#ffd1e8' : b.accent}" opacity=".8"/>`).join('')}`;
    case 'extinct':
      return `<path d="M20 200 L70 120 L120 200Z" fill="#1a0a0c" opacity=".7"/>
        <path d="M62 132 Q70 105 78 132" fill="${b.accent}" opacity=".6"/>
        <path d="M0 215 Q100 195 200 212 V280 H0Z" fill="${b.ground}"/>`;
    default:
      return `<path d="M0 205 Q50 175 100 200 T200 190 V280 H0Z" fill="${b.ground}" opacity=".75"/>
 <path d="M0 225 Q80 205 200 228 V280 H0Z" fill="${b.ground}"/>
        ${[0, 1, 2].map(i => `<path d="M${25 + i * 70 + s(i)} 205 l10 -34 l10 34z" fill="#0e2616" opacity=".7"/>`).join('')}`;
  }
}

function ornaments(tier, color, id) {
  let out = '';
  if (tier >= 2) out += `<g opacity="${0.08 + tier * 0.03}">${Array.from({ length: 12 }, (_, i) =>
    `<path d="M100 120 L${100 + 160 * Math.cos(i * Math.PI / 6)} ${120 + 160 * Math.sin(i * Math.PI / 6)} L${100 + 160 * Math.cos(i * Math.PI / 6 + 0.13)} ${120 + 160 * Math.sin(i * Math.PI / 6 + 0.13)}Z" fill="${color}"/>`).join('')}</g>`;
  if (tier >= 4) out += `<circle cx="100" cy="122" r="62" fill="url(#${id}h)"/>`;
  if (tier >= 6) out += Array.from({ length: 14 }, (_, i) =>
    `<path transform="translate(${(i * 53) % 190 + 5} ${(i * 37) % 170 + 10}) scale(${0.4 + (i % 3) * 0.25})" d="M0-6 L1.5-1.5 L6 0 L1.5 1.5 L0 6 L-1.5 1.5 L-6 0 L-1.5-1.5Z" fill="#fff" opacity=".85"/>`).join('');
  return out;
}

export function cardSVG(card, rarity, { hidden = false } = {}) {
  const b = BIOMES[card.category] || BIOMES.mammal;
  const seed = hash(card.id);
  const id = `g${seed.toString(36)}`;
  return `<svg viewBox="0 0 200 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(hidden ? 'Carte non découverte' : card.name)}" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hidden ? '#15151d' : b.sky[0]}"/><stop offset="1" stop-color="${hidden ? '#272735' : b.sky[1]}"/></linearGradient>
      <radialGradient id="${id}h"><stop offset="0" stop-color="${rarity.color}" stop-opacity=".55"/><stop offset="1" stop-color="${rarity.color}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="200" height="280" fill="url(#${id}s)"/>
    ${hidden ? '' : ornaments(rarity.id, rarity.color, id) + scenery(card.category, b, seed)}
    <ellipse cx="100" cy="196" rx="46" ry="8" fill="#000" opacity=".3"/>
    <text x="100" y="${hidden ? 150 : 158}" text-anchor="middle" font-size="${hidden ? 72 : 92}"
      ${hidden ? 'class="silhouette"' : ''}>${hidden ? '?' : esc(card.emoji)}</text>
  </svg>`;
}

// Élément carte complet (cadre, brillance holographique, infos).
export function cardHTML(card, rarity, { count = 0, hidden = false, locked = 0, extra = '', tag = 'button', attrs = '' } = {}) {
  return `<${tag} class="card r${rarity.id} ${hidden ? 'is-hidden' : ''}" style="--rc:${rarity.color}" data-tilt data-card="${esc(card.id)}" ${attrs}
      ${tag === 'button' ? 'type="button"' : ''} aria-label="${esc(hidden ? `Carte ${rarity.name} non découverte` : `${card.name}, ${rarity.name}`)}">
    <div class="card-inner">
      <div class="card-art">${cardSVG(card, rarity, { hidden })}</div>
      <div class="card-shine" aria-hidden="true"></div>
      <span class="card-num">#${String(card.number).padStart(3, '0')}</span>
      ${count > 1 ? `<span class="card-count">×${count}</span>` : ''}
      ${locked ? `<span class="card-lock" title="${locked} exemplaire(s) en vente ou en échange">🔒${locked > 1 ? locked : ''}</span>` : ''}
      <div class="card-info">
        <strong class="card-name">${hidden ? '???' : esc(card.name)}</strong>
 <span class="card-meta"><span class="rarity-dot"></span>${esc(rarity.name)}${hidden ? '' : ` · 🪙 ${card.value.toLocaleString('fr-FR')}`}</span>
      </div>
      ${extra}
    </div>
  </${tag}>`;
}

// Inclinaison 3D + reflet qui suit le pointeur (souris ou doigt).
export function enableTilt(root = document) {
  let frame = 0;
  root.addEventListener('pointermove', e => {
    const card = e.target.closest?.('[data-tilt]');
    if (!card || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      card.style.setProperty('--rx', `${(0.5 - y) * 16}deg`);
      card.style.setProperty('--ry', `${(x - 0.5) * 18}deg`);
      card.style.setProperty('--mx', `${x * 100}%`);
      card.style.setProperty('--my', `${y * 100}%`);
      card.classList.add('tilting');
    });
  }, { passive: true });
  root.addEventListener('pointerout', e => {
    const card = e.target.closest?.('[data-tilt]');
    if (card && !card.contains(e.relatedTarget)) {
      card.classList.remove('tilting');
      card.style.removeProperty('--rx'); card.style.removeProperty('--ry');
    }
  });
}
