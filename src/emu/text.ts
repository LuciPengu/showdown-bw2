// BW2's text banks (a/0/0/2): reading lines, and rewriting them on the cart
// while the game runs, for names and lines BW2 doesn't have.
//
// A bank is a header (sections, lines, size, 0, the section's offset), then a
// section: its size, a table of lines (offset from the section, length in
// code units, flags), and the lines. A line is UTF-16-ish code units ending in
// 0xFFFF, each XORed with a key that starts at 0x7C89 + 0x2983 × the line's
// number and rotates left 3 bits per unit. 0xFFFE is a line break; 0xF000,
// tag, count, args… is a placeholder the game fills in (a nickname, a move…).
//
// The game holds its banks open and remembers where each starts, so a bank
// can't move or grow (see romimage.ts). A longer line goes into the bytes of
// lines that won't be shown: ones the caller lends.

import type { Cart, CartArchive } from './romimage';

/** Banks in a/0/0/2. */
export const BANK = {
  items: 64,
  species: 90,
  abilities: 374,
  types: 398,
  moves: 403,
  /** "X used Y!": three lines per move, `move * 3` + (0 yours, 1 wild, 2 the foe's). */
  moveMessages: 16,
  /** Battle lines given with arguments (messages.ts `set`). */
  set: 18,
  /** Battle lines (messages.ts `std`). */
  std: 19,
} as const;

export const LINE_BREAK = 0xfffe;
const END = 0xffff;
/** Placeholder kinds (dumptext.py): the tag is 0x0100 | kind. */
export const WORD = { trainer: 0, species: 1, nickname: 2, type: 3, ability: 6, move: 7, item: 9 } as const;

const SPECIAL: Record<string, number> = { '\n': LINE_BREAK, '♂': 0x246d, '♀': 0x246e, '…': 0x246c, '×': 0x2467 };

/** Code units for `text`: `\n` breaks the line, `{nickname:0}` and the like are placeholders. */
export function encodeText(text: string): number[] {
  const out: number[] = [];
  const parts = text.split(/(\{\w+:\d+\})/);
  for (const part of parts) {
    const tag = /^\{(\w+):(\d+)\}$/.exec(part);
    if (tag) {
      const kind = WORD[tag[1] as keyof typeof WORD];
      if (kind === undefined) throw new Error(`unknown placeholder ${part}`);
      out.push(0xf000, 0x0100 | kind, 1, Number(tag[2]));
      continue;
    }
    for (const ch of part) out.push(SPECIAL[ch] ?? ch.codePointAt(0)!);
  }
  return out;
}

const rotl3 = (k: number) => ((k << 3) | (k >>> 13)) & 0xffff;
const keyOf = (line: number) => (0x7c89 + 0x2983 * line) & 0xffff;

/** XORs a line's code units with its key: encrypts plain ones, decrypts encrypted ones. */
export function crypt(line: number, units: ArrayLike<number>): number[] {
  const out: number[] = [];
  let key = keyOf(line);
  for (let k = 0; k < units.length; k++) {
    out.push(units[k] ^ key);
    key = rotl3(key);
  }
  return out;
}

interface Slot {
  /** Bytes from the bank's start. */
  at: number;
  /** Room in code units. */
  units: number;
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** A bank's line table, read from its bytes. */
export function lineTable(bank: Uint8Array): { section: number; lines: Slot[] } {
  const section = u32(bank, 12);
  const count = u16(bank, 2);
  const lines: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const e = section + 4 + i * 8;
    lines.push({ at: section + u32(bank, e), units: u16(bank, e + 4) });
  }
  return { section, lines };
}

/** A line's code units, without its end. */
export function readLine(bank: Uint8Array, line: number): number[] {
  const { lines } = lineTable(bank);
  const { at, units } = lines[line];
  const raw: number[] = [];
  for (let k = 0; k < units; k++) raw.push(u16(bank, at + k * 2));
  const plain = crypt(line, raw);
  const end = plain.indexOf(END);
  return end < 0 ? plain : plain.slice(0, end);
}

/**
 * A text bank on the cart, rewritten while the game runs. `restore` puts the
 * whole bank back as it came.
 */
export class LiveBank {
  /** Where the bank starts in the ROM. */
  private readonly base: number;
  private readonly original: Uint8Array;
  private readonly section: number;
  /** Each line's own room, as the bank came. */
  private readonly own: Slot[];
  /** Room lent by lines that won't be shown. */
  private free: Slot[] = [];
  /** Lines whose own room is lent. */
  private readonly lent = new Set<number>();
  /** Lines written, which keep their own room. */
  private readonly written = new Set<number>();
  /** Room taken from lent lines, by the line written there. */
  private readonly placed = new Map<number, Slot>();

  constructor(
    private readonly cart: Cart,
    archive: CartArchive,
    readonly bank: number,
  ) {
    const [start, end] = archive.fileRange(bank);
    this.base = start;
    this.original = cart.rom.slice(start, end);
    const table = lineTable(this.original);
    this.section = table.section;
    this.own = table.lines;
  }

  get lineCount(): number {
    return this.own.length;
  }

  /** The line as the game would show it now, without its end. */
  read(line: number): number[] {
    const rom = this.cart.rom;
    const e = this.entryAt(line);
    const at = this.base + this.section + u32(rom, e);
    const raw: number[] = [];
    for (let k = 0; k < u16(rom, e + 4); k++) raw.push(u16(rom, at + k * 2));
    const plain = crypt(line, raw);
    const end = plain.indexOf(END);
    return end < 0 ? plain : plain.slice(0, end);
  }

  /** Lets the room of `lines` hold other lines. They mustn't be shown until `restore`. */
  lend(lines: Iterable<number>): void {
    for (const line of lines) {
      const slot = this.own[line];
      if (!slot || this.lent.has(line) || this.written.has(line) || !slot.units) continue;
      this.lent.add(line);
      this.free.push({ ...slot });
    }
    this.mergeFree();
  }

  /** Lines lie one after another, so free neighbours make one longer room. */
  private mergeFree(): void {
    this.free.sort((a, b) => a.at - b.at);
    this.free = this.free.reduce<Slot[]>((merged, slot) => {
      const last = merged[merged.length - 1];
      if (last && last.at + last.units * 2 === slot.at) last.units += slot.units;
      else merged.push(slot);
      return merged;
    }, []);
  }

  /** Writes `units` (no end needed) as line `line`. False when there's no room for it. */
  write(line: number, units: number[]): boolean {
    const plain = [...units, END];
    const own = this.own[line];
    // Room the line took from lent lines before is free again.
    const before = this.placed.get(line);
    if (before) {
      this.placed.delete(line);
      this.free.push(before);
      this.mergeFree();
    }
    let at: number;
    if (!this.lent.has(line) && plain.length <= own.units) at = own.at;
    else {
      // Its own room can join lent rooms next to it.
      this.written.delete(line);
      this.lend([line]);
      const i = this.free.findIndex((s) => s.units >= plain.length);
      if (i < 0) return false;
      const slot = this.free[i];
      at = slot.at;
      this.placed.set(line, { at, units: plain.length });
      slot.at += plain.length * 2;
      slot.units -= plain.length;
      if (!slot.units) this.free.splice(i, 1);
    }
    this.written.add(line);
    const bytes = new Uint8Array(plain.length * 2);
    crypt(line, plain).forEach((u, k) => {
      bytes[k * 2] = u & 0xff;
      bytes[k * 2 + 1] = u >>> 8;
    });
    this.cart.write(this.base + at, bytes);
    const entry = new Uint8Array(6);
    const v = new DataView(entry.buffer);
    v.setUint32(0, at - this.section, true);
    v.setUint16(4, plain.length, true);
    this.cart.write(this.entryAt(line), entry);
    return true;
  }

  /** Puts the bank back as it came. */
  restore(): void {
    this.cart.write(this.base, this.original);
    this.free = [];
    this.lent.clear();
    this.written.clear();
    this.placed.clear();
  }

  private entryAt(line: number): number {
    return this.base + this.section + 4 + line * 8;
  }
}
