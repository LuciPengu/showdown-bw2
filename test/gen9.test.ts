// Gen 9 battles in BW2: what borrows a slot or a line, and what BW2 still can't
// show, across real Gen 9 replays. The snapshots change when something is
// filled in (good: update them) or newly missing (look at it).

import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BorrowingDex } from '../src/emu/dex';
import { type Bw2Side, Scene, wrap } from '../src/emu/scene';
import { Translator } from '../src/translate';

const fixtures = new URL('./fixtures/gen9/', import.meta.url);

/** The Pokémon BW2 has forms of, and how many (its personal data says so in the game). */
const FORMS: Record<number, number> = {
  201: 28, 351: 4, 386: 4, 412: 3, 413: 3, 421: 2, 422: 2, 423: 2, 479: 6, 487: 2, 492: 2, 493: 17, 550: 2, 555: 2,
  585: 4, 586: 4, 641: 2, 642: 2, 645: 2, 646: 3, 647: 2, 648: 2, 649: 5,
};

function sides(): [Bw2Side, Bw2Side] {
  const side = (client: number, first: number): Bw2Side => ({
    client,
    order: [0, 1, 2, 3, 4, 5].map((i) => first + i),
    hp: new Map([0, 1, 2, 3, 4, 5].map((i) => [first + i, { hp: 90, maxHp: 90 }])),
  });
  return [side(0, 0), side(1, 12)];
}

it('shows Gen 9 battles, borrowing what BW2 lacks', () => {
  const gaps = new Map<string, number>();
  const lines = new Set<string>();
  let borrowed = 0;
  for (const name of readdirSync(fixtures).filter((f) => f.endsWith('.log')).sort()) {
    const dex = new BorrowingDex((num) => FORMS[num] ?? 1);
    const scene = new Scene(sides(), undefined, 0, 1, dex);
    for (const cmd of new Translator().lines(readFileSync(new URL(name, fixtures), 'utf8').split('\n'))) {
      for (const w of scene.plan(cmd).work) {
        if (w.kind === 'line' && w.bank === 'std') lines.add(w.text[0].replace(/\n/g, ' '));
        else borrowed++;
      }
    }
    for (const [what, n] of scene.gaps) gaps.set(what, (gaps.get(what) ?? 0) + n);
  }
  expect(borrowed).toBeGreaterThan(0);
  expect([...gaps].sort(([a], [b]) => a.localeCompare(b)).map(([what, n]) => `${what} ×${n}`)).toMatchSnapshot('gaps');
  expect([...lines].sort()).toMatchSnapshot('lines in English');
});

it('wraps English lines for BW2\'s message box', () => {
  expect(wrap('It started to snow!')).toBe('It started to snow!');
  expect(wrap("The harsh sunlight activated Great Tusk's Protosynthesis!")).toBe("The harsh sunlight activated\nGreat Tusk's Protosynthesis!");
  expect(wrap('a'.repeat(70))).toBe(`${'a'.repeat(30)}\n${'a'.repeat(29)}…`);
});
