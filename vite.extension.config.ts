// Builds the extension's app page (extension/app.html). scripts/build-extension.mjs
// runs this, then adds everything else the extension needs.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./extension', import.meta.url)),
  base: './',
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist-extension', import.meta.url)),
    emptyOutDir: true,
    // Extension pages allow only their own script files: no inline preload helper.
    modulePreload: { polyfill: false },
    rollupOptions: { input: fileURLToPath(new URL('./extension/app.html', import.meta.url)) },
  },
});
