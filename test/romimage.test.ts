import { describe, expect, it } from 'vitest';
import { DsRam, MAIN_RAM } from '../src/emu/ram';
import { fatEntry, romFile } from '../src/emu/rom';
import { Cart, SCRATCH_BYTES, findRomCopies, romProbe, stretchInRam, withScratch } from '../src/emu/romimage';

/** A NARC holding `files`. */
function narc(files: Uint8Array[]): Uint8Array {
  const btaf = 0x10;
  const btnf = btaf + 12 + files.length * 8;
  const gmif = btnf + 16;
  const size = gmif + 8 + files.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set([0x4e, 0x41, 0x52, 0x43]);
  v.setUint16(0x0c, btaf, true);
  v.setUint32(btaf + 4, btnf - btaf, true);
  v.setUint16(btaf + 8, files.length, true);
  v.setUint32(btnf + 4, gmif - btnf, true);
  let at = 0;
  files.forEach((f, i) => {
    v.setUint32(btaf + 12 + i * 8, at, true);
    v.setUint32(btaf + 16 + i * 8, at + f.length, true);
    out.set(f, gmif + 8 + at);
    at += f.length;
  });
  return out;
}

/** A ROM whose file system has `a/0/0/4` (a NARC) and `b`, with the FAT at 0x200 and the FNT at 0x100. */
function makeRom(): Uint8Array {
  const sprites = narc([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])]);
  const other = new Uint8Array([9, 9, 9, 9]);
  const rom = new Uint8Array(0x1000 + sprites.length + other.length);
  const v = new DataView(rom.buffer);
  rom.set(new TextEncoder().encode('POKEMON B2\0\0IREO'), 0);
  // FNT: root (dir 0) holds "a"/ and "b"; a holds 0/, 0 holds 0/, that 0 holds "4".
  const fnt = 0x100;
  v.setUint32(0x40, fnt, true);
  v.setUint32(0x48, 0x200, true);
  v.setUint32(0x4c, 16, true);
  const dirs: [entries: number[], firstFile: number][] = [
    [[0x81, 0x61, 0x01, 0xf0, 0x01, 0x62, 0], 1], // a/ (dir 1), b (file 1)
    [[0x81, 0x30, 0x02, 0xf0, 0], 0], // 0/ (dir 2)
    [[0x81, 0x30, 0x03, 0xf0, 0], 0], // 0/ (dir 3)
    [[0x01, 0x34, 0], 0], // 4 (file 0)
  ];
  let at = fnt + dirs.length * 8;
  dirs.forEach(([entries, firstFile], d) => {
    v.setUint32(fnt + d * 8, at - fnt, true);
    v.setUint16(fnt + d * 8 + 4, firstFile, true);
    rom.set(entries, at);
    at += entries.length;
  });
  v.setUint32(0x200, 0x1000, true);
  v.setUint32(0x204, 0x1000 + sprites.length, true);
  v.setUint32(0x208, 0x1000 + sprites.length, true);
  v.setUint32(0x20c, rom.length, true);
  rom.set(sprites, 0x1000);
  rom.set(other, 0x1000 + sprites.length);
  return rom;
}

describe('the cart while the game runs', () => {
  it('finds the copies of the ROM in the heap, not main RAM', () => {
    const rom = makeRom();
    const heap = new Uint8Array(0x10000);
    heap.set(rom, 0x2000);
    heap.set(rom.subarray(0, 0x100), 0x8000); // a header alone, as main RAM has
    expect(findRomCopies(heap, romProbe(rom))).toEqual([0x2000]);
  });

  it('adds room at the end and stretches the sprite archive over it', () => {
    const rom = makeRom();
    const out = new Uint8Array(withScratch(rom.buffer as ArrayBuffer));
    expect(out.length).toBe(rom.length + SCRATCH_BYTES);
    const v = new DataView(out.buffer);
    expect(v.getUint32(fatEntry(out, 'a/0/0/4') + 4, true)).toBe(out.length);
    expect([...romFile(out, 'b')]).toEqual([9, 9, 9, 9]);
  });

  it('replaces files in place, or in the room at the end, in every copy', () => {
    const rom = new Uint8Array(withScratch(makeRom().buffer as ArrayBuffer));
    const heap = new Uint8Array(rom.length * 2 + 0x100);
    heap.set(rom, 0);
    heap.set(rom, rom.length + 0x100);
    const cart = new Cart(() => heap, [0, rom.length + 0x100], rom.length);
    const sprites = cart.archive('a/0/0/4');
    sprites.replace(1, new Uint8Array([7]));
    expect([...sprites.file(1)]).toEqual([7]);
    sprites.replace(0, new Uint8Array([8, 8, 8, 8, 8, 8, 8, 8]));
    expect([...sprites.file(0)]).toEqual([8, 8, 8, 8, 8, 8, 8, 8]);
    expect(sprites.fileRange(0)[0]).toBeGreaterThanOrEqual(rom.length - SCRATCH_BYTES);
    const second = heap.subarray(rom.length + 0x100);
    expect(second.every((b, i) => b === heap[i])).toBe(true);
  });

  it("stretches the archive in RAM's file table and in files the game holds open", () => {
    const rom = new Uint8Array(withScratch(makeRom().buffer as ArrayBuffer));
    const heap = new Uint8Array(rom.length + 0x400000);
    heap.set(rom, 0x400000);
    const cart = new Cart(() => heap, [0x400000], rom.length);
    const ram = new DsRam(() => heap, 0);
    const original = makeRom();
    const fat = original.subarray(0x200, 0x210);
    heap.set(fat, 0x1000); // the game's copy of the table, from before the room was added
    const open = new Uint8Array(new Uint32Array([0, 0x1000, 0x1000 + 100]).buffer); // file 0, start, end
    heap.set(open, 0x2000);
    expect(stretchInRam(ram, cart)).toBe(true);
    expect(ram.read32(MAIN_RAM + 0x1004)).toBe(rom.length);
    expect(ram.read32(MAIN_RAM + 0x2008)).toBe(rom.length);
    expect(ram.read32(MAIN_RAM + 0x100c)).toBe(original.length); // b is left alone
  });
});
