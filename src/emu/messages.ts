// Battle text as BW2 message commands. BW2 prints only strings from its own
// text banks (a/0/0/2 file 19 "std", file 18 "set"). Std messages are exact;
// set messages are given by their player-side ID and the game adds 2 for the
// foe's Pokémon, picking from the first argument. IDs were read from the ROM's
// text and pokebw2's btl_server_flow.c / btl_string.c.

import type { Effect, Side, Status, TextKey, Weather } from '../bw/commands';
import { ITEM_NUMBERS } from '../bw/items';
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

const STATUS_GAINED: Record<Status, number> = { brn: 0xff, par: 0x111, slp: 0x132, frz: 0x120, psn: 0xea, tox: 0xed };
const STATUS_CURED: Partial<Record<Status, number>> = { brn: 0x108, par: 0x117, psn: 0xf6, tox: 0xf6, slp: 0x138, frz: 0x126 };
/** Std weather lines; sun and rain have no "continues" line in Gen 5. */
const WEATHER_UPKEEP: Partial<Record<Weather, number>> = { Sandstorm: 0x5f, Hail: 0x60 };
/** Side conditions set and removed (std, argument: the side). */
const SIDE: Record<string, [set: number, removed?: number]> = {
  'Stealth Rock': [0x9c, 0x9e],
  Spikes: [0x94, 0x96],
  'Toxic Spikes': [0x98],
};

const set = (id: number, ...args: number[]): ServerCmd => [SC.MSG_SET, id, ...args];
const std = (id: number, ...args: number[]): ServerCmd => [SC.MSG_STD, id, ...args];

export type MsgRequest =
  | { kind: 'hpFrom'; change: 'damage' | 'heal' | 'set'; from: Effect }
  | { kind: 'status'; status: Status | null; from?: Effect; previous?: Status | null }
  | { kind: 'clearBoosts'; all: boolean }
  | { kind: 'weatherUpkeep'; weather: Weather }
  | { kind: 'cant'; reason: string }
  | { kind: 'text'; key: TextKey; args: string[]; from?: Effect }
  | { kind: 'side'; condition: string; active: boolean; side: Side; client: number }
  | { kind: 'dragged' };

/**
 * The message command for a line of battle text about `monId` (and `otherId`,
 * e.g. who drained HP), or null where BW2 has no such line.
 */
export function textMessage(req: MsgRequest, monId?: number, otherId?: number): ServerCmd | null {
  const mon = monId ?? -1;
  const has = monId !== undefined;
  switch (req.kind) {
    case 'hpFrom': {
      const { from, change } = req;
      if (!has) return null;
      if (change === 'heal') {
        if (from.name === 'drain') return otherId !== undefined ? set(0x383, otherId) : null;
        if (from.kind === 'item') {
          const item = ITEM_NUMBERS[toID(from.name)];
          if (!item) return null;
          return set(from.name === 'Leftovers' || from.name === 'Black Sludge' ? 0x392 : 0x38c, mon, item);
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
      return id === undefined ? null : std(id);
    }
    case 'cant':
      if (!has) return null;
      switch (req.reason) {
        case 'par': return set(0x114, mon);
        case 'slp': return set(0x135, mon);
        case 'frz': return set(0x123, mon);
        case 'flinch': return set(0x16b, mon);
        case 'recharge': return set(0x350, mon);
      }
      return null;
    case 'side': {
      const ids = SIDE[req.condition];
      const id = ids && (req.active ? ids[0] : ids[1]);
      return id === undefined ? null : std(id, req.client);
    }
    case 'dragged':
      return has ? set(0x34d, mon) : null;
    case 'text':
      return textLine(req.key, req.args, mon, has, otherId);
  }
}

function textLine(key: TextKey, args: string[], mon: number, has: boolean, otherId?: number): ServerCmd | null {
  const a = args[0] ?? '';
  switch (key) {
    case 'crit': return std(0x51);
    case 'superEffective': return std(0x4e);
    case 'resisted': return std(0x4f);
    case 'immune': return has ? set(0xd2, mon) : null;
    // Gen 5 has no "X's attack missed!": the target "avoided the attack".
    case 'miss': return otherId !== undefined ? set(0xd5, otherId) : null;
    case 'fail':
    case 'noTarget': return std(0x47);
    case 'hitCount': return std(0x20, Number(a) || 1);
    case 'singleTurn':
    case 'activate':
      if (!has) return null;
      if (a === 'Protect' || a === 'Detect') return set(0x20b, mon);
      if (a === 'confusion') return set(0x15c, mon);
      if (a === 'Substitute') return set(0x317, mon);
      return null;
    case 'volatileStart':
      if (!has) return null;
      if (a === 'Substitute') return set(0x311, mon);
      if (a === 'confusion') return set(0x159, mon);
      if (a === 'Leech Seed') return set(0x25f, mon);
      return null;
    case 'volatileEnd':
      if (!has) return null;
      if (a === 'Substitute') return set(0x31a, mon);
      if (a === 'confusion') return set(0x15f, mon);
      return null;
    default:
      return null;
  }
}
