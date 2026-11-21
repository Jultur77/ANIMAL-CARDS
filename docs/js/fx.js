// Ouverture de booster : animation, révélation carte par carte, particules,
// lumière, secousse d'écran et son synthétisé (désactivable).
import { cardHTML } from './art.js';
import { esc, pct, coins, reducedMotion, $ } from './ui.js';

const SOUND_KEY = 'animal-cards.sound';   // simple préférence d'affichage, rien de critique
export const sound = {
  get on() { return localStorage.getItem(SOUND_KEY) !== 'off'; },
  set on(v) { localStorage.setItem(SOUND_KEY, v ? 'on' : 'off'); }
};
let audio;
function tone(freqs, duration = 0.18, type = 'sine', gain = 0.06) {
  if (!sound.on) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    freqs.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.07);
      g.gain.linearRampToValueAtTime(gain, t + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + duration);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + duration + 0.05);
    });
  } catch { /* audio indisponible : on ignore */ }
}
const SOUNDS = [[523], [587, 784], [659, 880], [523, 659, 988], [523, 784, 1047, 1319], [440, 660, 880, 1320, 1760], [392, 523, 784, 1047, 1568, 2093]];

function particles(x, y, color, amount) {
  if (reducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const parts = Array.from({ length: amount }, () => {
    const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 7;
    return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: 1, size: 2 + Math.random() * 4,
      color: Math.random() < 0.3 ? '#ffffff' : color };
  });
  const step = () => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = false;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive = true;
      p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.vx *= 0.985; p.life -= 0.012;
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0, p.size * p.life), 0, Math.PI * 2); ctx.fill();
    }
    if (alive) requestAnimationFrame(step); else canvas.remove();
  };
  requestAnimationFrame(step);
}
function shake(intensity) {
  if (reducedMotion()) return;
  document.body.style.setProperty('--shake', `${intensity}px`);
  document.body.classList.remove('shaking'); void document.body.offsetWidth;
  document.body.classList.add('shaking');
  setTimeout(() => document.body.classList.remove('shaking'), 600);
}
function flash(color) {
  if (reducedMotion()) return;
  const el = document.createElement('div');
  el.className = 'fx-flash'; el.style.setProperty('--rc', color);
  document.body.append(el);
  setTimeout(() => el.remove(), 900);
}

// result : réponse de buy_booster ; lookup(cardId) -> { card, rarity }
export function openPack(result, lookup, boosterRarity) {
  return new Promise(resolve => {
    const items = result.cards.map(c => ({ ...c, ...lookup(c.card_id) }));
    const best = Math.max(...items.map(i => i.rarity.id));
    const overlay = document.createElement('div');
    overlay.className = 'pack-overlay';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Ouverture du booster');
    overlay.innerHTML = `
      <div class="pack-stage">
        <button class="booster booster-big r${boosterRarity.id}" style="--rc:${boosterRarity.color}" aria-label="Ouvrir le booster">
          <span class="booster-glow"></span><span class="booster-logo">🐾</span>
          <span class="booster-title">Booster ${esc(boosterRarity.name)}</span>
          <span class="booster-hint">Touche pour ouvrir</span>
        </button>
        <div class="reveal-row" hidden>
          ${items.map((it, i) => `<div class="reveal-slot" style="--i:${i};--rc:${it.rarity.color}">
     <button class="reveal-card" data-i="${i}" aria-label="Retourner la carte ${i + 1}">
       <div class="reveal-back r${Math.min(it.rarity.id, 6)}"><span>🐾</span></div>
       <div class="reveal-front">${cardHTML(it.card, it.rarity, { tag: 'div' })}
         ${it.is_new ? `<span class="new-badge">NOUVEAU · +${pct(it.luck_gained)} chance${it.reward ? ` · +${coins(it.reward)} 🪙` : ''}</span>` : ''}
       </div>
     </button></div>`).join('')}
        </div>
        <div class="pack-actions" hidden>
          <button class="btn btn-ghost" data-all>Tout révéler</button>
   <button class="btn btn-primary" data-done hidden>Continuer</button>
        </div>
      </div>`;
    document.body.append(overlay);
    const booster = $('.booster-big', overlay);
    booster.focus();
    let revealed = 0;
    const reveal = button => {
      if (button.classList.contains('flipped')) return;
      button.classList.add('flipped');
      const it = items[Number(button.dataset.i)];
      const r = button.getBoundingClientRect();
      tone(SOUNDS[it.rarity.id], 0.22 + it.rarity.id * 0.05);
      if (it.rarity.id >= 2) particles(r.left + r.width / 2, r.top + r.height / 2, it.rarity.color, 20 + it.rarity.id * 25);
      if (it.rarity.id >= 4) { flash(it.rarity.color); shake(2 + (it.rarity.id - 3) * 3); }
      if (++revealed === items.length) { $('[data-done]', overlay).hidden = false; $('[data-all]', overlay).hidden = true; $('[data-done]', overlay).focus(); }
    };
    booster.addEventListener('click', () => {
      booster.classList.add('opening');
      tone([300, 450, 600], 0.25, 'triangle');
      if (best >= 4) shake(3);
      setTimeout(() => {
        booster.remove();
        $('.reveal-row', overlay).hidden = false;
        $('.pack-actions', overlay).hidden = false;
 if (best >= 5) overlay.classList.add('epic-aura');
        overlay.style.setProperty('--best', items.find(i => i.rarity.id === best).rarity.color);
        $('.reveal-card', overlay).focus();
      }, reducedMotion() ? 0 : 650);
    }, { once: true });
    overlay.addEventListener('click', e => {
      const card = e.target.closest('.reveal-card');
      if (card) reveal(card);
      if (e.target.closest('[data-all]')) $$all('.reveal-card', overlay).forEach((b, i) => setTimeout(() => reveal(b), i * 180));
      if (e.target.closest('[data-done]')) { overlay.classList.add('out'); setTimeout(() => { overlay.remove(); resolve(); }, 250); }
    });
  });
}
const $$all = (s, r) => [...r.querySelectorAll(s)];
