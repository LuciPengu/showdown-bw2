import { describe, expect, it } from 'vitest';
import { lz11Compress, lz11Decompress } from '../src/emu/lz11';
import { type Picture, cellsFile, indexPictures, origin, quadsFile, sheetFile, shinyColors, staticFile } from '../src/emu/pokegra';

/** A 96×96 picture: a `w`×`h` box of `rgb` with its bottom-left corner at (x, y). */
function box(x: number, y: number, w: number, h: number, rgb: [number, number, number]): Picture {
  const data = new Uint8Array(96 * 96 * 4);
  for (let yy = y - h + 1; yy <= y; yy++) {
    for (let xx = x; xx < x + w; xx++) data.set([...rgb, 255], (yy * 96 + xx) * 4);
  }
  return { width: 96, height: 96, data };
}

/** An NCGR with one CHAR block of `size` bytes, as BW2's sprite files have. */
function ncgr(size: number): Uint8Array {
  const file = new Uint8Array(0x10 + 0x20 + size);
  const v = new DataView(file.buffer);
  file.set([0x52, 0x47, 0x43, 0x4e]);
  v.setUint16(12, 0x10, true);
  v.setUint16(14, 1, true);
  file.set([0x52, 0x41, 0x48, 0x43], 0x10);
  v.setUint32(0x14, 0x20 + size, true);
  v.setUint32(0x18 + 16, size, true);
  v.setUint32(0x18 + 20, 0x18, true);
  return file;
}

describe('LZ11', () => {
  it('gives back what it compressed', () => {
    const data = new Uint8Array(20000);
    for (let i = 0; i < data.length; i++) data[i] = i % 700 < 300 ? (i * 7) & 0xff : i % 3;
    const packed = lz11Compress(data);
    expect(packed.length).toBeLessThan(data.length / 2);
    expect(lz11Decompress(packed)).toEqual(data);
  });

  it('reaches at least two bytes back', () => {
    const data = new Uint8Array(64).fill(5);
    expect(lz11Decompress(lz11Compress(data))).toEqual(data);
  });
});

describe('sprites from pictures', () => {
  it('indexes front and back with one palette, and finds the shiny colours', () => {
    const front = box(30, 70, 20, 30, [200, 40, 40]);
    const back = box(30, 90, 20, 10, [40, 40, 200]);
    const indexed = indexPictures(front, back);
    expect(indexed.colors).toHaveLength(2);
    const red = indexed.front[70 * 96 + 30];
    expect(indexed.colors[red - 1]).toEqual([200, 40, 40]);
    expect(indexed.front[0]).toBe(0);
    const shiny = shinyColors(indexed, box(30, 70, 20, 30, [250, 200, 0]), null);
    expect(shiny[red - 1]).toEqual([250, 200, 0]);
    expect(shiny[indexed.back[90 * 96 + 30] - 1]).toEqual([40, 40, 200]);
  });

  it('stands a picture under the middle of its feet', () => {
    const { front } = indexPictures(box(30, 70, 20, 30, [1, 2, 3]), box(0, 95, 1, 1, [1, 2, 3]));
    expect(origin(front)).toEqual({ x: 40, y: 71, width: 20, height: 30 });
  });

  it('lays the static picture out in its four blocks', () => {
    const pixels = new Uint8Array(96 * 96);
    pixels[0] = 1; // top-left: block 0, first pixel
    pixels[64] = 2; // x 64: block 1's first pixel
    pixels[64 * 96] = 3; // y 64: block 2's first pixel
    pixels[64 * 96 + 64] = 4; // block 3's first pixel
    const file = staticFile(ncgr(96 * 48), pixels);
    const data = file.subarray(0x30);
    expect(data[0]).toBe(1);
    expect(data[64 * 32]).toBe(2);
    expect(data[(64 + 32) * 32]).toBe(3);
    expect(data[(64 + 32 + 32) * 32]).toBe(4);
  });

  it('puts the picture at the top left of the parts sheet, row by row', () => {
    const pixels = new Uint8Array(96 * 96);
    pixels[95 * 96 + 95] = 7;
    const data = sheetFile(ncgr(256 * 64), pixels).subarray(0x30);
    expect(data[(95 * 256 + 95) >> 1] >> 4).toBe(7);
  });

  it('cuts the picture into four double-size affine OAMs around its origin', () => {
    const file = cellsFile({ x: 40, y: 71 });
    const v = new DataView(file.buffer);
    const cebk = 0x18;
    expect(v.getUint16(cebk, true)).toBe(1);
    const cells = cebk + 0x18;
    expect(v.getUint16(cells, true)).toBe(4);
    const oam = cells + 8;
    const y = (v.getUint16(oam, true) << 24) >> 24;
    const x = ((v.getUint16(oam + 2, true) & 0x1ff) << 23) >> 23;
    // The 64×64 OAM's picture starts at (0, 0), so its box is 32 further out, around the origin.
    expect([x, y]).toEqual([0 - 40 - 32, 0 - 71 - 32]);
    expect(v.getUint16(oam, true) & 0x300).toBe(0x300);
    expect(v.getUint16(oam + 6 * 3 + 4, true)).toBe(8 * 32 + 8); // the 32×32 block's first tile
  });

  it('lists one quad, the whole picture, as BW2 draws the cell', () => {
    const v = new DataView(quadsFile({ x: 40, y: 71, width: 20, height: 30 }).buffer);
    expect(v.byteLength).toBe(16 + 48);
    expect([v.getUint32(0, true), v.getUint16(4, true), v.getUint16(6, true)]).toEqual([1, 20, 30]);
    expect([v.getInt32(12, true) / 256, v.getInt32(16, true) / 256, v.getInt32(20, true) / 4096, v.getInt32(24, true) / 4096]).toEqual([-40, 71, 96, 96]);
  });
});
