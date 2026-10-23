// What the BW2 screen has to be able to show. The translator turns Showdown
// protocol into these, and a renderer (the preview now, the emulator later)
// plays them one at a time. Showdown has already decided every outcome; a
// renderer only draws.

import type { Status } from '../showdown/protocol';

export type { Status };

/** 0 is the near side (the player's, bottom of the screen), 1 the far side. */
export type Side = 0 | 1;

/** A battle position. `pos` is 0 in singles, 0–1 in doubles, 0–2 in triples. */
export interface Slot {
  side: Side;
  pos: number;
}

export type GameType = 'singles' | 'doubles' | 'triples' | 'rotation';
export type Stat = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';
export type Weather = 'RainDance' | 'SunnyDay' | 'Sandstorm' | 'Hail';

/** `maxHp` is 100 when Showdown only reveals a percentage. */
export interface Hp {
  hp: number;
  maxHp: number;
}

export interface MonView {
  /** Nickname, as Showdown shows it. */
  name: string;
  species: string;
  level: number;
  gender: 'M' | 'F' | null;
  shiny: boolean;
}

/** The cause in a `[from]` tag: `ability: Iron Barbs`, `item: Leftovers`, `Stealth Rock`, `brn`. */
export interface Effect {
  kind: 'ability' | 'item' | 'move' | 'status' | 'weather' | 'other';
  name: string;
}

export interface Hit {
  crit: boolean;
  effectiveness: 'normal' | 'super' | 'resisted';
}

export interface Trainer {
  name: string;
  avatar: string;
  teamSize: number;
}

/** Battle text with no state change of its own. */
export type TextKey =
  | 'crit'
  | 'superEffective'
  | 'resisted'
  | 'immune'
  | 'miss'
  | 'fail'
  | 'noTarget'
  | 'nothing'
  | 'hitCount'
  | 'volatileStart'
  | 'volatileEnd'
  | 'activate'
  | 'singleTurn'
  | 'singleMove'
  | 'item'
  | 'endItem'
  | 'endAbility'
  | 'cureTeam'
  | 'message';

export type Command =
  | { kind: 'start'; gameType: GameType; trainers: [Trainer, Trainer] }
  | { kind: 'switchIn'; slot: Slot; mon: MonView; hp: Hp; status: Status | null; how: 'switch' | 'drag' | 'replace' }
  | { kind: 'switchOut'; slot: Slot; mon: MonView }
  /** `announce` is false for animation-only moves (`-anim`); `missed` plays the version that misses. */
  | { kind: 'move'; user: Slot; move: string; targets: Slot[]; animate: boolean; announce: boolean; missed: boolean; from?: Effect }
  | { kind: 'charge'; user: Slot; move: string; target: Slot | null }
  | { kind: 'cant'; slot: Slot; reason: string; move: string | null }
  /** `hit` is set on damage from a move hit, with what its text will say. */
  | { kind: 'hp'; slot: Slot; hp: Hp; change: 'damage' | 'heal' | 'set'; from?: Effect; of?: Slot; hit?: Hit }
  | { kind: 'faint'; slot: Slot }
  | { kind: 'status'; slot: Slot; status: Status | null; from?: Effect }
  /** `absolute` sets the stage (Belly Drum) instead of changing it. */
  | { kind: 'boost'; slot: Slot; stat: Stat; stages: number; absolute: boolean; from?: Effect }
  /** `slot` null clears every Pokémon's stages (Haze). */
  | { kind: 'clearBoosts'; slot: Slot | null }
  | { kind: 'ability'; slot: Slot; ability: string }
  | { kind: 'formChange'; slot: Slot; mon: MonView }
  | { kind: 'transform'; slot: Slot; into: Slot }
  | { kind: 'weather'; weather: Weather | null; upkeep: boolean; from?: Effect }
  | { kind: 'field'; condition: string; active: boolean }
  | { kind: 'sideCondition'; side: Side; condition: string; active: boolean }
  | { kind: 'text'; key: TextKey; slot?: Slot; target?: Slot; args: string[]; from?: Effect }
  | { kind: 'turn'; turn: number }
  | { kind: 'end'; winner: string | null };
