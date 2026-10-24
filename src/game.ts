// The BW2 game as a renderer: boots the emulator, takes over its battle, and
// switches battles (another style, or a fresh one after a battle ends). Shared
// by the web page (main.ts) and the browser extension (ext/app.ts).

import type { GameType } from './bw/commands';
import { Bw2Battle } from './emu/bw2';
import { Emulator, gameCode } from './emu/emulator';
import { BattleParties } from './emu/party';
import { EmulatorRenderer, type Lead } from './emu/renderer';
import { type PersonalTable, loadPersonal } from './emu/rom';
import { withScratch } from './emu/romimage';
import { Scene, drawable } from './emu/scene';
import { TrainerNames } from './emu/trainers';

export interface GameHost {
  status(text: string, ok: boolean): void;
  /** A battle was taken over: what's on screen should start over from its party data. */
  clearScreen(): void;
  /** Savestates of a battle in each style, as URLs. */
  stateUrls: Partial<Record<GameType, string>>;
  /**
   * Savestates from just before a battle of each style starts (the PWT's last
   * line before it), for battles shown with BW2's own intro.
   */
  introUrls?: Partial<Record<GameType, string>>;
  /** The emulator frame's page. */
  emuPage: string;
  /** Something worth knowing while debugging, not worth showing the player. */
  note?(text: string): void;
}

/** How many Pokémon each side has out in a BW2 battle style (0 singles, 1 doubles, 2 triples, 3 rotation). */
export function perSide(style: number): number {
  return style === 1 ? 2 : style === 2 ? 3 : 1;
}

const STYLES: Record<GameType, number> = { singles: 0, doubles: 1, triples: 2, rotation: 3 };
/** How long BW2's result line stays up before the game goes back to a fresh battle. */
const RESULT_MS = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Bw2Game {
  readonly renderer: EmulatorRenderer;
  emulator: Emulator | null = null;
  battle: Bw2Battle | null = null;
  parties: BattleParties | null = null;
  trainers: TrainerNames | null = null;
  /** The game as it was when the battle was taken over, to go back to once a battle ends. */
  private freshBattle: Uint8Array | null = null;
  /** Going back to a fresh battle after one ended; commands wait for it. */
  private restarting: Promise<void> | null = null;
  /** Ends the wait on the last battle's result early, when the next battle has begun. */
  private hurry: (() => void) | null = null;
  /** Species data from the ROM, read before the emulator takes the ROM. */
  private personal: PersonalTable | null = null;

  constructor(private readonly host: GameHost) {
    this.renderer = new EmulatorRenderer(
      {
        battle: () => this.live(),
        newScene: (screen) => new Scene(this.parties!.sides(), screen, this.battle!.winBgm, perSide(this.battle!.style)),
        writeMon: (write) => this.parties!.write(write),
        sizePlayerParty: (size) => {
          this.parties!.resizeParty(0, size);
          return this.parties!.sides()[0];
        },
        writeMoves: (client, partyIndex, moves) => this.parties!.writeMoves(client, partyIndex, moves),
        writeTrainer: (client, name) => this.trainers!.write(client, name),
        press: (button) => this.emulator!.press(button, 120, 300),
        readHp: (monId) => this.parties?.hpOf(monId) ?? null,
        writeHp: (monId, hp, maxHp) => this.parties?.setHp(monId, hp, maxHp),
        note: (text) => (host.note ? host.note(text) : console.warn(text)),
        battleOver: () => void this.restartBattle(),
        ready: () => this.ready(),
        intro: (gameType, names, leads) => this.intro(gameType, names, leads),
        prepare: (gameType) => this.prepareBattle(gameType),
      },
      (message) => host.status(`BW2: ${message}`, false),
    );
  }

  /** The taken-over battle, if it's still the one in the game. */
  live(): Bw2Battle | null {
    return this.battle?.alive ? this.battle : null;
  }

  private status(text: string, ok = true): void {
    this.host.status(text, ok);
  }

  /**
   * Boots `rom` in a new emulator frame in `container`. Once the game runs,
   * `start` gives it a save and a savestate to begin from (either may be null),
   * and the battle in it is taken over.
   */
  boot(container: HTMLElement, rom: ArrayBuffer, start: () => Promise<{ save: ArrayBuffer | null; state: ArrayBuffer | null }>): Emulator | null {
    const code = gameCode(rom);
    try {
      this.personal = loadPersonal(new Uint8Array(rom));
    } catch (err) {
      this.status(`Couldn't read species data from the ROM: ${(err as Error).message}`, false);
      return null;
    }
    if (code !== 'IREO') this.status(`Game code ${code}: the battle addresses are for US Black 2 (IREO). Trying anyway.`, false);
    this.emulator?.destroy();
    this.battle = null;
    this.parties = null;
    const emu = Emulator.boot(
      container,
      withScratch(rom),
      (text) => {
        if (text.startsWith('error')) return this.status(`Emulator ${text}`, false);
        if (text !== 'started') return this.status(`Emulator: ${text}…`);
        if (window.__emuBoot) window.__emuBoot.rom = new ArrayBuffer(0); // the core has its own copy
        void this.startGame(emu, start);
      },
      this.host.emuPage,
    );
    this.emulator = emu;
    return emu;
  }

  /** Finds the game's RAM, waits until it runs, then loads the save or savestate. */
  private async startGame(emu: Emulator, start: () => Promise<{ save: ArrayBuffer | null; state: ArrayBuffer | null }>): Promise<void> {
    let ram = emu.ram();
    for (let tries = 0; !ram && tries < 60 && this.emulator === emu; tries++) {
      await sleep(500);
      ram = emu.ram();
    }
    if (!ram) return this.status("The game is running, but its RAM wasn't found in the emulator's memory.", false);
    this.status('Click the game once to start it.');
    await emu.whenRunning();
    if (this.emulator !== emu) return;
    const { save, state } = await start();
    if (save) emu.loadSave(new Uint8Array(save));
    if (state) {
      emu.loadState(new Uint8Array(state));
      await sleep(1000);
    }
    if (!(await this.takeOver(false))) {
      this.status(`Running${state ? ' from the savestate' : save ? ' from the save' : ''}. Get into a battle, then press Take over.`);
    }
  }

  /** Attaches to the battle on screen and pauses BW2's own battle logic. */
  async takeOver(report = true, clearScreen = true): Promise<boolean> {
    const emu = this.emulator;
    const ram = emu?.ram();
    const battle = ram && Bw2Battle.attach(ram);
    if (!emu || !ram || !battle) {
      if (report) this.status("BW2 isn't in a battle.", false);
      return false;
    }
    battle.clock = () => (emu.frames() * 1000) / 60; // the DS runs at 60 frames a second
    this.status('Taking over the battle…');
    if (!battle.paused) this.freshBattle = emu.saveState(); // nothing of ours is in it yet
    try {
      await battle.takeOver((button) => emu.press(button, 120, 300));
    } catch (err) {
      this.status((err as Error).message, false);
      return false;
    }
    this.battle = battle;
    this.parties = new BattleParties(ram, battle.mainModule, this.personal!);
    this.trainers = new TrainerNames(ram, battle.mainModule, battle.server);
    this.renderer.newGame(perSide(battle.style));
    if (clearScreen) this.host.clearScreen(); // the next battle shown starts from this battle's party data
    this.status('BW2 is drawing: moves play in the game.', true);
    return true;
  }

  /** When Showdown's battle is another style than BW2's (doubles in a singles battle), loads a savestate of one. */
  private async prepareBattle(gameType: GameType): Promise<void> {
    const emu = this.emulator;
    if (!emu || !this.battle || this.battle.style === STYLES[gameType]) return;
    const url = this.host.stateUrls[gameType];
    if (!url) throw new Error(`there's no savestate of a ${gameType} battle, so this one is drawn in the wrong style`);
    this.status(`Switching BW2 to a ${gameType} battle…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`no ${gameType} savestate at ${url}`);
    emu.loadState(new Uint8Array(await res.arrayBuffer()));
    await sleep(1000);
    if (!(await this.takeOver(false, false))) throw new Error(`the ${gameType} savestate isn't in a battle`);
    if (this.battle.style !== STYLES[gameType]) throw new Error(`the savestate at ${url} isn't a ${gameType} battle`);
  }

  /**
   * Starts a battle with BW2's own intro. From a savestate just before a PWT
   * battle, the battle is started, and as soon as BW2 has built it (before its
   * intro shows anyone) the trainers are renamed and the leads written into
   * their party slots. BW2 then plays its intro (trainers, throws, "Go! X!"),
   * and at turn 1's menu its own battle logic is paused, the menu left open
   * for the player's first choice. False if it couldn't.
   */
  private async intro(gameType: GameType, names: [string, string], leads: Lead[]): Promise<boolean> {
    const emu = this.emulator;
    const url = this.host.introUrls?.[gameType];
    if (!emu || !url || !this.personal) return false;
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) return false;
    this.status('Starting the battle…');
    emu.loadState(new Uint8Array(await res.arrayBuffer()));
    await sleep(300);
    await emu.press('A', 120, 0); // past the PWT's last line, into the battle
    const ram = emu.ram();
    let battle: Bw2Battle | null = null;
    for (let tries = 0; ram && !battle && tries < 600; tries++) {
      await sleep(16);
      battle = Bw2Battle.attach(ram);
    }
    if (!ram || !battle) {
      this.status("BW2 didn't start the battle.", false);
      return false;
    }
    battle.clock = () => (emu.frames() * 1000) / 60;
    const parties = new BattleParties(ram, battle.mainModule, this.personal);
    const trainers = new TrainerNames(ram, battle.mainModule, battle.server);
    names.forEach((name, client) => name && drawable(name) && trainers.write(client, name));
    parties.quietServerMons();
    const sides = parties.sides();
    for (const { side, pos, mon } of leads) parties.write({ client: sides[side].client, partyIndex: pos, monId: sides[side].order[pos], mon });
    // BW2's intro plays; turn 1's menu means it's done.
    const end = battle.clock() + 60000;
    while (!battle.choosing) {
      if (battle.clock() > end || !battle.alive) {
        this.status("BW2's battle intro didn't finish.", false);
        return false;
      }
      await sleep(50);
    }
    battle.pauseLogic();
    this.battle = battle;
    this.parties = parties;
    this.trainers = trainers;
    this.freshBattle = null; // the next battle starts from the intro again
    this.renderer.newGame(perSide(battle.style));
    this.status('BW2 is drawing: moves play in the game.', true);
    return true;
  }

  /**
   * Resolves once the game can take a battle's commands: right away, or once
   * it's back in a fresh battle after the last one ended, which this hurries.
   */
  async ready(): Promise<void> {
    this.hurry?.();
    await this.restarting;
  }

  /**
   * After a battle ends, goes back to the battle as it was taken over, so the
   * next battle starts fresh. The game never leaves a battle, so it never saves
   * the rewritten party. Until it's back, the next battle's commands wait
   * (see ready): drawn into the old battle, the reload would wipe them.
   */
  private restartBattle(): void {
    const emu = this.emulator;
    const state = this.freshBattle;
    if (!emu || !state || this.restarting) return;
    this.restarting = (async () => {
      // The result line stays up for a while, unless the next battle has already begun.
      await new Promise<void>((resume) => {
        this.hurry = resume;
        setTimeout(resume, RESULT_MS);
      });
      this.hurry = null;
      if (this.emulator !== emu) return;
      this.status('The battle is over. Getting a fresh battle ready…');
      emu.loadState(state);
      await sleep(1000);
      if (await this.takeOver(false, false)) this.status('Ready for the next battle.', true);
    })().finally(() => {
      this.restarting = null;
    });
  }
}
