import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const output = new URL('./functions/generated/', root);
const [catalogue, source] = await Promise.all([
  readFile(new URL('./catalog.js', root), 'utf8'),
  readFile(new URL('./pages/game-model.js', root), 'utf8')
]);
const original = "from 'animal-catalog'";
if (source.split(original).length !== 2) throw new Error('Import du catalogue absent ou ambigu.');
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(new URL('./catalog.js', output), catalogue),
  writeFile(new URL('./game-model.js', output), source.replace(original, "from './catalog.js'"))
]);
console.log('FUNCTIONS_MODEL_READY functions/generated : catalogue et modèle synchronisés.');
