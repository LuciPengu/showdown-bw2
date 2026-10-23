// The extension's BW2 screen: the app without the preview, fed by the
// Showdown page it's framed in (embed.js) instead of the dev server's relay.
// The ROM is the player's own, kept in this browser; the savestates ship
// with the extension.

import { Director } from '../director';
import { gameCode } from '../emu/emulator';
import { Bw2Game } from '../game';
import { ChoiceBridge } from '../play';
import { Session } from '../session';
import { forgetRom, loadRom, saveRom } from './rom-store';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Showdown's client and side servers: the pages this may be framed in. */
const SHOWDOWN = /^https:\/\/(play\.pokemonshowdown\.com|[a-z0-9-]+\.psim\.us)$/;
const page = location.ancestorOrigins?.[0] ?? '';
const toPage = (m: object) => {
  if (SHOWDOWN.test(page)) parent.postMessage(m, page);
};

let fade = 0;
function status(text: string, ok: boolean): void {
  const el = $('status');
  el.hidden = false;
  el.textContent = text;
  el.dataset.ok = String(ok);
  el.classList.remove('faded');
  clearTimeout(fade);
  // Good news fades; problems stay until the next status.
  if (ok) fade = window.setTimeout(() => el.classList.add('faded'), 4000);
}

const game = new Bw2Game({
  status,
  clearScreen: () => {
    director.reset();
    startFeeding();
  },
  stateUrls: { singles: 'savestates/battle-move-select.state', doubles: 'savestates/battle-doubles.state' },
  emuPage: 'emu.html',
});
const director = new Director(game.renderer);

const session = new Session({
  follow(room) {
    director.reset();
    choices.stop();
    toPage({ t: 'room', room });
  },
  commands(cmds, instant) {
    choices.heard();
    if (cmds.some((c) => c.kind === 'end')) choices.stop();
    director.enqueue(cmds, instant);
  },
  request: (room, req, live) => choices.onRequest(room, req, live),
  choiceError: (room, message) => choices.onChoiceError(room, message),
});

const choices = new ChoiceBridge({
  battle: () => game.live(),
  renderer: game.renderer,
  caughtUp: () => director.idle,
  writeActiveMoves: (position, moves) => game.parties?.writeMoves(0, position, moves),
  send: (room, text) => {
    toPage({ t: 'send', room, text });
    return true;
  },
  status,
});

// Showdown's messages wait until BW2 has a battle to draw them in; a battle
// already going when the page loaded then catches up from its start.
let waiting: string[] | null = [];
function receive(message: string): void {
  if (waiting) waiting.push(message);
  else session.receive(message);
}
function startFeeding(): void {
  const messages = waiting;
  waiting = null;
  messages?.forEach((m) => session.receive(m));
}

window.addEventListener('message', (e) => {
  if (e.source !== parent || e.origin !== page || !SHOWDOWN.test(e.origin)) return;
  const m = e.data as { t?: string; data?: unknown; battleHeight?: number };
  if (m.t === 'msg' && typeof m.data === 'string') receive(m.data);
  else if (m.t === 'msgs' && Array.isArray(m.data)) m.data.forEach((d) => typeof d === 'string' && receive(d));
  else if (m.t === 'size' && m.battleHeight) document.documentElement.style.setProperty('--bh', `${m.battleHeight}px`);
  else if (m.t === 'parked') document.documentElement.classList.toggle('parked', !!(m as { on?: boolean }).on);
});

// The touch screen shows (embed.js makes room for it) while BW2's menu is open.
let choosing = false;
setInterval(() => {
  const now = !!game.live()?.choosing;
  if (now !== choosing) toPage({ t: 'choosing', on: (choosing = now) });
}, 250);

async function start(rom: ArrayBuffer): Promise<void> {
  if (gameCode(rom) !== 'IREO') status(`This ROM's game code is ${gameCode(rom)}; the battle addresses are for US Black 2 (IREO).`, false);
  const emu = game.boot($('emu'), rom, async () => {
    const res = await fetch('savestates/battle-move-select.state');
    return { save: null, state: res.ok ? await res.arrayBuffer() : null };
  });
  if (!emu) {
    await forgetRom();
    askForRom();
  }
}

function askForRom(): void {
  $('rom').hidden = false;
  toPage({ t: 'needRom', on: true });
}

$<HTMLInputElement>('rom-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const rom = await file.arrayBuffer();
  await saveRom(rom);
  $('rom').hidden = true;
  toPage({ t: 'needRom', on: false });
  void start(rom);
});

toPage({ t: 'ready' });
loadRom().then(
  (rom) => (rom ? start(rom) : askForRom()),
  () => askForRom(),
);
