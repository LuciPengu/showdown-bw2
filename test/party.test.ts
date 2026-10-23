import { describe, expect, it } from 'vitest';
import { buildPk5, expForLevel, hpInvestment } from '../src/emu/party';
import { loadPersonal, narcFiles, romFile } from '../src/emu/rom';
import type { MonSpec } from '../src/emu/scene';

const chomp: MonSpec = { species: 445, form: 0, level: 50, gender: 'F', shiny: false, nickname: 'Chompy', hp: 150, maxHp: 183, status: 'brn' };
const personal = { baseHp: 108, genderRatio: 127, growth: 5, ability: 8 };

describe('buildPk5', () => {
  const b = buildPk5(chomp, personal);
  const v = new DataView(b.buffer);
  const pid = v.getUint32(0, true);

  it('is stored plainly, in natural block order', () => {
    expect(b.length).toBe(0xdc);
    expect(v.getUint16(4, true)).toBe(0x0003); // already decrypted
    expect((pid >>> 13) & 31).toBe(0); // shuffle value 0: blocks A, B, C, D
    let sum = 0;
    for (let at = 8; at < 0x88; at += 2) sum = (sum + v.getUint16(at, true)) & 0xffff;
    expect(v.getUint16(6, true)).toBe(sum);
  });

  it('holds the species, level, EXP, HP, status and nickname', () => {
    expect(v.getUint16(0x08, true)).toBe(445);
    expect(v.getUint32(0x10, true)).toBe(expForLevel(5, 50));
    expect(b[0x8c]).toBe(50);
    expect(v.getUint16(0x8e, true)).toBe(150);
    expect(v.getUint16(0x90, true)).toBe(183);
    expect(v.getUint32(0x88, true)).toBe(1 << 4); // burned
    const name = String.fromCharCode(...[0, 1, 2, 3, 4, 5].map((i) => v.getUint16(0x48 + i * 2, true)));
    expect(name).toBe('Chompy');
    expect(v.getUint16(0x48 + 12, true)).toBe(0xffff);
  });

  it('derives gender from the PID and shininess from the IDs', () => {
    expect(pid & 0xff).toBeLessThan(personal.genderRatio); // female
    expect(buildPk5({ ...chomp, gender: 'M' }, personal)[0]).toBeGreaterThanOrEqual(personal.genderRatio); // male
    const xor = (b: Uint8Array) => {
      const d = new DataView(b.buffer);
      const p = d.getUint32(0, true);
      return d.getUint16(0x0c, true) ^ d.getUint16(0x0e, true) ^ (p >>> 16) ^ (p & 0xffff);
    };
    expect(xor(b)).toBeGreaterThanOrEqual(8);
    expect(xor(buildPk5({ ...chomp, shiny: true }, personal))).toBeLessThan(8);
  });

  it('writes the form into block B', () => {
    const rotom = buildPk5({ ...chomp, species: 479, form: 2, gender: null }, { baseHp: 50, genderRatio: 255, growth: 0, ability: 26 });
    expect(rotom[0x40] >> 3).toBe(2);
    expect((rotom[0x40] >> 1) & 3).toBe(2); // genderless
  });
});

describe('hpInvestment', () => {
  it('lets the game’s formula land on Showdown’s max HP', () => {
    // Ferrothorn (base 74) at Lv 50: 149 with no EVs, 160 with 84
    expect(hpInvestment(74, 50, 149)).toEqual({ iv: 31, ev: 0 });
    expect(hpInvestment(74, 50, 160)).toEqual({ iv: 31, ev: 84 });
    // Garchomp (108) at Lv 50, 183: 31 IVs and 4 EVs short of max
    const { iv, ev } = hpInvestment(108, 50, 183);
    expect(Math.floor(((2 * 108 + iv + Math.floor(ev / 4)) * 50) / 100) + 60).toBe(183);
  });

  it('stores it in the record', () => {
    const b = buildPk5({ ...chomp, maxHp: 183 }, personal);
    const { iv, ev } = hpInvestment(108, 50, 183);
    expect(b[0x18]).toBe(ev);
    expect(new DataView(b.buffer).getUint32(0x38, true) & 0x1f).toBe(iv);
  });
});

describe('expForLevel', () => {
  it('matches PKHeX’s tables', () => {
    const at10 = [1000, 1800, 540, 560, 800, 1250];
    const at100 = [1_000_000, 600_000, 1_640_000, 1_059_860, 800_000, 1_250_000];
    for (let g = 0; g < 6; g++) {
      expect(expForLevel(g, 1)).toBe(0);
      expect(expForLevel(g, 10)).toBe(at10[g]);
      expect(expForLevel(g, 100)).toBe(at100[g]);
    }
  });
});

/** A tiny DS image holding `a/0/1/6` as a NARC of personal records. */
function fakeRom(personalFiles: Uint8Array[]): Uint8Array {
  // NARC
  const fatb = 12 + personalFiles.length * 8;
  const total = personalFiles.reduce((n, f) => n + f.length, 0);
  const narc = new Uint8Array(0x10 + fatb + 8 + 8 + total);
  const nv = new DataView(narc.buffer);
  narc.set([0x4e, 0x41, 0x52, 0x43]);
  nv.setUint16(0x0c, 0x10, true);
  narc.set([0x42, 0x54, 0x41, 0x46], 0x10);
  nv.setUint32(0x14, fatb, true);
  nv.setUint16(0x18, personalFiles.length, true);
  let off = 0;
  personalFiles.forEach((f, i) => {
    nv.setUint32(0x1c + i * 8, off, true);
    nv.setUint32(0x20 + i * 8, off + f.length, true);
    off += f.length;
  });
  const btnf = 0x10 + fatb;
  nv.setUint32(btnf + 4, 8, true);
  const gmif = btnf + 8;
  let at = gmif + 8;
  for (const f of personalFiles) {
    narc.set(f, at);
    at += f.length;
  }
  // ROM: FNT with dirs root -> a -> 0 -> 1 holding files "5" and "6".
  const rom = new Uint8Array(0x1000 + narc.length);
  const rv = new DataView(rom.buffer);
  const fnt = 0x200;
  const fat = 0x400;
  rv.setUint32(0x40, fnt, true);
  rv.setUint32(0x48, fat, true);
  const subs: number[][] = [
    [0x81, 0x61, 0x01, 0xf0], // root: dir "a" -> 1
    [0x81, 0x30, 0x02, 0xf0], // a: dir "0" -> 2
    [0x81, 0x31, 0x03, 0xf0], // 0: dir "1" -> 3
    [0x01, 0x35, 0x01, 0x36], // 1: files "5", "6"
  ];
  let sub = fnt + subs.length * 8;
  subs.forEach((s, i) => {
    rv.setUint32(fnt + i * 8, sub - fnt, true);
    rv.setUint16(fnt + i * 8 + 4, i === 3 ? 7 : 0, true);
    rom.set([...s, 0], sub);
    sub += s.length + 1;
  });
  rv.setUint32(fat + 8 * 8, 0x1000, true); // file 8 is "6"
  rv.setUint32(fat + 8 * 8 + 4, 0x1000 + narc.length, true);
  rom.set(narc, 0x1000);
  return rom;
}

describe('ROM files', () => {
  const record = (hp: number, ratio: number, formStart = 0, forms = 1) => {
    const p = new Uint8Array(0x4c);
    p[0] = hp;
    p[1] = hp + 1;
    p[0x12] = ratio;
    p[0x15] = 3;
    p[0x18] = 7;
    new DataView(p.buffer).setUint16(0x1c, formStart, true);
    p[0x20] = forms;
    return p;
  };

  it('finds a file by path and splits a NARC', () => {
    const files = [record(1, 0), record(50, 127, 3, 2), record(60, 31), record(99, 255)];
    const rom = fakeRom(files);
    expect(narcFiles(romFile(rom, 'a/0/1/6')).map((f) => f[0])).toEqual([1, 50, 60, 99]);
    expect(() => romFile(rom, 'a/0/1/7')).toThrow(/isn't in the ROM/);
  });

  it('looks forms up after their species', () => {
    const personal = loadPersonal(fakeRom([record(1, 0), record(50, 127, 3, 2), record(60, 31), record(99, 255)]));
    expect(personal(1, 0)).toMatchObject({ baseHp: 50, genderRatio: 127, growth: 3, ability: 7 });
    expect(personal(1, 1)).toMatchObject({ baseHp: 99, genderRatio: 255 });
    expect(personal(9, 0)).toBeNull();
  });
});
