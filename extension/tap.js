// Runs in the Showdown page itself, before the client connects: copies the
// page's Showdown messages to embed.js, and sends the choices made in BW2 to
// Showdown as the logged-in player. The two talk through DOM events, since
// embed.js runs in the extension's own isolated world.

(() => {
  'use strict';
  const NativeWebSocket = window.WebSocket;
  /** The page's connection to Showdown, for sending when the old client's API isn't there. */
  let showdown = null;
  /** Messages from before embed.js was listening; it asks for them once. */
  let early = [];

  function emit(data) {
    if (early) {
      if (early.push(data) > 5000) early.shift();
      return;
    }
    document.dispatchEvent(new CustomEvent('bw2:from-showdown', { detail: data }));
  }

  document.addEventListener('bw2:embed-ready', () => {
    const messages = early ?? [];
    early = null;
    messages.forEach(emit);
  });

  /** SockJS wraps messages as `a["...","..."]` and sends `o`/`h` frames; a plain websocket sends them as-is. */
  function unwrap(data) {
    if (typeof data !== 'string') return [];
    if (data.startsWith('a[')) {
      try {
        return JSON.parse(data.slice(1));
      } catch {
        return [];
      }
    }
    if (data === 'o' || data === 'h' || data.startsWith('c[')) return [];
    return [data];
  }

  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (/showdown|psim\.us|sockjs/i.test(String(url))) {
        showdown = this;
        this.addEventListener('message', (e) => unwrap(e.data).forEach(emit));
      }
    }
  };

  /** Sends `text` to a battle room, as if typed in it: through the old client's API if it's there, else the socket. */
  document.addEventListener('bw2:to-showdown', (e) => {
    let m;
    try {
      m = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!m || !/^battle-[\w-]+$/.test(m.room) || typeof m.text !== 'string' || !m.text.startsWith('/choose ')) return;
    if (window.app && typeof window.app.send === 'function') {
      window.app.send(m.text, m.room);
      return;
    }
    if (!showdown || showdown.readyState !== NativeWebSocket.OPEN) return;
    const msg = `${m.room}|${m.text}`;
    showdown.send(/\/showdown\/\d+\/[^/]+\/websocket/.test(showdown.url) ? JSON.stringify([msg]) : msg);
  });
})();
