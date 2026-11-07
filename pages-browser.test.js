import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const reportPath = '.frst/pages-browser-test-result.json';
const screenshots = '.frst/screenshots';
const port = 20000 + process.pid % 20000;
const origin = `http://127.0.0.1:${port}`;
const url = `${origin}/ANIMAL-CARDS/`;
const checks = [];
const pageErrors = [];
const failedRequests = [];
const consoleErrors = [];
const layouts = [];
let browser;
let preview;
let previewOutput = '';
let report = {
  status: 'running', startedAt: new Date().toISOString(),
  scope: 'Interface statique et parcours visiteur uniquement ; aucune inscription ni transaction Firebase.',
  firebaseTransactionsVerified: false, firestoreRulesVerified: false,
  checks, pageErrors, failedRequests, consoleErrors, layouts
};
await mkdir(screenshots, { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2));
function passed(label) { checks.push(label); console.log(`OK ${checks.length} - ${label}`); }
async function layout(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth
  }));
  layouts.push(result);
  assert.ok(result.documentWidth <= result.viewport + 1 && result.bodyWidth <= result.viewport + 1,
    `Debordement horizontal a ${width}px : ${JSON.stringify(result)}`);
}
async function closeDialog(page, id) {
  await page.locator(`#${id} [data-close-dialog]`).click();
  await expect(page.locator(`#${id}`)).not.toBeVisible();
}
try {
  const metadata = JSON.parse(await readFile('dist-cdn/build-info.json', 'utf8'));
  assert.equal(metadata.mode, 'cdn');
  assert.equal(metadata.emulatorBuild, false);
  assert.equal(metadata.species, 56);
  const client = await readFile('dist-cdn/firebase-client.js', 'utf8');
  assert.ok(client.includes('https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js'));
  assert.ok(!client.includes('__FIREBASE_EMULATORS__'));
  assert.ok(!/firebase-analytics|from ['"]firebase\//.test(client));
  passed('Construction CDN : 56 especes, imports explicites et aucun module Analytics');

  preview = spawn(process.execPath, ['preview-pages.js', '--cdn', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('La previsualisation ne demarre pas.')), 8000);
    const finish = callback => value => { clearTimeout(timer); callback(value); };
    preview.once('error', finish(reject));
    preview.once('exit', finish(code => reject(new Error(`Previsualisation arretee : ${code}`))));
    preview.stdout.on('data', chunk => {
      previewOutput += chunk;
      if (previewOutput.includes('PREVIEW_READY')) finish(resolve)();
    });
    preview.stderr.on('data', chunk => { previewOutput += chunk; });
  });
  const redirect = await fetch(origin, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/ANIMAL-CARDS/');
  const script = await fetch(`${url}app.js`, { method: 'HEAD' });
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  for (const path of ['.env', 'server.js', '../package.json', 'inexistant.js']) {
    assert.equal((await fetch(url + path)).status, 404, path);
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  passed('Previsualisation sous /ANIMAL-CARDS/ et refus des ressources privees et ecritures HTTP');

  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => {
    if (response.status() >= 400) failedRequests.push({ url: response.url(), status: response.status() });
  });
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  assert.equal(response.status(), 200);
  await expect(page.locator('#catalogue-grid .animal-card')).toHaveCount(56);
  await expect(page.locator('#catalogue-count')).toHaveText('56 espèce(s) sur 56');
  await expect(page.locator('#signed-account')).not.toBeVisible();
  passed('Catalogue visiteur : 56 cartes affichees sans collection attribuee');

  await page.locator('#catalogue-search').fill('RENARD ROUX');
  await expect(page.locator('#catalogue-grid .animal-card')).toHaveCount(1);
  await expect(page.locator('#catalogue-grid h3')).toHaveText('Renard roux');
  await page.locator('#catalogue-search').fill('aucune-espece-987654321');
  await expect(page.locator('#catalogue-grid .animal-card')).toHaveCount(0);
  await expect(page.locator('#catalogue-grid')).toContainText('Aucune espèce');
  await page.locator('#catalogue-search').fill('');
  passed('Recherche insensible a la casse et resultat vide explicite');

  await page.locator('#catalogue-rarity').selectOption('0');
  await expect(page.locator('#catalogue-grid .animal-card')).toHaveCount(8);
  await page.locator('#catalogue-rarity').selectOption('all');
  await expect(page.locator('#catalogue-grid .animal-card')).toHaveCount(56);
  passed('Filtre de rarete et restauration du catalogue complet');

  await page.locator('#open-auth').click();
  await expect(page.locator('#auth-dialog')).toBeVisible();
  await expect(page.locator('#register-name-field')).toBeVisible();
  await page.locator('#choose-login').click();
  await expect(page.locator('#register-name-field')).not.toBeVisible();
  await expect(page.locator('#reset-password')).toBeVisible();
  await page.locator('#choose-register').click();
  await expect(page.locator('#register-name-field')).toBeVisible();
  await closeDialog(page, 'auth-dialog');
  passed('Dialogue de connexion et inscription, sans soumettre de compte');

  await page.locator('#open-help').click();
  await expect(page.locator('#help-dialog')).toBeVisible();
  await closeDialog(page, 'help-dialog');
  await page.locator('#open-credits').click();
  await expect(page.locator('#credits-dialog')).toBeVisible();
  await closeDialog(page, 'credits-dialog');
  passed('Guide et informations de transparence ouvrables et refermables');

  for (const route of ['collection', 'boutique', 'marche']) {
    await page.locator(`.main-nav [data-route="${route}"]`).click();
    await expect(page.locator('#signin-required')).toBeVisible();
    await expect(page.locator('#player-view')).not.toBeVisible();
  }
  await page.locator('.main-nav [data-route="decouvrir"]').click();
  await expect(page.locator('#discovery-view')).toBeVisible();
  passed('Collection, boutique et marche proteges pour les visiteurs');

  for (const width of [1440, 1024, 768]) await layout(page, width, 1000);
  await layout(page, 1440, 1000);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${screenshots}/pages-desktop.png` });
  passed('Largeurs bureau et tablette sans debordement horizontal');

  for (const width of [320, 360, 390, 414]) {
    await layout(page, width, 900);
    await page.locator('#open-auth').click();
    const box = await page.locator('#auth-dialog').boundingBox();
    assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, `Dialogue hors ecran a ${width}px`);
    await closeDialog(page, 'auth-dialog');
  }
  await layout(page, 390, 900);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${screenshots}/pages-mobile.png` });
  passed('Quatre largeurs mobiles et dialogue contenus dans la fenetre');

  report.connectionStatus = await page.locator('#connection-status').innerText();
  report.displayedError = await page.locator('#global-error').innerText();
  assert.deepEqual(pageErrors, [], 'Erreurs JavaScript non interceptees');
  assert.deepEqual(failedRequests.filter(item => item.url.startsWith(origin)), [], 'Ressources locales en echec');
  passed('Aucune erreur JavaScript non interceptee ni ressource locale en echec');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  catch (error) { report.cleanupError = String(error); report.status = 'failed'; process.exitCode = 1; }
  if (preview && preview.exitCode === null && preview.signalCode === null) {
    const closed = once(preview, 'close');
    preview.kill();
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
    if (preview.exitCode === null && preview.signalCode === null) {
      report.previewCleanupError = 'Le processus de previsualisation ne confirme pas son arret.';
      report.status = 'failed'; process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  report.checkCount = checks.length;
  report.previewOutput = previewOutput;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`PAGES_BROWSER_RESULT ${report.status} ${checks.length}/11 ${reportPath}`);
}
