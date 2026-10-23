// Showdown protocol → BW2 screen commands, for one battle.

import type { Command, Effect, GameType, Hit, Hp, MonView, Side, Slot, Stat, Status, TextKey, Trainer, Weather } from './bw/commands';
import { type Line, type SideId, STATUSES, parseDetails, parseHpStatus, parseLine, parseRef, toID } from './showdown/protocol';

/** Lines that change nothing on screen. Anything else unhandled is counted in `unhandled`. */
const IGNORED = new Set([
  '', 'init', 'title', 'j', 'J', 'join', 'l', 'L', 'leave', 'n', 'N', 'c', 'c:', 'chat', 't:', 'raw', 'html', 'uhtml',
  'uhtmlchange', 'error', 'bigerror', 'rule', 'rated', 'tier', 'seed', 'teampreview', 'clearpoke', 'inactive',
  'inactiveoff', 'upkeep', 'timestamp', 'badge', 'debug', 'sentchoice', 'noinit', 'deinit', 'expire', 'unlink',
  'updatepoke', 'poke', 'done', 'gen', '-hint', '-center', '-mustrecharge', '-waiting', '-ohko', 'message',
]);

const STATS = new Set<string>(['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion']);
const WEATHERS = new Set<string>(['RainDance', 'SunnyDay', 'Sandstorm', 'Hail']);
const HIT_TEXT: Record<string, TextKey> = { '-crit': 'crit', '-supereffective': 'superEffective', '-resisted': 'resisted' };

export interface TranslatorOptions {
  /** The watching user's name. Their side is drawn near; otherwise p1 is. */
  viewer?: () => string;
}

interface Active {
  mon: MonView;
  hp: Hp;
  fainted: boolean;
}

export class Translator {
  gen = 0;
  gameType: GameType = 'singles';
  /** Protocol commands seen that this translator doesn't turn into anything, with counts. */
  readonly unhandled = new Map<string, number>();

  private near: SideId = 'p1';
  private requestSide: SideId | null = null;
  private players: Record<SideId, Trainer> = {
    p1: { name: '', avatar: '', teamSize: 6 },
    p2: { name: '', avatar: '', teamSize: 6 },
  };
  private active = new Map<string, Active>();
  /** Crit and effectiveness text waits for the hit's HP change: BW2 shows the HP bar drop first. */
  private pendingHits: Extract<Command, { kind: 'text' }>[] = [];
  private lastAbility = '';

  constructor(private readonly opts: TranslatorOptions = {}) {}

  /** Translates one protocol line. */
  line(raw: string): Command[] {
    const l = parseLine(raw);
    if (!l) return [];
    const out: Command[] = [];
    const isHit = l.cmd in HIT_TEXT || (l.cmd === '-damage' && !('from' in l.kw));
    if (!isHit) this.flushHits(out);
    if (l.cmd === 'move' || l.cmd === 'switch' || l.cmd === 'turn') this.lastAbility = '';
    this.abilityFrom(l, out);
    this.handle(l, out);
    return out;
  }

  /** Translates a batch of lines and flushes anything still waiting. */
  lines(raws: string[]): Command[] {
    const out = raws.flatMap((r) => this.line(r));
    this.flushHits(out);
    return out;
  }

  private handle(l: Line, out: Command[]): void {
    const { args, kw } = l;
    const from = effect(kw.from);
    switch (l.cmd) {
      case 'player': {
        const side = args[0];
        if ((side === 'p1' || side === 'p2') && args[1]) {
          this.players[side] = { ...this.players[side], name: args[1], avatar: args[2] ?? '' };
        }
        return;
      }
      case 'teamsize':
        if (args[0] === 'p1' || args[0] === 'p2') this.players[args[0]].teamSize = Number(args[1]) || 6;
        return;
      case 'gametype':
        this.gameType = (args[0] as GameType) || 'singles';
        return;
      case 'gen':
        this.gen = Number(args[0]) || 0;
        return;
      case 'request': {
        try {
          const id = JSON.parse(args[0] || 'null')?.side?.id;
          if (id === 'p1' || id === 'p2') this.requestSide = id;
        } catch {
          // An empty or partial request carries no side.
        }
        return;
      }
      case 'start': {
        this.near = this.pickNear();
        const far: SideId = this.near === 'p1' ? 'p2' : 'p1';
        out.push({ kind: 'start', gameType: this.gameType, trainers: [this.players[this.near], this.players[far]] });
        return;
      }
      case 'switch':
      case 'drag':
      case 'replace': {
        const ref = parseRef(args[0]);
        if (!ref) break;
        const slot = this.slotOf(ref.side, ref.pos);
        const d = parseDetails(args[1] ?? '');
        const hs = parseHpStatus(args[2]);
        const mon: MonView = { name: ref.name, ...d };
        const prev = this.active.get(key(slot));
        if (prev && !prev.fainted && l.cmd !== 'replace') out.push({ kind: 'switchOut', slot, mon: prev.mon });
        const hp = { hp: hs.hp, maxHp: hs.maxHp || 100 };
        this.active.set(key(slot), { mon, hp, fainted: false });
        out.push({ kind: 'switchIn', slot, mon, hp, status: hs.status, how: l.cmd });
        return;
      }
      case 'detailschange':
      case '-formechange': {
        const slot = this.slot(args[0]);
        const a = slot && this.active.get(key(slot));
        if (!slot || !a) break;
        a.mon = { ...a.mon, ...parseDetails(args[1] ?? ''), name: a.mon.name };
        out.push({ kind: 'formChange', slot, mon: a.mon });
        return;
      }
      case 'move':
      case '-anim': {
        const user = this.slot(args[0]);
        if (!user) break;
        let targets: Slot[] = [];
        if (kw.spread) targets = kw.spread.split(',').flatMap((t) => this.slot(t) ?? []);
        else if (!('notarget' in kw)) targets = this.slot(args[2]) ? [this.slot(args[2])!] : [];
        const announce = l.cmd === 'move';
        // `[miss]` picks the miss animation; the text comes from the `-miss` line that follows.
        const missed = 'miss' in kw;
        out.push({ kind: 'move', user, move: args[1] ?? '', targets, animate: !('still' in kw), announce, missed, ...(from && { from }) });
        if ('notarget' in kw) out.push({ kind: 'text', key: 'noTarget', slot: user, args: [] });
        return;
      }
      case '-prepare': {
        const user = this.slot(args[0]);
        if (!user) break;
        out.push({ kind: 'charge', user, move: args[1] ?? '', target: this.slot(args[2]) });
        return;
      }
      case 'cant': {
        const slot = this.slot(args[0]);
        if (!slot) break;
        out.push({ kind: 'cant', slot, reason: stripPrefix(args[1] ?? ''), move: args[2] ?? null });
        return;
      }
      case '-damage':
      case '-heal':
      case '-sethp': {
        const slot = this.slot(args[0]);
        if (!slot) break;
        const hs = parseHpStatus(args[1]);
        const a = this.active.get(key(slot));
        const hp = { hp: hs.hp, maxHp: hs.maxHp || a?.hp.maxHp || 100 };
        if (a) a.hp = hp;
        const change = l.cmd === '-damage' ? 'damage' : l.cmd === '-heal' ? 'heal' : 'set';
        const of = this.slot(kw.of);
        const hit = change === 'damage' && !from ? this.hitOn(slot) : undefined;
        out.push({ kind: 'hp', slot, hp, change, ...(from && { from }), ...(of && { of }), ...(hit && { hit }) });
        if (hit) this.flushHits(out, slot);
        return;
      }
      case 'faint': {
        const slot = this.slot(args[0]);
        if (!slot) break;
        const a = this.active.get(key(slot));
        if (a) a.fainted = true;
        out.push({ kind: 'faint', slot });
        return;
      }
      case '-status':
      case '-curestatus': {
        const slot = this.slot(args[0]);
        if (!slot) break;
        const status = l.cmd === '-status' ? asStatus(args[1]) : null;
        if (l.cmd === '-status' && !status) break;
        out.push({ kind: 'status', slot, status, ...(from && { from }) });
        return;
      }
      case '-cureteam':
        return this.text(out, 'cureTeam', args[0], [], from);
      case '-boost':
      case '-unboost':
      case '-setboost': {
        const slot = this.slot(args[0]);
        const stat = args[1];
        if (!slot || !STATS.has(stat)) break;
        const n = Number(args[2]) || 0;
        const stages = l.cmd === '-unboost' ? -n : n;
        out.push({ kind: 'boost', slot, stat: stat as Stat, stages, absolute: l.cmd === '-setboost', ...(from && { from }) });
        return;
      }
      case '-clearboost':
      case '-clearallboost':
        out.push({ kind: 'clearBoosts', slot: l.cmd === '-clearboost' ? this.slot(args[0]) : null });
        return;
      case '-ability': {
        const slot = this.slot(args[0]);
        if (!slot) break;
        this.popup(out, slot, args[1] ?? '');
        return;
      }
      case '-endability':
        return this.text(out, 'endAbility', args[0], [stripPrefix(args[1] ?? '')], from);
      case '-transform': {
        const slot = this.slot(args[0]);
        const into = this.slot(args[1]);
        if (!slot || !into) break;
        out.push({ kind: 'transform', slot, into });
        return;
      }
      case '-weather': {
        const w = args[0];
        if (w !== 'none' && !WEATHERS.has(w)) break;
        out.push({ kind: 'weather', weather: w === 'none' ? null : (w as Weather), upkeep: 'upkeep' in kw, ...(from && { from }) });
        return;
      }
      case '-fieldstart':
      case '-fieldend':
        out.push({ kind: 'field', condition: stripPrefix(args[0] ?? ''), active: l.cmd === '-fieldstart' });
        return;
      case '-sidestart':
      case '-sideend': {
        const ref = parseRef(args[0]);
        if (!ref) break;
        out.push({ kind: 'sideCondition', side: this.sideOf(ref.side), condition: stripPrefix(args[1] ?? ''), active: l.cmd === '-sidestart' });
        return;
      }
      case '-crit':
      case '-supereffective':
      case '-resisted': {
        const slot = this.slot(args[0]);
        if (slot) this.pendingHits.push({ kind: 'text', key: HIT_TEXT[l.cmd], slot, args: [] });
        return;
      }
      case '-miss': {
        const slot = this.slot(args[0]);
        if (!slot) break;
        const target = this.slot(args[1]);
        out.push({ kind: 'text', key: 'miss', slot, ...(target && { target }), args: [] });
        return;
      }
      case '-immune':
        return this.text(out, 'immune', args[0], [], from);
      case '-fail':
        return this.text(out, 'fail', args[0], args[1] ? [stripPrefix(args[1])] : [], from);
      case '-notarget':
        return this.text(out, 'noTarget', args[0], []);
      case '-nothing':
        return this.text(out, 'nothing', args[0], []);
      case '-hitcount':
        return this.text(out, 'hitCount', args[0], [args[1] ?? '']);
      case '-start':
        return this.text(out, 'volatileStart', args[0], args.slice(1).map(stripPrefix), from);
      case '-end':
        return this.text(out, 'volatileEnd', args[0], args.slice(1).map(stripPrefix), from);
      case '-activate':
        return this.text(out, 'activate', args[0], args.slice(1).map(stripPrefix), from, kw.of);
      case '-singleturn':
        return this.text(out, 'singleTurn', args[0], [stripPrefix(args[1] ?? '')], from);
      case '-singlemove':
        return this.text(out, 'singleMove', args[0], [stripPrefix(args[1] ?? '')], from);
      case '-item':
        return this.text(out, 'item', args[0], [args[1] ?? ''], from, kw.of);
      case '-enditem':
        return this.text(out, 'endItem', args[0], [args[1] ?? ''], from, kw.of);
      case '-message':
        out.push({ kind: 'text', key: 'message', args: [args[0] ?? ''] });
        return;
      case 'turn':
        out.push({ kind: 'turn', turn: Number(args[0]) || 0 });
        return;
      case 'win':
        out.push({ kind: 'end', winner: args[0] ?? null });
        return;
      case 'tie':
        out.push({ kind: 'end', winner: null });
        return;
      default:
        if (IGNORED.has(l.cmd)) return;
    }
    this.unhandled.set(l.cmd, (this.unhandled.get(l.cmd) ?? 0) + 1);
  }

  /** `[from] ability: X` shows X's popup on its owner: `[of]` if given, else the line's subject. */
  private abilityFrom(l: Line, out: Command[]): void {
    const from = effect(l.kw.from);
    if (from?.kind !== 'ability' || l.cmd === '-ability') return;
    const owner = this.slot(l.kw.of) ?? this.slot(l.args[0]);
    if (owner) this.popup(out, owner, from.name);
  }

  private popup(out: Command[], slot: Slot, ability: string): void {
    const id = `${key(slot)}:${ability}`;
    if (id === this.lastAbility) return;
    this.lastAbility = id;
    out.push({ kind: 'ability', slot, ability });
  }

  private text(out: Command[], textKey: TextKey, subject: string | undefined, args: string[], from?: Effect, of?: string): void {
    const slot = this.slot(subject);
    const target = this.slot(of);
    out.push({ kind: 'text', key: textKey, ...(slot && { slot }), ...(target && { target }), args, ...(from && { from }) });
  }

  /** What the waiting hit text says about `slot`. */
  private hitOn(slot: Slot): Hit {
    const keys = this.pendingHits.filter((t) => t.slot && key(t.slot) === key(slot)).map((t) => t.key);
    const effectiveness = keys.includes('superEffective') ? 'super' : keys.includes('resisted') ? 'resisted' : 'normal';
    return { crit: keys.includes('crit'), effectiveness };
  }

  /** Emits waiting hit text: all of it, or only the text about `slot`. */
  private flushHits(out: Command[], slot?: Slot): void {
    const keep: typeof this.pendingHits = [];
    for (const t of this.pendingHits) {
      if (!slot || (t.slot && key(t.slot) === key(slot))) out.push(t);
      else keep.push(t);
    }
    this.pendingHits = keep;
  }

  private pickNear(): SideId {
    if (this.requestSide) return this.requestSide;
    const viewer = toID(this.opts.viewer?.());
    return viewer && toID(this.players.p2.name) === viewer ? 'p2' : 'p1';
  }

  private sideOf(side: SideId): Side {
    return side === this.near ? 0 : 1;
  }

  private slotOf(side: SideId, pos: number | null): Slot {
    return { side: this.sideOf(side), pos: pos ?? 0 };
  }

  /** The slot a protocol Pokémon reference is in, or null for sides, empty and unparseable refs. */
  private slot(s: string | undefined): Slot | null {
    const ref = parseRef(s);
    if (!ref || (ref.pos === null && !ref.name)) return null;
    if (ref.pos !== null) return this.slotOf(ref.side, ref.pos);
    // `p1: Name` with no position: find it among the actives by nickname.
    for (const [k, a] of this.active) {
      if (k.startsWith(`${this.sideOf(ref.side)}:`) && a.mon.name === ref.name) return parseKey(k);
    }
    return null;
  }
}

function key(slot: Slot): string {
  return `${slot.side}:${slot.pos}`;
}

function parseKey(k: string): Slot {
  const [side, pos] = k.split(':').map(Number);
  return { side: side as Side, pos };
}

function asStatus(s: string | undefined): Status | null {
  return (STATUSES as readonly string[]).includes(s ?? '') ? (s as Status) : null;
}

/** `move: Stealth Rock` → `Stealth Rock` */
function stripPrefix(s: string): string {
  return s.replace(/^(move|ability|item):\s*/, '');
}

export function effect(s: string | undefined): Effect | undefined {
  if (s === undefined || s === '') return undefined;
  const m = /^(ability|item|move):\s*(.*)$/.exec(s.trim());
  if (m) return { kind: m[1] as Effect['kind'], name: m[2] };
  if (asStatus(s)) return { kind: 'status', name: s };
  if (WEATHERS.has(s)) return { kind: 'weather', name: s };
  return { kind: 'other', name: s.trim() };
}
