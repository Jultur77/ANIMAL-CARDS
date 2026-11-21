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

/* ------------------------------------------------------------------ boosters
   Sachet imprimé dessiné à la main en SVG : bords sertis, trame de points, bandeau
   en biais, tampon « 5 cartes », code-barres, pointillés « déchirer ici ». */
let uid = 0;
const rnd = seed => () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x6d2b79f5 | 0) >>> 0) / 4294967296;

function crimp(y0, y1, dir) {   // bord serti en dents de scie
  let d = `M8 ${y0}`;
  for (let x = 8, i = 0; x <= 192; x += 4, i++) d += ` L${x} ${i % 2 ? y0 + dir * 3 : y0}`;
  return `${d} L192 ${y1} L8 ${y1}Z`;
}

export function boosterSVG(rarity, { cards = 5 } = {}) {
  const id = `bk${++uid}`, c = rarity.color, name = String(rarity.name || '').toUpperCase();
  const r = rnd(hash(name) || 7);
  const size = Math.min(30, 230 / Math.max(name.length, 4));
  const bars = [];
  for (let x = 26; x < 82;) { const w = 1 + Math.floor(r() * 3); bars.push(`<rect x="${x}" y="236" width="${w}" height="16"/>`); x += w + 1 + Math.floor(r() * 2); }
  const pips = Array.from({ length: Math.max(1, rarity.id + 1) }, (_, i) =>
    `<path transform="translate(${30 + i * 13} 214) rotate(${(r() - 0.5) * 20})" d="M0-5 L1.6-1.6 L5 0 L1.6 1.6 L0 5 L-1.6 1.6 L-5 0 L-1.6-1.6Z"/>`).join('');
  return `<svg class="booster-svg" viewBox="0 0 200 280" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <pattern id="${id}d" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(25)"><circle cx="3.5" cy="3.5" r="1.5" fill="#141414"/></pattern>
      <pattern id="${id}r" width="3" height="10" patternUnits="userSpaceOnUse"><rect width="1.4" height="10" fill="#141414" opacity=".22"/></pattern>
      <linearGradient id="${id}m" x1="0" y1="0" x2="1" y2="1"><stop offset=".35" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".9"/></linearGradient>
      <mask id="${id}k"><rect width="200" height="280" fill="url(#${id}m)"/></mask>
    </defs>
    <path d="M8 22 H192 V258 H8Z" fill="${c}"/>
    <rect x="8" y="22" width="184" height="236" fill="url(#${id}d)" opacity=".28" mask="url(#${id}k)"/>
    <path d="${crimp(0, 24, 1)}" fill="${c}"/><path d="${crimp(0, 24, 1)}" fill="url(#${id}r)"/>
    <path d="${crimp(280, 256, -1)}" fill="${c}"/><path d="${crimp(280, 256, -1)}" fill="url(#${id}r)"/>
    <path d="M8 23.5 H192 M8 256.5 H192" stroke="#141414" stroke-width="1.2" opacity=".5"/>
    <path d="M12 33 H188" stroke="#141414" stroke-width="1" stroke-dasharray="3 3" opacity=".55"/>
    <text x="186" y="30" text-anchor="end" font-size="5.5" font-family="Space Grotesk, sans-serif" font-weight="700" fill="#141414" opacity=".7">DÉCHIRER ICI ✂</text>
    <text x="18" y="56" font-size="15" font-family="Archivo Black, Arial Black, sans-serif" fill="#141414" letter-spacing=".5">ANIMAL</text>
    <text x="18" y="72" font-size="15" font-family="Archivo Black, Arial Black, sans-serif" fill="#FDFDFF" stroke="#141414" stroke-width="1.1" paint-order="stroke" letter-spacing=".5">CARDS</text>
    <text x="18" y="84" font-size="6.5" font-family="Space Grotesk, sans-serif" font-weight="700" fill="#141414" letter-spacing="1.2">SÉRIE 01 · FAUNE DU MONDE</text>
    <g transform="translate(118 118) rotate(-16)" fill="#141414" opacity=".88">
      <ellipse cx="0" cy="14" rx="19" ry="16"/><ellipse cx="-21" cy="-8" rx="7" ry="9.5" transform="rotate(-24 -21 -8)"/>
      <ellipse cx="-8" cy="-20" rx="7" ry="10"/><ellipse cx="8" cy="-20" rx="7" ry="10"/>
      <ellipse cx="21" cy="-8" rx="7" ry="9.5" transform="rotate(24 21 -8)"/>
    </g>
    <path d="M8 158 L192 118 V172 L8 212Z" fill="#141414"/>
    <text transform="translate(100 172) rotate(-12.3)" text-anchor="middle" font-size="${size}" font-family="Archivo Black, Arial Black, sans-serif" fill="#FDFDFF">${esc(name)}</text>
    <g fill="#141414">${pips}</g>
    <g transform="translate(160 64) rotate(12)">
      <circle r="23" fill="#FDFDFF" stroke="#141414" stroke-width="2"/><circle r="19" fill="none" stroke="#141414" stroke-width=".8" stroke-dasharray="2 2"/>
      <text y="5" text-anchor="middle" font-size="19" font-family="Archivo Black, Arial Black, sans-serif" fill="#141414">${cards}</text>
      <text y="14" text-anchor="middle" font-size="5.5" font-family="Space Grotesk, sans-serif" font-weight="700" fill="#141414" letter-spacing=".6">CARTES</text>
    </g>
    <rect x="22" y="232" width="64" height="22" fill="#FDFDFF"/><g fill="#141414">${bars.join('')}</g>
    <text x="182" y="248" text-anchor="end" font-size="6" font-family="Space Grotesk, sans-serif" font-weight="700" fill="#141414">N° ${String(Math.floor(r() * 9000) + 1000)}</text>
  </svg>`;
}

/* --------------------------------------------------- flèches dessinées à la main
   Tracé légèrement tremblé (deux passages comme au feutre) et pointe aux branches inégales. */
export function scribbleArrow({ from = [10, 70], c1 = [40, 0], c2 = [80, 90], to = [112, 22], seed = 3, cls = '' } = {}) {
  const r = rnd(seed);
  const at = t => [0, 1].map(k => (1 - t) ** 3 * from[k] + 3 * (1 - t) ** 2 * t * c1[k] + 3 * (1 - t) * t * t * c2[k] + t ** 3 * to[k]);
  const line = (jit, dx = 0, dy = 0) => Array.from({ length: 23 }, (_, i) => {
    const [x, y] = at(i / 22);
    return `${i ? 'L' : 'M'}${(x + dx + (r() - 0.5) * jit).toFixed(1)} ${(y + dy + (r() - 0.5) * jit).toFixed(1)}`;
  }).join(' ');
  const [ex, ey] = to, [px, py] = at(0.93), a = Math.atan2(ey - py, ex - px);
  const arm = (da, len) => `${(ex + Math.cos(a + da) * len).toFixed(1)} ${(ey + Math.sin(a + da) * len).toFixed(1)}`;
  return `<svg class="scribble ${cls}" viewBox="0 0 120 100" aria-hidden="true">
    <path class="s-main" d="${line(1.6)}"/><path class="s-pass" d="${line(1.2, 0.9, 0.6)}"/>
    <path class="s-head" d="M${arm(2.55, 17)} L${ex} ${ey} L${arm(-2.35, 13)}"/></svg>`;
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
