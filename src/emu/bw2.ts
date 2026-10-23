// Driving BW2's battle client from outside. In a local battle the battle logic
// (the server) and the client share an adapter in RAM: the server writes a
// command there, the client runs it and sets `returned`. Pausing the server and
// writing our own BTL_ACMD_SERVER_CMD blocks makes the client play whatever we
// send, with the game's own animations.
//
// Black 2 (IREO) addresses and offsets, from pokebw2's symbols and the game's
// own instructions (see README).

import type { DsRam } from './ram';

const S_ADAPTERS = 0x021dd86c; // BtlAdapter *sAdapters[4] (btl_adapter.c)
const MAIN_PROC_NORMAL = 0x021b19d5; // BattleClient_MainProcNormal | 1 (Thumb)

const ADAPTER = { returnData: 0x04, returnSize: 0x08, returned: 0x0c, cmd: 0x10, size: 0x12, data: 0x14 } as const;
const CLIENT = { mainModule: 0x00, mainProc: 0x28, adapter: 0x50, clientType: 0x1af, mainSeq: 0x1b0 } as const;
const MAIN_MODULE = { setup: 0x00, server: 0x08 } as const;
/** BtlSetup: the battle style (0 singles, 1 doubles, 2 triples, 3 rotation), and the victory music. */
const SETUP = { style: 0x04, winBgm: 0x1a } as const;
const SERVER = { mainModule: 0x0c, state: 0xed } as const;

const BTL_ACMD_SELECT_ACTION = 3;
const BTL_ACMD_SELECT_CHANGE_FAINTED = 5;
const BTL_ACMD_SERVER_CMD = 8;
const SERVER_STATE_DONE = 2; // BattleServer_Main does nothing more in this state
const MAIN_SEQ_RECV_CMD = 0;
const MAIN_SEQ_RUN_CMD = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the player chose in BW2's menus (a BattleAction). */
export type Bw2Action =
  | { kind: 'fight'; move: number; target: number }
  | { kind: 'switch'; partyIndex: number }
  | { kind: 'other'; action: number };

/** Unpacks a BattleAction word: the action in bits 0–3, a fight's target and move, or a switch's party slot. */
export function decodeAction(raw: number): Bw2Action {
  const action = raw & 0xf;
  if (action === 1) return { kind: 'fight', target: (raw >>> 4) & 7, move: (raw >>> 7) & 0xffff };
  if (action === 3) return { kind: 'switch', partyIndex: (raw >>> 7) & 7 };
  return { kind: 'other', action };
}

export class Bw2Battle {
  /**
   * The game's time in milliseconds, which timeouts are measured in. Wall-clock
   * time by default; set it to the emulator's frames so a paused game (a hidden
   * tab) never runs out of time.
   */
  clock: () => number = () => Date.now();

  private constructor(
    private readonly ram: DsRam,
    readonly adapter: number,
    readonly client: number,
    readonly server: number,
  ) {}

  /** Finds the player's battle client, or null when the game isn't in a battle. */
  static attach(ram: DsRam): Bw2Battle | null {
    const adapter = ram.read32(S_ADAPTERS);
    if (!isRam(adapter)) return null;
    // The client points at its adapter; look for that pointer where a client keeps it.
    const words = new Uint32Array(ram.bytes(0x02000000, 0x400000).buffer);
    for (let i = CLIENT.adapter / 4; i < words.length - 0x70; i++) {
      if (words[i] !== adapter) continue;
      const client = 0x02000000 + i * 4 - CLIENT.adapter;
      if (ram.read32(client + CLIENT.mainProc) !== MAIN_PROC_NORMAL || ram.read8(client + CLIENT.clientType) !== 0) continue;
      const mainModule = ram.read32(client + CLIENT.mainModule);
      const server = isRam(mainModule) ? ram.read32(mainModule + MAIN_MODULE.server) : 0;
      if (isRam(server) && ram.read32(server + SERVER.mainModule) === mainModule) return new Bw2Battle(ram, adapter, client, server);
    }
    return null;
  }

  /** The battle's main module (BtlMainModule). */
  get mainModule(): number {
    return this.ram.read32(this.client + CLIENT.mainModule);
  }

  /** Whether BW2's own battle logic is paused (taken over). */
  get paused(): boolean {
    return this.ram.read8(this.server + SERVER.state) === SERVER_STATE_DONE;
  }

  /** The battle's style: 0 singles, 1 doubles, 2 triples, 3 rotation. */
  get style(): number {
    return this.ram.read32(this.ram.read32(this.mainModule + MAIN_MODULE.setup) + SETUP.style);
  }

  /** The music BW2 plays when the player wins this battle. */
  get winBgm(): number {
    return this.ram.read16(this.ram.read32(this.mainModule + MAIN_MODULE.setup) + SETUP.winBgm);
  }

  /** Whether the battle this was attached to is still the one in memory. */
  get alive(): boolean {
    return this.ram.read32(S_ADAPTERS) === this.adapter && this.ram.read32(this.client + CLIENT.adapter) === this.adapter;
  }

  /** The client has answered its last command and is waiting for the next. */
  get idle(): boolean {
    return this.ram.read8(this.client + CLIENT.mainSeq) === MAIN_SEQ_RECV_CMD && (this.ram.read8(this.adapter + ADAPTER.returned) & 0xf) === 1;
  }

  /** The client has one of the player's menus open (the action menu, or picking a replacement). */
  get choosing(): boolean {
    const cmd = this.ram.read16(this.adapter + ADAPTER.cmd);
    return (cmd === BTL_ACMD_SELECT_ACTION || cmd === BTL_ACMD_SELECT_CHANGE_FAINTED) && this.ram.read8(this.client + CLIENT.mainSeq) === MAIN_SEQ_RUN_CMD;
  }

  /**
   * Closes an open menu the way a player would, by answering it (A until the
   * client replies), so the game cleans it up itself. The answer is ignored:
   * the server is paused.
   */
  async closeMenu(press: (button: 'A') => Promise<void>, timeoutMs = 10000): Promise<void> {
    const end = this.clock() + timeoutMs;
    while (this.choosing) {
      if (this.clock() > end) throw new Error("BW2's battle menu didn't close");
      await press('A');
      await sleep(350);
    }
  }

  /**
   * Stops the game's own battle logic and gets the client idle. If the player
   * is choosing an action, `press` answers the menu (Fight, then the first
   * move) so it closes the way it normally does; the paused logic never acts
   * on the answer.
   */
  async takeOver(press: (button: 'A') => Promise<void>, timeoutMs = 10000): Promise<void> {
    this.ram.write8(this.server + SERVER.state, SERVER_STATE_DONE);
    const end = this.clock() + timeoutMs;
    while (!this.idle) {
      if (this.clock() > end) throw new Error("BW2's battle menu didn't close");
      if (this.choosing) await press('A');
      await sleep(400);
    }
  }

  /** Stops the game's own battle logic, leaving whatever menu is open as it is. */
  pauseLogic(): void {
    this.ram.write8(this.server + SERVER.state, SERVER_STATE_DONE);
  }

  /** Abandons whatever the client is stuck on and sets it waiting for the next command. */
  private unstick(): void {
    this.ram.write8(this.client + CLIENT.mainSeq, MAIN_SEQ_RECV_CMD);
    this.ram.write8(this.adapter + ADAPTER.returned, (this.ram.read8(this.adapter + ADAPTER.returned) & 0xf0) | 1);
  }

  /**
   * Opens the player's menu: the action menu, or with `fainted`, the menu to
   * send in a replacement at those battle positions. Resolves with what the
   * player picked; there's no time limit. `signal` closes it unanswered.
   */
  async ask(fainted: number[] | null, signal?: AbortSignal): Promise<Bw2Action[]> {
    if (!this.alive) throw new Error('the battle has ended');
    const r = this.ram;
    const wanted = fainted ? BTL_ACMD_SELECT_CHANGE_FAINTED : BTL_ACMD_SELECT_ACTION;
    // A menu of the same kind already open (asked for an earlier request) answers this one too.
    if (!(this.choosing && r.read16(this.adapter + ADAPTER.cmd) === wanted)) {
      while (!this.idle) {
        if (signal?.aborted) throw new Error('cancelled');
        await sleep(30);
      }
      const data = Uint8Array.from(fainted ?? []);
      r.writeBytes(this.adapter + ADAPTER.data, data);
      r.write16(this.adapter + ADAPTER.size, data.length);
      r.write16(this.adapter + ADAPTER.cmd, wanted);
      r.write8(this.adapter + ADAPTER.returned, r.read8(this.adapter + ADAPTER.returned) & 0xf0);
      await sleep(50);
    }
    while (!this.idle) {
      if (signal?.aborted || !this.alive) throw new Error('cancelled'); // the menu stays open; see closeMenu
      await sleep(50);
    }
    const at = r.read32(this.adapter + ADAPTER.returnData);
    const size = r.read32(this.adapter + ADAPTER.returnSize);
    const actions: Bw2Action[] = [];
    for (let i = 0; i + 4 <= size && i < 12; i += 4) actions.push(decodeAction(r.read32(at + i)));
    return actions;
  }

  /** Has the client play a block of server commands, and resolves when it has. */
  async play(block: Uint8Array, timeoutMs = 20000): Promise<void> {
    if (!this.alive) throw new Error('the battle has ended');
    const end = this.clock() + timeoutMs;
    while (!this.idle) {
      if (this.clock() > end) throw new Error('the BW2 battle client is busy');
      await sleep(30);
    }
    const r = this.ram;
    r.writeBytes(this.adapter + ADAPTER.data, block);
    r.write16(this.adapter + ADAPTER.size, block.length);
    r.write16(this.adapter + ADAPTER.cmd, BTL_ACMD_SERVER_CMD);
    r.write8(this.adapter + ADAPTER.returned, r.read8(this.adapter + ADAPTER.returned) & 0xf0); // the client reads it next frame
    await sleep(50);
    while (!this.idle) {
      if (this.clock() > end) {
        this.unstick();
        throw new Error('BW2 took too long to play a command, so it was skipped');
      }
      await sleep(30);
    }
  }
}

function isRam(p: number): boolean {
  return p >= 0x02000000 && p < 0x02400000;
}
