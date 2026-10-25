// Playing from BW2: when Showdown asks the player to choose, BW2's own menus
// open, and the pick is sent back to Showdown as a /choose command.

import type { Status } from './bw/commands';
import type { Bw2Action, Bw2Battle } from './emu/bw2';
import { type Dex, nativeDex } from './emu/dex';
import type { BattleMove } from './emu/party';
import type { EmulatorRenderer, TeamMember } from './emu/renderer';
import { monSpec } from './emu/scene';
import type { ShowdownRequest } from './session';
import { parseDetails, parseHpStatus, toID } from './showdown/protocol';

/** BW2's move number for a request move id; Hidden Power comes as `hiddenpowerfire60`, Return as `return102`. */
export function moveNumber(id: string, dex: Dex = nativeDex): number | undefined {
  return dex.move(id) ?? undefined;
}

const nameOf = (ident: string) => ident.replace(/^p\d[a-c]?: /, '');

/** The player's team as the request lists it, ready to write into BW2's party. */
export function teamFromRequest(req: ShowdownRequest, dex: Dex = nativeDex): TeamMember[] {
  const team: TeamMember[] = [];
  for (const [i, p] of req.side.pokemon.entries()) {
    const name = nameOf(p.ident);
    const hs = parseHpStatus(p.condition);
    const spec = monSpec({ name, ...parseDetails(p.details) }, { hp: hs.hp, maxHp: hs.maxHp || 1 }, hs.status as Status | null, dex);
    if (!spec) continue;
    // The active Pokémon come first, in position order, matching `active`.
    const live = p.active ? req.active?.[i]?.moves : undefined;
    const moves: BattleMove[] = p.moves.flatMap((id) => {
      const num = moveNumber(id, dex);
      if (!num) return [];
      const m = live?.find((x) => toID(x.id) === toID(id));
      // A move Showdown won't take this turn (Disable, Taunt, a Choice lock…) has no PP in BW2's
      // menu, so the game itself refuses it.
      return [{ id: num, pp: m?.disabled ? 0 : (m?.pp ?? 10), maxPp: m?.maxpp ?? 10 }];
    });
    team.push({ name, spec, moves });
  }
  return team;
}

/** Move targets the player picks in doubles; spread and self-targeting moves take none. */
const PICKED_TARGETS = new Set(['normal', 'any', 'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe']);

/** Showdown's target for a BW2 battle position, from the player's side: foes 1 and 2, allies -1 and -2. */
export function showdownTarget(pos: number): number {
  const index = (pos >> 1) + 1;
  return pos & 1 ? index : -index;
}

/**
 * One position's part of a /choose command for what the player picked in BW2
 * for the Pokémon at `position`, or null if Showdown has no such choice.
 */
export function toChoice(
  action: Bw2Action,
  req: ShowdownRequest,
  nameAt: (partyIndex: number) => string | undefined,
  position = 0,
  dex: Dex = nativeDex,
): string | null {
  if (action.kind === 'fight') {
    const moves = req.active?.[position]?.moves ?? [];
    let i = moves.findIndex((m) => moveNumber(m.id, dex) === action.move);
    if (i < 0 && moves.length === 1) i = 0; // Struggle and locked moves offer one choice
    if (i < 0) return null;
    const picked = (req.active?.length ?? 1) > 1 && PICKED_TARGETS.has(moves[i].target ?? '');
    return picked ? `move ${i + 1} ${showdownTarget(action.target)}` : `move ${i + 1}`;
  }
  if (action.kind === 'switch') {
    const name = nameAt(action.partyIndex);
    const i = req.side.pokemon.findIndex((p) => nameOf(p.ident) === name);
    if (i < 0 || req.side.pokemon[i].active || req.side.pokemon[i].condition.endsWith(' fnt')) return null;
    return `switch ${i + 1}`;
  }
  return null;
}

/**
 * The whole /choose command for BW2's answers to a request: one part per
 * active position, in order. BW2's action menu answers once per position (an
 * empty action for a fainted one); its forced-switch menu answers only for
 * the positions it asked about. Positions with nothing to choose pass. BW2
 * has no Mega button, so the first Pokémon that can Mega Evolve does as it
 * attacks (a side Mega Evolves once a battle).
 */
export function toChoices(
  actions: Bw2Action[],
  req: ShowdownRequest,
  nameAt: (partyIndex: number) => string | undefined,
  dex: Dex = nativeDex,
): string | null {
  const count = Math.max(req.active?.length ?? 0, req.forceSwitch?.length ?? 0, 1);
  const needs = (i: number) =>
    req.forceSwitch ? !!req.forceSwitch[i] : !!req.active?.[i] && !req.side.pokemon[i]?.condition.endsWith(' fnt');
  const byPosition = actions.length >= count;
  const parts: string[] = [];
  let next = 0;
  let mega = false;
  for (let i = 0; i < count; i++) {
    const action = !needs(i) ? undefined : byPosition ? actions[i] : actions[next++];
    if (!action) {
      parts.push('pass');
      continue;
    }
    const part = toChoice(action, req, nameAt, i, dex);
    if (!part) return null;
    const megaHere: boolean = !mega && action.kind === 'fight' && !!req.active?.[i]?.canMegaEvo;
    mega ||= megaHere;
    parts.push(megaHere ? `${part} mega` : part);
  }
  return count === 1 ? parts[0] : parts.join(', ');
}

export interface ChoiceBridgeDeps {
  battle(): Bw2Battle | null;
  renderer: EmulatorRenderer;
  /** Whether everything Showdown sent so far has been shown. */
  caughtUp(): boolean;
  /** Sets the moves of the player's Pokémon at a position (its party slot), as the Fight menu shows them. */
  writeActiveMoves(position: number, moves: BattleMove[]): void;
  send(room: string, text: string): boolean;
  status(text: string, ok: boolean): void;
}

/** How long Showdown has to be quiet before a request is shown: its turn's events arrive right after it. */
const QUIET_MS = 700;

export class ChoiceBridge {
  private room = '';
  private request: ShowdownRequest | null = null;
  /** The request last answered; a new request object means a new choice. */
  private answered: ShowdownRequest | null = null;
  private teamRoom = '';
  private lastMessage = 0;
  private asking: AbortController | null = null;

  constructor(private readonly deps: ChoiceBridgeDeps) {
    setInterval(() => void this.tick(), 250);
  }

  /** Any message from the battle on screen. */
  heard(): void {
    this.lastMessage = Date.now();
  }

  /** A request from Showdown. Ones from the relay's backlog (`live` false) are history: they don't open menus. */
  onRequest(room: string, request: ShowdownRequest, live = true): void {
    this.heard();
    if (!live) return;
    if (room !== this.room) this.room = room;
    this.request = request;
    // The team goes into BW2's party once, from the first request after team preview.
    if (!request.teamPreview && !request.wait && this.teamRoom !== room) {
      if (this.deps.renderer.setTeam(teamFromRequest(request, this.deps.renderer.dex))) this.teamRoom = room;
    }
    // A request that arrives while the menu is open replaces what it's for.
    this.asking?.abort();
  }

  onChoiceError(room: string, message: string): void {
    if (room !== this.room) return;
    this.deps.status(`Showdown: ${message}`, false);
    this.answered = null; // the same request stands: ask again
  }

  /** A different battle (or none) is on screen. */
  stop(): void {
    this.asking?.abort();
    this.request = null;
    this.room = '';
  }

  private async tick(): Promise<void> {
    const req = this.request;
    const battle = this.deps.battle();
    if (!req || !battle || this.asking || req.wait || req.teamPreview) return;
    if (req === this.answered) return;
    if (!this.deps.caughtUp() || Date.now() - this.lastMessage < QUIET_MS) return;

    const asking = new AbortController();
    this.asking = asking;
    try {
      const forced = req.forceSwitch?.some(Boolean);
      if (!forced) {
        req.side.pokemon.forEach((p, i) => {
          if (!p.active || !req.active?.[i] || this.deps.renderer.playerAt(i) !== nameOf(p.ident)) return;
          const [member] = teamFromRequest({ ...req, active: [req.active[i]], side: { ...req.side, pokemon: [p] } }, this.deps.renderer.dex);
          if (member) this.deps.writeActiveMoves(i, member.moves);
        });
        // Borrowed moves' names and data are on the cart before the menu reads them.
        void this.deps.renderer.borrow();
      }
      this.deps.status(forced ? 'Choose a Pokémon to send in, in the game.' : 'Your move: choose in the game.', true);
      // A forced switch names the battle positions to fill: the player's are 0, 2, 4.
      const fainted = forced ? req.forceSwitch!.flatMap((f, i) => (f ? [i * 2] : [])) : null;
      const actions = await battle.ask(fainted, asking.signal);
      if (this.request !== req) return; // superseded while the menu was open
      const choice = actions.length ? toChoices(actions, req, (i) => this.deps.renderer.playerAt(i), this.deps.renderer.dex) : null;
      if (!choice) {
        this.deps.status("Showdown doesn't have that choice. Pick again.", false);
        return;
      }
      const sent = this.deps.send(this.room, `/choose ${choice}${req.rqid !== undefined ? `|${req.rqid}` : ''}`);
      if (!sent) {
        this.deps.status("Couldn't reach your Showdown tab. Is the userscript running?", false);
        return;
      }
      this.answered = req;
      this.deps.status(`Sent to Showdown: ${choice}`, true);
    } catch (err) {
      if ((err as Error).message !== 'cancelled') this.deps.status((err as Error).message, false);
    } finally {
      if (this.asking === asking) this.asking = null;
    }
  }
}
