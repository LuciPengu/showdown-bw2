// Playing from BW2: when Showdown asks the player to choose, BW2's own menus
// open, and the pick is sent back to Showdown as a /choose command.

import type { Status } from './bw/commands';
import { MOVE_NUMBERS } from './bw/moves';
import type { Bw2Action, Bw2Battle } from './emu/bw2';
import type { BattleMove } from './emu/party';
import type { EmulatorRenderer, TeamMember } from './emu/renderer';
import { monSpec } from './emu/scene';
import type { ShowdownRequest } from './session';
import { parseDetails, parseHpStatus, toID } from './showdown/protocol';

/** BW2's move number for a request move id; Hidden Power comes as `hiddenpowerfire60`, Return as `return102`. */
export function moveNumber(id: string): number | undefined {
  const key = toID(id);
  if (key.startsWith('hiddenpower')) return MOVE_NUMBERS.hiddenpower;
  return MOVE_NUMBERS[key] ?? MOVE_NUMBERS[key.replace(/\d+$/, '')];
}

const nameOf = (ident: string) => ident.replace(/^p\d[a-c]?: /, '');

/** The player's team as the request lists it, ready to write into BW2's party. */
export function teamFromRequest(req: ShowdownRequest): TeamMember[] {
  const team: TeamMember[] = [];
  for (const p of req.side.pokemon) {
    const name = nameOf(p.ident);
    const hs = parseHpStatus(p.condition);
    const spec = monSpec({ name, ...parseDetails(p.details) }, { hp: hs.hp, maxHp: hs.maxHp || 1 }, hs.status as Status | null);
    if (!spec) continue;
    const live = p.active ? req.active?.[0]?.moves : undefined;
    const moves: BattleMove[] = p.moves.flatMap((id) => {
      const num = moveNumber(id);
      if (!num) return [];
      const m = live?.find((x) => toID(x.id) === toID(id));
      return [{ id: num, pp: m?.pp ?? 10, maxPp: m?.maxpp ?? 10 }];
    });
    team.push({ name, spec, moves });
  }
  return team;
}

/** The /choose command for what the player picked in BW2, or null if Showdown has no such choice. */
export function toChoice(action: Bw2Action, req: ShowdownRequest, nameAt: (partyIndex: number) => string | undefined): string | null {
  if (action.kind === 'fight') {
    const moves = req.active?.[0]?.moves ?? [];
    const i = moves.findIndex((m) => moveNumber(m.id) === action.move);
    if (i >= 0) return `move ${i + 1}`;
    return moves.length === 1 ? 'move 1' : null; // Struggle and locked moves offer one choice
  }
  if (action.kind === 'switch') {
    const name = nameAt(action.partyIndex);
    const i = req.side.pokemon.findIndex((p) => nameOf(p.ident) === name);
    if (i < 0 || req.side.pokemon[i].active || req.side.pokemon[i].condition.endsWith(' fnt')) return null;
    return `switch ${i + 1}`;
  }
  return null;
}

export interface ChoiceBridgeDeps {
  battle(): Bw2Battle | null;
  renderer: EmulatorRenderer;
  /** Whether everything Showdown sent so far has been shown. */
  caughtUp(): boolean;
  writeActiveMoves(moves: BattleMove[]): void;
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
      if (this.deps.renderer.setTeam(teamFromRequest(request))) this.teamRoom = room;
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
      const forced = req.forceSwitch?.[0];
      if (!forced) {
        const active = req.side.pokemon.find((p) => p.active);
        if (active && this.deps.renderer.playerAt(0) === nameOf(active.ident)) {
          const team = teamFromRequest({ ...req, side: { ...req.side, pokemon: [active] } });
          if (team[0]) this.deps.writeActiveMoves(team[0].moves);
        }
      }
      this.deps.status(forced ? 'Choose a Pokémon to send in, in the game.' : 'Your move: choose in the game.', true);
      const [action] = await battle.ask(forced ? [0] : null, asking.signal);
      if (this.request !== req) return; // superseded while the menu was open
      const choice = action && toChoice(action, req, (i) => this.deps.renderer.playerAt(i));
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
