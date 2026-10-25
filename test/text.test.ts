import { describe, expect, it } from 'vitest';
import { Cart, type CartArchive, SCRATCH_BYTES } from '../src/emu/romimage';
import { LiveBank, crypt, encodeText, lineTable, readLine } from '../src/emu/text';

/** A bank as the game stores it: one section, lines one after another. */
function makeBank(lines: string[]): Uint8Array {
  const units = lines.map((l) => [...encodeText(l), 0xffff]);
  const section = 0x10;
  const table = 4 + lines.length * 8;
  const size = table + units.reduce((n, u) => n + u.length * 2, 0);
  const bank = new Uint8Array(section + size);
  const v = new DataView(bank.buffer);
  v.setUint16(0, 1, true);
  v.setUint16(2, lines.length, true);
  v.setUint32(4, size, true);
  v.setUint32(12, section, true);
  v.setUint32(section, size, true);
  let at = table;
  units.forEach((u, i) => {
    v.setUint32(section + 4 + i * 8, at, true);
    v.setUint16(section + 8 + i * 8, u.length, true);
    crypt(i, u).forEach((c, k) => v.setUint16(section + at + k * 2, c, true));
    at += u.length * 2;
  });
  return bank;
}

const text = (units: number[]) => String.fromCharCode(...units);

/** A cart whose ROM is a bank at 0x100, with one copy in a fake heap. */
function liveBank(lines: string[]) {
  const bank = makeBank(lines);
  const size = 0x100 + bank.length + SCRATCH_BYTES;
  const heap = new Uint8Array(size + 0x40);
  heap.set(bank, 0x40 + 0x100);
  const cart = new Cart(() => heap, [0x40], size);
  const archive = { fileRange: () => [0x100, 0x100 + bank.length] } as unknown as CartArchive;
  return { live: new LiveBank(cart, archive, 0), rom: () => cart.rom.slice(0x100, 0x100 + bank.length) };
}

describe('text banks', () => {
  it('reads lines as the game stores them', () => {
    const bank = makeBank(['Pound', 'Karate Chop', 'DoubleSlap']);
    expect(lineTable(bank).lines).toHaveLength(3);
    expect(text(readLine(bank, 1))).toBe('Karate Chop');
  });

  it('matches the key of a line from the ROM', () => {
    // Line 267 of bank 16 ("{NICK:0} used\nEarthquake!") starts with 0xF000 under key 0xC82A.
    expect(crypt(267, [0xf000])[0]).toBe(0xf000 ^ 0xc82a);
  });

  it('encodes placeholders and line breaks', () => {
    expect(encodeText('{nickname:0} used\nMoonblast!').slice(0, 5)).toEqual([0xf000, 0x0102, 1, 0, 0x20]);
    expect(encodeText('a\nb')).toEqual([0x61, 0xfffe, 0x62]);
  });

  it('rewrites a line in its own room, and puts the bank back', () => {
    const { live, rom } = liveBank(['Pound', 'Karate Chop', 'DoubleSlap']);
    const before = rom();
    expect(live.write(1, encodeText('Moonblast'))).toBe(true);
    expect(text(live.read(1))).toBe('Moonblast');
    expect(text(live.read(2))).toBe('DoubleSlap');
    live.restore();
    expect(rom()).toEqual(before);
  });

  it('puts a longer line in the room of lent lines next to each other', () => {
    const { live } = liveBank(['Pound', 'Cut', 'Bind', 'Slam', 'Earthquake']);
    expect(live.write(4, encodeText('Kowtow Cleave, a long name'))).toBe(false);
    live.lend([0, 1, 2, 3]);
    expect(live.write(4, encodeText('Kowtow Cleave, a long name'))).toBe(true);
    expect(text(live.read(4))).toBe('Kowtow Cleave, a long name');
  });

  it('keeps lines apart once their rooms are shared', () => {
    const { live } = liveBank(['Pound', 'Cut', 'Earthquake', 'Surf']);
    live.lend([0, 1]);
    expect(live.write(2, encodeText('Behemoth Bash'))).toBe(true);
    expect(live.write(3, encodeText('Moonblast'))).toBe(true);
    expect(text(live.read(2))).toBe('Behemoth Bash');
    expect(text(live.read(3))).toBe('Moonblast');
  });

  it('gives back the room a line took when it is written again', () => {
    const { live } = liveBank(['Pound', 'Cut', 'Bind', 'Multitype', 'Flower Gift']);
    live.lend([3, 4]);
    for (const name of ['Supreme Overlord', 'Orichalcum Pulse', 'Supersweet Syrup', 'Protosynthesis', 'Poison Puppeteer']) {
      expect(live.write(3, encodeText(name))).toBe(true);
      expect(text(live.read(3))).toBe(name);
    }
    expect(text(live.read(2))).toBe('Bind');
  });
});
