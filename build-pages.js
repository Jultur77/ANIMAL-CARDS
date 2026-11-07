import { mkdir, readFile, writeFile, readdir, copyFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARDS, RARITIES, SHOP_MS, MONEY_SCALE, STARTING_BALANCE, PACK_WEIGHTS, BASE_SHOP_WEIGHTS } from './catalog.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const source = join(root, 'pages');
const cdnBuild = process.argv.includes('--cdn');
const emulatorBuild = process.argv.includes('--emulators');
const output = join(root, `dist${cdnBuild ? '-cdn' : ''}${emulatorBuild ? '-emulators' : ''}`);
const catalogue = { CARDS, RARITIES, SHOP_MS, MONEY_SCALE, STARTING_BALANCE, PACK_WEIGHTS, BASE_SHOP_WEIGHTS };
const catalogueSource = Object.entries(catalogue).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join('\n');

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function copyMedia(directory, destination) {
  if (!await exists(directory)) return;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:svg|webp|png|jpe?g|avif|woff2?|json)$/i.test(entry.name)) {
      await copyFile(join(directory, entry.name), join(destination, entry.name));
    }
  }
}

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`Transformation de source ambiguë : ${before}`);
  return text.replace(before, after);
}

async function buildCdn() {
  const [app, model, originalClient, config, manifest] = await Promise.all([
    readFile(join(source, 'app.js'), 'utf8'),
    readFile(join(source, 'game-model.js'), 'utf8'),
    readFile(join(source, 'firebase-client.js'), 'utf8'),
    readFile(join(root, 'public', 'firebase-config.js'), 'utf8'),
    readFile(join(root, 'package.json'), 'utf8')
  ]);
  const version = JSON.parse(manifest).dependencies?.firebase;
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('La version Firebase doit être explicitement figée pour la construction CDN.');
  let client = originalClient;
  for (const product of ['app', 'auth', 'firestore', 'functions']) {
    client = replaceOnce(client, `from 'firebase/${product}'`, `from 'https://www.gstatic.com/firebasejs/${version}/firebase-${product}.js'`);
  }
  client = replaceOnce(client, "from '../public/firebase-config.js'", "from './firebase-config.js'");
  client = replaceOnce(client, '__FIREBASE_EMULATORS__', String(emulatorBuild));
  if (/firebase\/analytics|firebase-analytics/.test(client)) throw new Error('Analytics ne doit pas être chargé.');
  await Promise.all([
    writeFile(join(output, 'app.js'), app),
    writeFile(join(output, 'game-model.js'), replaceOnce(model, "from 'animal-catalog'", "from './catalog.js'")),
    writeFile(join(output, 'firebase-client.js'), client),
    writeFile(join(output, 'firebase-config.js'), config),
    writeFile(join(output, 'catalog.js'), catalogueSource)
  ]);
}

async function buildBundle() {
  const { build } = await import('esbuild-wasm');
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(source, 'app.js')],
    outfile: join(output, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: false,
    legalComments: 'external',
    metafile: true,
    define: { __FIREBASE_EMULATORS__: String(emulatorBuild) },
    plugins: [{
      name: 'animal-catalogue-statique',
      setup(builder) {
        builder.onResolve({ filter: /^animal-catalog$/ }, () => ({ path: 'catalogue', namespace: 'animal-catalogue' }));
        builder.onLoad({ filter: /.*/, namespace: 'animal-catalogue' }, () => ({ loader: 'js', contents: catalogueSource }));
      }
    }]
  });
  if (Object.keys(result.metafile.inputs).some(path => /(?:firebase[\\/]analytics|@firebase[\\/]analytics)/.test(path))) {
    throw new Error('Le module Analytics ne doit pas être inclus dans cette version.');
  }
}

async function main() {
  const [html, css] = await Promise.all([
    readFile(join(source, 'index.html'), 'utf8'),
    readFile(join(source, 'styles.css'), 'utf8')
  ]);
  if (!html.includes('./app.js') || !html.includes('./styles.css')) {
    throw new Error('Les ressources de la page doivent utiliser des chemins relatifs.');
  }
  await mkdir(output, { recursive: true });
  if (cdnBuild) await buildCdn();
  else await buildBundle();
  await Promise.all([
    writeFile(join(output, 'index.html'), html),
    writeFile(join(output, 'styles.css'), css),
    writeFile(join(output, '.nojekyll'), ''),
    copyFile(join(root, 'public', 'icon.svg'), join(output, 'icon.svg')),
    copyMedia(join(root, 'public', 'animals'), join(output, 'animals')),
    copyMedia(join(source, 'assets'), join(output, 'assets'))
  ]);
  await writeFile(join(output, 'build-info.json'), JSON.stringify({
    target: 'github-pages', mode: cdnBuild ? 'cdn' : 'bundle', emulatorBuild,
    species: CARDS.length, generatedAt: new Date().toISOString()
  }, null, 2));
  console.log(`BUILD_PAGES_TERMINE : ${CARDS.length} espèces ; mode ${cdnBuild ? 'CDN officiel Firebase, connexion requise' : 'groupé'} ; sortie ${resolve(output)} ; émulateurs ${emulatorBuild ? 'oui, tests locaux uniquement' : 'non'}.`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
