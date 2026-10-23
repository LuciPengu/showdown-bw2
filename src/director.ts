// Plays commands one at a time. Showdown sends a whole turn at once; the
// screen needs each animation to finish before the next starts.

import type { Command } from './bw/commands';

export interface Renderer {
  /**
   * Resolves when the command has finished showing. `instant` means apply it
   * with no animation. `upcoming` is what's queued after it, for a renderer
   * that needs to look ahead (BW2's battle intro needs the leads).
   */
  play(cmd: Command, instant: boolean, upcoming: readonly Command[]): Promise<void>;
  reset(): void;
}

export class Director {
  private queue: { cmd: Command; instant: boolean }[] = [];
  private running = false;
  private generation = 0;

  constructor(private readonly renderer: Renderer) {}

  get pending(): number {
    return this.queue.length;
  }

  /** Nothing queued and nothing playing. */
  get idle(): boolean {
    return !this.running && this.queue.length === 0;
  }

  enqueue(cmds: Command[], instant = false): void {
    for (const cmd of cmds) this.queue.push({ cmd, instant });
    void this.pump();
  }

  /** Drops everything queued and clears the screen. */
  reset(): void {
    this.queue = [];
    this.generation++;
    this.renderer.reset();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = this.generation;
    try {
      while (this.queue.length && gen === this.generation) {
        const { cmd, instant } = this.queue.shift()!;
        try {
          await this.renderer.play(cmd, instant, this.queue.map((q) => q.cmd));
        } catch (e) {
          console.error('renderer failed on', cmd, e);
        }
      }
    } finally {
      this.running = false;
    }
    // A reset during an await left newer commands for a fresh pump.
    if (this.queue.length) void this.pump();
  }
}
