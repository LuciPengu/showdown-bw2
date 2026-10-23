// ==UserScript==
// @name         Showdown → BW2 tap
// @namespace    showdown-bw2
// @version      0.2.0
// @description  Forwards your Showdown battle messages to the Showdown in BW2 app on localhost, and sends the moves you pick in BW2 back to your battle.
// @match        https://play.pokemonshowdown.com/*
// @match        https://*.psim.us/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==

(() => {
  'use strict';
  const RELAY = 'ws://localhost:5173/relay?role=tap';
  const NativeWebSocket = window.WebSocket;
  const pending = [];
  let relay = null;
  /** The page's connection to Showdown, for sending choices made in BW2. */
  let showdown = null;

  function connect() {
    relay = new NativeWebSocket(RELAY);
    relay.onopen = () => {
      for (const msg of pending.splice(0)) relay.send(msg);
    };
    relay.onclose = () => setTimeout(connect, 3000);
    relay.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m && m.t === 'send' && /^battle-[\w-]+$/.test(m.room) && typeof m.text === 'string') sendToShowdown(m.room, m.text);
    };
  }

  function forward(msg) {
    if (relay && relay.readyState === NativeWebSocket.OPEN) relay.send(msg);
    else if (pending.push(msg) > 2000) pending.shift();
  }

  /** Sends `text` to a battle room, as if typed in it: through the old client's API if it's there, else the socket. */
  function sendToShowdown(room, text) {
    if (window.app && typeof window.app.send === 'function') {
      window.app.send(text, room);
      return;
    }
    if (!showdown || showdown.readyState !== NativeWebSocket.OPEN) return;
    const msg = `${room}|${text}`;
    // SockJS's websocket transport takes JSON arrays of messages; a plain websocket takes the text.
    showdown.send(/\/showdown\/\d+\/[^/]+\/websocket/.test(showdown.url) ? JSON.stringify([msg]) : msg);
  }

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

  // Wrap the page's WebSocket so the Showdown connection's messages are copied.
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (/showdown|psim\.us|sockjs/i.test(String(url))) {
        showdown = this;
        this.addEventListener('message', (e) => unwrap(e.data).forEach(forward));
      }
    }
  };

  connect();
})();
