// What BW2's battle client should do for each command: the server commands to
// send, and the Pokémon to write into party slots first. Pure logic over a copy
// of BW2's battle state, so it can be tested without the game.

import { ABILITY_NUMBERS } from '../bw/abilities';
import type { Command, MonView, Side, Slot, Stat, Status, Weather } from '../bw/commands';
import { MOVE_NUMBERS } from '../bw/moves';
import { type ServerCmd, SC } from '../bw/servercmd';
import { SPECIES } from '../bw/species';
import { toID } from '../showdown/protocol';
import { MSG, textMessage } from './messages';

/** A Pokémon to write into a party slot before it's sent out. */
export interface MonSpec {
  species: number;
  form: number;
  level: number;
  gender: 'M' | 'F' | null;
  shiny: boolean;
  nickname: string;
  hp: number;
  maxHp: number;
  status: Status | null;
}

export interface MonWrite {
  client: number;
  partyIndex: number;
  monId: number;
  mon: MonSpec;
}

/** A trainer's name to show, by client. */
export interface TrainerWrite {
  client: number;
  name: string;
}

/** One step for the game: party slots and trainer names to rewrite, then a block of server commands. */
export interface Step {
  writes: MonWrite[];
  trainers: TrainerWrite[];
  cmds: ServerCmd[];
}

/**
 * What BW2 has on screen, by battle position. It outlives a Scene: a new battle
 * picks up where the last one left the screen.
 */
export interface Screen {
  /** Whether a Pokémon is out at each battle position. */
  out: boolean[];
}

export function newScreen(): Screen {
  return { out: [true, true, false, false, false, false] };
}

/** A side of the battle as BW2 has it. */
export interface Bw2Side {
  client: number;
  /** Mon IDs by party index; switching swaps them. */
  order: number[];
  /** BW2 HP and max HP by mon ID. */
  hp: Map<number, { hp: number; maxHp: number }>;
}

const STAT_NUMBERS: Record<Stat, number> = { atk: 1, def: 2, spa: 3, spd: 4, spe: 5, accuracy: 6, evasion: 7 };
const CONDITIONS: Record<Status, number> = { par: 1, slp: 2, frz: 3, brn: 4, psn: 5, tox: 5 };
/** The gauge's status icons: the condition, and one past poison for bad poison. */
const GAUGE_ICONS: Record<Status, number> = { par: 1, slp: 2, frz: 3, brn: 4, psn: 5, tox: 6 };
const WEATHERS: Record<Weather, number> = { SunnyDay: 1, RainDance: 2, Hail: 3, Sandstorm: 4 };
const RECALL_EFFECT = 0x26c; // what the server passes SC_RECALL for a switch
/** Status animations (SC_EFFECT_BY_POS), on infliction and when the status acts. */
const STATUS_EFFECTS: Record<Status, number> = { slp: 0x256, psn: 0x257, tox: 0x257, brn: 0x258, frz: 0x259, par: 0x25a };
/** Weather start animations (SC_EFFECT), replayed while it lasts. */
const WEATHER_EFFECTS: Record<Weather, number> = { SunnyDay: 0x26b, RainDance: 0x268, Hail: 0x269, Sandstorm: 0x26a };
const WEATHER_HIT_EFFECT = 0x290; // sand or hail hitting a Pokémon

/** BtlCondition values: permanent (type 1); bad poison counts 15 turns; sleep counts down (type 2). */
function conditionValue(status: Status): number {
  if (status === 'tox') return 1 | (15 << 3);
  if (status === 'slp') return 2 | (3 << 3);
  return 1;
}

/** A level-`level` Pokémon's max HP with 31 IVs and 84 EVs, Showdown's usual unknown set. */
export function estimateMaxHp(baseHp: number, level: number): number {
  if (baseHp === 1) return 1; // Shedinja
  return Math.floor(((2 * baseHp + 31 + 21) * level) / 100) + level + 10;
}

export function monSpec(mon: MonView, hp: { hp: number; maxHp: number }, status: Status | null): MonSpec | null {
  const species = SPECIES[toID(mon.species)];
  if (!species) return null;
  const [num, form, baseHp] = species;
  // Showdown gives exact HP for your own side, a percentage otherwise.
  const maxHp = hp.maxHp !== 100 ? hp.maxHp : estimateMaxHp(baseHp, mon.level);
  const value = hp.maxHp !== 100 ? hp.hp : scaleHp(hp.hp, maxHp);
  return { species: num, form, level: mon.level, gender: mon.gender, shiny: mon.shiny, nickname: printableName(mon), hp: value, maxHp, status };
}

/** Whether the US games' font can draw `text`: it has Latin letters only. */
export function drawable(text: string): boolean {
  return /^[\u0020-\u00ff\u2018\u2019\u201c\u201d\u2026\u2642\u2640]+$/u.test(text);
}

/** The nickname, or the species name if the font can't draw it. */
function printableName(mon: MonView): string {
  return drawable(mon.name) && [...mon.name].length <= 10 ? mon.name : mon.species.slice(0, 10);
}

/** A percentage of `maxHp`, never rounding a living Pokémon down to 0. */
function scaleHp(percent: number, maxHp: number): number {
  if (percent <= 0) return 0;
  return Math.max(1, Math.round((percent * maxHp) / 100));
}

export class Scene {
  /** Showdown's Pokémon by party index, per side: what's written into each slot. */
  private written: [Map<number, string>, Map<number, string>] = [new Map(), new Map()];
  /** Whether each side's active Pokémon is still the one BW2 started with. */
  private placeholder = [true, true];
  private nextBench = [1, 1];
  private turn = 1;
  private lastMove = 0;
  private weather: Weather | null = null;
  private popupOut: number | null = null;
  /** Status by mon ID, for which "cured" line to show. */
  private statuses = new Map<number, Status>();
  /** Slots (side * 4 + pos) whose Pokémon changed while catching up, so the screen shows the wrong one. */
  private stale = new Set<number>();

  constructor(
    private readonly sides: [Bw2Side, Bw2Side],
    private readonly screen: Screen = newScreen(),
  ) {}

  /** Recalls the Pokémon at a slot if one is on screen. */
  private recall(c: ServerCmd[], slot: Slot): void {
    const pos = this.pos(slot);
    if (!this.screen.out[pos]) return;
    c.push([SC.RECALL, pos, RECALL_EFFECT]);
    this.screen.out[pos] = false;
  }

  /**
   * Says which Showdown Pokémon (by nickname) are in a side's party slots, in
   * party order, after they were written there; `side` is reread from the game.
   */
  assignTeam(sideIndex: Side, side: Bw2Side, names: string[]): void {
    this.sides[sideIndex] = side;
    const written = this.written[sideIndex];
    written.clear();
    names.forEach((name, i) => i < side.order.length && written.set(i, name));
  }

  /** The Showdown Pokémon written into a party slot, if any. */
  nameAt(side: Side, partyIndex: number): string | undefined {
    return this.written[side].get(partyIndex);
  }

  /** The mon ID in a battle slot. Singles: the party's first Pokémon is the one out. */
  private monAt(slot: Slot): number {
    return this.sides[slot.side].order[slot.pos];
  }

  /** BW2's battle position: the player's side is even, the opponent's odd. */
  private pos(slot: Slot): number {
    return slot.side + slot.pos * 2;
  }

  /**
   * The step for one command. An `instant` command (history being caught up
   * on) only changes the game's battle data: the commands below
   * SC_MOVE_ANIM. What's on screen is brought up to date before the next
   * command that animates.
   */
  plan(cmd: Command, instant = false): Step {
    const step: Step = { writes: [], trainers: [], cmds: [] };
    if (!instant) this.refreshScreen(step);
    const screenBefore = [...this.screen.out];
    if (this.popupOut !== null && cmd.kind !== 'ability') {
      if (!instant) step.cmds.push([SC.ABILITY_POPUP_OUT, this.popupOut]);
      this.popupOut = null;
    }
    this.add(cmd, step);
    if (instant) {
      if (cmd.kind === 'switchIn') this.stale.add(cmd.slot.side * 4 + cmd.slot.pos);
      step.cmds = step.cmds.filter(([n]) => n < SC.MOVE_ANIM);
      this.screen.out = screenBefore; // nothing visible was sent
    }
    return step;
  }

  /** Sends out, without a word, whoever should be out where the screen fell behind. */
  private refreshScreen(step: Step): void {
    for (const key of this.stale) {
      const slot: Slot = { side: (key >> 2) as Slot['side'], pos: key & 3 };
      const client = this.sides[slot.side].client;
      this.recall(step.cmds, slot);
      step.cmds.push([SC.SEND_OUT, client, slot.pos, slot.pos, 0]);
      this.screen.out[this.pos(slot)] = true;
    }
    this.stale.clear();
  }

  private add(cmd: Command, step: Step): void {
    const c = step.cmds;
    switch (cmd.kind) {
      case 'turn':
        this.turn = cmd.turn;
        return;
      case 'switchOut': {
        const monId = this.monAt(cmd.slot);
        if (this.screen.out[this.pos(cmd.slot)]) c.push([SC.RECALL_MSG, this.sides[cmd.slot.side].client, monId]);
        this.recall(c, cmd.slot);
        c.push([SC.OP_CLEAR_FOR_SWITCH, monId]);
        this.placeholder[cmd.slot.side] = false;
        return;
      }
      case 'switchIn': {
        const side = this.sides[cmd.slot.side];
        if (this.placeholder[cmd.slot.side]) {
          // BW2's own Pokémon from the savestate leaves without a word.
          const monId = this.monAt(cmd.slot);
          this.recall(c, cmd.slot);
          c.push([SC.OP_CLEAR_FOR_SWITCH, monId]);
          this.placeholder[cmd.slot.side] = false;
        }
        const spec = monSpec(cmd.mon, cmd.hp, cmd.status);
        if (!spec) return;
        const bench = this.benchFor(cmd.slot, cmd.mon.name);
        const monId = side.order[bench];
        step.writes.push({ client: side.client, partyIndex: bench, monId, mon: spec });
        side.hp.set(monId, { hp: spec.hp, maxHp: spec.maxHp });
        if (spec.status) this.statuses.set(monId, spec.status);
        else this.statuses.delete(monId);
        this.written[cmd.slot.side].set(bench, cmd.mon.name);
        c.push([SC.OP_SEND_IN, side.client, cmd.slot.pos, bench, this.turn]);
        c.push([SC.SEND_OUT, side.client, cmd.slot.pos, bench, cmd.how === 'switch' ? 1 : 0]);
        this.screen.out[this.pos(cmd.slot)] = true;
        [side.order[cmd.slot.pos], side.order[bench]] = [side.order[bench], side.order[cmd.slot.pos]];
        const written = this.written[cmd.slot.side];
        const out = written.get(cmd.slot.pos);
        written.set(cmd.slot.pos, cmd.mon.name);
        if (out === undefined) written.delete(bench);
        else written.set(bench, out);
        if (cmd.how === 'drag') this.message(c, 'dragged', monId);
        return;
      }
      case 'move': {
        const move = MOVE_NUMBERS[toID(cmd.move)];
        if (!move) return;
        this.lastMove = move;
        if (cmd.announce) c.push([SC.MOVE_MSG, this.monAt(cmd.user), move]);
        if (cmd.animate) {
          const target = cmd.targets[0] ?? cmd.user;
          c.push([SC.MOVE_ANIM, this.pos(cmd.user), this.pos(target), move, 0]);
        }
        return;
      }
      case 'hp': {
        const monId = this.monAt(cmd.slot);
        const side = this.sides[cmd.slot.side];
        const now = side.hp.get(monId);
        if (!now) return;
        const target = cmd.hp.maxHp === now.maxHp ? cmd.hp.hp : scaleHp((cmd.hp.hp / cmd.hp.maxHp) * 100, now.maxHp);
        const delta = target - now.hp;
        const from = cmd.from;
        if (from && cmd.change === 'damage') {
          if (from.kind === 'status') c.push([SC.EFFECT_BY_POS, this.pos(cmd.slot), STATUS_EFFECTS[from.name as Status]]);
          if (from.name === 'Sandstorm' || from.name === 'Hail') c.push([SC.EFFECT_BY_POS, this.pos(cmd.slot), WEATHER_HIT_EFFECT]);
        }
        if (delta < 0) c.push([SC.OP_SUBTRACT_HP, monId, -delta]);
        if (delta > 0) c.push([SC.OP_ADD_HP, monId, delta]);
        now.hp = target;
        if (cmd.hit) {
          const sound = cmd.hit.effectiveness === 'super' ? 2 : cmd.hit.effectiveness === 'resisted' ? 3 : 1;
          c.push([SC.DAMAGE, monId, sound, this.lastMove]);
        } else if (delta !== 0) {
          c.push([SC.UPDATE_HP_GAUGE, monId]);
        }
        const msg = cmd.from && textMessage({ kind: 'hpFrom', change: cmd.change, from: cmd.from }, monId, cmd.of && this.monAt(cmd.of));
        if (msg) c.push(msg);
        return;
      }
      case 'faint': {
        const monId = this.monAt(cmd.slot);
        const now = this.sides[cmd.slot.side].hp.get(monId);
        if (now && now.hp > 0) {
          c.push([SC.OP_ZERO_HP, monId], [SC.FAINT_HP_GAUGE, monId, 0]);
          now.hp = 0;
        }
        c.push([SC.MSG_SET, MSG.fainted, monId], [SC.FAINT, monId]);
        this.screen.out[this.pos(cmd.slot)] = false;
        return;
      }
      case 'status': {
        const monId = this.monAt(cmd.slot);
        const previous = this.statuses.get(monId) ?? null;
        if (cmd.status) {
          c.push([SC.OP_SET_CONDITION, monId, CONDITIONS[cmd.status], conditionValue(cmd.status)]);
          c.push([SC.SET_GAUGE_STATUS, monId, GAUGE_ICONS[cmd.status]]);
          c.push([SC.EFFECT_BY_POS, this.pos(cmd.slot), STATUS_EFFECTS[cmd.status]]);
          this.statuses.set(monId, cmd.status);
        } else {
          c.push([SC.OP_CURE_CONDITION, monId], [SC.SET_GAUGE_STATUS, monId, 0]);
          this.statuses.delete(monId);
        }
        const msg = textMessage({ kind: 'status', status: cmd.status, from: cmd.from, previous }, monId);
        if (msg) c.push(msg);
        return;
      }
      case 'boost': {
        const monId = this.monAt(cmd.slot);
        const stat = STAT_NUMBERS[cmd.stat];
        const n = Math.min(Math.abs(cmd.stages), 6);
        if (cmd.absolute || cmd.stages > 0) {
          const by = cmd.absolute ? 6 : n;
          c.push([SC.OP_RAISE_STAT_STAGE, monId, stat, by], [SC.STAT_UP_EFFECT, monId, stat, by]);
          c.push([SC.MSG_SET, MSG.statRose, monId, stat, Math.min(by, 3)]);
        } else if (cmd.stages < 0) {
          c.push([SC.OP_LOWER_STAT_STAGE, monId, stat, n], [SC.STAT_DOWN_EFFECT, monId, stat, n]);
          c.push([SC.MSG_SET, MSG.statFell, monId, stat, Math.min(n, 3)]);
        } else {
          c.push([SC.MSG_SET, Object.is(cmd.stages, -0) ? MSG.statWontGoLower : MSG.statWontGoHigher, monId, stat]);
        }
        return;
      }
      case 'clearBoosts': {
        const slots = cmd.slot ? [cmd.slot] : this.activeSlots();
        for (const slot of slots) c.push([SC.OP_RESET_STAT_STAGES, this.monAt(slot)]);
        const msg = textMessage({ kind: 'clearBoosts', all: !cmd.slot }, cmd.slot ? this.monAt(cmd.slot) : undefined);
        if (msg) c.push(msg);
        return;
      }
      case 'ability': {
        const monId = this.monAt(cmd.slot);
        const ability = ABILITY_NUMBERS[toID(cmd.ability)];
        if (!ability) return;
        if (this.popupOut !== null) c.push([SC.ABILITY_POPUP_OUT, this.popupOut]);
        c.push([SC.OP_CHANGE_ABILITY, monId, ability], [SC.ABILITY_POPUP_IN, monId]);
        this.popupOut = monId;
        return;
      }
      case 'weather': {
        if (cmd.weather && cmd.upkeep) {
          c.push([SC.EFFECT, WEATHER_EFFECTS[cmd.weather]]);
          const msg = textMessage({ kind: 'weatherUpkeep', weather: cmd.weather });
          if (msg) c.push(msg);
        } else if (cmd.weather) {
          // Gen 5 weather from an ability lasts until replaced; from a move, 5 turns.
          c.push([SC.WEATHER_START, WEATHERS[cmd.weather], cmd.from?.kind === 'ability' ? 0xff : 5]);
        } else if (this.weather) {
          c.push([SC.WEATHER_END, WEATHERS[this.weather]]);
        }
        this.weather = cmd.weather;
        return;
      }
      case 'formChange': {
        const species = SPECIES[toID(cmd.mon.species)];
        if (species) c.push([SC.CHANGE_FORM, this.monAt(cmd.slot), species[1]]);
        return;
      }
      case 'transform': {
        c.push([SC.TRANSFORM, this.monAt(cmd.slot), this.monAt(cmd.into)]);
        return;
      }
      case 'cant': {
        const status = cmd.reason as Status;
        if (status in STATUS_EFFECTS) c.push([SC.EFFECT_BY_POS, this.pos(cmd.slot), STATUS_EFFECTS[status]]);
        const msg = textMessage({ kind: 'cant', reason: cmd.reason }, this.monAt(cmd.slot));
        if (msg) c.push(msg);
        return;
      }
      case 'text': {
        const msg = textMessage(
          { kind: 'text', key: cmd.key, args: cmd.args, from: cmd.from },
          cmd.slot && this.monAt(cmd.slot),
          cmd.target && this.monAt(cmd.target),
        );
        if (msg) c.push(msg);
        return;
      }
      case 'sideCondition': {
        const client = this.sides[cmd.side].client;
        const msg = textMessage({ kind: 'side', condition: cmd.condition, active: cmd.active, side: cmd.side, client });
        if (msg) c.push(msg);
        return;
      }
      case 'start':
        cmd.trainers.forEach((t, i) => {
          const name = drawable(t.name) ? t.name : i === 0 ? 'Player' : 'Opponent';
          step.trainers.push({ client: this.sides[i].client, name });
        });
        return;
      case 'charge':
      case 'field':
      case 'end':
        return;
    }
  }

  private message(c: ServerCmd[], key: 'dragged', monId: number): void {
    const msg = textMessage({ kind: key }, monId);
    if (msg) c.push(msg);
  }

  /** A party index to write an incoming Pokémon into: where it already is, else the next benched slot. */
  private benchFor(slot: Slot, name: string): number {
    const side = this.sides[slot.side];
    const written = this.written[slot.side];
    for (const [index, n] of written) if (n === name) return index;
    const count = side.order.length;
    if (count < 2) return slot.pos;
    let index = this.nextBench[slot.side];
    if (index === slot.pos || index >= count) index = slot.pos === 1 ? 2 % count : 1;
    this.nextBench[slot.side] = index + 1 >= count ? 1 : index + 1;
    return index;
  }

  private activeSlots(): Slot[] {
    return [
      { side: 0, pos: 0 },
      { side: 1, pos: 0 },
    ];
  }
}
