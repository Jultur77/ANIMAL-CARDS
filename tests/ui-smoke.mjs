// Test de fumée de l'interface : ouvre web/ dans Chromium avec un FAUX Supabase (tests/ui-mock-supabase.js).
// Lancer : npm run test:ui   (nécessite Playwright ; le test est ignoré s'il est absent)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pw;
try { pw = await import('playwright'); }
catch {
  try { pw = await import(pathToFileURL(fileURLToPath(new URL('../archive/firebase-v1/node_modules/playwright/index.mjs', import.meta.url))).href); }
  catch { console.log('Playwright absent : test d’interface ignoré (npm i -D playwright).'); process.exit(0); }
}
const { chromium } = pw;

const root = fileURLToPath(new URL('../web/', import.meta.url));
const mock = await readFile(new URL('./ui-mock-supabase.js', import.meta.url), 'utf8');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/ANIMAL-CARDS\//, '') || 'index.html';
  const file = normalize(join(root, p.endsWith('/') || p === '' ? p + 'index.html' : p));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); return res.end(); }
  try { const b = await readFile(file); res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const URL0 = `http://127.0.0.1:${server.address().port}/ANIMAL-CARDS/`;

const CONF_OK = "export const CONFIG = { supabaseUrl: 'https://mock.supabase.co', supabaseAnonKey: '" + 'x'.repeat(40) + "' };";
const CONF_EMPTY = "export const CONFIG = { supabaseUrl: '', supabaseAnonKey: '' };";
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`); };

// « chromium-headless-shell » n'est pas toujours téléchargé : on retombe sur le Chromium complet.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chromium' })).catch(e => {
  console.log('Chromium introuvable : lance « npx playwright install chromium ».\n' + e.message.split('\n')[0]);
  process.exit(0);
});
async function newPage(viewport, conf, reducedMotion = 'no-preference') {
  const ctx = await browser.newContext({ viewport, reducedMotion, locale: 'fr-FR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route('**/vendor/supabase.js', r => r.fulfill({ contentType: 'text/javascript', body: mock }));
  await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: conf }));
  return { ctx, page, errors };
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const toastText = async page => (await page.locator('#toasts').innerText()).trim();

async function fullRun(viewport, reducedMotion) {
  console.log(`\n▶ Parcours ${viewport.width}×${viewport.height}${reducedMotion === 'reduce' ? ' (animations réduites)' : ''}`);
  const { ctx, page, errors } = await newPage(viewport, CONF_OK, reducedMotion);
  await page.goto(URL0);

  // Pseudo
  await page.waitForSelector('#pseudo-form', { timeout: 8000 });
  check(await page.inputValue('#pseudo-form input') === 'Renard_77', 'pseudo prérempli depuis user_metadata');
  await page.click('#pseudo-form button[type="submit"], #pseudo-form .btn-primary');
  await page.waitForSelector('#h-inv', { timeout: 8000 });
  check(await page.locator('#list button[data-card]').count() === 12, 'inventaire : 12 cartes distinctes');
  check(await noOverflow(page), 'inventaire : pas de débordement horizontal');

  // Recherche
  await page.fill('#inv-q', 'nom assez long 3');
  await page.waitForTimeout(400);
  check(await page.locator('#list button[data-card]').count() === 1, 'recherche « 3 » : 1 carte');
  await page.fill('#inv-q', '');
  await page.waitForTimeout(400);

  // Détail puis vente en enchère
  await page.locator('#list button[data-card]').first().click();
  await page.waitForSelector('.modal');
  await page.click('.modal footer .btn-primary');      // « Vendre »
  await page.waitForSelector('#sell-form');
  await page.check('#sell-form input[value="auction"]');
  check((await page.locator('[data-sum]').innerText()).includes('Taxe'), 'formulaire de vente : taxe affichée');
  check((await page.locator('#sell-form select[name="minutes"] option').count()) === 7, 'enchère : 7 durées proposées');
  await page.click('.modal footer .btn-ghost');         // Annuler
  await page.waitForSelector('.modal', { state: 'detached' });

  // Récupérer
  await page.click('[data-claim]');
  await page.waitForTimeout(300);
  check((await toastText(page)).includes('récupérées'), 'récupérer les revenus : notification');

  // Boutique
  await page.goto(URL0 + '#/boutique');
  await page.waitForSelector('#h-shop');
  check(await page.locator('[data-buy]').count() === 6, 'boutique : 6 emplacements');
  check(await page.locator('[data-buy="5"]').isDisabled(), 'emplacement épuisé désactivé');
  check(await noOverflow(page), 'boutique : pas de débordement horizontal');
  await page.click('[data-odds="2"]');
  await page.waitForSelector('.modal');
  check((await page.locator('.modal').innerText()).includes('%'), 'fenêtre de contenu du booster : probabilités');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.click('[data-buy="1"]');
  await page.waitForSelector('.booster-big', { timeout: 5000 });
  check(true, 'ouverture du booster affichée');
  await page.click('[data-all]');
  await page.waitForSelector('[data-done]:not([hidden])', { timeout: 8000 });
  check(await noOverflow(page), 'révélation : pas de débordement horizontal');
  await page.click('[data-done]');
  await page.waitForSelector('.booster-big', { state: 'detached', timeout: 5000 });
  check(await page.evaluate(() => window.__calls.includes('buy_booster')), 'RPC buy_booster appelée');

  // Marché
  await page.goto(URL0 + '#/marche');
  await page.waitForSelector('#h-market');
  check(await noOverflow(page), 'marché : pas de débordement horizontal');
  await page.click('[data-bid="l1"]');
  await page.waitForSelector('.modal input[name="amount"]');
  check(await page.inputValue('.modal input[name="amount"]') === '630', 'enchère minimale = 630 (600 + 5 %)');
  await page.click('.modal footer .btn-primary');
  await page.waitForTimeout(400);
  check((await toastText(page)).includes('630'), 'erreur serveur sur l’enchère : notification affichée');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.click('[data-mtab="echanges"]');
  await page.waitForSelector('[data-accept-trade="t1"]');
  check(!(await page.locator('[data-accept-trade="t1"]').isDisabled()), 'échange t1 acceptable');
  check(await page.locator('[data-accept-trade="t2"]').isDisabled(), 'échange t2 désactivé (carte non possédée)');
  await page.click('[data-mtab="historique"]');
  await page.waitForTimeout(150);
  check((await page.locator('#list').innerText()).includes('Alice'), 'historique : vente et échange terminés');
  await page.click('[data-mtab="mes"]');
  await page.waitForTimeout(150);
  check((await page.locator('#list').innerText()).length > 0, 'mes annonces : contenu');

  // Index
  await page.goto(URL0 + '#/index');
  await page.waitForSelector('#dex-progress');
  check((await page.locator('#dex-progress').innerText()).replace(/\s/g, '').includes('12/28'), 'index : 12 / 28');
  check(await noOverflow(page), 'index : pas de débordement horizontal');

  // Déconnexion
  await page.click('[data-account]');
  await page.waitForSelector('.modal');
  await page.click('.modal footer .btn-danger');
  await page.waitForSelector('#auth-form', { timeout: 5000 });
  check(true, 'déconnexion : retour au formulaire de connexion');

  check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' :\n      ' + errors.join('\n      ') : ''));
  await ctx.close();
}

try {
  await fullRun({ width: 390, height: 844 }, 'no-preference');
  await fullRun({ width: 1280, height: 800 }, 'reduce');

  console.log('\n▶ Site non configuré');
  const { ctx, page, errors } = await newPage({ width: 390, height: 844 }, CONF_EMPTY);
  await page.goto(URL0);
  await page.waitForSelector('h1');
  check((await page.locator('h1').innerText()).includes('Configuration requise'), 'écran « Configuration requise »');
  check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
  await ctx.close();
} catch (e) {
  failures.push('exception : ' + e.message.split('\n')[0]);
  console.log('  ✘ exception : ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} échec(s).` : '\nTout est vert.');
process.exit(failures.length ? 1 : 0);
