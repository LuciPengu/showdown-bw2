// Boots EmulatorJS in the emulator frame (emu.html). EmulatorJS is configured
// through window globals and runs one instance per page, so it lives in a
// same-origin iframe. The app puts { rom: ArrayBuffer, onStatus(text) } on its
// own window as __emuBoot first. Files are found next to this script.

(() => {
  const base = new URL('.', document.currentScript.src).href;
  const boot = window.parent.__emuBoot;
  const status = (text) => boot?.onStatus?.(text);
  // Problems in this frame go to the app's status line, where they can be seen.
  window.addEventListener('error', (e) => status(`error: ${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => status(`error: ${e.reason?.message ?? e.reason}`));
  status('booting');
  if (!boot?.rom) {
    document.body.style.color = '#fff';
    document.body.textContent = 'Open this from the app.';
    return;
  }
  // The game has to keep running while you watch your Showdown tab, or while the extension's frame
  // is parked out of sight. RetroArch pauses a page it sees as hidden, so it's told the page is
  // always visible. Browsers also stop animation frames in a hidden page or a frame they consider
  // out of sight, and throttle their timers to a tick a second or less. The core asks for each frame
  // through this global, so a frame the browser hasn't delivered in time comes from a worker's
  // timer, which isn't throttled.
  Object.defineProperty(document, 'hidden', { get: () => false });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
  document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  window.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);
  let ticker;
  try {
    ticker = new Worker(`${base}emu-ticker.js`);
  } catch (err) {
    status(`error: no frame timer (${err.message}); the game will pause while hidden`);
    ticker = { set onmessage(_) {} };
  }
  // Every frame asked for waits here until the browser or the worker delivers it, whichever is
  // first: the worker takes over from a browser that's two frames late.
  const LATE_MS = 2000 / 60;
  let waiting = [];
  const deliver = (entry, time) => {
    if (entry.done) return;
    entry.done = true;
    entry.callback(time);
  };
  ticker.onmessage = () => {
    const now = performance.now();
    const due = waiting.filter((entry) => !entry.done && now - entry.asked >= LATE_MS);
    waiting = waiting.filter((entry) => !entry.done && now - entry.asked < LATE_MS);
    for (const entry of due) deliver(entry, now);
  };
  const nativeFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    const entry = { callback, done: false, asked: performance.now() };
    waiting.push(entry);
    nativeFrame((time) => deliver(entry, time));
    return 0;
  };
  // EmulatorJS locks the mouse to the game on a click (melonDS takes mouse input), which hides the
  // pointer from the rest of the page until Escape. The touch screen takes clicks where they land,
  // so it isn't needed.
  Element.prototype.requestPointerLock = function () {
    return Promise.resolve();
  };
  // RetroArch keeps the screen awake with a wake lock, which a page framed in another site (the
  // extension, in Showdown) isn't allowed; there it just does without.
  if (navigator.wakeLock) {
    const request = navigator.wakeLock.request.bind(navigator.wakeLock);
    const standIn = (type) => ({ type, released: false, onrelease: null, release: async () => {}, addEventListener() {}, removeEventListener() {} });
    navigator.wakeLock.request = (type) => request(type).catch(() => standIn(type));
  }
  window.EJS_player = '#game';
  window.EJS_core = 'melonds';
  window.EJS_gameName = 'showdown-bw2.nds';
  // A view made in this frame's realm: EmulatorJS checks instanceof, which fails across frames.
  window.EJS_gameUrl = new Uint8Array(boot.rom);
  window.EJS_pathtodata = `${base}emulatorjs/data/`;
  window.EJS_startOnLoaded = true;
  window.EJS_disableDatabases = true;
  window.EJS_backgroundColor = '#000';
  window.EJS_language = 'en-US';
  // Clicks land on the touch screen where they're made (the core's default is a relative mouse cursor).
  window.EJS_defaultOptions = { melonds_touch_mode: 'Touch' };
  window.EJS_onGameStart = () => {
    window.EJS_gameUrl = null; // the core has its own copy
    status('started');
  };
  const script = document.createElement('script');
  script.src = `${base}emulatorjs/data/loader.js`;
  document.body.append(script);
  status('loading');
})();
