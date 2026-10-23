// Draws commands in the running BW2 game, through the scene's plan.

import type { Command, GameType } from '../bw/commands';
import { SC, type ServerCmd, encodeBlock } from '../bw/servercmd';
import type { Renderer } from '../director';
import type { Bw2Battle } from './bw2';
import type { BattleMove } from './party';
import { type Bw2Side, type MonSpec, type MonWrite, Scene, type Screen, monSpec, newScreen } from './scene';

/** One of the player's own Pokémon, from Showdown's request. */
export interface TeamMember {
  name: string;
  spec: MonSpec;
  moves: BattleMove[];
}

/** What the renderer needs from the game: the battle, and its party data. */
export interface GameLink {
  battle(): Bw2Battle | null;
  /** A scene over the battle's current party data, continuing from what's on screen. */
  newScene(screen: Screen): Scene;
  /** Rewrites a party slot's Pokémon. */
  writeMon(write: MonWrite): void;
  /** Gives the player `size` party slots (as many as it can) and returns their side, reread. */
  sizePlayerParty(size: number): Bw2Side;
  writeMoves(client: number, partyIndex: number, moves: BattleMove[]): void;
  /** Renames a client's trainer. */
  writeTrainer(client: number, name: string): void;
  /** Presses a button in the game. */
  press(button: 'A'): Promise<void>;
  /** A battle Pokémon's HP as the game has it, and setting it. */
  readHp(monId: number): { hp: number; maxHp: number } | null;
  writeHp(monId: number, hp: number, maxHp: number): void;
  /** Something worth knowing while debugging, not worth showing the player. */
  note(text: string): void;
  /** The battle on screen has ended and BW2 has shown its result. */
  battleOver(): void;
  /** Gets BW2 into a battle of this style (a savestate of one), if it isn't in one. */
  prepare(gameType: GameType): Promise<void>;
  /** Resolves once the game can take commands (it may be going back to a fresh battle). */
  ready(): Promise<void>;
  /**
   * Starts a battle of this style with BW2's own intro (trainers, throws),
   * these trainer names (near, far) and these leads. False if it can't (no
   * savestate for the style, or the game didn't get there).
   */
  intro(gameType: GameType, names: [string, string], leads: Lead[]): Promise<boolean>;
}

/** A lead for BW2's intro: where it goes and who it is. */
export interface Lead {
  side: 0 | 1;
  pos: number;
  mon: MonSpec;
}

/**
 * The leads a battle's start sends out, from the commands after it: the first
 * switch-in at each position before turn 1. Null unless every position has one.
 */
export function leadsOf(upcoming: readonly Command[], perSide: number): Extract<Command, { kind: 'switchIn' }>[] | null {
  const leads = new Map<string, Extract<Command, { kind: 'switchIn' }>>();
  for (const cmd of upcoming) {
    if (cmd.kind === 'turn') break;
    if (cmd.kind === 'switchIn' && !leads.has(`${cmd.slot.side}:${cmd.slot.pos}`)) leads.set(`${cmd.slot.side}:${cmd.slot.pos}`, cmd);
  }
  return leads.size === perSide * 2 ? [...leads.values()] : null;
}

export class EmulatorRenderer implements Renderer {
  private scene: Scene | null = null;
  /** The player's team in the battle on screen, from Showdown's request. */
  private team: TeamMember[] | null = null;
  /** Whether `team` is in BW2's party: switching to another savestate (doubles) loses it. */
  private teamWritten = false;
  /** The team's names, written before the scene existed; the scene takes them on when made. */
  private pendingTeam: string[] | null = null;
  /** What BW2 has on screen; kept across battles shown on the same game. */
  private screen = newScreen();
  /** Leads BW2's intro sent out ("side:pos" → name), whose switch-ins are taken on, not played. */
  private introLeads = new Map<string, string>();

  constructor(
    private readonly game: GameLink,
    private readonly onError: (message: string) => void,
  ) {}

  private makeScene(): Scene {
    const scene = this.game.newScene(this.screen);
    this.scene = scene;
    if (this.team && !this.teamWritten) this.writeTeam(this.team);
    else if (this.pendingTeam) scene.assignTeam(0, this.game.sizePlayerParty(this.pendingTeam.length), this.pendingTeam);
    this.pendingTeam = null;
    return scene;
  }

  /**
   * Writes the player's whole team into BW2's party, in Showdown's order, so
   * BW2's Pokémon menu shows it, now and in any battle BW2 switches to. Returns
   * false when there's no battle to write it into yet.
   */
  setTeam(team: TeamMember[]): boolean {
    this.team = team;
    this.teamWritten = false;
    return this.writeTeam(team);
  }

  private writeTeam(team: TeamMember[]): boolean {
    if (!this.game.battle()) return false;
    // As many slots as the team has, so the Pokémon menu shows no leftovers from the PWT's party.
    const side = this.game.sizePlayerParty(team.length);
    const names: string[] = [];
    team.slice(0, side.order.length).forEach((member, i) => {
      this.game.writeMon({ client: side.client, partyIndex: i, monId: side.order[i], mon: member.spec });
      this.game.writeMoves(side.client, i, member.moves);
      side.hp.set(side.order[i], { hp: member.spec.hp, maxHp: member.spec.maxHp });
      names.push(member.name);
    });
    if (this.scene) this.scene.assignTeam(0, side, names);
    else this.pendingTeam = names;
    this.teamWritten = true;
    return true;
  }

  /** What BW2 couldn't show in this battle so far, with counts. */
  get gaps(): ReadonlyMap<string, number> {
    return this.scene?.gaps ?? new Map();
  }

  /** The Showdown Pokémon in the player's BW2 party slot. */
  playerAt(partyIndex: number): string | undefined {
    return this.scene?.nameAt(0, partyIndex);
  }

  /** A new battle starts from the game's party data as it is now. */
  reset(): void {
    this.scene = null;
    this.team = null;
    this.pendingTeam = null;
  }

  /** A different BW2 battle was taken over, with `perSide` Pokémon out a side: nothing of ours is on its screen. */
  newGame(perSide = 1): void {
    this.scene = null;
    this.teamWritten = false;
    this.screen = newScreen(perSide);
  }

  /**
   * A battle seen from its start begins with BW2's own intro: trainers on
   * screen, their throws, "Go! X!". Joined mid-way (`instant`), or without the
   * leads, it can't.
   */
  private async intro(cmd: Extract<Command, { kind: 'start' }>, instant: boolean, upcoming: readonly Command[]): Promise<boolean> {
    this.introLeads.clear();
    if (instant) return false;
    const perSide = cmd.gameType === 'doubles' ? 2 : cmd.gameType === 'singles' ? 1 : 0;
    const switchIns = perSide && leadsOf(upcoming, perSide);
    if (!switchIns) return false;
    const leads: Lead[] = [];
    for (const s of switchIns) {
      const mon = monSpec(s.mon, s.hp, s.status);
      if (!mon) return false;
      leads.push({ side: s.slot.side, pos: s.slot.pos, mon });
    }
    const names: [string, string] = [cmd.trainers[0].name, cmd.trainers[1].name];
    if (!(await this.game.intro(cmd.gameType, names, leads))) return false;
    for (const s of switchIns) this.introLeads.set(`${s.slot.side}:${s.slot.pos}`, s.mon.name);
    return true;
  }

  /**
   * Showdown decides HP, so after each step the game's HP is checked against
   * Showdown's, and set to it (gauge and all) where they differ.
   */
  private async enforceHp(step: { hp: { monId: number; hp: number; maxHp: number }[] }, instant: boolean): Promise<void> {
    const fix: ServerCmd[] = [];
    for (const { monId, hp, maxHp } of step.hp) {
      const game = this.game.readHp(monId);
      if (!game || (game.hp === hp && game.maxHp === maxHp)) continue;
      this.game.note(`HP drift: mon ${monId} had ${game.hp}/${game.maxHp} in BW2, Showdown says ${hp}/${maxHp}; set it`);
      this.game.writeHp(monId, hp, maxHp);
      fix.push([SC.UPDATE_HP_GAUGE, monId]);
    }
    const battle = this.game.battle();
    if (fix.length && !instant && battle) await battle.play(encodeBlock(fix));
  }

  async play(cmd: Command, instant: boolean, upcoming: readonly Command[] = []): Promise<void> {
    try {
      await this.game.ready();
      if (cmd.kind === 'start' && !(await this.intro(cmd, instant, upcoming))) await this.game.prepare(cmd.gameType);
    } catch (e) {
      this.onError((e as Error).message);
    }
    const battle = this.game.battle();
    if (!battle) return;
    if (cmd.kind === 'switchIn' && this.introLeads.get(`${cmd.slot.side}:${cmd.slot.pos}`) === cmd.mon.name) {
      this.introLeads.delete(`${cmd.slot.side}:${cmd.slot.pos}`);
      this.scene ??= this.makeScene();
      await this.enforceHp(this.scene.adoptLead(cmd), instant);
      return;
    }
    try {
      this.scene ??= this.makeScene();
      // History drawn instantly still updates the game's battle data; the scene leaves out what would animate.
      const step = this.scene.plan(cmd, instant);
      for (const write of step.writes) this.game.writeMon(write);
      for (const t of step.trainers) this.game.writeTrainer(t.client, t.name);
      if (!step.cmds.length) return;
      // A menu left open (a choice that's no longer wanted) would block the game: close it first.
      if (battle.choosing) await battle.closeMenu((b) => this.game.press(b));
      await battle.play(encodeBlock(step.cmds));
      await this.enforceHp(step, instant);
      if (cmd.kind === 'end' && !instant) this.game.battleOver();
    } catch (e) {
      this.onError((e as Error).message);
    }
  }
}

/** Plays every command on several renderers at once, finishing when all have. */
export class TeeRenderer implements Renderer {
  constructor(private readonly renderers: Renderer[]) {}

  reset(): void {
    this.renderers.forEach((r) => r.reset());
  }

  async play(cmd: Command, instant: boolean, upcoming: readonly Command[]): Promise<void> {
    await Promise.all(this.renderers.map((r) => r.play(cmd, instant, upcoming)));
  }
}
