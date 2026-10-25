// The cartridge as the game reads it while it runs. BW2 reads its archives'
// tables and files from the cart each time (a sprite on each send-out, a line
// of text for each message), even after a savestate, so the app can change
// them live: in melonDS's copy of the ROM in the WebAssembly heap.
//
// Files that grow go into room added at the end of the ROM before it boots.
// That only works for archives the game opens anew for each file (sprites):
// the game keeps its text banks open, remembering where each starts, so text
// has to stay within its bank's own bytes.

import type { DsRam } from './ram';
import { MAIN_RAM } from './ram';
import { fatEntry, romFile, romFileId } from './rom';

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const put32 = (b: Uint8Array, at: number, v: number) => new DataView(b.buffer, b.byteOffset).setUint32(at, v >>> 0, true);

/** Room at the end of the ROM for files written while the game runs. */
export const SCRATCH_BYTES = 16 << 20;
/** The archives whose files may move into the room at the end: Pokémon sprites. */
export const LIVE_ARCHIVES = ['a/0/0/4'];
/** Bytes of the ROM that identify a copy of it: the header, and the start of the file name table. */
const PROBE_LEN = 0x40;

/**
 * The ROM with room at its end for new files, and the archives in
 * `LIVE_ARCHIVES` stretched to the end in the file allocation table, so a file
 * moved into that room is still inside its archive as the game's file system
 * sees it.
 */
export function withScratch(rom: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(rom.byteLength + SCRATCH_BYTES);
  out.set(new Uint8Array(rom));
  for (const path of LIVE_ARCHIVES) put32(out, fatEntry(out, path) + 4, out.length);
  return out.buffer;
}

/**
 * Stretches the archives in `LIVE_ARCHIVES` in the game's RAM too. The game's
 * file system keeps its own copy of the file allocation table in RAM, and a
 * savestate brings back the one from when it was made, so this runs after
 * each one. Files the game holds open keep their end as well (the file's
 * number, then its start and end); those are stretched alike. False if the
 * table isn't in RAM.
 */
export function stretchInRam(ram: DsRam, cart: Cart): boolean {
  const rom = cart.rom;
  const fat = u32(rom, 0x48);
  const mem = ram.bytes(MAIN_RAM, 0x400000);
  const words = new Uint32Array(mem.buffer);
  const first = u32(rom, fat);
  // Files' starts identify the table; their ends may differ, being the ones stretched.
  const starts = Math.min(8, u32(rom, 0x4c) / 8);
  let table = -1;
  for (let i = words.indexOf(first); i >= 0 && table < 0; i = words.indexOf(first, i + 1)) {
    let k = 1;
    while (k < starts && words[i + k * 2] === u32(rom, fat + k * 8)) k++;
    if (k === starts) table = i * 4;
  }
  if (table < 0) return false;
  for (const path of LIVE_ARCHIVES) {
    const id = romFileId(rom, path);
    const top = u32(rom, fat + id * 8);
    const end = u32(rom, fat + id * 8 + 4);
    ram.write32(MAIN_RAM + table + id * 8 + 4, end);
    for (let i = words.indexOf(top, 1); i >= 0; i = words.indexOf(top, i + 1)) {
      if (words[i - 1] === id && words[i + 1] < end) ram.write32(MAIN_RAM + (i + 1) * 4, end);
    }
  }
  return true;
}

/** What a copy of the ROM in the heap must match: its header, and the file name table's start. */
export interface RomProbe {
  header: Uint8Array;
  fntAt: number;
  fnt: Uint8Array;
}

export function romProbe(rom: Uint8Array): RomProbe {
  const fntAt = u32(rom, 0x40);
  return { header: rom.slice(0, PROBE_LEN), fntAt, fnt: rom.slice(fntAt, fntAt + PROBE_LEN) };
}

/**
 * Every copy of the ROM in `heap`, as heap offsets: melonDS's cart, and the
 * frontend's copy of the file it loaded. Main RAM's header copy doesn't count,
 * since the file name table isn't behind it.
 */
export function findRomCopies(heap: Uint8Array, probe: RomProbe): number[] {
  const words = new Uint32Array(heap.buffer, heap.byteOffset, Math.floor(heap.byteLength / 4));
  const first = u32(probe.header, 0);
  const found: number[] = [];
  for (let i = words.indexOf(first); i >= 0; i = words.indexOf(first, i + 1)) {
    const at = i * 4;
    if (same(heap, at, probe.header) && same(heap, at + probe.fntAt, probe.fnt)) found.push(at);
  }
  return found;
}

function same(heap: Uint8Array, at: number, want: Uint8Array): boolean {
  if (at + want.length > heap.length) return false;
  for (let k = 0; k < want.length; k++) if (heap[at + k] !== want[k]) return false;
  return true;
}

/**
 * The cartridge while the game runs. Writes go to every copy of the ROM in the
 * heap, so it doesn't matter which one the core reads; reads come from the
 * first. `size` is the ROM's size as booted, room at the end included.
 */
export class Cart {
  /** The next free byte of the room at the end. */
  private free: number;

  constructor(
    private readonly heap: () => Uint8Array,
    private readonly copies: number[],
    private readonly size: number,
  ) {
    this.free = size - SCRATCH_BYTES;
  }

  /** The ROM as the game sees it now. A view into the heap: don't keep it past a call. */
  get rom(): Uint8Array {
    return this.heap().subarray(this.copies[0], this.copies[0] + this.size);
  }

  write(at: number, data: Uint8Array): void {
    const heap = this.heap();
    for (const base of this.copies) heap.set(data, base + at);
  }

  write32(at: number, v: number): void {
    const b = new Uint8Array(4);
    put32(b, 0, v);
    this.write(at, b);
  }

  /**
   * Where `pattern` is in the emulator's memory outside the ROM: melonDS's own
   * copies of what the game has loaded from the cart (its video memory), on
   * 4-byte boundaries.
   */
  findLoaded(pattern: Uint8Array): number[] {
    const heap = this.heap();
    const found: number[] = [];
    const inRom = (at: number) => this.copies.some((base) => at >= base && at < base + this.size);
    outer: for (let at = 0; at + pattern.length <= heap.length; at += 4) {
      if (heap[at] !== pattern[0] || heap[at + pattern.length - 1] !== pattern[pattern.length - 1]) continue;
      for (let i = 1; i < pattern.length; i++) if (heap[at + i] !== pattern[i]) continue outer;
      if (!inRom(at)) found.push(at);
    }
    return found;
  }

  /** Whether `pattern` is still at `at`, as `findLoaded` found it. */
  isLoaded(at: number, pattern: Uint8Array): boolean {
    const heap = this.heap();
    return pattern.every((b, i) => heap[at + i] === b);
  }

  /** Writes to what `findLoaded` found. */
  writeLoaded(at: number, data: Uint8Array): void {
    this.heap().set(data, at);
  }

  /** Puts `data` in the room at the end and returns where. */
  place(data: Uint8Array): number {
    const at = this.free;
    if (at + data.length > this.size) throw new Error('no room left in the ROM for new files');
    this.free = (at + data.length + 3) & ~3;
    this.write(at, data);
    return at;
  }

  /** Lets the room at the end be used again: everything put there before is forgotten. */
  clearScratch(): void {
    this.free = this.size - SCRATCH_BYTES;
  }

  archive(path: string): CartArchive {
    return new CartArchive(this, path);
  }
}

/** A NARC archive on the cart, whose files can be replaced while the game runs. */
export class CartArchive {
  /** Where the archive's table of files (BTAF) starts in the ROM. */
  private readonly table: number;
  /** Where the archive's file data starts in the ROM: offsets in the table count from here. */
  private readonly data: number;
  readonly count: number;
  /** Table entries of files replaced, as they came. */
  private readonly original = new Map<number, Uint8Array>();

  constructor(
    private readonly cart: Cart,
    path: string,
  ) {
    const rom = cart.rom;
    const at = romFile(rom, path).byteOffset - rom.byteOffset;
    if (String.fromCharCode(...rom.subarray(at, at + 4)) !== 'NARC') throw new Error(`${path} isn't a NARC archive`);
    this.table = at + u16(rom, at + 0x0c);
    this.count = u16(rom, this.table + 8);
    const names = this.table + u32(rom, this.table + 4);
    this.data = names + u32(rom, names + 4) + 8;
  }

  /** A copy of a file's bytes as the game would read them now. */
  file(index: number): Uint8Array {
    const [start, end] = this.fileRange(index);
    return this.cart.rom.slice(start, end);
  }

  /** Where a file is in the ROM now: its start and end. */
  fileRange(index: number): [number, number] {
    const rom = this.cart.rom;
    const entry = this.entry(index);
    return [this.data + u32(rom, entry), this.data + u32(rom, entry + 4)];
  }

  /**
   * Replaces a file, putting the new one in the room at the end. `restore`
   * puts the archive back as it came.
   */
  replace(index: number, bytes: Uint8Array): void {
    const entry = this.entry(index);
    if (!this.original.has(index)) this.original.set(index, this.cart.rom.slice(entry, entry + 8));
    const at = this.cart.place(bytes) - this.data;
    this.cart.write32(entry, at);
    this.cart.write32(entry + 4, at + bytes.length);
  }

  /** Puts back every file replaced. */
  restore(): void {
    for (const [index, entry] of this.original) this.cart.write(this.entry(index), entry);
    this.original.clear();
  }

  private entry(index: number): number {
    if (index < 0 || index >= this.count) throw new RangeError(`file ${index} isn't in the archive`);
    return this.table + 12 + index * 8;
  }
}
