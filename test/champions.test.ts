// Pokémon Champions VGC (doubles, Megas) in BW2: what borrows a slot or a line,
// and what BW2 still can't show, across real Champions VGC replays. The
// snapshots change when something is filled in (good: update them) or newly
// missing (look at it).

import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SC } from '../src/bw/servercmd';
import { BorrowingDex } from '../src/emu/dex';
import { type Bw2Side, Scene, newScreen } from '../src/emu/scene';
import { Translator } from '../src/translate';

const fixtures = new URL('./fixtures/champions/', import.meta.url);

/** The Pokémon BW2 has forms of, and how many (its personal data says so in the game). */
const FORMS: Record<number, number> = {
  201: 28, 351: 4, 386: 4, 412: 3, 413: 3, 421: 2, 422: 2, 423: 2, 479: 6, 487: 2, 492: 2, 493: 17, 550: 2, 555: 2,
  585: 4, 586: 4, 641: 2, 642: 2, 645: 2, 646: 3, 647: 2, 648: 2, 649: 5,
};

/** A PWT doubles battle: four Pokémon a side, the first two out. */
function sides(): [Bw2Side, Bw2Side] {
  const side = (client: number, first: number): Bw2Side => ({
    client,
    order: [0, 1, 2, 3].map((i) => first + i),
    hp: new Map([0, 1, 2, 3].map((i) => [first + i, { hp: 90, maxHp: 90 }])),
  });
  return [side(0, 0), side(1, 12)];
}

it('shows Champions VGC battles, borrowing what BW2 lacks', () => {
  const gaps = new Map<string, number>();
  const unhandled = new Map<string, number>();
  const lines = new Set<string>();
  for (const name of readdirSync(fixtures).filter((f) => f.endsWith('.log')).sort()) {
    const dex = new BorrowingDex((num) => FORMS[num] ?? 1);
    const scene = new Scene(sides(), newScreen(2), 0, 2, dex);
    const translator = new Translator();
    for (const cmd of translator.lines(readFileSync(new URL(name, fixtures), 'utf8').split('\n'))) {
      for (const w of scene.plan(cmd).work) {
        if (w.kind === 'line' && w.bank === 'std') lines.add(w.text[0].replace(/\n/g, ' '));
      }
    }
    for (const [what, n] of scene.gaps) gaps.set(what, (gaps.get(what) ?? 0) + n);
    for (const [what, n] of translator.unhandled) unhandled.set(what, (unhandled.get(what) ?? 0) + n);
  }
  const report = (m: Map<string, number>) => [...m].sort(([a], [b]) => a.localeCompare(b)).map(([what, n]) => `${what} ×${n}`);
  expect(report(unhandled)).toMatchSnapshot('protocol not translated');
  expect(report(gaps)).toMatchSnapshot('gaps');
  expect([...lines].sort()).toMatchSnapshot('lines in English');
});

it('Mega Evolves a Pokémon by rewriting it as a borrowed slot, then changing its form', () => {
  const dex = new BorrowingDex((num) => FORMS[num] ?? 1);
  const scene = new Scene(sides(), newScreen(2), 0, 2, dex);
  const steps = new Translator()
    .lines([
      '|gametype|doubles',
      '|player|p1|a|1',
      '|player|p2|b|2',
      '|gen|9',
      '|start',
      '|switch|p1a: Charizard|Charizard, L50, M|100/100',
      '|switch|p1b: Pelipper|Pelipper, L50, F|100/100',
      '|switch|p2a: Garchomp|Garchomp, L50, M|100/100',
      '|switch|p2b: Sneasler|Sneasler, L50, F|100/100',
      '|turn|1',
      '|detailschange|p1a: Charizard|Charizard-Mega-Y, L50, M',
      '|-mega|p1a: Charizard|Charizard|Charizardite Y',
    ])
    .map((cmd) => ({ cmd, step: scene.plan(cmd) }));
  const change = steps.find((s) => s.cmd.kind === 'formChange')!.step;
  const mega = dex.species('Charizard-Mega-Y')!;
  expect(mega.native).toBe(false);
  expect(change.writes).toEqual([expect.objectContaining({ client: 0, partyIndex: 0, mon: expect.objectContaining({ species: mega.num, form: 0 }) })]);
  expect(change.work).toContainEqual(expect.objectContaining({ kind: 'sprite', species: mega.num, spriteId: 'charizard-megay' }));
  expect(change.cmds.map(([n]) => n)).toEqual([SC.MOVE_ANIM, SC.CHANGE_FORM]);
  const said = steps.find((s) => s.cmd.kind === 'mega')!.step;
  expect(said.work).toContainEqual(expect.objectContaining({ kind: 'line', bank: 'set', text: expect.arrayContaining(["{nickname:0} has Mega\nEvolved into Mega Charizard Y!"]) }));
  expect(said.cmds.map(([n]) => n)).toEqual([SC.MSG_SET]);
});
