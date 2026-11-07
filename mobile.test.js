import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createGameServer } from './server.js';
import { GameStore } from './store.js';

test('Inventaire, dimensions et reconnexion sur mobile', { timeout: 60000 }, async t => {
  const directory = '.frst/screenshots';
  await mkdir(directory, { recursive: true });
  const store = new GameStore(':memory:');
  const { server } = createGameServer({ store, secure: false, origin: '' });
  let browser;
  const measurements = [];
  const errors = [];
  t.after(async () => {
    await writeFile('.frst/mobile-test-result.json', JSON.stringify({ measurements, errors }, null, 2));
    if (browser) await browser.close();
    if (server.listening) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    store.close();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  async function measure(label) {
    const measurement = await page.evaluate(label => ({
      label,
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      header: [...document.querySelectorAll('.topbar, .wallets, .wallet, .wallet > *, #logout-mobile')].map(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { className: element.className, left: rect.left, right: rect.right, width: rect.width, display: style.display, flex: style.flex, minWidth: style.minWidth, padding: style.padding, gap: style.gap, transform: style.transform };
      }),
      overflowing: [...document.querySelectorAll('body *')].map(element => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, id: element.id, className: String(element.className), left: rect.left, right: rect.right, width: rect.width };
      }).filter(rect => rect.width > 0 && rect.right > innerWidth + 0.5).slice(0, 25)
    }), label);
    measurements.push(measurement);
    console.log(JSON.stringify({ label, viewport: measurement.viewport, documentWidth: measurement.documentWidth }));
    return measurement;
  }
  await page.goto(origin);
  await expect(page.locator('#guest')).toBeVisible();
  await page.locator('#username').fill('MobileRegression');
  await page.locator('#password').fill('MobileRegression_2026!');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#game')).toBeVisible();
  await page.locator('.pack.r0 [data-command="buy-pack"]').first().click();
  await expect(page.locator('[data-command="open-sealed"]')).toBeVisible();
  await page.locator('#close-modal').click();
  await page.locator('.main-nav [data-tab="inventaire"]').click();
  await expect(page.locator('#inventory-results .card').first()).toBeVisible();
  for (const width of [390, 320, 360, 414, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await measure(`redimensionnement-immediat-${width}`);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await measure(`inventaire-${width}`);
    assert.ok(layout.documentWidth <= width, `Débordement : ${JSON.stringify(layout)}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/mobile-layout.png`, animations: 'disabled' });
  await expect(page.locator('#logout-mobile')).toBeVisible();
  await expect(page.locator('#logout')).toBeHidden();
  await page.locator('#logout-mobile').click();
  await expect(page.locator('#guest')).toBeVisible();
  await page.locator('[data-auth="login"]').click();
  await page.locator('#username').fill('MobileRegression');
  await page.locator('#password').fill('MobileRegression_2026!');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#game')).toBeVisible();
  const response = await page.request.get(`${origin}/api/state`);
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).inventory.length, 8);
  assert.deepEqual(errors, []);
  console.log('RECONNEXION_MOBILE_VERIFIEE');
});
