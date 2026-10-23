// What BW2 can't show yet across the fixture replays. The snapshot changes when
// a gap is filled (good: update it) or a new one appears (look at it).

import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { type Bw2Side, Scene } from '../src/emu/scene';
import { Translator } from '../src/translate';

const fixtures = new URL('./fixtures/', import.meta.url);

function sides(): [Bw2Side, Bw2Side] {
  const side = (client: number, first: number): Bw2Side => ({
    client,
    order: [0, 1, 2, 3, 4, 5].map((i) => first + i),
    hp: new Map([0, 1, 2, 3, 4, 5].map((i) => [first + i, { hp: 90, maxHp: 90 }])),
  });
  return [side(0, 0), side(1, 12)];
}

it('lists what BW2 has no line or animation for', () => {
  const gaps = new Map<string, number>();
  for (const name of readdirSync(fixtures).filter((f) => f.endsWith('.log')).sort()) {
    const scene = new Scene(sides());
    for (const cmd of new Translator().lines(readFileSync(new URL(name, fixtures), 'utf8').split('\n'))) scene.plan(cmd);
    for (const [what, n] of scene.gaps) gaps.set(what, (gaps.get(what) ?? 0) + n);
  }
  const report = [...gaps].sort(([a], [b]) => a.localeCompare(b)).map(([what, n]) => `${what} ×${n}`);
  expect(report).toMatchSnapshot();
});
