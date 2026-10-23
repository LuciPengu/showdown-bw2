// EmulatorJS unpacks its emulator core from a 7z archive in a blob: worker and
// runs it as a blob: script, which extension pages don't allow. The build
// unpacks the core ahead of time (emulatorjs/cores/melonds/), and this swaps
// in two methods as EmulatorJS loads: "unpacking" the core reads those files,
// and the core's script loads from its file.

(() => {
  'use strict';
  const CORE = new URL('emulatorjs/cores/melonds/', document.currentScript.src).href;
  const FILES = ['melonds_libretro.wasm', 'build.json', 'core.json', 'license.txt'];

  async function unpackedCore() {
    const files = { 'melonds_libretro.js': new Uint8Array(0) }; // loaded from its file instead
    for (const name of FILES) {
      const res = await fetch(CORE + name);
      if (!res.ok) throw new Error(`the extension is missing ${name}; rebuild it`);
      files[name] = new Uint8Array(await res.arrayBuffer());
    }
    return files;
  }

  function patch(proto) {
    const checkCompression = proto.checkCompression;
    proto.checkCompression = function (data, message, ...rest) {
      if (message === this.localization('Decompress Game Core')) return unpackedCore();
      return checkCompression.call(this, data, message, ...rest);
    };
    proto.initGameCore = function (_js, wasm, worker) {
      const script = this.createElement('script');
      script.src = CORE + 'melonds_libretro.js';
      script.addEventListener('load', () => this.initModule(wasm, worker));
      document.body.appendChild(script);
    };
  }

  // emulator.min.js ends with `window.EmulatorJS = EmulatorJS`; loader.js constructs it right after.
  let EmulatorJS;
  Object.defineProperty(window, 'EmulatorJS', {
    configurable: true,
    get: () => EmulatorJS,
    set(value) {
      EmulatorJS = value;
      patch(value.prototype);
    },
  });
})();
