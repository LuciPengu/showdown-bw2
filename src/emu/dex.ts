// Showdown's Pokémon, moves, abilities and items as BW2 numbers. BW2 has
// Gen 1–5; anything later borrows the slot of one of its own that the battle
// won't show (see later.ts), and what the slot needs on the cart (a sprite, a
// name, a move's type) is handed out as work for the game to do first.

import { ABILITY_NUMBERS } from '../bw/abilities';
import { ITEM_NUMBERS } from '../bw/items';
import { DONORS, LATER_ABILITIES, LATER_ITEMS, LATER_MOVES, LATER_SPECIES } from '../bw/later';
import { MOVE_NUMBERS } from '../bw/moves';
import { SPECIES } from '../bw/species';
import { toID } from '../showdown/protocol';

export interface DexSpecies {
  /** The species number BW2 is given: the Pokémon's own, or the one whose slot it borrows. */
  num: number;
  form: number;
  /** The Pokémon's own base HP, for estimating its max HP. */
  baseHp: number;
  /** Whether BW2 has this Pokémon and form itself, rather than lending it a slot. */
  native: boolean;
}

/** What a borrowed slot needs on the cart before it shows. */
export type CartWork =
  | { kind: 'sprite'; species: number; spriteId: string }
  | { kind: 'move'; move: number; name: string; type: number; category: number; pp: number; power: number; accuracy: number }
  | { kind: 'name'; what: 'ability' | 'item'; num: number; name: string };

export interface Dex {
  species(name: string): DexSpecies | null;
  /** The move number BW2 is given for its name and the Fight menu. */
  move(name: string): number | null;
  /** The move whose animation plays. */
  moveAnimation(name: string): number | null;
  ability(name: string): number | null;
  item(name: string): number | null;
  /** Cart work for what was borrowed since last asked. */
  takeWork(): CartWork[];
}

/** Request move ids carry extras: `hiddenpowerfire60`, `return102`. */
function moveKey(name: string): string {
  const id = toID(name);
  if (id.startsWith('hiddenpower')) return 'hiddenpower';
  return MOVE_NUMBERS[id] || LATER_MOVES[id] ? id : id.replace(/\d+$/, '');
}

/** BW2's own Pokémon and moves only. */
export const nativeDex: Dex = {
  species(name) {
    const s = SPECIES[toID(name)];
    return s ? { num: s[0], form: s[1], baseHp: s[2], native: true } : null;
  },
  move: (name) => MOVE_NUMBERS[moveKey(name)] ?? null,
  moveAnimation: (name) => MOVE_NUMBERS[moveKey(name)] ?? null,
  ability: (name) => ABILITY_NUMBERS[toID(name)] ?? null,
  item: (name) => ITEM_NUMBERS[toID(name)] ?? null,
  takeWork: () => [],
};

/**
 * Lends later Pokémon and moves the slots of BW2's own that Gen 9 doesn't
 * have. A species or move keeps its slot for the whole battle; abilities and
 * items take turns with a few, their name written just before it shows.
 * `forms` tells how many forms BW2 has of a species (from the ROM).
 */
export class BorrowingDex implements Dex {
  private readonly species_ = new Map<string, DexSpecies>();
  private readonly moves = new Map<string, number>();
  private readonly takenSpecies = new Set<number>();
  private readonly takenMoves = new Set<number>();
  /** Which name each ability and item donor holds now. */
  private readonly lent = { ability: new Map<number, string>(), item: new Map<number, string>() };
  private nextLent = { ability: 0, item: 0 };
  private work: CartWork[] = [];

  constructor(private readonly forms: (num: number) => number) {}

  /** A new battle: every slot is free again. */
  reset(): void {
    this.species_.clear();
    this.moves.clear();
    this.takenSpecies.clear();
    this.takenMoves.clear();
    this.lent.ability.clear();
    this.lent.item.clear();
    this.work = [];
  }

  species(name: string): DexSpecies | null {
    const id = toID(name);
    const native = SPECIES[id];
    if (native && native[1] < Math.max(1, this.forms(native[0]))) return { num: native[0], form: native[1], baseHp: native[2], native: true };
    const known = this.species_.get(id);
    if (known) return known;
    const later = LATER_SPECIES[id];
    if (!later) return null;
    const [, , baseHp, gender, spriteId] = later;
    const pool = gender === 'N' ? DONORS.species.genderless : DONORS.species.either;
    const num = pool.find((n) => !this.takenSpecies.has(n));
    if (num === undefined) return null;
    this.takenSpecies.add(num);
    const spec = { num, form: 0, baseHp, native: false };
    this.species_.set(id, spec);
    this.work.push({ kind: 'sprite', species: num, spriteId });
    return spec;
  }

  move(name: string): number | null {
    const id = moveKey(name);
    const native = MOVE_NUMBERS[id];
    if (native) return native;
    const known = this.moves.get(id);
    if (known) return known;
    const later = LATER_MOVES[id];
    if (!later) return null;
    const num = DONORS.moves.find((n) => !this.takenMoves.has(n));
    if (num === undefined) return null;
    this.takenMoves.add(num);
    this.moves.set(id, num);
    const [type, category, pp, power, accuracy, , moveName] = later;
    this.work.push({ kind: 'move', move: num, name: moveName, type, category, pp, power, accuracy });
    return num;
  }

  moveAnimation(name: string): number | null {
    const id = moveKey(name);
    return MOVE_NUMBERS[id] ?? LATER_MOVES[id]?.[5] ?? null;
  }

  /** The Showdown move a borrowed (or native) move number stands for, of `among`. */
  moveFor(num: number, among: string[]): string | undefined {
    return among.find((m) => this.move(m) === num);
  }

  ability(name: string): number | null {
    return this.named('ability', name, ABILITY_NUMBERS[toID(name)], LATER_ABILITIES[toID(name)], DONORS.abilities);
  }

  item(name: string): number | null {
    return this.named('item', name, ITEM_NUMBERS[toID(name)], LATER_ITEMS[toID(name)], DONORS.items);
  }

  /**
   * An ability's or item's number. A later one takes the next of `donors` and
   * gets its name written there; an earlier one whose slot is lent out gets
   * its own name back.
   */
  private named(what: 'ability' | 'item', name: string, native: number | undefined, later: string | undefined, donors: number[]): number | null {
    const lent = this.lent[what];
    if (native) {
      if (lent.has(native)) {
        lent.delete(native);
        this.work.push({ kind: 'name', what, num: native, name });
      }
      return native;
    }
    if (!later) return null;
    for (const [num, held] of lent) if (held === later) return num;
    const num = donors[this.nextLent[what]++ % donors.length];
    lent.set(num, later);
    this.work.push({ kind: 'name', what, num, name: later });
    return num;
  }

  takeWork(): CartWork[] {
    const work = this.work;
    this.work = [];
    return work;
  }
}
