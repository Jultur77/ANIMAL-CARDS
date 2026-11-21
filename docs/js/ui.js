// Petits utilitaires d'interface : échappement, formats, toasts, fenêtres modales.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ESC[ch]);
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const nf = new Intl.NumberFormat('fr-FR');
export const coins = n => `${nf.format(Math.floor(Number(n) || 0))}`;
export const pct = (n, digits = 3) => `${Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: digits })} %`;
export function duration(ms) {
  if (ms <= 0) return '0 s';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
export const dateTime = iso => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

export function toast(text, type = 'info', ms = 3800) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = text;
  host.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

let openModals = 0;
// actions : [{ label, kind: 'primary'|'ghost'|'danger', value, onClick(close) }]
export function modal({ title, body, actions = [], wide = false, onOpen }) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header><h2 id="modal-title">${esc(title)}</h2>
          <button class="icon-btn" data-close aria-label="Fermer">✕</button></header>
        <div class="modal-body">${body}</div>
        ${actions.length ? `<footer>${actions.map((a, i) =>
   `<button class="btn btn-${a.kind || 'ghost'}" data-action="${i}">${esc(a.label)}</button>`).join('')}</footer>` : ''}
      </div>`;
    const close = value => {
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), 180);
      document.removeEventListener('keydown', onKey);
      openModals--;
      previous?.focus?.();
      resolve(value);
    };
    const onKey = e => {
      if (e.key === 'Escape') close(undefined);
      if (e.key === 'Tab') {   // garde le focus dans la fenêtre
        const items = $$('button, input, select, textarea, [tabindex]:not([tabindex="-1"])', wrap).filter(x => !x.disabled);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
 if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
 else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    wrap.addEventListener('click', async e => {
      if (e.target === wrap || e.target.closest('[data-close]')) return close(undefined);
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = actions[Number(btn.dataset.action)];
      if (action.onClick) {
        btn.disabled = true;
        try { await action.onClick(close, wrap); } finally { btn.disabled = false; }
      } else close(action.value);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    openModals++;
    onOpen?.(wrap, close);
    ($('[autofocus]', wrap) || $('footer .btn-primary', wrap) || $('[data-close]', wrap)).focus();
  });
}
export const confirmBox = (title, text, label = 'Confirmer', kind = 'primary') =>
  modal({ title, body: `<p>${text}</p>`, actions: [{ label: 'Annuler', value: false }, { label, kind, value: true }] })
    .then(Boolean);

// Désactive un bouton pendant une action asynchrone (anti double clic côté interface ;
// la vraie protection est côté serveur).
export async function busy(button, task) {
  if (button?.dataset.busy) return;
  if (button) { button.dataset.busy = '1'; button.disabled = true; button.classList.add('loading'); }
  try { return await task(); }
  catch (error) { toast(error.message || String(error), 'error', 5000); }
  finally { if (button) { delete button.dataset.busy; button.disabled = false; button.classList.remove('loading'); } }
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
