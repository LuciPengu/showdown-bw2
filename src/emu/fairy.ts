// The Fairy type, which BW2 doesn't have (type 17 here): its label in the
// Fight menu, and the colour of its moves' tiles.
//
// The Fight menu draws a move's type label from a/0/8/2 (labels from file 34,
// one per type), in one of three palettes (file 33) that sTypeIconPalettes
// picks by type. After the 17 types come the contest labels, so type 17 shows
// "COOL", which battles never use: it becomes FAIRY, in two pinks put into
// palette 2's unused slots. The tile behind it takes its palette from a table
// of 17 file numbers in overlay 168; type 17 reads the word after it, which is
// 0, and gets a black tile. That word is the first of the move screen's key
// cursor stops when no move can be used; it's set to Psychic's pink tile.
// Addresses are from pokebw2.

import type { DsRam } from './ram';
import type { Cart } from './romimage';

export const FAIRY = 17;

const LABEL_FILE = 34 + FAIRY;
const LABEL_PALETTES_FILE = 33;
/** Label palette 2's unused slots (magenta in the game): the label's border and its colour. */
const PINKS: [slot: number, rgb: [number, number, number]][] = [
  [8, [184, 72, 128]],
  [9, [240, 136, 184]],
];
/** FAIRY, as BW2's labels letter (32×16, 4 bits a pixel, 8×8 tiles four a row): 14 and 15 the letters, 8 and 9 the pinks. */
const LABEL =
  '00000000000000008888888898999999f8ffef99f8eeeef9f89e99f9f8ff9ef900000000000000008888888899999999ff9ef9ffeeefe9ef9eef99ef9eef99ef' +
  '000000000000000088888888999999999effef999eeffe9e99eff99e99ffef9900000000000000008888888899999989ef99ef89ef99ef89fefe9e89e9ef9989' +
  'f8ee9ef9f89e99f9f89e99f9e89e99e998999999888888880000000000000000ffef99efeeef99ef9eeff9ff9eeee9ee99999999888888880000000000000000' +
  '99efef9999effe9e9eeff99e9eeee99e9999999988888888000000000000000099ef998999ef998999ef998999ee998999999989888888880000000000000000';

/** sTypeIconPalettes (ARM9): a byte per type, which label palette it uses. */
const TYPE_LABEL_PALETTES = 0x0209208c;
/** The tile palette file of each move type (overlay 168), 17 words, and the word after them. */
const MOVE_TILE_PALETTES = 0x021f3864;
const MOVE_TILE_PALETTE_FILES = [464, 470, 473, 471, 472, 476, 475, 477, 479, 465, 466, 468, 467, 469, 478, 474, 480];
const PSYCHIC_TILE = 469;

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

/** Puts the FAIRY label and its pinks on the cart. They stay: battles never show what they replace. */
export function fairyOnCart(cart: Cart): void {
  const labels = cart.archive('a/0/8/2');
  const [label] = labels.fileRange(LABEL_FILE);
  cart.write(label + 0x30, hex(LABEL));
  const [palettes] = labels.fileRange(LABEL_PALETTES_FILE);
  for (const [slot, [r, g, b]] of PINKS) {
    const color = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
    cart.write(palettes + 0x28 + (2 * 16 + slot) * 2, new Uint8Array([color & 0xff, color >> 8]));
  }
}

/**
 * Points type 17 at the FAIRY label's palette and a pink move tile, in RAM.
 * Only where the tables are as expected: the tile table is in the battle's
 * overlay, there only during a battle. False if it isn't.
 */
export function fairyInRam(ram: DsRam): boolean {
  if (ram.read8(TYPE_LABEL_PALETTES) === 0 && ram.read8(TYPE_LABEL_PALETTES + 2) === 1) ram.write8(TYPE_LABEL_PALETTES + FAIRY, 2);
  if (!MOVE_TILE_PALETTE_FILES.every((file, type) => ram.read32(MOVE_TILE_PALETTES + type * 4) === file)) return false;
  ram.write32(MOVE_TILE_PALETTES + FAIRY * 4, PSYCHIC_TILE);
  return true;
}
