import { describe, expect, it } from 'vitest';
import { fairyInRam } from '../src/emu/fairy';
import { DsRam } from '../src/emu/ram';

const LABEL_PALETTES = 0x0209208c;
const TILE_PALETTES = 0x021f3864;
const TILES = [464, 470, 473, 471, 472, 476, 475, 477, 479, 465, 466, 468, 467, 469, 478, 474, 480];

function ram(battle: boolean): DsRam {
  const r = new DsRam(() => heap, 0);
  const heap = new Uint8Array(0x400000);
  [0, 0, 1, 1, 0, 0, 2].forEach((p, type) => r.write8(LABEL_PALETTES + type, p));
  if (battle) TILES.forEach((file, type) => r.write32(TILE_PALETTES + type * 4, file));
  return r;
}

describe('the Fairy type', () => {
  it('gets the pink label palette and tile in a battle', () => {
    const r = ram(true);
    expect(fairyInRam(r)).toBe(true);
    expect(r.read8(LABEL_PALETTES + 17)).toBe(2);
    expect(r.read32(TILE_PALETTES + 17 * 4)).toBe(469);
  });

  it("leaves RAM alone where the battle's tables aren't", () => {
    const r = ram(false);
    expect(fairyInRam(r)).toBe(false);
    expect(r.read32(TILE_PALETTES + 17 * 4)).toBe(0);
  });
});
