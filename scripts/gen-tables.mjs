// Writes src/bw/later.ts: what BW2 doesn't have (Pokémon, forms, moves,
// abilities and items from Gen 6 on), and which of its own numbers can lend
// their slot to them. Data from Pokémon Showdown via @pkmn/dex (MIT).
//
//   node scripts/gen-tables.mjs

import { writeFileSync } from 'node:fs';
import { Dex } from '@pkmn/dex';

const dex = Dex.forGen(9);
const toID = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** BW2's type numbers; 17 is Fairy, which BW2 doesn't have. */
const TYPES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy'];
const CATEGORIES = { Status: 0, Physical: 1, Special: 2 };

/** A Gen 5 move's animation for each type: physical, special, status. */
const ANIMATIONS = {
  Normal: [34, 304, 14], // Body Slam, Hyper Voice, Swords Dance
  Fighting: [370, 411, 339], // Close Combat, Focus Blast, Bulk Up
  Flying: [413, 403, 366], // Brave Bird, Air Slash, Tailwind
  Poison: [398, 188, 92], // Poison Jab, Sludge Bomb, Toxic
  Ground: [529, 414, 191], // Drill Run, Earth Power, Spikes
  Rock: [444, 408, 446], // Stone Edge, Power Gem, Stealth Rock
  Bug: [404, 405, 483], // X-Scissor, Bug Buzz, Quiver Dance
  Ghost: [421, 247, 109], // Shadow Claw, Shadow Ball, Confuse Ray
  Steel: [442, 430, 334], // Iron Head, Flash Cannon, Iron Defense
  Fire: [394, 53, 261], // Flare Blitz, Flamethrower, Will-O-Wisp
  Water: [127, 503, 392], // Waterfall, Scald, Aqua Ring
  Grass: [348, 412, 73], // Leaf Blade, Energy Ball, Leech Seed
  Electric: [528, 85, 86], // Wild Charge, Thunderbolt, Thunder Wave
  Psychic: [428, 94, 347], // Zen Headbutt, Psychic, Calm Mind
  Ice: [556, 58, 114], // Icicle Crash, Ice Beam, Haze
  Dragon: [337, 434, 349], // Dragon Claw, Draco Meteor, Dragon Dance
  Dark: [242, 399, 417], // Crunch, Dark Pulse, Nasty Plot
  Fairy: [343, 186, 204], // Covet, Sweet Kiss, Charm
};
/** Moves whose closest Gen 5 animation isn't their type's usual one. */
const ANIMATION_OVERRIDES = {
  moonblast: 236, // Moonlight
  dazzlinggleam: 148, // Flash
  drainingkiss: 186, // Sweet Kiss
  mistyexplosion: 153, // Explosion
  flipturn: 453, // Aqua Jet
  icespinner: 229, // Rapid Spin
  rapidspin: 229,
  bodypress: 34, // Body Slam
  gigatonhammer: 359, // Hammer Arm
  kowtowcleave: 400, // Night Slash
  makeitrain: 6, // Pay Day
  ragingbull: 36, // Take Down
  headlongrush: 529, // Drill Run
  wavecrash: 127, // Waterfall
  aquastep: 291, // Dive
  torchsong: 53, // Flamethrower
  flowertrick: 75, // Razor Leaf
  axekick: 136, // High Jump Kick
  ragefist: 264, // Focus Punch
  lastrespects: 247, // Shadow Ball
  saltcure: 157, // Rock Slide
  tripleaxel: 8, // Ice Punch
  icywind: 196,
  courtchange: 502, // Ally Switch
  shedtail: 164, // Substitute
  chillyreception: 258, // Hail
  snowscape: 258,
  spikyshield: 182, // Protect
  kingsshield: 182,
  banefulbunker: 182,
  silktrap: 182,
  burningbulwark: 182,
  obstruct: 182,
  stickyweb: 527, // Electroweb
  bitterblade: 400, // Night Slash
  bulletseed: 331,
  stoneaxe: 444, // Stone Edge
  ceaselessedge: 400,
  spiritbreak: 343, // Covet
  playrough: 343,
  hurricane: 542,
  nastyplot: 417,
  terablast: 63, // Hyper Beam
  expandingforce: 94, // Psychic
  psychicnoise: 94,
  freezedry: 58, // Ice Beam
  thunderclap: 85,
  electroshot: 85,
  boomburst: 304, // Hyper Voice
  partingshot: 45, // Growl
  defog: 432,
  trailblaze: 348, // Leaf Blade
  matchagotcha: 412, // Energy Ball
  bloodmoon: 63,
};

// Pokémon and forms BW2 doesn't have: from Gen 6 on, and later forms of earlier Pokémon (Megas,
// regional forms…). Each: [national number, form index, base HP, gender, Showdown sprite id].
// Gender is 'N' (genderless), 'M' or 'F' (one only), '' (either). Earlier forms BW2 has are
// in species.ts; the game tells which forms it has.
const species = {};
for (const s of dex.species.all()) {
  if (!s.exists || s.num <= 0 || (s.gen <= 5 && !s.forme)) continue;
  const base = dex.species.get(s.baseSpecies);
  const form = Math.max(0, (base.formeOrder ?? [base.name]).indexOf(s.name));
  const spriteId = toID(s.baseSpecies) + (s.forme ? `-${toID(s.forme)}` : '');
  const gender = s.gender || '';
  species[s.id] = [s.num, form, s.baseStats.hp, gender, spriteId];
}

// Moves BW2 doesn't have: [type, category, PP, power, accuracy (0 never misses), Gen 5 animation, name].
const moves = {};
for (const m of dex.moves.all()) {
  if (!m.exists || m.num <= 559 || m.isZ || m.isMax) continue;
  const type = TYPES.indexOf(m.type);
  const category = CATEGORIES[m.category];
  const animation = ANIMATION_OVERRIDES[m.id] ?? ANIMATIONS[m.type][category === 0 ? 2 : category - 1];
  moves[m.id] = [type, category, m.pp, m.basePower, m.accuracy === true ? 0 : m.accuracy, animation, m.name];
}

/** Names of abilities and items BW2 doesn't have (Gen 6 on). */
const abilities = {};
for (const a of dex.abilities.all()) if (a.exists && a.num > 164) abilities[a.id] = a.name;
const items = {};
for (const i of Dex.items.all()) if (i.exists && i.num > 638 && !i.isPokeball) items[i.id] = i.name;

// Earlier numbers that can lend their slot: ones Gen 9 doesn't have, so a Gen 9 battle never shows
// them; those Gen 8 didn't have either come first. Species that change looks on their own (Spinda's
// spots, Unown, Castform…), have forms, or look different by gender are left out.
const gen8 = Dex.forGen(8);
const pastIn8First = (list, past8) => [...list.filter(past8), ...list.filter((x) => !past8(x))];
const ODD_SPECIES = new Set([201, 327, 351, 386, 412, 413, 421, 487, 492, 493, 550, 555, 585, 586, 641, 642, 645, 646, 647, 648, 649]);
const donorSpecies = { either: [], genderless: [] };
for (let num = 1; num <= 649; num++) {
  const s = dex.species.all().find((x) => x.num === num && !x.forme);
  if (!s || s.isNonstandard !== 'Past' || ODD_SPECIES.has(num) || (s.otherFormes?.length ?? 0) > 0) continue;
  if (s.gender === 'N') donorSpecies.genderless.push(num);
  else if (!s.gender && s.genderRatio.M === 0.5) donorSpecies.either.push(num);
}
const speciesPast8 = (num) => gen8.species.all().find((x) => x.num === num && !x.forme)?.isNonstandard === 'Past';
donorSpecies.either = pastIn8First(donorSpecies.either, speciesPast8);
donorSpecies.genderless = pastIn8First(donorSpecies.genderless, speciesPast8);
const donorMoves = pastIn8First(
  dex.moves
    .all()
    .filter((m) => m.num >= 1 && m.num <= 559 && m.isNonstandard === 'Past' && !m.id.startsWith('hiddenpower'))
    .map((m) => m.num)
    .sort((a, b) => a - b),
  (num) => gen8.moves.all().find((m) => m.num === num)?.isNonstandard === 'Past',
);
// The Gems (548–563): gone since Gen 6, and their names lie one after another.
const gems = dex.items.all().filter((i) => i.num >= 548 && i.num <= 563 && i.isNonstandard === 'Past').map((i) => i.num);
if (gems.length !== 16) throw new Error(`expected 16 Gems that Gen 9 doesn't have, found ${gems.length}`);

const json = (v) => JSON.stringify(v);
const record = (obj) =>
  Object.entries(obj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  ${/^[a-z_][a-z0-9_]*$/.test(k) ? k : json(k)}: ${json(v)},`)
    .join('\n');

const out = `// What BW2 doesn't have: Pokémon, forms, moves, abilities and items from Gen 6 on,
// keyed by Showdown id, and which of BW2's own numbers can lend them their slot.
// Generated by scripts/gen-tables.mjs from Pokémon Showdown's data (@pkmn/dex, MIT).

/** BW2's type numbers, and Fairy as 17, which BW2 doesn't have. */
export const TYPES = ${json(TYPES)};

/**
 * Pokémon and forms past BW2's: national number, form index (Showdown's
 * formeOrder), base HP, gender ('N' genderless, 'M' or 'F' one only, '' either),
 * Showdown's sprite id. Forms of earlier Pokémon are here too; the game tells
 * which of them it has.
 */
export const LATER_SPECIES: Record<string, [num: number, form: number, baseHp: number, gender: '' | 'M' | 'F' | 'N', spriteId: string]> = {
${record(species)}
};

/** Moves past BW2's: type, category (0 status, 1 physical, 2 special), PP, power, accuracy (0 never misses), the Gen 5 move whose animation it plays, name. */
export const LATER_MOVES: Record<string, [type: number, category: number, pp: number, power: number, accuracy: number, animation: number, name: string]> = {
${record(moves)}
};

/** Abilities past BW2's, by name. */
export const LATER_ABILITIES: Record<string, string> = {
${record(abilities)}
};

/** Items past BW2's, by name. */
export const LATER_ITEMS: Record<string, string> = {
${record(items)}
};

/**
 * BW2 numbers Gen 9 doesn't have, which can lend their slot. Species are split
 * by gender: a genderless Pokémon needs a genderless species' slot to show no
 * gender.
 */
export const DONORS = {
  species: ${json(donorSpecies)},
  moves: ${json(donorMoves)},
  /** The Gems, gone since Gen 6. Items take turns with the first four; all their names' room is lent. */
  items: [548, 552, 556, 560],
  itemRoom: ${json(gems)},
  /**
   * Gen 9 has every Gen 5 ability, so abilities borrow ones rarely seen
   * (Multitype, Healer), with the room of the line after each (Flower Gift,
   * Friend Guard) for longer names. Each name is written just before it shows.
   */
  abilities: [121, 131],
  abilityRoom: [121, 122, 131, 132],
};
`;
writeFileSync(new URL('../src/bw/later.ts', import.meta.url), out);
console.log(
  `species ${Object.keys(species).length}, moves ${Object.keys(moves).length}, abilities ${Object.keys(abilities).length}, items ${Object.keys(items).length}; ` +
    `donors: ${donorSpecies.either.length}+${donorSpecies.genderless.length} species, ${donorMoves.length} moves`,
);
