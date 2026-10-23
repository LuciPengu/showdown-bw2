// Runs on Showdown in the extension's isolated world: puts the BW2 app (an
// extension page) in a frame over the battle scene of the battle it's showing,
// and passes messages between it and tap.js.

(() => {
  'use strict';
  const APP = chrome.runtime.getURL('app.html');
  const APP_ORIGIN = new URL(APP).origin;
  /** A debug build sends log lines to the dev server (see build-extension.mjs). */
  const log = (...parts) => {
    if (!globalThis.BW2_DEBUG_LOG) return;
    fetch(globalThis.BW2_DEBUG_LOG, { method: 'POST', mode: 'no-cors', body: parts.join(' ') }).catch(() => {});
  };
  log('embed: started on', location.pathname);

  const frame = document.createElement('iframe');
  frame.src = APP;
  frame.title = 'Pokémon Black 2';
  frame.allow = 'autoplay; gamepad';
  // Above the battle room, under Showdown's popups (forfeit, team, options: z-index 20) and tooltips.
  Object.assign(frame.style, { position: 'fixed', border: '0', background: '#000', zIndex: '15' });
  document.body.append(frame);
  frame.addEventListener('load', () => log('embed: frame loaded'));

  /**
   * Showdown's messages so far, for the app each time it starts: the page can
   * throw the frame away while it loads (it's put back), which starts it over.
   */
  const history = [];
  /** Whether the app in the frame is listening. */
  let listening = false;
  /** The battle room the app is showing, whether Showdown's own controls should show, and whether it needs a ROM. */
  let room = null;
  let showdownControls = false;
  let needRom = false;
  let lastHeight = 0;
  /** Whether the app was last told it's parked in the corner (only its status shows). */
  let parked = null;

  /** Only once the app is listening: before it loads, the frame is a blank page of Showdown's own. */
  const post = (m) => {
    if (listening) frame.contentWindow?.postMessage(m, APP_ORIGIN);
  };

  document.addEventListener('bw2:from-showdown', (e) => {
    if (history.push(e.detail) > 5000) history.shift();
    if (listening) post({ t: 'msg', data: e.detail });
  });

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== APP_ORIGIN) return;
    const m = e.data;
    if (m?.t === 'log') return log('app:', m.text);
    log('embed: from app', JSON.stringify(m).slice(0, 200));
    if (m?.t === 'ready') {
      listening = true;
      post({ t: 'msgs', data: history });
      lastHeight = 0; // tell it the battle scene's size again, and whether it's parked
      parked = null;
    } else if (m?.t === 'send') {
      document.dispatchEvent(new CustomEvent('bw2:to-showdown', { detail: JSON.stringify({ room: m.room, text: m.text }) }));
    } else if (m?.t === 'room') {
      room = m.room;
    } else if (m?.t === 'controls') {
      showdownControls = !!m.showdown;
    } else if (m?.t === 'needRom') {
      needRom = !!m.on;
    }
    place();
  });

  // tap.js has been keeping Showdown's messages since the page started; now they can come.
  document.dispatchEvent(new CustomEvent('bw2:embed-ready'));

  /**
   * Over the battle scene of the room the app shows, and twice as tall, so
   * BW2's touch screen covers Showdown's move and switch buttons; just the
   * top screen when Showdown's own controls are needed. With nothing to
   * show, the frame is parked in the corner as a see-through strip that shows
   * only BW2's status.
   */
  function place() {
    if (!frame.isConnected) {
      log('embed: the frame was removed; putting it back');
      // A fresh app: it says again what it shows once it's caught up.
      listening = false;
      room = null;
      showdownControls = false;
      needRom = false;
      document.body.append(frame);
    }
    const scene = room && document.querySelector(`#room-${CSS.escape(room)} .battle`);
    const r = scene?.getBoundingClientRect();
    const s = frame.style;
    if (needRom) {
      park(false);
      Object.assign(s, { left: 'auto', top: 'auto', right: '16px', bottom: '16px', width: '340px', height: '150px', pointerEvents: 'auto' });
      Object.assign(s, { background: '#1d2228', boxShadow: '0 4px 24px rgba(0, 0, 0, 0.5)', borderRadius: '8px' });
      return;
    }
    s.boxShadow = 'none';
    s.borderRadius = '0';
    if (!r || r.width < 50 || r.height < 50) {
      park(true);
      Object.assign(s, { left: 'auto', top: 'auto', right: '8px', bottom: '8px', width: '420px', height: '32px', background: 'transparent', pointerEvents: 'none' });
      return;
    }
    park(false);
    s.background = '#000';
    // Both screens, or just the top one; smaller if the window is too short.
    const space = window.innerHeight - Math.max(0, r.top) - 4;
    const height = Math.max(120, Math.min(showdownControls ? r.height : r.height * 2, space));
    const screenHeight = showdownControls ? height : height / 2;
    Object.assign(s, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      right: 'auto',
      bottom: 'auto',
      width: `${r.width}px`,
      height: `${height}px`,
      pointerEvents: 'auto',
    });
    if (screenHeight !== lastHeight) {
      lastHeight = screenHeight;
      post({ t: 'size', battleHeight: screenHeight });
    }
  }

  function park(on) {
    if (parked === on) return;
    log('embed: parked', on, 'room', room);
    parked = on;
    post({ t: 'parked', on });
  }

  place();
  setInterval(place, 200);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
})();
