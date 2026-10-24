// The BW2 emulator: EmulatorJS (melonDS core) in an iframe, plus access to its RAM.

import { DsRam, findMainRam } from './ram';
import { Cart, type RomProbe, findRomCopies, romProbe, stretchInRam } from './romimage';

interface EmuBoot {
  rom: ArrayBuffer;
  onStatus(text: string): void;
}

declare global {
  interface Window {
    __emuBoot?: EmuBoot;
  }
}

/** libretro joypad indices, which EmulatorJS's simulateInput takes. */
export const BUTTONS = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 } as const;
export type Button = keyof typeof BUTTONS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads a ROM's 4-letter game code (`IREO` is US Black 2, `IRDO` US White 2). */
export function gameCode(rom: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(rom, 0x0c, 4));
}

export class Emulator {
  private ramCache: DsRam | null = null;
  private cartCache: Cart | null = null;
  private readonly rom: Uint8Array;
  private readonly romSize: number;
  private readonly probe: RomProbe;

  private constructor(private readonly frame: HTMLIFrameElement, rom: ArrayBuffer) {
    // The header and the start of ARM9 are all findMainRam needs; don't hold the whole ROM.
    this.rom = new Uint8Array(rom.slice(0, 0x8000));
    this.romSize = rom.byteLength;
    this.probe = romProbe(new Uint8Array(rom));
  }

  /** Boots `rom` in a new frame (the page `page`) inside `container`, replacing what was there. */
  static boot(container: HTMLElement, rom: ArrayBuffer, onStatus: (text: string) => void, page = '/emu.html'): Emulator {
    window.__emuBoot = { rom, onStatus };
    const frame = document.createElement('iframe');
    frame.src = page;
    frame.title = 'Pokémon Black 2 / White 2';
    frame.allow = 'autoplay; fullscreen; gamepad';
    frame.className = 'emu-frame';
    container.replaceChildren(frame);
    return new Emulator(frame, rom);
  }

  private get gameManager(): Record<string, any> {
    const gm = (this.frame.contentWindow as any)?.EJS_emulator?.gameManager;
    if (!gm) throw new Error('the game is still loading');
    return gm;
  }

  /**
   * Loads an EmulatorJS savestate (same EmulatorJS version and core), then
   * makes the files moved into the ROM's added room reachable from it.
   */
  loadState(state: Uint8Array): void {
    this.gameManager.loadState(state);
    const ram = this.ram();
    const cart = this.cart();
    if (ram && cart && !stretchInRam(ram, cart)) console.warn("The game's file table wasn't found in RAM: new sprites won't load.");
  }

  /** The current savestate. */
  saveState(): Uint8Array {
    return this.gameManager.getState();
  }

  /** Replaces the cartridge save, as EmulatorJS's own "Load Save" does, then restarts so the game reads it. */
  loadSave(save: Uint8Array): void {
    const gm = this.gameManager;
    const path: string = gm.getSaveFilePath();
    const fs = gm.FS;
    let dir = '';
    for (const part of path.split('/').slice(0, -1).filter(Boolean)) {
      dir += `/${part}`;
      if (!fs.analyzePath(dir).exists) fs.mkdir(dir);
    }
    if (fs.analyzePath(path).exists) fs.unlink(path);
    fs.writeFile(path, save);
    gm.loadSaveFiles();
    gm.restart();
  }

  /** Resolves once the game is running: browsers hold it until the page gets a click. */
  async whenRunning(): Promise<void> {
    const ram = this.ram();
    if (!ram) throw new Error('the game is still loading');
    const sample = () => ram.bytes(0x02000000, 0x40000);
    let last = sample();
    for (;;) {
      await sleep(300);
      const now = sample();
      if (now.some((b, i) => b !== last[i])) return;
      last = now;
    }
  }

  private get ejs(): Record<string, any> {
    const ejs = (this.frame.contentWindow as any)?.EJS_emulator;
    if (!ejs) throw new Error('the game is still loading');
    return ejs;
  }

  /** Whether the game's sound is off. EmulatorJS remembers it for next time. */
  get muted(): boolean {
    return !!this.ejs.muted;
  }

  set muted(on: boolean) {
    const ejs = this.ejs;
    ejs.setVolume(on ? 0 : ejs.volume || 0.5);
  }

  /** Runs the game at `ratio` times its normal speed (1 is normal), with RetroArch's fast-forward. */
  setSpeed(ratio: number): void {
    const gm = this.gameManager;
    gm.setFastForwardRatio(ratio);
    gm.toggleFastForward(ratio > 1 ? 1 : 0);
  }

  /** How many frames the game has run. */
  frames(): number {
    return this.gameManager.getFrameNum();
  }

  /** Holds a button for `ms`, then lets go and waits `after` ms. */
  async press(button: Button, ms = 100, after = 150): Promise<void> {
    const gm = this.gameManager;
    gm.simulateInput(0, BUTTONS[button], 1);
    await sleep(ms);
    gm.simulateInput(0, BUTTONS[button], 0);
    await sleep(after);
  }

  /** EmulatorJS's emscripten module, once the core has loaded. */
  private get module(): Record<string, any> | null {
    const ejs = (this.frame.contentWindow as any)?.EJS_emulator;
    return ejs?.gameManager?.Module ?? null;
  }

  private heap(): Uint8Array | null {
    const m = this.module;
    if (!m) return null;
    if (m.HEAPU8) return m.HEAPU8 as Uint8Array;
    const buffer = m.wasmMemory?.buffer ?? m.asm?.memory?.buffer ?? m.wasmExports?.memory?.buffer;
    return buffer ? new Uint8Array(buffer) : null;
  }

  /** Main RAM, or null until the game has booted far enough to find it. */
  ram(): DsRam | null {
    if (this.ramCache) return this.ramCache;
    const heap = this.heap();
    if (!heap) return null;
    const base = findMainRam(heap, this.rom);
    if (base === null) return null;
    this.ramCache = new DsRam(() => this.heap()!, base);
    return this.ramCache;
  }

  /** The cartridge as the game reads it, or null until the core has loaded the ROM. */
  cart(): Cart | null {
    if (this.cartCache) return this.cartCache;
    const heap = this.heap();
    if (!heap) return null;
    const copies = findRomCopies(heap, this.probe);
    if (!copies.length) return null;
    this.cartCache = new Cart(() => this.heap()!, copies, this.romSize);
    return this.cartCache;
  }

  destroy(): void {
    this.frame.remove();
    if (window.__emuBoot) window.__emuBoot = undefined;
  }
}
