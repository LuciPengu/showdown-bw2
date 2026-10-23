// Battle text as BW2 message commands. BW2 prints only strings from its own
// text banks (a/0/0/2 file 19 "std", file 18 "set"). Std messages are exact;
// set messages are given by their player-side ID and the game adds 2 for the
// foe's Pokémon, picking from the first argument (a line about two Pokémon
// picks from both). Std side messages take a client and add 1 for the
// opponent's side. IDs were read from the ROM's text and pokebw2's
// btl_server_flow.c / btl_string.c.

import type { Effect, Side, Status, TextKey, Weather } from '../bw/commands';
import { ITEM_NUMBERS } from '../bw/items';
import { MOVE_NUMBERS } from '../bw/moves';
import { type ServerCmd, SC } from '../bw/servercmd';
import { toID } from '../showdown/protocol';

/** Set-bank IDs the scene uses directly. Arguments in comments. */
export const MSG = {
  fainted: 0x00, // mon
  statRose: 0x1b, // mon, stat, stages (the game picks "sharply"/"drastically")
  statFell: 0x5a, // mon, stat, stages
  statWontGoHigher: 0x99, // mon, stat
  statWontGoLower: 0xae, // mon, stat
} as const;

/** Something BW2 shows no line for, on purpose (Gen 5 has none, or another line covers it). */
export const SILENT = 'silent';

const STATUS_GAINED: Record<Status, number> = { brn: 0xff, par: 0x111, slp: 0x132, frz: 0x120, psn: 0xea, tox: 0xed };
const STATUS_CURED: Partial<Record<Status, number>> = { brn: 0x108, par: 0x117, psn: 0xf6, tox: 0xf6, slp: 0x138, frz: 0x126 };
/** Std weather lines; sun and rain have no "continues" line in Gen 5. */
const WEATHER_UPKEEP: Partial<Record<Weather, number>> = { Sandstorm: 0x5f, Hail: 0x60 };
/** Side conditions set and removed (std, argument: the side's client). */
const SIDE: Record<string, [set: number, removed?: number]> = {
  'Stealth Rock': [0x9c, 0x9e],
  Spikes: [0x94, 0x96],
  'Toxic Spikes': [0x98],
  Reflect: [0x7c, 0x7e],
  'Light Screen': [0x80, 0x82],
  Safeguard: [0x84, 0x86],
  Mist: [0x88, 0x8a],
  Tailwind: [0x8c, 0x8e],
  'Lucky Chant': [0x90, 0x92],
};
/** Whole-field conditions: started (set, about who used it, or std), ended (std). */
const FIELD: Record<string, [start: number, end: number, startIsSet?: boolean]> = {
  'Trick Room': [0x359, 0x74, true],
  Gravity: [0x75, 0x76],
  'Wonder Room': [0xb2, 0xb3],
  'Magic Room': [0xb4, 0xb5],
};
/** The first turn of two-turn moves (set, about the user). */
const CHARGE: Record<string, number> = {
  Fly: 0x211,
  Dive: 0x217,
  Dig: 0x21a,
  'Shadow Force': 0x21d,
  Bounce: 0x220,
  'Razor Wind': 0x223,
  'Sky Attack': 0x226,
  'Solar Beam': 0x229,
  'Skull Bash': 0x22c,
  'Freeze Shock': 0x35f,
  'Ice Burn': 0x362,
};
/** Abilities that heal with "X's HP was restored." */
const HEAL_ABILITIES = new Set(['Rain Dish', 'Poison Heal', 'Volt Absorb', 'Water Absorb', 'Ice Body', 'Dry Skin']);
/** Volatile conditions starting and ending (set, about the Pokémon). */
const VOLATILE_START: Record<string, number> = {
  Taunt: 0x238,
  Encore: 0x22f,
  'Focus Energy': 0x411,
  Yawn: 0x29b,
  Attract: 0x147,
  Torment: 0x241,
  Ingrain: 0x2e0,
  'Aqua Ring': 0x259,
  'Magnet Rise': 0x292,
};
const VOLATILE_END: Record<string, number> = {
  Taunt: 0x23e,
  Encore: 0x232,
  Illusion: 0x1de,
  Torment: 0x247,
  'Magnet Rise': 0x295,
  Stockpile: 0x2d4,
};
/** Single-turn effects (set, about the Pokémon). Roost's landing has no line in Gen 5. */
const SINGLE_TURN: Record<string, number | typeof SILENT> = {
  Protect: 0x20b,
  Detect: 0x20b,
  Endure: 0x1ff,
  'Focus Punch': 0x268,
  'Magic Coat': 0x2f9,
  Snatch: 0x2ef,
  'Follow Me': 0x29e,
  'Rage Powder': 0x29e,
  Roost: SILENT,
};

const set = (id: number, ...args: number[]): ServerCmd => [SC.MSG_SET, id, ...args];
const std = (id: number, ...args: number[]): ServerCmd => [SC.MSG_STD, id, ...args];
const item = (name: string) => ITEM_NUMBERS[toID(name)];
const move = (name: string) => MOVE_NUMBERS[toID(name)];

export type MsgRequest =
  | { kind: 'hpFrom'; change: 'damage' | 'heal' | 'set'; from: Effect }
  | { kind: 'status'; status: Status | null; from?: Effect; previous?: Status | null }
  | { kind: 'clearBoosts'; all: boolean }
  | { kind: 'weatherUpkeep'; weather: Weather }
  | { kind: 'cant'; reason: string; move?: string | null }
  | { kind: 'text'; key: TextKey; args: string[]; from?: Effect }
  | { kind: 'side'; condition: string; active: boolean; side: Side; client: number }
  | { kind: 'field'; condition: string; active: boolean }
  | { kind: 'charge'; move: string }
  | { kind: 'dragged' };

export type MsgResult = ServerCmd | typeof SILENT | null;

/**
 * The message command for a line of battle text about `monId` (and `otherId`,
 * e.g. who drained HP), SILENT where BW2 rightly shows nothing, or null where
 * BW2 has no such line or it isn't mapped yet.
 */
export function textMessage(req: MsgRequest, monId?: number, otherId?: number): MsgResult {
  const mon = monId ?? -1;
  const has = monId !== undefined;
  switch (req.kind) {
    case 'hpFrom': {
      const { from, change } = req;
      if (!has) return null;
      if (change === 'set') return from.name === 'Pain Split' ? std(0x71) : null;
      if (change === 'heal') {
        if (from.name === 'drain') return otherId !== undefined ? set(0x383, otherId) : null;
        if (from.kind === 'item') {
          const id = item(from.name);
          if (!id) return null;
          return set(from.name === 'Leftovers' || from.name === 'Black Sludge' ? 0x392 : 0x38c, mon, id);
        }
        if (from.kind === 'ability' && HEAL_ABILITIES.has(from.name)) return set(0x183, mon);
        switch (from.name) {
          case 'Healing Wish': return set(0x2b9, mon);
          case 'Aqua Ring': return set(0x25c, mon);
          case 'Wish': return set(0x2bc, mon);
        }
        return null;
      }
      switch (from.name) {
        case 'Stealth Rock': return set(0x356, mon);
        case 'Spikes': return set(0x353, mon);
        case 'brn': return set(0x105, mon);
        case 'psn':
        case 'tox': return set(0xf3, mon);
        case 'Sandstorm': return set(0x18c, mon);
        case 'Hail': return set(0x18f, mon);
        case 'Recoil': return set(0x17a, mon);
        case 'Life Orb': return set(0x3f5, mon);
        case 'confusion': return std(0x50, mon);
        case 'Leech Seed': return set(0x262, mon);
        case 'Rocky Helmet': return set(0x1a8, mon);
        case 'Iron Barbs':
        case 'Rough Skin': return set(0x1ae, mon);
      }
      return null;
    }
    case 'status':
      if (!has) return null;
      if (req.status) return set(STATUS_GAINED[req.status], mon);
      return set((req.previous && STATUS_CURED[req.previous]) ?? 0x156, mon);
    case 'clearBoosts':
      return null; // Haze's line isn't in the decoded table yet
    case 'weatherUpkeep': {
      const id = WEATHER_UPKEEP[req.weather];
      return id === undefined ? SILENT : std(id);
    }
    case 'cant': {
      if (!has) return null;
      const m = req.move ? move(req.move) : undefined;
      switch (req.reason) {
        case 'par': return set(0x114, mon);
        case 'slp': return set(0x135, mon);
        case 'frz': return set(0x123, mon);
        case 'flinch': return set(0x16b, mon);
        case 'recharge': return set(0x350, mon);
        case 'Attract': return set(0x150, mon);
        case 'Truant': return set(0x1bd, mon);
        case 'Torment': return set(0x244, mon);
        case 'Taunt': return m ? set(0x23b, mon, m) : null;
        case 'Disable': return m ? set(0x253, mon, m) : null;
        case 'Gravity': return m ? set(0x43e, mon, m) : null;
      }
      return null;
    }
    case 'side': {
      const ids = SIDE[req.condition];
      const id = ids && (req.active ? ids[0] : ids[1]);
      return id === undefined ? null : std(id, req.client);
    }
    case 'field': {
      const ids = FIELD[req.condition];
      if (!ids) return null;
      if (!req.active) return std(ids[1]);
      if (!ids[2]) return std(ids[0]);
      return has ? set(ids[0], mon) : null;
    }
    case 'charge': {
      const id = CHARGE[req.move];
      return id !== undefined && has ? set(id, mon) : null;
    }
    case 'dragged':
      return has ? set(0x34d, mon) : null;
    case 'text':
      return textLine(req.key, req.args, req.from, mon, has, otherId);
  }
}

function textLine(key: TextKey, args: string[], from: Effect | undefined, mon: number, has: boolean, otherId?: number): MsgResult {
  const a = args[0] ?? '';
  const other = otherId !== undefined;
  switch (key) {
    case 'crit': return std(0x51);
    case 'superEffective': return std(0x4e);
    case 'resisted': return std(0x4f);
    case 'immune': return has ? set(0xd2, mon) : null;
    // Gen 5 has no "X's attack missed!": the target "avoided the attack".
    case 'miss': return other ? set(0xd5, otherId) : null;
    case 'fail':
    case 'noTarget': return std(0x47);
    case 'hitCount': return std(0x20, Number(a) || 1);
    case 'singleTurn': {
      if (!has) return null;
      const id = SINGLE_TURN[a];
      return id === undefined ? null : id === SILENT ? SILENT : set(id, mon);
    }
    case 'singleMove':
      return has && a === 'Destiny Bond' ? set(0x272, mon) : null;
    case 'activate':
      if (!has) return null;
      if (a === 'Protect' || a === 'Detect') return set(0x20b, mon);
      if (a === 'confusion') return set(0x15c, mon);
      if (a === 'Substitute') return set(0x317, mon);
      if (a === 'Endure') return set(0x202, mon);
      if (a === 'Trick' || a === 'Switcheroo') return set(0x2aa, mon);
      if (a === 'Pursuit') return SILENT; // the switch-out it catches shows the hit
      return null;
    case 'volatileStart': {
      if (!has) return null;
      if (a === 'Substitute') return set(0x311, mon);
      if (a === 'confusion') return set(0x159, mon);
      if (a === 'Leech Seed') return set(0x25f, mon);
      if (a === 'Disable') return move(args[1] ?? '') ? set(0x250, mon, move(args[1])) : null;
      if (a === 'Curse') return other ? set(0x428, otherId, mon) : null;
      const perish = /^perish(\d)$/.exec(a);
      if (perish) return set(0x35c, mon, Number(perish[1]));
      const stockpile = /^stockpile(\d)$/.exec(a);
      if (stockpile) return set(0x2d1, mon, Number(stockpile[1]));
      const id = VOLATILE_START[a];
      return id === undefined ? null : set(id, mon);
    }
    case 'volatileEnd': {
      if (!has) return null;
      if (a === 'Substitute') return set(0x31a, mon);
      if (a === 'confusion') return set(0x15f, mon);
      const id = VOLATILE_END[a];
      return id === undefined ? null : set(id, mon);
    }
    case 'item': {
      if (!has) return null;
      const id = item(a);
      if (!id) return null;
      const by = from?.name;
      if (by === 'Frisk') return other ? set(0x1b7, otherId, id) : null;
      if (by === 'Trick' || by === 'Switcheroo') return set(0x2ad, mon, id);
      if (by === 'Thief' || by === 'Covet') return other ? set(0x1cc, otherId, id) : null;
      if (!by && a === 'Air Balloon') return set(0x198, mon);
      return null;
    }
    case 'endItem': {
      if (!has) return null;
      const id = item(a);
      if (from?.name === 'Knock Off') return other && id ? set(0x41a, otherId, mon, id) : null;
      if (a === 'Air Balloon') return set(0x19b, mon);
      if (a === 'Eject Button') return set(0x19e, mon);
      if (a === 'Focus Sash') return id ? set(0x3ef, mon, id) : null;
      if (args[1] === 'weaken') return id ? set(0xdb, mon, id) : null;
      if (args[1] === 'eat') return SILENT; // the berry's effect shows its own line
      return null;
    }
    default:
      return null;
  }
}
