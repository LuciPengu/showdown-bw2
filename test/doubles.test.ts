import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SC } from '../src/bw/servercmd';
import { type Bw2Side, Scene, newScreen } from '../src/emu/scene';
import { showdownTarget, toChoices } from '../src/play';
import type { ShowdownRequest } from '../src/session';
import { Translator } from '../src/translate';

const fixtures = new URL('./fixtures/doubles/', import.meta.url);
const log = (name: string) => readFileSync(new URL(name, fixtures), 'utf8').split('\n');

/** A PWT doubles battle: four Pokémon a side, the first two out. */
function sides(): [Bw2Side, Bw2Side] {
  const side = (client: number, first: number): Bw2Side => ({
    client,
    order: [0, 1, 2, 3].map((i) => first + i),
    hp: new Map([0, 1, 2, 3].map((i) => [first + i, { hp: 90, maxHp: 90 }])),
  });
  return [side(0, 0), side(1, 12)];
}

const mon = (ident: string, active: boolean, condition = '100/100') => ({ ident, details: 'Garchomp, L50', condition, active, moves: [] });
const moves = [
  { move: 'Earthquake', id: 'earthquake', pp: 16, maxpp: 16, target: 'allAdjacent' },
  { move: 'Dragon Claw', id: 'dragonclaw', pp: 24, maxpp: 24, target: 'normal' },
];
const request: ShowdownRequest = {
  rqid: 3,
  active: [{ moves }, { moves }],
  side: { id: 'p1', pokemon: [mon('p1: A', true), mon('p1: B', true), mon('p1: C', false), mon('p1: D', false)] },
};
const nameAt = (i: number) => ['A', 'B', 'C', 'D'][i];

describe('doubles choices', () => {
  it('maps BW2 battle positions to Showdown targets: foes positive, allies negative', () => {
    expect([0, 1, 2, 3].map(showdownTarget)).toEqual([-1, 1, -2, 2]);
  });

  it('gives a target only to moves that take one', () => {
    const choice = toChoices(
      [
        { kind: 'fight', move: 89, target: 1 },
        { kind: 'fight', move: 337, target: 3 },
      ],
      request,
      nameAt,
    );
    expect(choice).toBe('move 1, move 2 2');
  });

  it('passes for a fainted Pokémon, and fills forced switches in order', () => {
    const fainted = { ...request, side: { ...request.side, pokemon: [mon('p1: A', true, '0 fnt'), ...request.side.pokemon.slice(1)] } };
    expect(toChoices([{ kind: 'fight', move: 337, target: 1 }], fainted, nameAt)).toBe('pass, move 2 1');
    // BW2's action menu answers once per position, with an empty action for the fainted one.
    expect(toChoices([{ kind: 'other', action: 0 }, { kind: 'fight', move: 337, target: 3 }], fainted, nameAt)).toBe('pass, move 2 2');
    const forced = { ...request, active: undefined, forceSwitch: [false, true] };
    expect(toChoices([{ kind: 'switch', partyIndex: 3 }], forced, nameAt)).toBe('pass, switch 4');
  });
});

describe('doubles scene', () => {
  const plan = (name: string) => {
    const scene = new Scene(sides(), newScreen(2), 0, 2);
    return new Translator().lines(log(name)).map((cmd) => ({ cmd, step: scene.plan(cmd) }));
  };

  it('starts with both Pokémon a side out', () => {
    expect(newScreen(2).out).toEqual([true, true, true, true, false, false]);
  });

  it.each(readdirSync(fixtures).filter((f) => f.endsWith('.log')))('never writes an incoming Pokémon over the other active one in %s', (name) => {
    for (const { cmd, step } of plan(name)) {
      if (cmd.kind !== 'switchIn') continue;
      for (const w of step.writes) expect(w.partyIndex === cmd.slot.pos || w.partyIndex >= 2).toBe(true);
    }
  });

  it('animates from the user’s battle position to the target’s', () => {
    const steps = plan('gen5doublesou-2696807960.log');
    const rockSlide = steps.find((s) => s.cmd.kind === 'move' && s.cmd.move === 'Rock Slide' && s.cmd.user.side === 1)!;
    const anim = rockSlide.step.cmds.find(([n]) => n === SC.MOVE_ANIM)!;
    expect(rockSlide.cmd).toMatchObject({ user: { side: 1, pos: 0 }, targets: [{ side: 0, pos: 0 }, { side: 0, pos: 1 }] });
    expect(anim.slice(1, 3)).toEqual([1, 0]); // p2a is position 1, p1a position 0
  });
});
