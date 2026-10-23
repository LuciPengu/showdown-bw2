import { describe, expect, it } from 'vitest';
import { MOVE_NUMBERS } from '../src/bw/moves';
import { SC, encodeBlock } from '../src/bw/servercmd';

describe('encodeBlock', () => {
  it('packs a move animation exactly as the block that played Thunderbolt in the game', () => {
    expect([...encodeBlock([[SC.MOVE_ANIM, 0, 1, 85, 0]])]).toEqual([0x00, 0x30, 0x00, 0x40, 0x55, 0x00, 0x00, 0x5f, 3, 0, 0, 0]);
  });

  it('pads every block to whole words, and only when needed', () => {
    for (let n = 1; n <= 6; n++) {
      const block = encodeBlock(Array.from({ length: n }, () => [SC.UPDATE_HP_GAUGE, 1] as [number, number]));
      expect(block.length % 4).toBe(0);
      expect(block.length - n * 3).toBeLessThan(7);
    }
    expect(encodeBlock([[SC.OP_SUBTRACT_HP, 1, 20]]).length).toBe(8); // 5 bytes + RESERVE(3) = 8, no extra room
    expect([...encodeBlock([[SC.WEATHER_START, 1, 5]])]).toEqual([0x00, 0x3f, 1, 5]); // already whole
  });

  it('packs bit fields high bits first', () => {
    // SC_SEND_OUT is 5_3_5_3: (5, 2), (1, 0)
    expect([...encodeBlock([[SC.SEND_OUT, 5, 2, 1, 0]])]).toEqual([0x00, 0x3d, (5 << 3) | 2, (1 << 3) | 0]);
    // SC_STAT_UP_EFFECT is 5_5_5 in a halfword
    expect([...encodeBlock([[SC.STAT_UP_EFFECT, 1, 2, 3]])].slice(0, 4)).toEqual([0x00, 0x37, 0x04, 0x43]);
  });

  it('packs messages as an ID halfword, argument words and the end marker', () => {
    // "X's Attack rose!" as ServerDisplay_StatChange writes it: SET 0x1b, mon 12, stat 1, 1 stage
    expect([...encodeBlock([[SC.MSG_SET, 0x1b, 12, 1, 1]])]).toEqual([
      0x00, 0x5b, 0x00, 0x1b, 0, 0, 0, 12, 0, 0, 0, 1, 0, 0, 0, 1, 0xff, 0xff, 0, 0,
    ]);
  });

  it('rejects the wrong number of arguments', () => {
    expect(() => encodeBlock([[SC.MOVE_ANIM, 0, 1, 85]])).toThrow(/takes 4 arguments/);
  });
});

describe('move numbers', () => {
  it('match the national numbers BW2 uses', () => {
    expect(MOVE_NUMBERS.thunderbolt).toBe(85);
    expect(MOVE_NUMBERS.surf).toBe(57);
    expect(MOVE_NUMBERS.fusionbolt).toBe(559);
    expect(MOVE_NUMBERS.hiddenpowerice).toBe(237);
    expect(Object.values(MOVE_NUMBERS).every((n) => n >= 1 && n <= 559)).toBe(true);
  });
});
