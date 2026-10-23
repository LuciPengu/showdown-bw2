// Builds the browser extension into dist-extension/, ready for Chrome's
// "Load unpacked": the app page (Vite), the content scripts, EmulatorJS with
// its melonDS core unpacked ahead of time, and the battle savestates.
//
//   npm run build:extension

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'vite';

const root = new URL('../', import.meta.url);
const path = (p) => new URL(p, root).pathname;
const out = (p) => path(`dist-extension/${p}`);
const SAVESTATES = ['battle-move-select.state', 'battle-doubles.state', 'intro-singles.state', 'intro-doubles.state'];

const missing = SAVESTATES.filter((s) => !existsSync(path(`savestates/${s}`)));
if (missing.length) {
  console.error(`Missing savestates/${missing.join(', savestates/')}. See the README for making them.`);
  process.exit(1);
}

await build({ configFile: path('vite.extension.config.ts'), logLevel: 'warn' });

for (const file of ['manifest.json', 'tap.js', 'embed.js', 'emu.html', 'core-files.js']) cpSync(path(`extension/${file}`), out(file));
// BW2_DEBUG=1: embed.js sends log lines (its own and the app's) to the dev server's ext.log.
if (process.env.BW2_DEBUG) {
  writeFileSync(out('embed.js'), `globalThis.BW2_DEBUG_LOG = 'http://localhost:5173/ext-log';\n${readFileSync(out('embed.js'), 'utf8')}`);
  console.log('Debug build: logging to the dev server (ext.log).');
}
for (const file of ['emu-boot.js', 'emu-ticker.js']) cpSync(path(`public/${file}`), out(file));
for (const s of SAVESTATES) cpSync(path(`savestates/${s}`), out(`savestates/${s}`));

// EmulatorJS, with only the melonDS cores.
const ejs = 'public/emulatorjs/data';
cpSync(path(ejs), out('emulatorjs/data'), {
  recursive: true,
  filter: (src) => !/\/cores\/(?!melonds|reports)[^/]+$/.test(src) && !/\/reports\/(?!melonds)[^/]+$/.test(src),
});

// Unpack the core with EmulatorJS's own 7z extractor, run as the worker it expects.
const files = await unpack(readFileSync(path(`${ejs}/compression/extract7z.js`), 'utf8'), readFileSync(path(`${ejs}/cores/melonds-wasm.data`)));
mkdirSync(out('emulatorjs/cores/melonds'), { recursive: true });
for (const [name, data] of Object.entries(files)) writeFileSync(out(`emulatorjs/cores/melonds/${name}`), data);
if (!files['melonds_libretro.js'] || !files['melonds_libretro.wasm']) throw new Error('the melonDS core archive had no core in it');

console.log(`Built dist-extension/ (core: ${Object.keys(files).join(', ')}).`);
console.log('Load it in chrome://extensions with Developer mode on: Load unpacked, then pick the dist-extension folder.');

function unpack(extractor, archive) {
  return new Promise((resolve, reject) => {
    const files = {};
    const worker = {
      Module: { ENVIRONMENT: 'WORKER' },
      console,
      importScripts() {},
      location: { href: '' },
      close: () => resolve(files),
      postMessage(m) {
        if (m.t === 2) files[m.file] = m.data;
        if (m.t === 1) resolve(files);
      },
    };
    worker.self = worker;
    try {
      vm.createContext(worker);
      vm.runInContext(extractor, worker);
      worker.onmessage({ data: new Uint8Array(archive) });
    } catch (err) {
      reject(err);
    }
  });
}
