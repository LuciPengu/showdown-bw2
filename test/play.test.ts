import { describe, expect, it } from 'vitest';
import { decodeAction } from '../src/emu/bw2';
import { moveNumber, teamFromRequest, toChoice } from '../src/play';
import type { ShowdownRequest } from '../src/session';

const request: ShowdownRequest = {
  rqid: 7,
  active: [
    {
      moves: [
        { move: 'Earthquake', id: 'earthquake', pp: 14, maxpp: 16 },
        { move: 'Outrage', id: 'outrage', pp: 16, maxpp: 16 },
        { move: 'Hidden Power Fire 70', id: 'hiddenpowerfire70', pp: 24, maxpp: 24 },
        { move: 'Swords Dance', id: 'swordsdance', pp: 32, maxpp: 32 },
      ],
    },
  ],
  side: {
    id: 'p2',
    pokemon: [
      { ident: 'p2: Chompy', details: 'Garchomp, L50, F', condition: '150/183', active: true, moves: ['earthquake', 'outrage', 'hiddenpowerfire70', 'swordsdance'] },
      { ident: 'p2: Ferrothorn', details: 'Ferrothorn, L50, M', condition: '0 fnt', active: false, moves: ['powerwhip', 'gyroball', 'leechseed', 'stealthrock'] },
      { ident: 'p2: Starmie', details: 'Starmie, L50', condition: '120/135 par', active: false, moves: ['surf', 'thunderbolt', 'icebeam', 'recover'] },
    ],
  },
};

describe('reading a request', () => {
  it('maps move ids to BW2 numbers, Hidden Power and Return included', () => {
    expect(moveNumber('earthquake')).toBe(89);
    expect(moveNumber('hiddenpowerfire70')).toBe(237);
    expect(moveNumber('return102')).toBe(216);
    expect(moveNumber('notamove')).toBeUndefined();
  });

  it('builds the team with exact HP, status, and the active Pokémon’s PP', () => {
    const team = teamFromRequest(request);
    expect(team.map((m) => m.name)).toEqual(['Chompy', 'Ferrothorn', 'Starmie']);
    expect(team[0].spec).toMatchObject({ species: 445, level: 50, gender: 'F', hp: 150, maxHp: 183 });
    expect(team[0].moves).toEqual([
      { id: 89, pp: 14, maxPp: 16 },
      { id: 200, pp: 16, maxPp: 16 },
      { id: 237, pp: 24, maxPp: 24 },
      { id: 14, pp: 32, maxPp: 32 },
    ]);
    expect(team[2].spec).toMatchObject({ status: 'par', hp: 120 });
  });
});

describe('turning a BW2 pick into a choice', () => {
  const slots = ['Chompy', 'Starmie', 'Ferrothorn']; // BW2 party order can differ from Showdown's
  const nameAt = (i: number) => slots[i];

  it('finds a fight’s move by its number', () => {
    expect(toChoice({ kind: 'fight', move: 237, target: 1 }, request, nameAt)).toBe('move 3');
    expect(toChoice({ kind: 'fight', move: 85, target: 1 }, request, nameAt)).toBeNull();
  });

  it('finds a switch’s Pokémon by name, and refuses the active or fainted one', () => {
    expect(toChoice({ kind: 'switch', partyIndex: 1 }, request, nameAt)).toBe('switch 3');
    expect(toChoice({ kind: 'switch', partyIndex: 2 }, request, nameAt)).toBeNull(); // fainted
    expect(toChoice({ kind: 'switch', partyIndex: 0 }, request, nameAt)).toBeNull(); // already out
  });

  it('has no choice for the bag or running', () => {
    expect(toChoice({ kind: 'other', action: 2 }, request, nameAt)).toBeNull();
  });
});

describe('decodeAction', () => {
  it('unpacks BattleAction words', () => {
    // fight: action 1, target 1, move 89
    expect(decodeAction(1 | (1 << 4) | (89 << 7))).toEqual({ kind: 'fight', target: 1, move: 89 });
    // switch: action 3, slot 4
    expect(decodeAction(3 | (4 << 7))).toEqual({ kind: 'switch', partyIndex: 4 });
    expect(decodeAction(4)).toEqual({ kind: 'other', action: 4 });
  });
});
