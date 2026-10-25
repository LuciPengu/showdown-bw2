// The Bag button as a Mega Evolution or Terastallization button. Showdown
// battles have no use for the bag, and BW2's menus have no button for either.
//
// The touch screen's command menu (archive a/0/1/1) is a BG: tiles from file
// 358, placed by one of the button maps 361–371 (BtlvInput_ChooseButtonMap),
// or the same files 134 later for the other file set. A map is read from the
// cart each time the menu opens, the tiles each time the touch screen is set
// up (a battle's start, and after the Pokémon menu or the bag). So MEGA and
// TERA are lettered into unused tiles once, and the Bag button's label cells
// are pointed at them before the menu opens. A battle taken over from a
// savestate has its touch screen set up already, so the tiles are also written
// into melonDS's copies of the video memory, found by BAG's own tiles.
//
// With the client's bagMode 1, BattleClient_ActionSelectRoot answers Bag by
// resetting the touch screen and opening the menu again, without the bag; a
// Bag tap is seen as the client passing through that wait, and flips the
// choice. A PWT battle has Bag turned off (BtlvEffect_GetUnk304): the menu
// ignores it and darkens its palette as it opens, so while there's something
// to choose the button is turned on again and its palette put back, as
// BtlvInput_RestoreSavedPalette does. A menu already open when the choice
// came (turn 1's, left open after the intro) is reopened the same way, the
// Bag pressed for the player. Addresses are from pokebw2.

import type { DsRam } from './ram';
import type { Cart } from './romimage';

export type Gimmick = 'mega' | 'tera';
type Label = 'bag' | Gimmick | `${Gimmick}On`;

const ARCHIVE = 'a/0/1/1';
const TILES_FILE = 358;
const MAP_FILES = [361, 362, 363, 364, 365, 366, 367, 368, 369, 370, 371];
/** BtlvInput_FileId: the other file set's files come this much later. */
const FILE_SETS = [0, 0x86];
/** Where BAG's B is in map 361: its label is the 7 cells from 2 left of it, on its row and the next. */
const BAG_B = { col: 3, row: 20 };
const LABEL_COLS = 7;
const LABEL_LEFT = 2;

/** BtlClient fields (btl_client.c). */
const CLIENT = { viewCore: 0x54, selActProc: 0xd8, selActSeq: 0xdc, procActionIdx: 0x125, bagMode: 0x1b2 } as const;
/** BtlvCore's touch screen driver, BtlvScd's touch screen, and BtlvInput's fields. */
const CORE_SCD = 0x1c4;
const SCD_INPUT = 0xbc;
const INPUT = { screen: 0x58, pressedButton: 0x70, bagEnabled: 0x2de + 1, savedPalette: 0x308 } as const;
const BAG_BUTTON = 1;
const SCREEN_COMMAND = 1;
/** sBtlvEffect (overlay 168), its PaletteFade, and the sub screen BG buffer's unfaded and faded colours. */
const BTLV_EFFECT = 0x021f4240;
const EFFECT_PALETTE_FADE = 0x18c;
const SUB_BG_BUFFER = { unfaded: 0x14, faded: 0x18 } as const;
/** Where the Bag button's palette (2) is in a palette buffer. */
const BAG_PALETTE = 2 * 32;
const ACTION_SELECT_ROOT = 0x021b3629; // BattleClient_ActionSelectRoot | 1 (Thumb)
const ROOT_SEQ_START_SELECT = 3; // the menu opens, reading its map
const ROOT_SEQ_SELECT = 4; // the menu is open
const ROOT_SEQ_WAIT_SCREEN = 5; // after a command the Pokémon can't use: the screen resets, the menu opens again

/**
 * BW2's label lettering, 8 pixels high: f the letter, e its edge. BAG's own
 * B, A and G are copied from the game; the rest drawn to match.
 */
const GLYPHS: Record<string, string[]> = {
  A: ['...ff...', '..effe..', '..ffff..', '.efeefe.', '.ff..ff.', 'effffffe', 'ffffffff', 'ff....ff'],
  E: ['ffffff', 'ffffff', 'ff....', 'fffff.', 'fffff.', 'ff....', 'ffffff', 'ffffff'],
  G: ['.efffe.', 'efffffe', 'ffe.eff', 'ff.....', 'ff.ffff', 'ffe..ff', 'effffff', '.efffff'],
  M: ['ffe..eff', 'fffeefff', 'ffffffff', 'ffeffeff', 'ff.ee.ff', 'ff....ff', 'ff....ff', 'ff....ff'],
  R: ['fffffe.', 'ffffffe', 'ff..eff', 'ffffffe', 'fffffe.', 'ff.eff.', 'ff..eff', 'ff...ff'],
  T: ['ffffff', 'ffffff', '..ff..', '..ff..', '..ff..', '..ff..', '..ff..', '..ff..'],
};
const LETTER_GAP = 4;
/** Palette indices of the Bag button's palette: its dark fill, the label's darker and bright yellows. */
const DARK = 1;
const EDGE = 14;
const BRIGHT = 15;
/** Within the label's 56×16 pixels: where BAG is centred, the rows its letters take, and the plate of a chosen one. */
const CENTRE = 30.5;
const LETTER_TOP = 4;
const PLATE = { left: 6, right: 54, top: 2, bottom: 13 };

const VARIANTS: Exclude<Label, 'bag'>[] = ['mega', 'tera', 'megaOn', 'teraOn'];
const TEXT: Record<Gimmick, string> = { mega: 'MEGA', tera: 'TERA' };

const isRam = (p: number) => p >= 0x02000000 && p < 0x02400000;
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Where a 4-bit NCGR's tiles start in the file. */
export function tileData(ncgr: Uint8Array): number {
  const section = u16(ncgr, 0x0c);
  return section + 8 + u32(ncgr, section + 0x1c);
}

/** Where an NSCR's cells start in the file, and its width in pixels. */
export function mapCells(nscr: Uint8Array): { at: number; width: number } {
  const section = u16(nscr, 0x0c);
  return { at: section + 0x14, width: u16(nscr, section + 8) };
}

/** A cell's index in a map stored as 32×32-cell blocks, left to right, then down. */
export function cellIndex(width: number, col: number, row: number): number {
  const across = Math.max(1, width / 256);
  return ((row >> 5) * across + (col >> 5)) * 1024 + (row & 31) * 32 + (col & 31);
}

/** A tile's 64 pixels (one byte each), as the cell shows it, flips applied. */
function pixels(tiles: Uint8Array, at: number, cell: number): Uint8Array {
  const tile = cell & 0x3ff;
  const hf = (cell >> 10) & 1;
  const vf = (cell >> 11) & 1;
  const out = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sx = hf ? 7 - x : x;
      const sy = vf ? 7 - y : y;
      const b = tiles[at + tile * 32 + sy * 4 + (sx >> 1)];
      out[y * 8 + x] = sx & 1 ? b >> 4 : b & 0xf;
    }
  }
  return out;
}

/**
 * A label's pixels (LABEL_COLS × 2 tiles) over the button's own: its text
 * centred where BAG's is, and when chosen, dark on a bright plate.
 */
export function letter(background: Uint8Array, text: string, chosen: boolean): Uint8Array {
  const width = LABEL_COLS * 8;
  const out = background.slice();
  if (chosen) {
    for (let y = PLATE.top; y <= PLATE.bottom; y++) for (let x = PLATE.left; x <= PLATE.right; x++) out[y * width + x] = BRIGHT;
  }
  const glyphs = [...text].map((ch) => GLYPHS[ch]);
  const total = glyphs.reduce((sum, g) => sum + g[0].length, 0) + LETTER_GAP * (glyphs.length - 1);
  let x0 = Math.round(CENTRE - total / 2 + 0.5);
  for (const glyph of glyphs) {
    glyph.forEach((row, y) => {
      [...row].forEach((p, x) => {
        if (p === '.') return;
        const value = p === 'e' ? EDGE : chosen ? DARK : BRIGHT;
        out[(LETTER_TOP + y) * width + x0 + x] = value;
      });
    });
    x0 += glyph[0].length + LETTER_GAP;
  }
  return out;
}

/** Packs a label's pixels into 4-bit tiles: the top row's, then the bottom's. */
export function packTiles(label: Uint8Array): Uint8Array {
  const width = LABEL_COLS * 8;
  const out = new Uint8Array(LABEL_COLS * 2 * 32);
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < LABEL_COLS; c++) {
      const tile = (r * LABEL_COLS + c) * 32;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x += 2) {
          const at = (r * 8 + y) * width + c * 8 + x;
          out[tile + y * 4 + x / 2] = label[at] | (label[at + 1] << 4);
        }
      }
    }
  }
  return out;
}

/** The first of `count` unused (all-zero) tiles from the end, short of the last tile, the maps' fill. */
export function freeTiles(tiles: Uint8Array, at: number, count: number): number | null {
  const total = Math.floor((tiles.length - at) / 32);
  let run = 0;
  for (let t = total - 2; t >= 0; t--) {
    const empty = tiles.subarray(at + t * 32, at + t * 32 + 32).every((b) => b === 0);
    run = empty ? run + 1 : 0;
    if (run === count) return t;
  }
  return null;
}

interface MapLabel {
  /** Where the label's cells are in the ROM, top row then bottom row. */
  cells: number[];
  /** The cells as they came: BAG. */
  bag: number[];
}

interface FileSet {
  /** The first tile of each variant's 2 × LABEL_COLS tiles. */
  first: Record<Exclude<Label, 'bag'>, number>;
  /** Every variant's tiles, from the first variant's first tile on. */
  tiles: Uint8Array;
  /** BAG's own tiles (from its B) and their place among the tiles, to find them in video memory. */
  bag: { bytes: Uint8Array; at: number };
  /** Where they were found last. */
  vram?: number[];
  palette: number;
  maps: MapLabel[];
}

/** The Bag button's labels on the cart, and which one the menu shows. */
export class BagLabels {
  private readonly sets: FileSet[] = [];
  private shown: Label = 'bag';

  /** Letters MEGA and TERA into each file set's unused tiles. False if the cart isn't laid out as expected. */
  constructor(private readonly cart: Cart) {
    const archive = cart.archive(ARCHIVE);
    for (const offset of FILE_SETS) {
      if (archive.count <= offset + MAP_FILES[MAP_FILES.length - 1]) continue;
      const [tilesStart] = archive.fileRange(offset + TILES_FILE);
      const tiles = archive.file(offset + TILES_FILE);
      const data = tileData(tiles);
      const base = freeTiles(tiles, data, VARIANTS.length * LABEL_COLS * 2);
      if (base === null) continue;
      const maps: MapLabel[] = [];
      let bTile = -1;
      let palette = 0;
      let background: Uint8Array | null = null;
      for (const file of MAP_FILES) {
        const [start] = archive.fileRange(offset + file);
        const map = archive.file(offset + file);
        const { at, width } = mapCells(map);
        const cell = (col: number, row: number) => u16(map, at + 2 * cellIndex(width, col, row));
        if (bTile < 0) {
          bTile = cell(BAG_B.col, BAG_B.row) & 0x3ff;
          palette = cell(BAG_B.col, BAG_B.row) >> 12;
        }
        const found = this.find(map, at, width, bTile);
        if (!found) continue;
        const col0 = found.col - LABEL_LEFT;
        const where: number[] = [];
        const bag: number[] = [];
        for (let r = 0; r < 2; r++) {
          for (let c = 0; c < LABEL_COLS; c++) {
            where.push(start + at + 2 * cellIndex(width, col0 + c, found.row + r));
            bag.push(cell(col0 + c, found.row + r));
          }
        }
        if (!background) {
          background = new Uint8Array(LABEL_COLS * 8 * 16);
          bag.forEach((c, i) => {
            const px = pixels(tiles, data, c);
            const r = Math.floor(i / LABEL_COLS);
            const col = i % LABEL_COLS;
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) background![(r * 8 + y) * LABEL_COLS * 8 + col * 8 + x] = px[y * 8 + x];
          });
          // Clear BAG's letters: the rows they take, back to the label's fill.
          for (let y = LETTER_TOP; y < LETTER_TOP + 8; y++) {
            for (let x = 0; x < LABEL_COLS * 8; x++) background[y * LABEL_COLS * 8 + x] = DARK;
          }
        }
        maps.push({ cells: where, bag });
      }
      if (!background || !maps.length) continue;
      const first = {} as FileSet['first'];
      const all = new Uint8Array(VARIANTS.length * LABEL_COLS * 2 * 32);
      VARIANTS.forEach((variant, i) => {
        const gimmick = variant.replace('On', '') as Gimmick;
        first[variant] = base + i * LABEL_COLS * 2;
        all.set(packTiles(letter(background!, TEXT[gimmick], variant.endsWith('On'))), i * LABEL_COLS * 2 * 32);
      });
      cart.write(tilesStart + data + base * 32, all);
      const bag = { bytes: tiles.slice(data + bTile * 32, data + (bTile + 4) * 32), at: bTile * 32 };
      this.sets.push({ first, palette, maps, tiles: all, bag });
    }
  }

  get ready(): boolean {
    return this.sets.length > 0;
  }

  /**
   * Writes the labels' tiles into a touch screen already set up, wherever
   * melonDS keeps its tiles. The number of copies written (0 if none is set up).
   */
  intoVram(): number {
    let written = 0;
    for (const set of this.sets) {
      // melonDS's video memory stays put: look again only when it's not where it was.
      if (!set.vram?.length || !set.vram.every((at) => this.cart.isLoaded(at, set.bag.bytes))) set.vram = this.cart.findLoaded(set.bag.bytes);
      for (const at of set.vram) {
        this.cart.writeLoaded(at - set.bag.at + set.first[VARIANTS[0]] * 32, set.tiles);
        written++;
      }
    }
    return written;
  }

  /** Has the menu show `label` on the Bag button the next time it opens. */
  show(label: Label): void {
    if (label === this.shown) return;
    this.shown = label;
    for (const set of this.sets) {
      for (const map of set.maps) {
        map.cells.forEach((at, i) => {
          const cell = label === 'bag' ? map.bag[i] : (set.palette << 12) | (set.first[label] + i);
          this.cart.write(at, new Uint8Array([cell & 0xff, cell >> 8]));
        });
      }
    }
  }

  /** The cell holding BAG's B (and A's tile after it), in the block where the buttons are. */
  private find(map: Uint8Array, at: number, width: number, bTile: number): { col: number; row: number } | null {
    for (let row = 0; row < 32; row++) {
      for (let col = 0; col < 31; col++) {
        const here = u16(map, at + 2 * cellIndex(width, col, row)) & 0x3ff;
        const next = u16(map, at + 2 * cellIndex(width, col + 1, row)) & 0x3ff;
        if (here === bTile && next === bTile + 1 && col >= LABEL_LEFT) return { col, row };
      }
    }
    return null;
  }
}

/**
 * What the player's Pokémon may do, by position, and what was chosen with
 * the Bag button. Driven every frame while BW2's menu is open.
 */
export class BagButton {
  private offered: (Gimmick | null)[] = [];
  private chosen: (Gimmick | null)[] = [];
  private lastSeq = -1;
  /** The label the open menu read as it opened. */
  private openedWith: Label = 'bag';
  /** The Bag was pressed for the player, to reopen the menu: not a choice. */
  private reopening = false;

  constructor(
    private readonly ram: DsRam,
    private readonly labels: BagLabels,
  ) {}

  /** A new choice: what each position may do. Nothing is chosen yet. */
  offer(gimmicks: (Gimmick | null)[]): void {
    this.offered = gimmicks;
    this.chosen = gimmicks.map(() => null);
  }

  /** What was chosen for each position. */
  choices(): (Gimmick | null)[] {
    return this.chosen.slice();
  }

  /** The choice is made: the button is the Bag again. */
  clear(): void {
    this.offered = [];
    this.chosen = [];
    this.labels.show('bag');
  }

  /** Called each frame with the player's battle client. */
  frame(client: number): void {
    const r = this.ram;
    if (r.read8(client + CLIENT.bagMode) !== 1) r.write8(client + CLIENT.bagMode, 1);
    if (r.read32(client + CLIENT.selActProc) !== ACTION_SELECT_ROOT) {
      this.lastSeq = -1;
      return;
    }
    const seq = r.read32(client + CLIENT.selActSeq);
    const position = r.read8(client + CLIENT.procActionIdx);
    if (seq === ROOT_SEQ_WAIT_SCREEN && this.lastSeq !== ROOT_SEQ_WAIT_SCREEN) {
      if (this.reopening) this.reopening = false;
      else this.toggle(position);
    }
    const gimmick = this.offered[position] ?? null;
    const label: Label = gimmick ? (this.chosen[position] === gimmick ? `${gimmick}On` : gimmick) : 'bag';
    this.labels.show(label);
    // The menu reads its map as it opens; one found open (lastSeq -1, SELECT) opened before we looked.
    const opened = seq === ROOT_SEQ_START_SELECT ? this.lastSeq !== ROOT_SEQ_START_SELECT : seq === ROOT_SEQ_SELECT && this.lastSeq !== -1 && this.lastSeq !== ROOT_SEQ_START_SELECT && this.lastSeq !== ROOT_SEQ_SELECT;
    if (opened) this.openedWith = label;
    this.lastSeq = seq;
    const input = this.input(client);
    if (!input) return;
    if (gimmick) this.turnOn(input);
    if (seq === ROOT_SEQ_SELECT && label !== this.openedWith && !this.reopening) {
      this.reopening = true;
      this.openedWith = label;
      r.write32(input + INPUT.pressedButton, BAG_BUTTON);
    }
  }

  /** The touch screen (BtlvInput) while it shows the command menu, or null. */
  private input(client: number): number | null {
    const r = this.ram;
    const core = r.read32(client + CLIENT.viewCore);
    const scd = isRam(core) ? r.read32(core + CORE_SCD) : 0;
    const input = isRam(scd) ? r.read32(scd + SCD_INPUT) : 0;
    return isRam(input) && r.read32(input + INPUT.screen) === SCREEN_COMMAND ? input : null;
  }

  /** Turns the Bag button on, and back to its own colours, while the menu shows. */
  private turnOn(input: number): void {
    const r = this.ram;
    if (r.read8(input + INPUT.bagEnabled) !== 1) r.write8(input + INPUT.bagEnabled, 1);
    const effect = r.read32(BTLV_EFFECT);
    const fade = isRam(effect) ? r.read32(effect + EFFECT_PALETTE_FADE) : 0;
    if (!isRam(fade)) return;
    const colours = r.bytes(input + INPUT.savedPalette, 32);
    for (const buffer of [SUB_BG_BUFFER.unfaded, SUB_BG_BUFFER.faded]) {
      const at = r.read32(fade + buffer);
      if (isRam(at)) r.writeBytes(at + BAG_PALETTE, colours);
    }
  }

  /** The Bag button was tapped at `position`: its Mega or Tera on or off, and off for the others (once a side). */
  toggle(position: number): void {
    const gimmick = this.offered[position];
    if (!gimmick) return;
    if (this.chosen[position] === gimmick) {
      this.chosen[position] = null;
      return;
    }
    this.chosen = this.chosen.map((c) => (c === gimmick ? null : c));
    this.chosen[position] = gimmick;
  }
}
