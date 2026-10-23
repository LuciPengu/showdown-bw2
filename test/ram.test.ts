import { describe, expect, it } from 'vitest';
import { DsRam, findMainRam } from '../src/emu/ram';

/** A fake ROM: header with ARM9 at ROM 0x4000, loaded to 0x02004000. */
function fakeRom(): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom.set(new TextEncoder().encode('POKEMON B2\0\0IREO'), 0);
  const v = new DataView(rom.buffer);
  v.setUint32(0x20, 0x4000, true);
  v.setUint32(0x28, 0x02004000, true);
  for (let i = 0x4000; i < 0x8000; i++) rom[i] = (i * 7) & 0xff;
  return rom;
}

describe('findMainRam', () => {
  it('finds the header copy with ARM9 loaded behind it, not the ROM itself', () => {
    const rom = fakeRom();
    const heap = new Uint8Array(0xc00000);
    heap.set(rom, 0x10); // the ROM's own header, earlier in the heap
    const base = 0x400000;
    heap.set(rom.subarray(0x4000, 0x8000), base + 0x4000); // ARM9 at 0x02004000
    heap.set(rom.subarray(0, 0x170), base + 0x3ffe00); // header copy at 0x027FFE00
    expect(findMainRam(heap, rom)).toBe(base);
  });

  it('returns null when the game has no RAM in the heap yet', () => {
    const rom = fakeRom();
    const heap = new Uint8Array(0x100000);
    heap.set(rom, 0);
    expect(findMainRam(heap, rom)).toBeNull();
  });
});

describe('DsRam', () => {
  it('reads and writes little-endian by DS address, through mirrors', () => {
    const heap = new Uint8Array(0x500000);
    const ram = new DsRam(() => heap, 0x100);
    ram.write32(0x02000010, 0xdeadbeef);
    expect(heap[0x110]).toBe(0xef);
    expect(ram.read16(0x02000012)).toBe(0xdead);
    expect(ram.read32(0x02400010)).toBe(0xdeadbeef); // mirror
    expect(() => ram.read8(0x01ffffff)).toThrow(RangeError);
  });
});
