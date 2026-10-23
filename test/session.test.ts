import { describe, expect, it } from 'vitest';
import type { Command } from '../src/bw/commands';
import { Session } from '../src/session';

function received(message: string) {
  const got: { kinds: string[]; instant: boolean }[] = [];
  const session = new Session({ follow() {}, commands: (cmds: Command[], instant) => got.push({ kinds: cmds.map((c) => c.kind), instant }) });
  session.receive(message);
  return got;
}

const opening = ['|init|battle', '|player|p1|Me|1|', '|player|p2|Foe|2|', '|gametype|singles', '|gen|5', '|start|',
  '|switch|p1a: Chompy|Garchomp, L50|183/183', '|switch|p2a: Rotom|Rotom-Wash, L50|100/100', '|turn|1'];

describe('catching up on a battle joined mid-way', () => {
  it('plays a battle that has only just started from its start, send-outs and all', () => {
    const got = received(['>battle-gen5ou-1', ...opening].join('\n'));
    const animated = got.filter((g) => !g.instant).flatMap((g) => g.kinds);
    expect(animated).toEqual(['start', 'switchIn', 'switchIn', 'turn']);
  });

  it('draws earlier turns instantly and animates only the latest', () => {
    const later = [...opening, '|move|p1a: Chompy|Earthquake|p2a: Rotom', '|-immune|p2a: Rotom', '|turn|2', '|move|p1a: Chompy|Outrage|p2a: Rotom'];
    const got = received(['>battle-gen5ou-1', ...later].join('\n'));
    expect(got.filter((g) => g.instant).flatMap((g) => g.kinds)).toContain('switchIn');
    expect(got.filter((g) => !g.instant).flatMap((g) => g.kinds)).toEqual(['turn', 'move']);
  });
});
