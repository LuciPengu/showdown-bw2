import { Director } from './director';
import { SC, encodeBlock } from './bw/servercmd';
import { Bw2Battle } from './emu/bw2';
import { Emulator, gameCode } from './emu/emulator';
import { BattleParties } from './emu/party';
import { EmulatorRenderer, TeeRenderer } from './emu/renderer';
import { type PersonalTable, loadPersonal } from './emu/rom';
import { Scene } from './emu/scene';
import { TrainerNames } from './emu/trainers';
import { ChoiceBridge } from './play';
import { PreviewRenderer } from './preview';
import { Session } from './session';
import { battleRoom, fetchReplay, listenToRelay, spectate } from './sources';
import type { Translator } from './translate';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const renderer = new PreviewRenderer([$('side-near'), $('side-far')], $('textbox'), $('screen-status'), $('log'));
const inGame = new EmulatorRenderer(
  {
    battle: () => (bw2?.alive ? bw2 : null),
    newScene: (screen) => new Scene(parties!.sides(), screen, bw2!.winBgm),
    writeMon: (write) => parties!.write(write),
    growPlayerParty: () => {
      parties!.growParty(0);
      return parties!.sides()[0];
    },
    writeMoves: (client, partyIndex, moves) => parties!.writeMoves(client, partyIndex, moves),
    writeTrainer: (client, name) => trainers!.write(client, name),
    press: (button) => emulator!.press(button, 120, 300),
    battleOver: () => void restartBattle(),
  },
  (message) => setStatus($('emu-status'), `BW2: ${message}`, false),
);
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
  battle: () => (bw2?.alive ? bw2 : null),
  renderer: inGame,
  caughtUp: () => director.idle,
  writeActiveMoves: (moves) => parties?.writeMoves(0, 0, moves),
  send: (room, text) => relay.send(room, text),
  status: (text, ok) => setStatus($('emu-status'), text, ok),
});

// The game.
let emulator: Emulator | null = null;
let bw2: Bw2Battle | null = null;
let parties: BattleParties | null = null;
let trainers: TrainerNames | null = null;
/** The game as it was when the battle was taken over, to go back to once a battle ends. */
let freshBattle: Uint8Array | null = null;
/** Species data from the ROM, read before the emulator takes the ROM. */
let personal: PersonalTable | null = null;
const emuStatus = (text: string, ok = true) => setStatus($('emu-status'), text, ok);

$('rom-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $<HTMLInputElement>('rom-file').files?.[0];
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
  const code = gameCode(rom);
  try {
    personal = loadPersonal(new Uint8Array(rom));
  } catch (err) {
    return emuStatus(`Couldn't read species data from the ROM: ${(err as Error).message}`, false);
  }
  if (code !== 'IREO') emuStatus(`Game code ${code}: the battle addresses are for US Black 2 (IREO). Trying anyway.`, false);
  emulator?.destroy();
  bw2 = null;
  parties = null;
  $('emu').hidden = false;
  $('take-over').hidden = true;
  const emu = Emulator.boot($('emu'), rom, (text) => {
    if (text !== 'started') return emuStatus(`Emulator: ${text}…`);
    if (window.__emuBoot) window.__emuBoot.rom = new ArrayBuffer(0); // the core has its own copy
    void startGame(emu);
  });
  emulator = emu;
  (window as any).bw = {
    emulator: emu,
    SC,
    encodeBlock,
    /** Writes the current savestate to savestates/<name> through the dev server. */
    async keepState(name: string) {
      const res = await fetch(`/savestates/${encodeURIComponent(name)}`, { method: 'POST', body: emu.saveState() as BlobPart });
      return res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`));
    },
  };
});

/** Finds the game's RAM, waits for the first click, then loads the dev server's save or savestate. */
async function startGame(emu: Emulator): Promise<void> {
  let ram = emu.ram();
  for (let tries = 0; !ram && tries < 60 && emulator === emu; tries++) {
    await new Promise((r) => setTimeout(r, 500));
    ram = emu.ram();
  }
  if (!ram) return emuStatus("The game is running, but its RAM wasn't found in the emulator's memory.", false);
  (window as any).bw.ram = ram;
  emuStatus('Click the game once to start it.');
  await emu.whenRunning();
  if (emulator !== emu) return;

  const fetched = (url: string) => fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null), () => null);
  const [save, state] = await Promise.all([fetched('/save'), fetched('/state')]);
  if (save) emu.loadSave(new Uint8Array(save));
  if (state) {
    emu.loadState(new Uint8Array(state));
    await new Promise((r) => setTimeout(r, 1000));
  }
  $('take-over').hidden = false;
  if (!(await takeOverBattle(emu, false))) {
    emuStatus(`Running${state ? ' from the savestate' : save ? ' from the save' : ''}. Get into a battle, then press Take over.`);
  }
}

/** Attaches to the battle on screen and pauses BW2's own battle logic. */
async function takeOverBattle(emu: Emulator, report = true, clearScreen = true): Promise<boolean> {
  const ram = emu.ram();
  const battle = ram && Bw2Battle.attach(ram);
  if (!battle) {
    if (report) emuStatus("BW2 isn't in a battle.", false);
    return false;
  }
  battle.clock = () => (emu.frames() * 1000) / 60; // the DS runs at 60 frames a second
  emuStatus('Taking over the battle…');
  if (!battle.paused) freshBattle = emu.saveState(); // nothing of ours is in it yet
  try {
    await battle.takeOver((button) => emu.press(button, 120, 300));
  } catch (err) {
    emuStatus((err as Error).message, false);
    return false;
  }
  bw2 = battle;
  parties = new BattleParties(ram, battle.mainModule, personal!);
  trainers = new TrainerNames(ram, battle.mainModule, battle.server);
  inGame.newGame();
  if (clearScreen) director.reset(); // the next battle shown starts from this battle's party data
  (window as any).bw.battle = battle;
  (window as any).bw.parties = parties;
  (window as any).bw.trainers = trainers;
  emuStatus('BW2 is drawing: moves play in the game.', true);
  return true;
}

/** How long BW2's result line stays up before the game goes back to a fresh battle. */
const RESULT_MS = 4000;

/**
 * After a battle ends, goes back to the battle as it was taken over, so the
 * next battle starts fresh. The game never leaves a battle, so it never saves
 * the rewritten party.
 */
async function restartBattle(): Promise<void> {
  const emu = emulator;
  const state = freshBattle;
  if (!emu || !state) return;
  await new Promise((r) => setTimeout(r, RESULT_MS));
  if (emulator !== emu) return;
  emuStatus('The battle is over. Getting a fresh battle ready…');
  emu.loadState(state);
  await new Promise((r) => setTimeout(r, 1000));
  if (await takeOverBattle(emu, false, false)) emuStatus('Ready for the next battle.', true);
}

$('take-over').addEventListener('click', () => {
  if (emulator) void takeOverBattle(emulator);
});
