import { Director } from './director';
import { SC, encodeBlock } from './bw/servercmd';
import { TeeRenderer } from './emu/renderer';
import { Bw2Game } from './game';
import { ChoiceBridge } from './play';
import { PreviewRenderer } from './preview';
import { Session } from './session';
import { battleRoom, fetchReplay, listenToRelay, spectate } from './sources';
import type { Translator } from './translate';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const renderer = new PreviewRenderer([$('side-near'), $('side-far')], $('textbox'), $('screen-status'), $('log'));
const game = new Bw2Game({
  status: (text, ok) => setStatus($('emu-status'), text, ok),
  clearScreen: () => director.reset(),
  // The dev server's STATE for singles, savestates/ for the rest.
  stateUrls: { singles: '/state', doubles: '/savestates/battle-doubles.state' },
  emuPage: '/emu.html',
});
const inGame = game.renderer;
const director = new Director(new TeeRenderer([renderer, inGame]));
let current: Translator | null = null;

const session = new Session({
  follow(room, translator) {
    current = translator;
    director.reset();
    choices.stop();
    setStatus($('source-status'), `Showing ${room}`, true);
  },
  commands(cmds, instant) {
    choices.heard();
    // Nothing is left to choose once the battle is over, even while its last turn is still playing.
    if (cmds.some((c) => c.kind === 'end')) choices.stop();
    director.enqueue(cmds, instant);
    showWarnings();
  },
  request: (room, req, live) => choices.onRequest(room, req, live),
  choiceError: (room, message) => choices.onChoiceError(room, message),
});

function setStatus(el: HTMLElement, text: string, ok: boolean): void {
  el.textContent = text;
  el.dataset.ok = String(ok);
}

function showWarnings(): void {
  if (!current) return;
  const warning = $('gen-warning');
  warning.hidden = !current.gen || current.gen === 5;
  warning.textContent = `This is a Gen ${current.gen} battle. BW2 can only draw Gen 5 battles faithfully.`;
  showCounts('unhandled', [...current.unhandled].map(([cmd, n]) => [`|${cmd}|`, n]));
  showCounts('gaps', [...inGame.gaps]);
}

// Gaps are found as BW2 plays each command, after it was queued.
setInterval(showWarnings, 1000);

/** Fills a collapsible list of things with counts, hidden while it's empty. */
function showCounts(id: string, items: [string, number][]): void {
  $(`${id}-list`).replaceChildren(
    ...items.map(([what, n]) => {
      const li = document.createElement('li');
      li.textContent = `${what} ×${n}`;
      return li;
    }),
  );
  $(id).hidden = items.length === 0;
}

// Live battles, as a guest spectator.
let stopWatching: (() => void) | null = null;
$('watch-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const room = battleRoom($<HTMLInputElement>('watch-url').value);
  if (!room) return setStatus($('source-status'), "That doesn't look like a battle link.", false);
  stopWatching?.();
  session.followed = null;
  stopWatching = spectate(room, (msg) => session.receive(msg), (text, ok) => setStatus($('source-status'), text, ok));
});

// Replays.
$('replay-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  stopWatching?.();
  stopWatching = null;
  setStatus($('source-status'), 'Loading replay…', true);
  try {
    const { room, log } = await fetchReplay($<HTMLInputElement>('replay-url').value);
    session.playLog(room, log);
  } catch (err) {
    setStatus($('source-status'), (err as Error).message, false);
  }
});

// Your own battles, through the userscript and the dev server relay.
const relay = listenToRelay(
  (msg) => session.receive(msg),
  (msgs) => msgs.forEach((m) => session.receive(m, { instant: true })),
  (text, ok) => setStatus($('relay-status'), text, ok),
);

$('speeds').addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-speed]');
  if (!button) return;
  renderer.speed = Number(button.dataset.speed);
  for (const b of $('speeds').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button));
});

// Playing from BW2's menus: Showdown's requests open them, and the pick goes back through the relay.
const choices = new ChoiceBridge({
  battle: () => game.live(),
  renderer: inGame,
  caughtUp: () => director.idle,
  writeActiveMoves: (position, moves) => game.parties?.writeMoves(0, position, moves),
  send: (room, text) => relay.send(room, text),
  status: (text, ok) => setStatus($('emu-status'), text, ok),
});

// The game.
$('rom-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $<HTMLInputElement>('rom-file').files?.[0];
  const emuStatus = (text: string, ok = true) => setStatus($('emu-status'), text, ok);
  let rom: ArrayBuffer;
  try {
    if (file) {
      rom = await file.arrayBuffer();
    } else {
      emuStatus('Loading the ROM from the dev server…');
      const res = await fetch('/rom');
      if (!res.ok) throw new Error(await res.text());
      rom = await res.arrayBuffer();
    }
  } catch (err) {
    return emuStatus((err as Error).message, false);
  }
  $('emu').hidden = false;
  $('take-over').hidden = true;
  const fetched = (url: string) => fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null), () => null);
  const emu = game.boot($('emu'), rom, async () => {
    $('take-over').hidden = false;
    const [save, state] = await Promise.all([fetched('/save'), fetched('/state')]);
    return { save, state };
  });
  if (!emu) return;
  // For the console: window.bw.ram, .battle, .parties, .trainers follow the game.
  (window as any).bw = {
    emulator: emu,
    SC,
    encodeBlock,
    get ram() {
      return emu.ram();
    },
    get battle() {
      return game.battle;
    },
    get parties() {
      return game.parties;
    },
    get trainers() {
      return game.trainers;
    },
    /** Writes the current savestate to savestates/<name> through the dev server. */
    async keepState(name: string) {
      const res = await fetch(`/savestates/${encodeURIComponent(name)}`, { method: 'POST', body: emu.saveState() as BlobPart });
      return res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`));
    },
  };
});

$('take-over').addEventListener('click', () => void game.takeOver());
