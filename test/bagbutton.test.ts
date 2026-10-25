import { describe, expect, it } from 'vitest';
import { BagButton, type BagLabels, cellIndex, freeTiles, letter, packTiles } from '../src/emu/bagbutton';
import { DsRam } from '../src/emu/ram';

/** A label's pixels as text: . the fill, # the letters, + their edges, = the plate. */
function draw(label: Uint8Array): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) rows.push([...label.subarray(y * 56, y * 56 + 56)].map((v) => ({ 1: '.', 14: '+', 15: '#' })[v] ?? '?').join(''));
  return rows;
}

describe('the Bag button’s labels', () => {
  const background = new Uint8Array(56 * 16).fill(1);

  it('letters MEGA where BAG was, in its yellows', () => {
    const rows = draw(letter(background, 'MEGA', false));
    expect(rows.slice(4, 12)).toEqual([
      '...........##+..+##....######.....+###+........##.......',
      '...........###++###....######....+#####+......+##+......',
      '...........########....##........##+.+##......####......',
      '...........##+##+##....#####.....##..........+#++#+.....',
      '...........##.++.##....#####.....##.####.....##..##.....',
      '...........##....##....##........##+..##....+######+....',
      '...........##....##....######....+######....########....',
      '...........##....##....######.....+#####....##....##....',
    ]);
    expect(rows.slice(0, 4).concat(rows.slice(12)).every((r) => r === '.'.repeat(56))).toBe(true);
  });

  it('shows a chosen one dark on a bright plate', () => {
    const rows = draw(letter(background, 'TERA', true));
    expect(rows[2]).toBe('......#################################################.');
    // The T's bar (x 12–17), dark on the plate.
    expect(rows[4].slice(11, 19)).toBe('#......#');
    expect(rows[1]).toBe('.'.repeat(56));
  });

  it('packs the label into tiles, top row then bottom, two pixels a byte', () => {
    const label = new Uint8Array(56 * 16);
    label[0] = 0xf; // top left tile, first pixel
    label[8 * 56 + 9] = 0xe; // bottom row's second tile, second pixel
    const tiles = packTiles(label);
    expect(tiles.length).toBe(14 * 32);
    expect(tiles[0]).toBe(0x0f);
    expect(tiles[8 * 32]).toBe(0xe0);
  });

  it('finds unused tiles from the end, short of the last one', () => {
    const tiles = new Uint8Array(16 * 32).fill(1);
    tiles.fill(0, 10 * 32, 16 * 32);
    expect(freeTiles(tiles, 0, 3)).toBe(12);
    expect(freeTiles(tiles, 0, 6)).toBe(null); // tile 15 isn't used, but it's the fill
  });

  it('reads a 512-wide map in 32×32-cell blocks', () => {
    expect(cellIndex(512, 3, 20)).toBe(20 * 32 + 3);
    expect(cellIndex(512, 33, 0)).toBe(1024 + 1);
    expect(cellIndex(256, 3, 20)).toBe(20 * 32 + 3);
  });
});

describe('the Bag button', () => {
  const CLIENT = 0x02100000;
  const ROOT = 0x021b3629;
  const WAIT_SCREEN = 5;

  function setup() {
    const heap = new Uint8Array(0x400000);
    const ram = new DsRam(() => heap, 0);
    const shown: string[] = [];
    const labels = { show: (label: string) => shown.push(label) } as unknown as BagLabels;
    const button = new BagButton(ram, labels);
    // client → view core → touch screen driver → touch screen, showing the command menu
    const [CORE, SCD, INPUT, EFFECT, FADE, UNFADED, FADED] = [0x02110000, 0x02120000, 0x02130000, 0x02140000, 0x02150000, 0x02160000, 0x02170000];
    ram.write32(CLIENT + 0x54, CORE);
    ram.write32(CORE + 0x1c4, SCD);
    ram.write32(SCD + 0xbc, INPUT);
    ram.write32(INPUT + 0x58, 1);
    ram.write32(INPUT + 0x70, -1 >>> 0);
    ram.writeBytes(INPUT + 0x308, new Uint8Array(32).fill(0x77)); // the button's own colours
    ram.write32(0x021f4240, EFFECT);
    ram.write32(EFFECT + 0x18c, FADE);
    ram.write32(FADE + 0x14, UNFADED);
    ram.write32(FADE + 0x18, FADED);
    const menu = (position: number, seq: number) => {
      ram.write32(CLIENT + 0xd8, ROOT);
      ram.write32(CLIENT + 0xdc, seq);
      ram.write8(CLIENT + 0x125, position);
      button.frame(CLIENT);
    };
    return { ram, button, shown, menu, INPUT, FADED };
  }

  it('keeps the bag closed, and shows MEGA for a Pokémon that can Mega Evolve', () => {
    const { ram, button, shown, menu } = setup();
    button.offer(['mega', null]);
    menu(0, 4);
    expect(ram.read8(CLIENT + 0x1b2)).toBe(1);
    expect(shown.at(-1)).toBe('mega');
    menu(1, 4);
    expect(shown.at(-1)).toBe('bag');
  });

  it('flips the choice once per Bag tap, and shows it', () => {
    const { button, shown, menu } = setup();
    button.offer(['mega', null]);
    menu(0, 3); // the menu opens
    menu(0, 4);
    menu(0, WAIT_SCREEN);
    menu(0, WAIT_SCREEN); // still waiting: the same tap
    expect(button.choices()).toEqual(['mega', null]);
    expect(shown.at(-1)).toBe('megaOn');
    menu(0, 4);
    menu(0, WAIT_SCREEN);
    expect(button.choices()).toEqual([null, null]);
    expect(shown.at(-1)).toBe('mega');
  });

  it('lets one Pokémon a side Mega Evolve', () => {
    const { button, menu } = setup();
    button.offer(['mega', 'mega']);
    menu(0, WAIT_SCREEN);
    menu(1, 4);
    menu(1, WAIT_SCREEN);
    expect(button.choices()).toEqual([null, 'mega']);
  });

  it('is the Bag again once the choice is made', () => {
    const { button, shown, menu } = setup();
    button.offer(['tera']);
    menu(0, WAIT_SCREEN);
    button.clear();
    expect(shown.at(-1)).toBe('bag');
    expect(button.choices()).toEqual([]);
  });

  it('turns the Bag button on, in its own colours, while there’s something to choose', () => {
    const { ram, button, menu, INPUT, FADED } = setup();
    button.offer(['tera']);
    menu(0, 4);
    expect(ram.read8(INPUT + 0x2df)).toBe(1);
    expect(ram.read8(FADED + 0x40)).toBe(0x77);
  });

  it('reopens a menu that opened before the choice came, without choosing', () => {
    const { ram, button, shown, menu, INPUT } = setup();
    menu(0, 4); // turn 1's menu, open with BAG
    button.offer(['mega']);
    menu(0, 4);
    expect(ram.read32(INPUT + 0x70)).toBe(1); // the Bag, pressed for the player
    expect(shown.at(-1)).toBe('mega');
    menu(0, WAIT_SCREEN);
    menu(0, 3);
    menu(0, 4);
    expect(button.choices()).toEqual([null]);
    menu(0, WAIT_SCREEN); // now the player's own tap
    expect(button.choices()).toEqual(['mega']);
  });
});
