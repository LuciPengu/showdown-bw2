// Runs on Showdown in the extension's isolated world: puts the BW2 app (an
// extension page) in a frame over the battle scene of the battle it's showing,
// and passes messages between it and tap.js.

(() => {
  'use strict';
  const APP = chrome.runtime.getURL('app.html');
  const APP_ORIGIN = new URL(APP).origin;

  const frame = document.createElement('iframe');
  frame.src = APP;
  frame.title = 'Pokémon Black 2';
  frame.allow = 'autoplay; gamepad';
  Object.assign(frame.style, { position: 'fixed', border: '0', background: '#000', zIndex: '40' });
  document.body.append(frame);

  /** Messages from Showdown before the app said it's listening. */
  let queue = [];
  /** The battle room the app is showing, whether its menu is open, and whether it needs a ROM. */
  let room = null;
  let choosing = false;
  let needRom = false;
  let lastHeight = 0;

  const post = (m) => frame.contentWindow?.postMessage(m, APP_ORIGIN);

  document.addEventListener('bw2:from-showdown', (e) => {
    if (queue) queue.push(e.detail);
    else post({ t: 'msg', data: e.detail });
  });

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== APP_ORIGIN) return;
    const m = e.data;
    if (m?.t === 'ready') {
      post({ t: 'msgs', data: queue ?? [] });
      queue = null;
      lastHeight = 0; // tell it the battle scene's size again
    } else if (m?.t === 'send') {
      document.dispatchEvent(new CustomEvent('bw2:to-showdown', { detail: JSON.stringify({ room: m.room, text: m.text }) }));
    } else if (m?.t === 'room') {
      room = m.room;
    } else if (m?.t === 'choosing') {
      choosing = !!m.on;
    } else if (m?.t === 'needRom') {
      needRom = !!m.on;
    }
    place();
  });

  // tap.js has been keeping Showdown's messages since the page started; now they can come.
  document.dispatchEvent(new CustomEvent('bw2:embed-ready'));

  /**
   * Over the battle scene of the room the app shows, and twice as tall while
   * BW2 asks for a choice, so its touch screen shows below. With nothing to
   * show, the frame stays running in a corner, too small to see: a hidden
   * frame would stop drawing.
   */
  function place() {
    const scene = room && document.querySelector(`#room-${CSS.escape(room)} .battle`);
    const r = scene?.getBoundingClientRect();
    const s = frame.style;
    if (needRom) {
      Object.assign(s, { left: 'auto', top: 'auto', right: '16px', bottom: '16px', width: '340px', height: '150px', opacity: '1', pointerEvents: 'auto' });
      s.boxShadow = '0 4px 24px rgba(0, 0, 0, 0.5)';
      s.borderRadius = '8px';
      return;
    }
    s.boxShadow = 'none';
    s.borderRadius = '0';
    if (!r || r.width < 50 || r.height < 50) {
      Object.assign(s, { left: 'auto', top: 'auto', right: '0', bottom: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
      return;
    }
    const height = choosing ? Math.min(r.height * 2, window.innerHeight - r.top) : r.height;
    Object.assign(s, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      right: 'auto',
      bottom: 'auto',
      width: `${r.width}px`,
      height: `${height}px`,
      opacity: '1',
      pointerEvents: 'auto',
    });
    if (r.height !== lastHeight) {
      lastHeight = r.height;
      post({ t: 'size', battleHeight: r.height });
    }
  }

  place();
  setInterval(place, 200);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
})();
