// A Pokémon's battle sprites as BW2 stores them (a/0/0/4, 20 files a species),
// made from 96×96 pictures: Showdown's Gen 5-style sprites for later Pokémon.
//
// For each of front and back, BW2 has a static picture (files 0/1, male and
// female) and an animated one: a 256×128 sheet of body parts (2/3), cells that
// cut the parts out (NCER, 4), their animations (NANR, 5), a multi-cell that
// puts the parts together (NMCR, 6) and its animation (NMAR, 7), and the quads
// BW2 draws each cell as (8). 18 and 19 are the normal and shiny palettes. Back
// sprites are 9–17 in the same order. BW2 draws its battle Pokémon in 3D: each
// cell is one or two textured quads, as file 8 lists them; the cells' OAMs are
// the same parts in 2D terms.
//
// A made sprite is one part, the whole picture, that breathes: it stretches
// up a little and back, from its feet. Its origin, where BW2 stands it, is
// under the middle of its feet, as BW2's own Pokémon have it.

import { lz11Compress, lz11Decompress } from './lz11';

export interface Picture {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: ArrayLike<number>;
}

export interface SpritePictures {
  front: Picture;
  back: Picture;
  frontShiny: Picture | null;
  backShiny: Picture | null;
}

const SIZE = 96;
const SHEET_W = 256;
const SHEET_H = 128;
/** The static picture's tiles come in four sprite-sized blocks: x, y, width and height in tiles. */
const STATIC_BLOCKS = [
  [0, 0, 8, 8],
  [8, 0, 4, 8],
  [0, 8, 8, 4],
  [8, 8, 4, 4],
] as const;
/** The four OAMs the whole picture is cut into: x, y, OAM shape and size (64×64, 32×64, 64×32, 32×32). */
const OAMS = [
  [0, 0, 0, 3],
  [64, 0, 2, 3],
  [0, 64, 1, 3],
  [64, 64, 0, 2],
] as const;
const OAM_SIZE: Record<string, [number, number]> = { '0,3': [64, 64], '2,3': [32, 64], '1,3': [64, 32], '0,2': [32, 32] };

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** A Nitro file: its magic (as named, e.g. NCER), version, and blocks. */
function nitroFile(magic: string, version: number, blocks: [string, Uint8Array][]): Uint8Array {
  const size = 0x10 + blocks.reduce((n, [, d]) => n + 8 + d.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const reversed = (m: string) => [...m].reverse().map((c) => c.charCodeAt(0));
  out.set(reversed(magic), 0);
  v.setUint16(4, 0xfeff, true);
  v.setUint16(6, version, true);
  v.setUint32(8, size, true);
  v.setUint16(12, 0x10, true);
  v.setUint16(14, blocks.length, true);
  let at = 0x10;
  for (const [name, data] of blocks) {
    out.set(reversed(name), at);
    v.setUint32(at + 4, 8 + data.length, true);
    out.set(data, at + 8);
    at += 8 + data.length;
  }
  return out;
}

/** The data of a Nitro file's block, by name (e.g. CHAR). */
function block(file: Uint8Array, name: string): { at: number; size: number } {
  const want = [...name].reverse().join('');
  let at = u16(file, 12);
  for (let i = 0; i < u16(file, 14); i++) {
    const magic = String.fromCharCode(...file.subarray(at, at + 4));
    const size = u32(file, at + 4);
    if (magic === want) return { at: at + 8, size: size - 8 };
    at += size;
  }
  throw new Error(`no ${name} block`);
}

class Writer {
  private bytes: number[] = [];
  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }
  get length(): number {
    return this.bytes.length;
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** BGR555, as the DS stores colours. */
const bgr555 = (r: number, g: number, b: number) => (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);

/** Palette indexes for two pictures that share one palette of 15 colours (0 is see-through). */
export interface Indexed {
  colors: [number, number, number][];
  front: Uint8Array;
  back: Uint8Array;
}

const opaque = (p: Picture, i: number) => p.data[i * 4 + 3] >= 128;
const rgbAt = (p: Picture, i: number): [number, number, number] => [p.data[i * 4], p.data[i * 4 + 1], p.data[i * 4 + 2]];
const key = ([r, g, b]: [number, number, number]) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/**
 * Puts a picture on a 96×96 canvas, bottom-centred (Showdown's sprites are
 * 96×96 already; a few are bigger), as palette-ready RGBA.
 */
function fit(p: Picture): Picture {
  if (p.width === SIZE && p.height === SIZE) return p;
  const data = new Uint8Array(SIZE * SIZE * 4);
  const dx = Math.floor((SIZE - p.width) / 2);
  const dy = SIZE - p.height;
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) continue;
      for (let c = 0; c < 4; c++) data[(ty * SIZE + tx) * 4 + c] = p.data[(y * p.width + x) * 4 + c];
    }
  }
  return { width: SIZE, height: SIZE, data };
}

/**
 * Indexes the front and back pictures with one palette of at most 15 colours
 * (index 0 is see-through): their own colours if they have that few, else the
 * most used, with each other colour mapped to the nearest.
 */
export function indexPictures(frontIn: Picture, backIn: Picture): Indexed {
  const front = fit(frontIn);
  const back = fit(backIn);
  const counts = new Map<number, { rgb: [number, number, number]; n: number }>();
  for (const p of [front, back]) {
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (!opaque(p, i)) continue;
      const rgb = rgbAt(p, i);
      const k = key(rgb);
      const c = counts.get(k);
      if (c) c.n++;
      else counts.set(k, { rgb, n: 1 });
    }
  }
  const colors = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 15).map((c) => c.rgb);
  const nearest = new Map<number, number>();
  const index = (rgb: [number, number, number]) => {
    const k = key(rgb);
    let i = nearest.get(k);
    if (i === undefined) {
      let best = Infinity;
      i = 1;
      colors.forEach((c, n) => {
        const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
        if (d < best) {
          best = d;
          i = n + 1;
        }
      });
      nearest.set(k, i);
    }
    return i;
  };
  const indexed = (p: Picture) => {
    const out = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) out[i] = opaque(p, i) ? index(rgbAt(p, i)) : 0;
    return out;
  };
  return { colors, front: indexed(front), back: indexed(back) };
}

/**
 * The shiny palette: for each index, the colour the shiny pictures most often
 * have where the normal ones have that index. Without shiny pictures, the
 * normal palette.
 */
export function shinyColors(indexed: Indexed, frontShiny: Picture | null, backShiny: Picture | null): [number, number, number][] {
  const votes = indexed.colors.map(() => new Map<number, { rgb: [number, number, number]; n: number }>());
  const vote = (pixels: Uint8Array, shinyIn: Picture | null) => {
    if (!shinyIn) return;
    const shiny = fit(shinyIn);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const index = pixels[i];
      if (!index || !opaque(shiny, i)) continue;
      const rgb = rgbAt(shiny, i);
      const k = key(rgb);
      const v = votes[index - 1].get(k);
      if (v) v.n++;
      else votes[index - 1].set(k, { rgb, n: 1 });
    }
  };
  vote(indexed.front, frontShiny);
  vote(indexed.back, backShiny);
  return indexed.colors.map((c, i) => [...votes[i].values()].sort((a, b) => b.n - a.n)[0]?.rgb ?? c);
}

/** A palette file (NCLR) like `template`, with these colours after see-through index 0. */
export function paletteFile(template: Uint8Array, colors: [number, number, number][]): Uint8Array {
  const out = template.slice();
  const pltt = block(out, 'PLTT');
  const dataAt = pltt.at + u32(out, pltt.at + 12);
  const v = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) {
    const c = colors[i - 1];
    v.setUint16(dataAt + i * 2, i === 0 ? u16(template, dataAt) : c ? bgr555(...c) : 0, true);
  }
  return out;
}

/** 4bpp pixel data: two pixels a byte, the first in the low nibble. */
function pack4(indexes: number[]): Uint8Array {
  const out = new Uint8Array(indexes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (indexes[i * 2] & 0xf) | ((indexes[i * 2 + 1] & 0xf) << 4);
  return out;
}

/** A static picture's NCGR like `template`, with `pixels` (96×96 indexes) in its tile order. */
export function staticFile(template: Uint8Array, pixels: Uint8Array): Uint8Array {
  const order: number[] = [];
  for (const [bx, by, tw, th] of STATIC_BLOCKS) {
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        for (let r = 0; r < 64; r++) order.push(pixels[((by + ty) * 8 + (r >> 3)) * SIZE + (bx + tx) * 8 + (r & 7)]);
      }
    }
  }
  return withCharData(template, pack4(order));
}

/** A parts sheet's NCGR like `template` (256×128, row by row), with the picture at its top left. */
export function sheetFile(template: Uint8Array, pixels: Uint8Array): Uint8Array {
  const sheet = new Array<number>(SHEET_W * SHEET_H).fill(0);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) sheet[y * SHEET_W + x] = pixels[y * SIZE + x];
  return withCharData(template, pack4(sheet));
}

function withCharData(template: Uint8Array, data: Uint8Array): Uint8Array {
  const out = template.slice();
  const char = block(out, 'CHAR');
  const at = char.at + u32(out, char.at + 20);
  if (u32(out, char.at + 16) !== data.length) throw new Error(`the sheet holds ${u32(out, char.at + 16)} bytes, not ${data.length}`);
  out.set(data, at);
  return out;
}

/** Where a picture stands (under the middle of its opaque pixels, one row below the lowest), and their size. */
export function origin(pixels: Uint8Array): { x: number; y: number; width: number; height: number } {
  let minX = SIZE;
  let maxX = -1;
  let minY = SIZE;
  let maxY = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!pixels[y * SIZE + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return { x: SIZE / 2, y: SIZE, width: 0, height: 0 };
  return { x: Math.round((minX + maxX + 1) / 2), y: maxY + 1, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Cells (NCER) for the sheet: one, the whole picture in four OAMs around `at` (the origin). */
export function cellsFile(at: { x: number; y: number }, extra: [string, Uint8Array][] = []): Uint8Array {
  const n = 1;
  const w = new Writer();
  w.u16(n).u16(0).u32(0x18).u32(4).u32(0).u32(0).u32(0);
  // Cell 0's bounding radius, in 4s: to the farthest corner of the picture.
  const far = Math.hypot(Math.max(at.x, SIZE - at.x), Math.max(at.y, SIZE - at.y));
  w.u16(OAMS.length).u16(Math.min(0x3f, Math.ceil(far / 4))).u32(0);
  for (let i = 1; i < n; i++) w.u16(0).u16(0).u32(OAMS.length * 6);
  for (const [x, y, shape, size] of OAMS) {
    // Affine and double-size, as BW2's own: the box is twice the size, centred on the picture.
    const [ow, oh] = OAM_SIZE[`${shape},${size}`];
    const ox = x - at.x - ow / 2;
    const oy = y - at.y - oh / 2;
    const tile = (y / 8) * (SHEET_W / 8) + x / 8;
    w.u16((oy & 0xff) | 0x300 | (shape << 14));
    w.u16((ox & 0x1ff) | (size << 14));
    w.u16(tile);
  }
  while (w.length % 4) w.u8(0);
  return nitroFile('NCER', 0x0100, [['CEBK', w.done()], ...extra]);
}

/**
 * The quads BW2 draws the cells as (file 8): the Pokémon's size and an
 * offset, then per cell two quads of x, y (1/256 pixels, from the origin, up
 * is positive), width, height, and where in the sheet (1/4096 pixels). One
 * cell, one quad: the whole picture.
 */
export function quadsFile(at: { x: number; y: number; width: number; height: number }): Uint8Array {
  const w = new Writer();
  w.u32(1).u16(at.width).u16(at.height).u16(0).u16(0);
  w.u32(-at.x * 256).u32(at.y * 256).u32(SIZE * 4096).u32(SIZE * 4096).u32(0).u32(0);
  for (let i = 0; i < 6; i++) w.u32(0);
  w.u32(0);
  return w.done();
}

/** Breathing: the picture's height over one cycle, as a scale (1 is as drawn), with each frame's length. */
const BREATH = [1, 1.01, 1.02, 1.03, 1.035, 1.03, 1.02, 1.01];
const BREATH_FRAME = 6;

/** Cell animation (NANR): one sequence, cell 0 breathing (scale and rotation about its origin). */
export function cellAnimationFile(extra: [string, Uint8Array][] = []): Uint8Array {
  const frames = BREATH.length;
  const seqAt = 0x18;
  const frameAt = seqAt + 16;
  const dataAt = frameAt + frames * 8;
  const w = new Writer();
  w.u16(1).u16(frames).u32(seqAt).u32(frameAt).u32(dataAt).u32(0).u32(0);
  w.u16(frames).u16(0).u32(0x00010001).u32(2).u32(0); // SRT frames of a cell, looping
  for (let i = 0; i < frames; i++) w.u32(i * 16).u16(BREATH_FRAME).u16(0xbeef);
  for (const sy of BREATH) {
    const sx = 1 - (sy - 1) / 2;
    w.u16(0).u16(0).u32(Math.round(sx * 4096)).u32(Math.round(sy * 4096)).u16(0).u16(0);
  }
  return nitroFile('NANR', 0x0100, [['ABNK', w.done()], ...extra]);
}

/** Multi-cell (NMCR): one, with one node playing sequence 0 at the origin. */
export function multiCellFile(): Uint8Array {
  const w = new Writer();
  w.u16(1).u16(0xbeef).u32(0x14).u32(0x1c).u32(0).u32(0);
  w.u16(1).u16(1).u32(0);
  w.u16(0).u16(0).u16(0).u16(0x0020);
  return nitroFile('NMCR', 0x0100, [['MCBK', w.done()]]);
}

/** Multi-cell animation (NMAR): one sequence showing multi-cell 0, looping. */
export function multiCellAnimationFile(): Uint8Array {
  const w = new Writer();
  w.u16(1).u16(1).u32(0x18).u32(0x28).u32(0x30).u32(0).u32(0);
  w.u16(1).u16(0).u32(0x00020000).u32(2).u32(0);
  w.u32(0).u16(BREATH.length * BREATH_FRAME).u16(0xbeef);
  w.u16(0).u16(0);
  return nitroFile('NMAR', 0x0100, [['ABNK', w.done()]]);
}

/** A block of `file` to carry over into a made one, if it has it (the user extension, UEXT). */
function carried(file: Uint8Array, name: string): [string, Uint8Array][] {
  try {
    const b = block(file, name);
    return [[name, file.slice(b.at, b.at + b.size)]];
  } catch {
    return [];
  }
}

/** A file as stored, from its stored form and contents: compressed again if it came compressed. */
const store = (stored: Uint8Array, contents: Uint8Array) => (stored[0] === 0x11 ? lz11Compress(contents) : contents);
const contents = (stored: Uint8Array) => (stored[0] === 0x11 ? lz11Decompress(stored) : stored);

/**
 * A species' 20 sprite files made from `pictures`, with `donor`'s (as stored)
 * as templates: headers, per-cell data, and which files are compressed.
 */
export function spriteFiles(pictures: SpritePictures, donor: Uint8Array[]): Uint8Array[] {
  const indexed = indexPictures(pictures.front, pictures.back);
  const shiny = shinyColors(indexed, pictures.frontShiny, pictures.backShiny);
  const out = donor.slice();
  for (const [first, pixels] of [
    [0, indexed.front],
    [9, indexed.back],
  ] as const) {
    const at = origin(pixels);
    const cells = contents(donor[first + 4]);
    const anims = contents(donor[first + 5]);
    const still = staticFile(contents(donor[first]), pixels);
    const sheet = sheetFile(contents(donor[first + 2]), pixels);
    out[first] = store(donor[first], still);
    out[first + 2] = store(donor[first + 2], sheet);
    // A species that looks the same either way has no female files; one that doesn't gets the same picture.
    if (donor[first + 1].length) out[first + 1] = store(donor[first + 1], still);
    if (donor[first + 3].length) out[first + 3] = store(donor[first + 3], sheet);
    out[first + 4] = store(donor[first + 4], cellsFile(at, carried(cells, 'UEXT')));
    out[first + 5] = store(donor[first + 5], cellAnimationFile(carried(anims, 'UEXT')));
    out[first + 6] = store(donor[first + 6], multiCellFile());
    out[first + 7] = store(donor[first + 7], multiCellAnimationFile());
    out[first + 8] = store(donor[first + 8], quadsFile(at));
  }
  out[18] = store(donor[18], paletteFile(contents(donor[18]), indexed.colors));
  out[19] = store(donor[19], paletteFile(contents(donor[19]), shiny));
  return out;
}
