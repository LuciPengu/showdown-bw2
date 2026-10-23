// Draws commands in the running BW2 game, through the scene's plan.

import type { Command } from '../bw/commands';
import { encodeBlock } from '../bw/servercmd';
import type { Renderer } from '../director';
import type { Bw2Battle } from './bw2';
import type { BattleMove } from './party';
import { type Bw2Side, type MonSpec, type MonWrite, Scene, type Screen, newScreen } from './scene';

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
  /** Gives the player up to six party slots and returns their side, reread. */
  growPlayerParty(): Bw2Side;
  writeMoves(client: number, partyIndex: number, moves: BattleMove[]): void;
  /** Renames a client's trainer. */
  writeTrainer(client: number, name: string): void;
  /** Presses a button in the game. */
  press(button: 'A'): Promise<void>;
  /** The battle on screen has ended and BW2 has shown its result. */
  battleOver(): void;
}

export class EmulatorRenderer implements Renderer {
  private scene: Scene | null = null;
  /** The player's team, written before the scene existed; the scene takes it on when made. */
  private pendingTeam: string[] | null = null;
  /** What BW2 has on screen; kept across battles shown on the same game. */
  private screen = newScreen();

  constructor(
    private readonly game: GameLink,
    private readonly onError: (message: string) => void,
  ) {}

  private makeScene(): Scene {
    const scene = this.game.newScene(this.screen);
    if (this.pendingTeam) scene.assignTeam(0, this.game.growPlayerParty(), this.pendingTeam);
    this.pendingTeam = null;
    return scene;
  }

  /**
   * Writes the player's whole team into BW2's party, in Showdown's order, so
   * BW2's Pokémon menu shows it. Returns false when there's no battle.
   */
  setTeam(team: TeamMember[]): boolean {
    if (!this.game.battle()) return false;
    const side = this.game.growPlayerParty();
    const names: string[] = [];
    team.slice(0, side.order.length).forEach((member, i) => {
      this.game.writeMon({ client: side.client, partyIndex: i, monId: side.order[i], mon: member.spec });
      this.game.writeMoves(side.client, i, member.moves);
      side.hp.set(side.order[i], { hp: member.spec.hp, maxHp: member.spec.maxHp });
      names.push(member.name);
    });
    if (this.scene) this.scene.assignTeam(0, side, names);
    else this.pendingTeam = names;
    return true;
  }

  /** The Showdown Pokémon in the player's BW2 party slot. */
  playerAt(partyIndex: number): string | undefined {
    return this.scene?.nameAt(0, partyIndex);
  }

  /** A new battle starts from the game's party data as it is now. */
  reset(): void {
    this.scene = null;
    this.pendingTeam = null;
  }

  /** A different BW2 battle was taken over: nothing of ours is on its screen. */
  newGame(): void {
    this.scene = null;
    this.screen = newScreen();
  }

  async play(cmd: Command, instant: boolean): Promise<void> {
    const battle = this.game.battle();
    if (!battle) return;
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

  async play(cmd: Command, instant: boolean): Promise<void> {
    await Promise.all(this.renderers.map((r) => r.play(cmd, instant)));
  }
}
