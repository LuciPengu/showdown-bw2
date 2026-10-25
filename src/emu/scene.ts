// What BW2's battle client should do for each command: the server commands to
// send, and the Pokémon to write into party slots first. Pure logic over a copy
// of BW2's battle state, so it can be tested without the game.

import type { Command, MonView, Side, Slot, Stat, Status, Weather } from '../bw/commands';
import { type ServerCmd, SC } from '../bw/servercmd';
import { describe, makeNamer } from '../bw/english';
import { toID } from '../showdown/protocol';
import { type CartWork, type Dex, nativeDex } from './dex';
import { MSG, type MsgRequest, type MsgResult, SILENT, textMessage } from './messages';

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
  /** A later Pokémon's own base HP, which its borrowed slot is given; the game works out max HP from it. */
  baseHp?: number;
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

/** One step for the game: cart work, party slots and trainer names to rewrite, then a block of server commands. */
export interface Step {
  /** What borrowed slots need on the cart before the rest. */
  work: CartWork[];
  writes: MonWrite[];
  trainers: TrainerWrite[];
  cmds: ServerCmd[];
  /** The HP Showdown says Pokémon have once the step has played, in BW2's units, to check the game against. */
  hp: { monId: number; hp: number; maxHp: number }[];
}

/**
 * What BW2 has on screen, by battle position. It outlives a Scene: a new battle
 * picks up where the last one left the screen.
 */
export interface Screen {
  /** Whether a Pokémon is out at each battle position. */
  out: boolean[];
}

/** The screen of a battle that has just started: `perSide` Pokémon out on each side (2 in doubles). */
export function newScreen(perSide = 1): Screen {
  return { out: [0, 1, 2, 3, 4, 5].map((pos) => pos < perSide * 2) };
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
/** BW2's weathers; Snow (Gen 9, which has no Hail) shows as Hail, its lines reworded. */
const WEATHERS: Record<Weather, number> = { SunnyDay: 1, RainDance: 2, Hail: 3, Sandstorm: 4, Snow: 3 };
/** Hail's std lines (start, end, continues) as Snow's. */
const SNOW_LINES: [number, string][] = [
  [0x57, 'It started to snow!'],
  [0x5c, 'The snow stopped.'],
  [0x60, 'The snow continues to fall.'],
];
/** A sparkle (Cosmic Power's animation) for Terastallization. */
const TERA_ANIMATION = 322;
/** About how many letters fit on a line of BW2's message box. */
const LINE_LETTERS = 30;
const RECALL_EFFECT = 0x26c; // what the server passes SC_RECALL for a switch
/** Status animations (SC_EFFECT_BY_POS), on infliction and when the status acts. */
const STATUS_EFFECTS: Record<Status, number> = { slp: 0x256, psn: 0x257, tox: 0x257, brn: 0x258, frz: 0x259, par: 0x25a };
/** Weather start animations (SC_EFFECT), replayed while it lasts. */
const WEATHER_EFFECTS: Record<Weather, number> = { SunnyDay: 0x26b, RainDance: 0x268, Hail: 0x269, Sandstorm: 0x26a, Snow: 0x269 };
const WEATHER_HIT_EFFECT = 0x290; // sand or hail hitting a Pokémon
/** The std lines BW2 ends a trainer battle with, about the opponent's client: "Player defeated X!", lost, draw. */
const RESULT_MSG = { win: 0x2c, lose: 0x2e, draw: 0x2f } as const;

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

export function monSpec(mon: MonView, hp: { hp: number; maxHp: number }, status: Status | null, dex: Dex = nativeDex): MonSpec | null {
  const species = dex.species(mon.species);
  if (!species) return null;
  const { num, form, baseHp } = species;
  // Showdown gives exact HP for your own side, a percentage otherwise.
  const maxHp = hp.maxHp !== 100 ? hp.maxHp : estimateMaxHp(baseHp, mon.level);
  const value = hp.maxHp !== 100 ? hp.hp : scaleHp(hp.hp, maxHp);
  const spec: MonSpec = { species: num, form, level: mon.level, gender: mon.gender, shiny: mon.shiny, nickname: printableName(mon), hp: value, maxHp, status };
  if (!species.native) spec.baseHp = baseHp;
  return spec;
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
  /** Slots (side * 4 + pos) whose Pokémon is no longer the one BW2 started with. */
  private replaced = new Set<number>();
  private nextBench: [number, number];
  private turn = 1;
  private lastMove = 0;
  private weather: Weather | null = null;
  private popupOut: number | null = null;
  /** Status by mon ID, for which "cured" line to show. */
  private statuses = new Map<number, Status>();
  /** Slots (side * 4 + pos) whose Pokémon changed while catching up, so the screen shows the wrong one. */
  private stale = new Set<number>();
  /** The trainers' Showdown names, near side first. */
  private names: [string, string] = ['', ''];
  /** The command being planned, for its English line where BW2 has none. */
  private current: Command | null = null;
  /** What BW2 couldn't show (no line or animation mapped yet), with counts. */
  readonly gaps = new Map<string, number>();

  /**
   * `winBgm` is the battle's victory music (from its BtlSetup), 0 for none.
   * `perSide` is how many Pokémon each side has out: 1 in singles, 2 in doubles.
   * They're the first party slots.
   */
  constructor(
    private readonly sides: [Bw2Side, Bw2Side],
    private readonly screen: Screen = newScreen(),
    private readonly winBgm = 0,
    private readonly perSide = 1,
    private readonly dex: Dex = nativeDex,
  ) {
    this.nextBench = [perSide, perSide];
  }

  /**
   * A lead that BW2's own battle intro already sent out (written into its
   * party slot beforehand): takes it on without sending it out again.
   */
  adoptLead(cmd: Extract<Command, { kind: 'switchIn' }>): Step {
    const step: Step = { work: [], writes: [], trainers: [], cmds: [], hp: [] };
    const spec = monSpec(cmd.mon, cmd.hp, cmd.status, this.dex);
    step.work = this.dex.takeWork();
    if (!spec) return step;
    const monId = this.monAt(cmd.slot);
    this.sides[cmd.slot.side].hp.set(monId, { hp: spec.hp, maxHp: spec.maxHp });
    if (spec.status) this.statuses.set(monId, spec.status);
    this.written[cmd.slot.side].set(cmd.slot.pos, cmd.mon.name);
    this.replaced.add(this.slotKey(cmd.slot));
    this.screen.out[this.pos(cmd.slot)] = true;
    step.hp.push({ monId, hp: spec.hp, maxHp: spec.maxHp });
    return step;
  }

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
    const step: Step = { work: [], writes: [], trainers: [], cmds: [], hp: [] };
    if (!instant) this.refreshScreen(step);
    const screenBefore = [...this.screen.out];
    if (this.popupOut !== null && cmd.kind !== 'ability') {
      if (!instant) step.cmds.push([SC.ABILITY_POPUP_OUT, this.popupOut]);
      this.popupOut = null;
    }
    this.current = cmd;
    this.add(cmd, step);
    this.current = null;
    step.work = this.dex.takeWork();
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
        this.replaced.add(this.slotKey(cmd.slot));
        return;
      }
      case 'switchIn': {
        const side = this.sides[cmd.slot.side];
        if (!this.replaced.has(this.slotKey(cmd.slot))) {
          // BW2's own Pokémon from the savestate leaves without a word.
          const monId = this.monAt(cmd.slot);
          this.recall(c, cmd.slot);
          c.push([SC.OP_CLEAR_FOR_SWITCH, monId]);
          this.replaced.add(this.slotKey(cmd.slot));
        }
        const spec = monSpec(cmd.mon, cmd.hp, cmd.status, this.dex);
        if (!spec) return this.gap(`species: ${cmd.mon.species}`);
        const bench = this.benchFor(cmd.slot, cmd.mon.name);
        const monId = side.order[bench];
        step.writes.push({ client: side.client, partyIndex: bench, monId, mon: spec });
        side.hp.set(monId, { hp: spec.hp, maxHp: spec.maxHp });
        step.hp.push({ monId, hp: spec.hp, maxHp: spec.maxHp });
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
        const move = this.dex.move(cmd.move);
        const animation = this.dex.moveAnimation(cmd.move);
        if (!move || !animation) return this.gap(`move: ${cmd.move}`);
        this.lastMove = animation;
        if (cmd.announce) c.push([SC.MOVE_MSG, this.monAt(cmd.user), move]);
        if (cmd.animate) {
          const target = cmd.targets[0] ?? cmd.user;
          c.push([SC.MOVE_ANIM, this.pos(cmd.user), this.pos(target), animation, 0]);
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
        step.hp.push({ monId, hp: target, maxHp: now.maxHp });
        if (cmd.hit) {
          const sound = cmd.hit.effectiveness === 'super' ? 2 : cmd.hit.effectiveness === 'resisted' ? 3 : 1;
          c.push([SC.DAMAGE, monId, sound, this.lastMove]);
        } else if (delta !== 0) {
          c.push([SC.UPDATE_HP_GAUGE, monId]);
        }
        if (cmd.from && !cmd.silent) {
          const msg = this.text({ kind: 'hpFrom', change: cmd.change, from: cmd.from }, monId, cmd.of && this.monAt(cmd.of));
          this.say(c, msg, `${cmd.change} from ${cmd.from.name}`);
        }
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
        if (now) step.hp.push({ monId, hp: 0, maxHp: now.maxHp });
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
        const msg = this.text({ kind: 'status', status: cmd.status, from: cmd.from, previous }, monId);
        this.say(c, msg, cmd.status ? `status: ${cmd.status}` : `cure: ${previous ?? '?'}`);
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
        const msg = this.text({ kind: 'clearBoosts', all: !cmd.slot }, cmd.slot ? this.monAt(cmd.slot) : undefined);
        this.say(c, msg, cmd.slot ? 'clearboost' : 'clearallboost');
        return;
      }
      case 'ability': {
        const monId = this.monAt(cmd.slot);
        const ability = this.dex.ability(cmd.ability);
        if (!ability) return this.gap(`ability: ${cmd.ability}`);
        if (this.popupOut !== null) c.push([SC.ABILITY_POPUP_OUT, this.popupOut]);
        c.push([SC.OP_CHANGE_ABILITY, monId, ability], [SC.ABILITY_POPUP_IN, monId]);
        this.popupOut = monId;
        return;
      }
      case 'weather': {
        if (cmd.weather === 'Snow') for (const [line, text] of SNOW_LINES) this.dex.reword(line, text);
        if (cmd.weather && cmd.upkeep) {
          c.push([SC.EFFECT, WEATHER_EFFECTS[cmd.weather]]);
          this.say(c, this.text({ kind: 'weatherUpkeep', weather: cmd.weather }), `${cmd.weather} continues`);
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
        // BW2 can change a Pokémon's form, not its species: a form it doesn't have borrows another species' slot.
        const species = this.dex.species(cmd.mon.species);
        if (species?.native) c.push([SC.CHANGE_FORM, this.monAt(cmd.slot), species.form]);
        else this.gap(`form change: ${cmd.mon.species}`);
        return;
      }
      case 'tera': {
        const monId = this.monAt(cmd.slot);
        const line = this.dex.line('set', `{nickname:0} terastallized into\nthe ${cmd.type} type!`);
        c.push([SC.MOVE_ANIM, this.pos(cmd.slot), this.pos(cmd.slot), TERA_ANIMATION, 0]);
        if (line === null) return this.gap(`tera: ${cmd.type}`);
        c.push([SC.MSG_SET, line, monId]);
        return;
      }
      case 'transform': {
        c.push([SC.TRANSFORM, this.monAt(cmd.slot), this.monAt(cmd.into)]);
        return;
      }
      case 'cant': {
        const status = cmd.reason as Status;
        if (status in STATUS_EFFECTS) c.push([SC.EFFECT_BY_POS, this.pos(cmd.slot), STATUS_EFFECTS[status]]);
        const msg = this.text({ kind: 'cant', reason: cmd.reason, move: cmd.move }, this.monAt(cmd.slot));
        this.say(c, msg, `cant: ${cmd.reason}`);
        return;
      }
      case 'text': {
        const msg = this.text(
          { kind: 'text', key: cmd.key, args: cmd.args, from: cmd.from },
          cmd.slot && this.monAt(cmd.slot),
          cmd.target && this.monAt(cmd.target),
        );
        // Lines Showdown makes up itself ("X forfeited.") have nothing to match in BW2.
        if (cmd.key === 'message') return;
        this.say(c, msg, cmd.args[0] ? `${cmd.key}: ${cmd.args[0]}` : cmd.key);
        return;
      }
      case 'sideCondition': {
        const client = this.sides[cmd.side].client;
        const msg = this.text({ kind: 'side', condition: cmd.condition, active: cmd.active, side: cmd.side, client });
        this.say(c, msg, `side${cmd.active ? 'start' : 'end'}: ${cmd.condition}`);
        return;
      }
      case 'start':
        this.names = [cmd.trainers[0].name, cmd.trainers[1].name];
        cmd.trainers.forEach((t, i) => {
          const name = drawable(t.name) ? t.name : i === 0 ? 'Player' : 'Opponent';
          step.trainers.push({ client: this.sides[i].client, name });
        });
        return;
      case 'end': {
        const result = cmd.winner === null ? 'draw' : toID(cmd.winner) === toID(this.names[0]) ? 'win' : 'lose';
        if (result === 'win' && this.winBgm) c.push([SC.PLAY_BGM, this.winBgm]);
        c.push([SC.MSG_STD, RESULT_MSG[result], this.sides[1].client]);
        return;
      }
      case 'charge':
        return this.say(c, this.text({ kind: 'charge', move: cmd.move }, this.monAt(cmd.user)), `charge: ${cmd.move}`);
      case 'field': {
        const msg = this.text({ kind: 'field', condition: cmd.condition, active: cmd.active }, cmd.slot && this.monAt(cmd.slot));
        return this.say(c, msg, `field${cmd.active ? 'start' : 'end'}: ${cmd.condition}`);
      }
    }
  }

  private text(req: MsgRequest, monId?: number, otherId?: number): MsgResult {
    return textMessage(req, monId, otherId, this.dex);
  }

  private gap(what: string): void {
    this.gaps.set(what, (this.gaps.get(what) ?? 0) + 1);
  }

  /**
   * Adds a line of text. Where BW2 has none, it shows the line in English in a
   * borrowed line, or else notes the gap.
   */
  private say(c: ServerCmd[], msg: MsgResult, what: string): void {
    if (msg === SILENT) return;
    if (msg) return void c.push(msg);
    const english = this.english();
    const line = english && this.dex.line('std', english);
    if (line !== null && line !== '') c.push([SC.MSG_STD, line]);
    else this.gap(what);
  }

  /** The command being planned in English, wrapped for BW2's message box, with Pokémon by nickname. */
  private english(): string | null {
    if (!this.current) return null;
    const namer = makeNamer((slot) => this.written[slot.side].get(slot.pos));
    const text = describe(this.current, namer, (side) => this.names[side] || 'The foe');
    return text ? wrap(text) : null;
  }

  private message(c: ServerCmd[], key: 'dragged', monId: number): void {
    this.say(c, this.text({ kind: key }, monId), key);
  }

  /**
   * A party index to write an incoming Pokémon into: where it already is, else
   * the next benched slot (the active Pokémon hold the first `perSide`).
   */
  private benchFor(slot: Slot, name: string): number {
    const side = this.sides[slot.side];
    const written = this.written[slot.side];
    for (const [index, n] of written) if (n === name && (index >= this.perSide || index === slot.pos)) return index;
    const count = side.order.length;
    if (count <= this.perSide) return slot.pos;
    let index = this.nextBench[slot.side];
    if (index >= count) index = this.perSide;
    this.nextBench[slot.side] = index + 1 >= count ? this.perSide : index + 1;
    return index;
  }

  private activeSlots(): Slot[] {
    return ([0, 1] as const).flatMap((side) => Array.from({ length: this.perSide }, (_, pos) => ({ side, pos })));
  }

  private slotKey(slot: Slot): number {
    return slot.side * 4 + slot.pos;
  }
}

/** A line broken in two for BW2's message box: at the last space that fits, the rest cut to fit. */
export function wrap(text: string): string {
  if (text.length <= LINE_LETTERS) return text;
  let at = text.lastIndexOf(' ', LINE_LETTERS);
  if (at <= 0) at = LINE_LETTERS;
  const first = text.slice(0, at);
  let rest = text.slice(at).trimStart();
  if (rest.length > LINE_LETTERS) rest = `${rest.slice(0, LINE_LETTERS - 1)}…`;
  return `${first}\n${rest}`;
}
