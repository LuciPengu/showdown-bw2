// Reading files out of a DS ROM: the file name table, the file allocation
// table, and the game's NARC archives. Enough to load species data.

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** A file's bytes by its path in the ROM's file system, like `a/0/1/6`. */
export function romFile(rom: Uint8Array, path: string): Uint8Array {
  const fat = u32(rom, 0x48);
  const fileId = romFileId(rom, path);
  return rom.subarray(u32(rom, fat + fileId * 8), u32(rom, fat + fileId * 8 + 4));
}

/** Where a file's start and end offsets are in the ROM's file allocation table. */
export function fatEntry(rom: Uint8Array, path: string): number {
  return u32(rom, 0x48) + romFileId(rom, path) * 8;
}

/** A file's number in the ROM's file system, by its path. */
export function romFileId(rom: Uint8Array, path: string): number {
  const fnt = u32(rom, 0x40);
  let dir = 0; // the root is directory 0xF000
  const parts = path.split('/');
  for (let p = 0; p < parts.length; p++) {
    const entry = fnt + dir * 8;
    let at = fnt + u32(rom, entry);
    let fileId = u16(rom, entry + 4);
    let found = false;
    for (;;) {
      const b = rom[at++];
      if (!b) break;
      const len = b & 0x7f;
      const name = String.fromCharCode(...rom.subarray(at, at + len));
      at += len;
      const isDir = (b & 0x80) !== 0;
      if (isDir) {
        const id = u16(rom, at) & 0x0fff;
        at += 2;
        if (name === parts[p] && p < parts.length - 1) {
          dir = id;
          found = true;
          break;
        }
      } else {
        if (name === parts[p] && p === parts.length - 1) return fileId;
        fileId++;
      }
    }
    if (!found) break;
  }
  throw new Error(`${path} isn't in the ROM`);
}

/** The files of a NARC archive. */
export function narcFiles(narc: Uint8Array): Uint8Array[] {
  if (String.fromCharCode(...narc.subarray(0, 4)) !== 'NARC') throw new Error('not a NARC archive');
  const btaf = u16(narc, 0x0c);
  const count = u16(narc, btaf + 8);
  const btnf = btaf + u32(narc, btaf + 4);
  const gmif = btnf + u32(narc, btnf + 4);
  const data = gmif + 8;
  const files: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const start = u32(narc, btaf + 12 + i * 8);
    const end = u32(narc, btaf + 16 + i * 8);
    files.push(narc.subarray(data + start, data + end));
  }
  return files;
}

/** What the party writer needs from a species' personal data (PKHeX PersonalInfo5B2W2). */
export interface Personal {
  baseHp: number;
  baseAtk: number;
  /** 0 always male, 254 always female, 255 genderless; otherwise female when the PID's low byte is below it. */
  genderRatio: number;
  growth: number;
  ability: number;
}

export type PersonalTable = (species: number, form: number) => Personal | null;

/** Loads Black 2 / White 2's personal data (a/0/1/6). Forms past 0 live after the species, from 0x1C. */
export function loadPersonal(rom: Uint8Array): PersonalTable {
  const files = narcFiles(romFile(rom, 'a/0/1/6'));
  const parse = (p: Uint8Array | undefined): Personal | null =>
    p && p.length >= 0x4c ? { baseHp: p[0], baseAtk: p[1], genderRatio: p[0x12], growth: p[0x15], ability: p[0x18] } : null;
  return (species, form) => {
    const base = files[species];
    if (!base) return null;
    const formStart = u16(base, 0x1c);
    if (form > 0 && formStart && form < base[0x20]) return parse(files[formStart + form - 1]) ?? parse(base);
    return parse(base);
  };
}

/** How many forms BW2 has of each species (personal data byte 0x20; 1 for most). */
export function loadFormCounts(rom: Uint8Array): (species: number) => number {
  const files = narcFiles(romFile(rom, 'a/0/1/6'));
  return (species) => {
    const base = files[species];
    return base && base.length > 0x20 ? Math.max(1, base[0x20]) : 1;
  };
}
