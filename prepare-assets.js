import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CARDS } from './catalog.js';

const directory = new URL('./public/animals/', import.meta.url);
const manifestPath = new URL('manifest.json', directory);
const offline = process.argv.includes('--offline');
const strict = process.argv.includes('--strict');
const headers = { 'User-Agent': 'AnimalCardsLocalAssets/1.0 (educational game; Wikimedia attribution stored with each image)' };
const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#7ef0c0"/><stop offset="1" stop-color="#69b9ff"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="#091410"/><path d="m32 8 7 17 17 7-17 7-7 17-7-17-17-7 17-7Z" fill="url(#a)"/></svg>\n';
const plain = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const exists = async path => { try { await access(path); return true; } catch { return false; } };
let stopDownloads = false;
let consecutiveFailures = 0;

async function fetchChecked(url, maximum = 5_000_000) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['en.wikipedia.org', 'commons.wikimedia.org', 'upload.wikimedia.org'].includes(parsed.hostname)) throw new Error('Hôte de téléchargement non autorisé.');
  await new Promise(resolve => setTimeout(resolve, 350));
  const response = await fetch(parsed, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) {
    if ([403, 429].includes(response.status)) stopDownloads = true;
    throw new Error(`HTTP ${response.status} sur ${parsed.hostname}`);
  }
  if (Number(response.headers.get('content-length')) > maximum) { await response.body.cancel(); throw new Error('Ressource trop volumineuse.'); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('Ressource trop volumineuse.');
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), type: (response.headers.get('content-type') || '').split(';')[0] };
}
async function api(host, params) {
  const url = new URL(`https://${host}/w/api.php`);
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params }).toString();
  const { buffer } = await fetchChecked(url, 1_000_000);
  const result = JSON.parse(buffer.toString('utf8'));
  if (result.error) throw new Error(plain(result.error.info || result.error.code));
  return result.query?.pages || [];
}
async function downloadCard(card) {
  const pages = await api('en.wikipedia.org', { titles: card.wiki, redirects: '1', prop: 'pageimages', piprop: 'name', pilicense: 'free' });
  const filename = pages[0]?.pageimage;
  if (!filename) throw new Error('Aucune photographie libre associée à cette espèce.');
  const files = await api('commons.wikimedia.org', { titles: `File:${filename}`, prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '640', iiextmetadatalanguage: 'fr' });
  const info = files[0]?.imageinfo?.[0];
  const metadata = info?.extmetadata;
  const license = plain(metadata?.LicenseShortName?.value);
  const licenseURL = metadata?.LicenseUrl?.value || '';
  const author = plain(metadata?.Artist?.value);
  if (!info || !author || !/^(CC BY(?:-SA)? [\d.]+|CC0(?: [\d.]+)?|Public domain)$/i.test(license)) throw new Error(`Licence ou auteur insuffisamment documenté : ${license || 'inconnu'}.`);
  const { buffer, type } = await fetchChecked(info.thumburl || info.url);
  const formats = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const extension = formats[type];
  if (!extension || buffer.length < 100) throw new Error('Format de photographie non pris en charge.');
  const valid = extension === 'jpg' ? buffer[0] === 255 && buffer[1] === 216 : extension === 'png' ? buffer.subarray(1, 4).toString() === 'PNG' : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw new Error('Le contenu reçu n’est pas une image valide.');
  const src = `/animals/${card.id}.${extension}`;
  await writeFile(new URL(`${card.id}.${extension}`, directory), buffer);
  return { src, author, license, licenseURL, source: info.descriptionurl, original: info.url, downloadedAt: new Date().toISOString(), modifications: 'Miniature redimensionnée par Wikimedia ; recadrage de présentation par CSS.' };
}

await mkdir(directory, { recursive: true });
const iconPath = new URL('./public/icon.svg', import.meta.url);
if (!await exists(iconPath)) await writeFile(iconPath, icon);
let manifest = { version: 1, images: {} };
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.images || typeof manifest.images !== 'object' || Array.isArray(manifest.images)) throw new Error('Format du manifeste invalide.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
let downloaded = 0;
let missing = 0;
for (const card of CARDS) {
  const existing = manifest.images[card.id];
  if (existing?.src && /^\/animals\/[a-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(existing.src) && await exists(new URL(`./public${existing.src}`, import.meta.url))) continue;
  missing++;
  if (offline || stopDownloads) continue;
  try {
    manifest.images[card.id] = await downloadCard(card);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    downloaded++;
    missing--;
    consecutiveFailures = 0;
    console.log(`Photo enregistrée : ${card.name}`);
  } catch (error) {
    console.warn(`${card.name} : ${error.message} Illustration emoji conservée.`);
    if (/fetch failed|timeout|aborted|HTTP 5\d\d/i.test(error.message)) consecutiveFailures++;
    else consecutiveFailures = 0;
    if (consecutiveFailures >= 3) stopDownloads = true;
  }
}
console.log(`Ressources prêtes dans ${fileURLToPath(directory)}. ${downloaded} photo(s) téléchargée(s), ${missing} espèce(s) en illustration emoji.`);
if (stopDownloads) console.warn('Téléchargements arrêtés après un refus, une limitation ou plusieurs pannes réseau. Aucun contournement effectué.');
if (strict && missing) process.exitCode = 1;
