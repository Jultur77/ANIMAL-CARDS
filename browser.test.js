import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createGameServer } from './server.js';
import { GameStore } from './store.js';

const screenshotDirectory = '.frst/screenshots';
const password = 'AnimalCards_Test_2026!';
let now = Date.UTC(2026, 10, 2, 12, 0, 1);
const store = new GameStore(':memory:', { now: () => now });
const { server } = createGameServer({ store, secure: false, origin: '' });
const errors = [];
const failedResources = [];
let browser;
let origin;
let checks = 0;
function passed(label) { checks++; console.log(`OK ${checks} — ${label}`); }
async function state(page) {
  const response = await page.request.get(`${origin}/api/state`);
  assert.equal(response.status(), 200);
  return response.json();
}
async function tab(page, name) {
  await page.locator(`.main-nav [data-tab="${name}"]`).click();
  await expect(page.locator('#page-label')).toHaveText({ inventaire: 'Inventaire', boutique: 'Boutique', encheres: 'Enchères', index: 'Index' }[name]);
}
async function register(page, username) {
  await page.goto(origin);
  await expect(page.locator('#guest')).toBeVisible();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#game')).toBeVisible();
  assert.equal((await state(page)).inventory.length, 4);
}
async function openItem(page, cardId) {
  await tab(page, 'inventaire');
  const card = page.locator(`#inventory-results button[data-card-id="${cardId}"]`);
  await expect(card).toBeVisible();
  const itemId = await card.getAttribute('data-item-id');
  await card.click();
  await expect(page.locator('#modal')).toBeVisible();
  return itemId;
}
async function list(page, cardId, kind, price) {
  const itemId = await openItem(page, cardId);
  await page.locator('[data-command="list-form"]').click();
  await page.locator('#listing-kind').selectOption(kind);
  await page.locator('#listing-price').fill(String(price));
  await page.locator('#listing-duration').selectOption('5');
  await page.locator('#listing-form button[type="submit"]').click();
  await expect(page.locator('#modal')).not.toBeVisible();
  const current = await state(page);
  assert.equal(current.inventory.find(item => item.id === itemId).locked, 'listing');
  return itemId;
}
async function market(page, type) {
  await tab(page, 'encheres');
  await page.locator(`[data-market-type="${type}"]`).click();
  await expect(page.locator('#market-results')).not.toHaveAttribute('aria-busy', 'true');
}
async function refresh(page) {
  await page.locator('[data-command="refresh"]').click();
  await expect(page.locator('#sync-warning')).not.toBeVisible();
}
async function screenshot(page, name) {
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, animations: 'disabled' });
}
function observe(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failedResources.push(`${response.status()} ${response.url()}`); });
}
async function main() {
  await mkdir(screenshotDirectory, { recursive: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const bobContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  aliceContext.setDefaultTimeout(8000);
  bobContext.setDefaultTimeout(8000);
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  observe(alice);
  observe(bob);
  await alice.goto(origin);
  await expect(alice.locator('#guest')).toBeVisible();
  await expect(alice.locator('#landing-cards .card')).toHaveCount(3);
  await screenshot(alice, 'landing-desktop');
  await alice.setViewportSize({ width: 390, height: 844 });
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'La page d’accueil ne doit pas déborder horizontalement.');
  await screenshot(alice, 'landing-mobile');
  await alice.setViewportSize({ width: 1440, height: 1000 });
  passed('Accueil et illustrations sur ordinateur et mobile');

  await register(alice, 'TestAlice');
  await register(bob, 'TestBob');
  const aliceStart = await state(alice);
  const bobStart = await state(bob);
  assert.notEqual(aliceStart.user.id, bobStart.user.id);
  assert.equal(aliceStart.discoveredIds.length, 4);
  assert.equal(aliceStart.shop.offers.length, 6);
  await screenshot(alice, 'shop-desktop');
  passed('Deux comptes isolés avec quatre cartes et boutique personnelle');

  const common = alice.locator('.pack.r0 [data-command="buy-pack"]').first();
  await expect(common).toBeEnabled();
  await common.click();
  await expect(alice.locator('[data-command="open-sealed"]')).toBeVisible();
  assert.equal((await state(alice)).inventory.length, 8);
  await alice.locator('[data-command="open-sealed"]').click();
  await expect(alice.locator('[data-command="flip"]')).toHaveCount(4);
  await alice.locator('[data-command="reveal-all"]').click();
  await expect(alice.locator('.reveal.flipped')).toHaveCount(4);
  await screenshot(alice, 'booster-revealed');
  await alice.locator('[data-command="finish-opening"]').click();
  await expect(alice.locator('#page-label')).toHaveText('Inventaire');
  await alice.locator('#filter-search').fill('renard');
  await expect(alice.locator('#inventory-results .card')).toHaveCount(1);
  await alice.locator('#filter-search').fill('animal introuvable');
  await expect(alice.locator('#inventory-results .empty')).toBeVisible();
  await alice.locator('#filter-search').fill('');
  await tab(alice, 'index');
  await expect(alice.locator('#index-results .card')).toHaveCount(56);
  await expect(alice.locator('#index-results .undiscovered')).not.toHaveCount(0);
  await screenshot(alice, 'index-desktop');
  passed('Achat, révélation des quatre cartes, recherche et Index');

  const soldItemId = await list(alice, 'red-fox', 'fixed', 150);
  await market(bob, 'fixed');
  const sale = bob.locator('.market-row').filter({ has: bob.locator('[data-command="buy"]') }).first();
  await expect(sale).toContainText('Renard roux');
  await sale.locator('[data-command="buy"]').click();
  await bob.locator('[data-command="confirm-action"]').click();
  await expect(bob.locator('#modal')).not.toBeVisible();
  assert.ok((await state(bob)).inventory.some(item => item.id === soldItemId));
  assert.ok(!(await state(alice)).inventory.some(item => item.id === soldItemId));
  assert.ok((await state(alice)).discoveredIds.includes('red-fox'));
  passed('Vente réelle, transfert unique et découverte permanente');

  const offeredItemId = await openItem(alice, 'rabbit');
  await alice.locator('[data-command="trade-form"]').click();
  await alice.locator('#wanted-card').selectOption('clownfish');
  await alice.locator('#trade-form button[type="submit"]').click();
  await expect(alice.locator('#modal')).not.toBeVisible();
  const bobClownfish = (await state(bob)).inventory.find(item => item.cardId === 'clownfish' && !item.locked);
  await market(bob, 'trade');
  await bob.locator('[data-command="accept-trade"]').click();
  await bob.locator('[data-command="confirm-action"]').click();
  await expect(bob.locator('#modal')).not.toBeVisible();
  assert.ok((await state(bob)).inventory.some(item => item.id === offeredItemId && !item.locked));
  assert.ok((await state(alice)).inventory.some(item => item.id === bobClownfish.id && !item.locked));
  passed('Échange atomique de deux cartes entre les joueurs');

  const auctionItemId = await list(alice, 'monarch', 'auction', 40);
  await market(bob, 'auction');
  await bob.locator('[data-command="bid"]').click();
  await bob.locator('#bid-amount').fill('40');
  const beforeBid = (await state(bob)).user.balanceMilli;
  await bob.locator('#bid-form button[type="submit"]').click();
  await expect(bob.locator('#modal')).not.toBeVisible();
  assert.equal((await state(bob)).user.balanceMilli, beforeBid - 40000);
  await expect(bob.locator('.tag.win')).toBeVisible();
  await bob.locator('[data-command="bid"]').click();
  await bob.locator('#bid-amount').fill('50');
  await bob.locator('#bid-form button[type="submit"]').click();
  await expect(bob.locator('#modal')).not.toBeVisible();
  assert.equal((await state(bob)).user.balanceMilli, beforeBid - 50000);
  now += 301000;
  await state(bob);
  await refresh(bob);
  assert.ok((await state(bob)).inventory.some(item => item.id === auctionItemId && !item.locked));
  assert.ok(!(await state(alice)).inventory.some(item => item.id === auctionItemId));
  await market(bob, 'history');
  await expect(bob.locator('.market-row')).toHaveCount(2);
  await screenshot(bob, 'market-history');
  passed('Enchère, augmentation, réserve et règlement automatique');

  const cancelledItemId = await list(alice, 'clownfish', 'fixed', 200);
  await market(alice, 'fixed');
  await alice.locator('#filter-mine').check();
  await expect(alice.locator('[data-command="cancel-listing"]')).toHaveCount(1);
  await alice.locator('[data-command="cancel-listing"]').click();
  await alice.locator('[data-command="confirm-action"]').click();
  await expect(alice.locator('#modal')).not.toBeVisible();
  assert.equal((await state(alice)).inventory.find(item => item.id === cancelledItemId).locked, '');
  const cancelledTradeItemId = await openItem(alice, 'clownfish');
  await alice.locator('[data-command="trade-form"]').click();
  await alice.locator('#wanted-card').selectOption('wolf');
  await alice.locator('#trade-form button[type="submit"]').click();
  await expect(alice.locator('#modal')).not.toBeVisible();
  await market(alice, 'trade');
  await alice.locator('[data-command="cancel-trade"]').click();
  await alice.locator('[data-command="confirm-action"]').click();
  await expect(alice.locator('#modal')).not.toBeVisible();
  assert.equal((await state(alice)).inventory.find(item => item.id === cancelledTradeItemId).locked, '');
  passed('Annulation des ventes et échanges avec libération des cartes');

  await tab(alice, 'boutique');
  await refresh(alice);
  const beforeLostResponse = await state(alice);
  let intercepted = false;
  const loseResponse = async route => {
    if (intercepted) return route.continue();
    intercepted = true;
    await route.fetch();
    await route.abort('failed');
  };
  await alice.route('**/api/action', loseResponse);
  await alice.locator('.pack.r0 [data-command="buy-pack"]').first().click();
  await expect(alice.locator('#pending-banner')).toBeVisible();
  assert.equal((await state(alice)).inventory.length, beforeLostResponse.inventory.length + 4);
  const pendingKey = await alice.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('animal-cards.pending.')));
  assert.ok(pendingKey);
  const pending = await alice.evaluate(key => JSON.parse(localStorage.getItem(key)), pendingKey);
  assert.ok(pending.key);
  await alice.unroute('**/api/action', loseResponse);
  await alice.reload();
  await expect(alice.locator('#pending-banner')).toBeVisible();
  await expect(alice.locator('.pack.r0 [data-command="buy-pack"]').first()).toBeDisabled();
  await alice.locator('#retry-pending').click();
  await expect(alice.locator('[data-command="open-sealed"]')).toBeVisible();
  await expect(alice.locator('#pending-banner')).not.toBeVisible();
  assert.equal((await state(alice)).inventory.length, beforeLostResponse.inventory.length + 4);
  assert.equal(await alice.evaluate(key => localStorage.getItem(key), pendingKey), null);
  await alice.locator('#close-modal').click();
  passed('Réponse perdue et reprise après rechargement sans double achat');

  await tab(alice, 'inventaire');
  await alice.setViewportSize({ width: 390, height: 844 });
  await expect(alice.locator('.main-nav')).toBeVisible();
  await alice.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const mobileLayout = await alice.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')].map(element => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, id: element.id, className: element.className, left: rect.left, right: rect.right, width: rect.width };
    }).filter(rect => rect.width > 0 && rect.right > innerWidth + 0.5).slice(0, 20)
  }));
  assert.ok(mobileLayout.documentWidth <= mobileLayout.viewport, `Le jeu ne doit pas déborder sur mobile : ${JSON.stringify(mobileLayout)}`);
  await screenshot(alice, 'inventory-mobile');
  await tab(alice, 'index');
  await expect(alice.locator('#index-results .card')).toHaveCount(56);
  await screenshot(alice, 'index-mobile');
  await expect(alice.locator('#logout-mobile')).toBeVisible();
  await expect(alice.locator('#logout')).toBeHidden();
  await alice.locator('#logout-mobile').click();
  await expect(alice.locator('#guest')).toBeVisible();
  await alice.locator('[data-auth="login"]').click();
  await alice.locator('#username').fill('TestAlice');
  await alice.locator('#password').fill(password);
  await alice.locator('#auth-submit').click();
  await expect(alice.locator('#game')).toBeVisible();
  assert.equal((await state(alice)).user.id, aliceStart.user.id);
  assert.equal((await state(alice)).inventory.length, beforeLostResponse.inventory.length + 4);
  await alice.setViewportSize({ width: 1440, height: 1000 });
  await expect(alice.locator('#logout')).toBeVisible();
  await expect(alice.locator('#logout-mobile')).toBeHidden();
  passed('Navigation, déconnexion et reconnexion sur mobile avec progression conservée');

  assert.deepEqual(errors, [], 'Aucune exception JavaScript ne doit atteindre le navigateur.');
  assert.deepEqual(failedResources, [], 'Aucune ressource HTTP ne doit être en échec.');
  passed('Aucune exception JavaScript ni ressource HTTP manquante');
  console.log(`${checks} scénarios navigateur vérifiés. Captures : ${screenshotDirectory}/`);
}
process.exitCode = 1;
const watchdog = setTimeout(() => {
  console.error(`Délai maximal dépassé : ${checks}/10 scénarios terminés.`);
  process.exit(1);
}, 150_000);
watchdog.unref();
try {
  await mkdir('.frst', { recursive: true });
  await writeFile('.frst/browser-test-result.json', JSON.stringify({ status: 'running', startedAt: new Date().toISOString(), checks: 0 }));
  await main();
  assert.equal(checks, 10, 'Tous les scénarios navigateur doivent avoir été terminés.');
  await writeFile('.frst/browser-test-result.json', JSON.stringify({ status: 'passed', completedAt: new Date().toISOString(), checks, errors, failedResources }, null, 2));
  process.exitCode = 0;
}
catch (error) {
  await writeFile('.frst/browser-test-result.json', JSON.stringify({ status: 'failed', completedAt: new Date().toISOString(), checks, error: error.stack || String(error), errors, failedResources }, null, 2));
  console.error(error.stack || error);
  console.error(JSON.stringify({ errors, failedResources }, null, 2));
  if (browser) {
    let index = 0;
    for (const context of browser.contexts()) for (const page of context.pages()) {
      try { await screenshot(page, `browser-failure-${++index}`); } catch {}
    }
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server.listening) {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  store.close();
}
