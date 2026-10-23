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

/** Goes to the dev server's ext.log in a debug build of the extension, through embed.js. */
function log(text: string): void {
  toPage({ t: 'log', text });
}
window.addEventListener('error', (e) => log(`error: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log(`unhandled: ${String((e.reason as Error)?.stack ?? e.reason)}`));

let fade = 0;
function status(text: string, ok: boolean): void {
  log(`status (${ok ? 'ok' : 'problem'}): ${text}`);
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
    applySpeed();
  },
  stateUrls: { singles: 'savestates/battle-move-select.state', doubles: 'savestates/battle-doubles.state' },
  introUrls: { singles: 'savestates/intro-singles.state', doubles: 'savestates/intro-doubles.state' },
  emuPage: 'emu.html',
  note: (text) => log(text),
});
const director = new Director(game.renderer);

const session = new Session({
  follow(room) {
    log(`following ${room}`);
    director.reset();
    choices.stop();
    toPage({ t: 'room', room });
    teamPreview = ended = false;
    showControls();
  },
  commands(cmds, instant) {
    choices.heard();
    if (cmds.some((c) => c.kind === 'end')) {
      choices.stop();
      ended = true;
      showControls();
    }
    director.enqueue(cmds, instant);
  },
  request: (room, req, live) => {
    teamPreview = !!req.teamPreview;
    showControls();
    choices.onRequest(room, req, live);
  },
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
  log(`feeding ${waiting?.length ?? 0} waiting messages`);
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
  else if (m.t === 'parked') {
    parked = !!(m as { on?: boolean }).on;
    document.documentElement.classList.toggle('parked', parked);
    applySound();
  }
});

// How fast the game runs (its animations and text), remembered for next time.
let speed = 1;
try {
  speed = Number(localStorage.getItem('speed')) || 1;
} catch {
  // storage unavailable: normal speed
}
function applySpeed(): void {
  try {
    game.emulator?.setSpeed(speed);
  } catch {
    return; // still loading; applied once a battle is taken over
  }
  $('speed').hidden = false;
  for (const b of $('speed').querySelectorAll<HTMLButtonElement>('button[data-speed]')) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === speed));
  applySound();
}

// The game is silent while it's parked out of sight (no battle on screen, or the battle closed),
// and otherwise follows the mute button, which is remembered for next time.
let parked = false;
let userMuted = false;
try {
  userMuted = localStorage.getItem('muted') === '1';
} catch {
  // storage unavailable: sound on
}
function applySound(): void {
  $('mute').textContent = userMuted ? 'Unmute' : 'Mute';
  $('mute').setAttribute('aria-pressed', String(userMuted));
  try {
    const want = userMuted || parked;
    if (game.emulator && game.emulator.muted !== want) game.emulator.muted = want;
  } catch {
    // still loading
  }
}
// Also as the game boots, which happens out of sight, before any battle shows.
setInterval(applySound, 500);
$('mute').addEventListener('click', () => {
  userMuted = !userMuted;
  try {
    localStorage.setItem('muted', userMuted ? '1' : '0');
  } catch {
    // not remembered
  }
  applySound();
});
$('speed').addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-speed]');
  if (!button) return;
  speed = Number(button.dataset.speed);
  try {
    localStorage.setItem('speed', String(speed));
  } catch {
    // not remembered
  }
  applySpeed();
});

// BW2's touch screen covers Showdown's own move and switch buttons, so they can't be clicked
// by mistake. They show only where BW2 can't stand in: team preview (picked on Showdown) and
// after the battle (rematch, close).
let teamPreview = false;
let ended = false;
function showControls(): void {
  toPage({ t: 'controls', showdown: teamPreview || ended });
}

async function start(rom: ArrayBuffer): Promise<void> {
  log(`starting with a ${rom.byteLength}-byte ROM`);
  if (gameCode(rom) !== 'IREO') status(`This ROM's game code is ${gameCode(rom)}; the battle addresses are for US Black 2 (IREO).`, false);
  log('booting the emulator frame');
  const emu = game.boot($('emu'), rom, async () => {
    const res = await fetch('savestates/battle-move-select.state');
    return { save: null, state: res.ok ? await res.arrayBuffer() : null };
  });
  log(emu ? 'emulator frame created' : 'boot failed');
  if (emu) $('emu').querySelector('iframe')?.addEventListener('load', () => log('emulator frame loaded'));
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
log(`app loaded; framed in ${page || 'nothing'}`);
loadRom().then(
  (rom) => (rom ? start(rom) : askForRom()),
  (err) => {
    log(`couldn't read the stored ROM: ${err}`);
    askForRom();
  },
);
