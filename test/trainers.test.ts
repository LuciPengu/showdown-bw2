import { describe, expect, it } from 'vitest';
import { encodeStrBuf } from '../src/emu/trainers';

describe('trainer names', () => {
  it('packs a name as a StrBuf: capacity, length, magic, characters, terminator', () => {
    const b = encodeStrBuf('Kath', 6);
    const v = new DataView(b.buffer);
    expect(b.length).toBe(8 + 12);
    expect([v.getUint16(0, true), v.getUint16(2, true), v.getUint32(4, true)]).toEqual([6, 4, 0xb6f8d2ec]);
    expect([0, 1, 2, 3, 4].map((i) => v.getUint16(8 + 2 * i, true))).toEqual([0x4b, 0x61, 0x74, 0x68, 0xffff]);
  });

  it('keeps as many characters as fit before the terminator', () => {
    const v = new DataView(encodeStrBuf('MajesticKath', 6).buffer);
    expect(v.getUint16(2, true)).toBe(5);
    expect(v.getUint16(8 + 2 * 5, true)).toBe(0xffff);
  });
});
