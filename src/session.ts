// Routes raw Showdown websocket messages to one Translator per battle room and
// decides which battle is on screen.

import type { Command } from './bw/commands';
import { splitMessage, toID } from './showdown/protocol';
import { Translator } from './translate';

export interface SessionEvents {
  /** A new battle took over the screen; the renderer should clear. */
  follow(room: string, translator: Translator): void;
  /** Commands for the battle on screen. `instant` ones are history to catch up on, not to animate. */
  commands(cmds: Command[], instant: boolean): void;
  /** Showdown asked the logged-in player for a choice in the battle on screen. `live` is false for history. */
  request?(room: string, request: ShowdownRequest, live: boolean): void;
  /** Showdown rejected the player's last choice. */
  choiceError?(room: string, message: string): void;
}

/** The parts of Showdown's `|request|` JSON this app reads. */
export interface ShowdownRequest {
  rqid?: number;
  wait?: boolean;
  teamPreview?: boolean;
  forceSwitch?: boolean[];
  active?: { moves: { move: string; id: string; pp: number; maxpp: number; disabled?: boolean }[]; trapped?: boolean }[];
  side: {
    id: string;
    pokemon: {
      ident: string;
      details: string;
      condition: string;
      active: boolean;
      moves: string[];
      baseAbility?: string;
      item?: string;
    }[];
  };
}

export class Session {
  /** The logged-in user, from `|updateuser|`. Their side is drawn near. */
  viewer = '';
  followed: string | null = null;
  private rooms = new Map<string, Translator>();

  constructor(private readonly events: SessionEvents) {}

  /**
   * Takes one websocket message. A `|init|battle` message holds the whole
   * battle so far: with `catchUp`, everything before its last turn is drawn
   * instantly and only the latest turn animates. With `instant`, nothing animates.
   */
  receive(message: string, { catchUp = true, instant = false } = {}): void {
    const { room, lines } = splitMessage(message);
    if (!room) {
      for (const line of lines) {
        const m = /^\|updateuser\|([^|]*)/.exec(line);
        if (m) this.viewer = toID(m[1]).startsWith('guest') ? '' : m[1].trim();
      }
      return;
    }
    if (!room.startsWith('battle-')) return;

    const isInit = lines.some((l) => l.startsWith('|init|battle'));
    let t = this.rooms.get(room);
    if (!t || isInit) {
      t = new Translator({ viewer: () => this.viewer });
      this.rooms.set(room, t);
    }
    if (isInit || this.followed === null) {
      this.followed = room;
      this.events.follow(room, t);
    }
    if (room !== this.followed) {
      t.lines(lines); // keep its state current in case it's followed later
      return;
    }

    for (const line of lines) {
      if (line.startsWith('|request|')) {
        try {
          const req = JSON.parse(line.slice('|request|'.length) || 'null') as ShowdownRequest | null;
          if (req?.side) this.events.request?.(room, req, !instant);
        } catch {
          // a partial request carries nothing to act on
        }
      } else if (line.startsWith('|error|[Invalid choice]') || line.startsWith('|error|[Unavailable choice]')) {
        this.events.choiceError?.(room, line.slice('|error|'.length));
      }
    }

    const split = instant ? lines.length : isInit && catchUp ? lastTurnIndex(lines) : 0;
    if (split > 0) this.events.commands(t.lines(lines.slice(0, split)), true);
    if (split < lines.length) this.events.commands(t.lines(lines.slice(split)), false);
  }

  /** Plays a finished battle log (a replay) from the start. */
  playLog(room: string, log: string): void {
    this.receive(`>${room}\n|init|battle\n${log}`, { catchUp: false });
  }
}

function lastTurnIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('|turn|')) return i;
  return 0;
}
