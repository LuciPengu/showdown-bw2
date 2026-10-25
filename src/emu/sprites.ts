// Showdown's Gen 5-style sprites as BW2 sprites, for later Pokémon borrowing a
// species' slot: fetched, then made into BW2's sprite files (pokegra.ts).

import { type SpriteWriter, iconIndex } from './lender';
import { type Picture, iconFile, iconPaletteOf, iconPalettes, paletteColors, spriteFiles } from './pokegra';

/** Where Showdown keeps a sprite: `gen5`, `gen5-back`, `gen5-shiny` or `gen5-back-shiny`, by sprite id. */
export type SpriteUrl = (dir: string, id: string) => string;

export const showdownSpriteUrl: SpriteUrl = (dir, id) => `https://play.pokemonshowdown.com/sprites/${dir}/${id}.png`;

/** A picture's RGBA, or null if there's none. */
async function load(url: string): Promise<Picture | null> {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(bitmap, 0, 0);
  const { data } = g.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width: bitmap.width, height: bitmap.height, data };
}

/** A picture facing the other way, for a Pokémon whose back Showdown doesn't draw. */
function mirrored(p: Picture): Picture {
  const data = new Uint8ClampedArray(p.width * p.height * 4);
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      for (let c = 0; c < 4; c++) data[(y * p.width + x) * 4 + c] = p.data[(y * p.width + (p.width - 1 - x)) * 4 + c];
    }
  }
  return { width: p.width, height: p.height, data };
}

/** Writes Showdown's sprites for a later Pokémon into the species slot it borrows. */
export function showdownSprites(url: SpriteUrl = showdownSpriteUrl): SpriteWriter {
  const pictures = new Map<string, Promise<(Picture | null)[]>>();
  return async ({ sprites: archive, icons, setIcon }, work) => {
    const id = work.spriteId;
    let got = pictures.get(id);
    if (!got) {
      got = Promise.all(['gen5', 'gen5-back', 'gen5-shiny', 'gen5-back-shiny'].map((dir) => load(url(dir, id))));
      pictures.set(id, got);
    }
    const [front, back, frontShiny, backShiny] = await got;
    if (!front) {
      pictures.delete(id);
      throw new Error(`no sprite for ${id}`);
    }
    const first = work.species * 20;
    const donor = Array.from({ length: 20 }, (_, k) => archive.file(first + k));
    const files = spriteFiles({ front, back: back ?? mirrored(front), frontShiny, backShiny: backShiny ?? (frontShiny && mirrored(frontShiny)) }, donor);
    files.forEach((file, k) => {
      if (file !== donor[k]) archive.replace(first + k, file);
    });
    // The icon keeps the donor's palette, which the game picks by species.
    const donorIcon = icons.file(iconIndex(work.species));
    const palettes = iconPalettes(icons.file(0));
    const palette = palettes[iconPaletteOf(donorIcon, palettes, paletteColors(donor[18]))];
    setIcon(work.species, iconFile(donorIcon, front, palette));
  };
}
