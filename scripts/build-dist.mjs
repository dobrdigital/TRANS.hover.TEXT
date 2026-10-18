// Собирает папку с расширением для загрузки в любой Chromium-браузер:
//   node scripts/build-dist.mjs  →  dist/TRANS.hover.TEXT/
// В папку попадают только файлы, нужные браузеру: без тестов, скриптов и документации.
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'TRANS.hover.TEXT');

const FILES = [
  'manifest.json',
  'background.js',
  'experts.js',
  'cache.js',
  'content.js',
  'content.css',
  'popup.html',
  'popup.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

await rm(outDir, { recursive: true, force: true });

for (const file of FILES) {
  const target = path.join(outDir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, file), target);
}

const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
console.log(`Собрано ${FILES.length} файлов, версия ${manifest.version}: ${outDir}`);
