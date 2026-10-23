import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SC, encodeBlock, MAX_BLOCK } from '../src/bw/servercmd';
import { type Bw2Side, Scene, estimateMaxHp, monSpec, newScreen } from '../src/emu/scene';
import { Translator } from '../src/translate';

const fixtures = new URL('./fixtures/', import.meta.url);
const log = (name: string) => readFileSync(new URL(name, fixtures), 'utf8').split('\n');

/** A PWT-like battle: three Pokémon a side, the player's mons 0–2, the opponent's 12–14. */
function sides(): [Bw2Side, Bw2Side] {
  const side = (client: number, first: number): Bw2Side => ({
    client,
    order: [first, first + 1, first + 2],
    hp: new Map([0, 1, 2].map((i) => [first + i, { hp: 90, maxHp: 90 }])),
  });
  return [side(0, 0), side(1, 12)];
}

function plan(name: string) {
  const scene = new Scene(sides());
  return new Translator().lines(log(name)).map((cmd) => ({ cmd, step: scene.plan(cmd) }));
}

describe('scene', () => {
  it('names both trainers when the battle starts, near side first', () => {
    const start = plan('gen5ou-2703228634.log').find((s) => s.cmd.kind === 'start')!;
    expect(start.step.trainers).toEqual([
      { client: 0, name: 'frosssted' },
      { client: 1, name: 'MajesticKath' },
    ]);
  });

  it('replaces the savestate’s Pokémon silently, then sends out Showdown’s', () => {
    const steps = plan('gen5ou-2703228634.log');
    const first = steps.find((s) => s.cmd.kind === 'switchIn')!;
    expect(first.step.writes).toEqual([
      expect.objectContaining({ client: 0, partyIndex: 1, monId: 1, mon: expect.objectContaining({ species: 186, nickname: 'Politoed', level: 100 }) }),
    ]);
    expect(first.step.cmds).toEqual([
      [SC.RECALL, 0, 0x26c],
      [SC.OP_CLEAR_FOR_SWITCH, 0],
      [SC.OP_SEND_IN, 0, 0, 1, 1],
      [SC.SEND_OUT, 0, 0, 1, 1],
    ]);
  });

  it('plays a hit as an HP change, the damage effect with its sound, then its text', () => {
    const steps = plan('gen5ou-2703228634.log');
    const i = steps.findIndex((s) => s.cmd.kind === 'move' && s.cmd.move === 'Foul Play');
    expect(steps[i].step.cmds).toEqual([
      [SC.MOVE_MSG, 13, 492], // Amoonguss went into party slot 1 (mon 13), then out front
      [SC.MOVE_ANIM, 1, 0, 492, 0],
    ]);
    // Ferrothorn (100%, estimated 352 max HP at Lv 100) to 93%.
    const hit = steps[i + 1].step.cmds;
    expect(hit[0][0]).toBe(SC.OP_SUBTRACT_HP);
    expect(hit[1]).toEqual([SC.DAMAGE, hit[0][1], 3, 492]); // 3: not very effective
  });

  it('keeps every block valid through whole battles', () => {
    for (const name of readdirSync(fixtures).filter((f) => f.endsWith('.log'))) {
      const scene = new Scene(sides());
      for (const cmd of new Translator().lines(log(name))) {
        const step = scene.plan(cmd);
        const block = encodeBlock(step.cmds);
        expect(block.length).toBeLessThanOrEqual(MAX_BLOCK);
        for (const w of step.writes) {
          expect(w.partyIndex).not.toBe(0); // never the Pokémon that's out
          expect(w.mon.hp).toBeLessThanOrEqual(w.mon.maxHp);
        }
      }
    }
  });
});

describe('catching up', () => {
  it('only changes battle data, then sends out the right Pokémon before the next animation', () => {
    const scene = new Scene(sides());
    const cmds = new Translator().lines(log('gen5ou-2703228634.log'));
    const firstTurn = cmds.findIndex((c) => c.kind === 'turn');
    for (const cmd of cmds.slice(0, firstTurn)) {
      for (const [n] of scene.plan(cmd, true).cmds) expect(n).toBeLessThan(SC.MOVE_ANIM);
    }
    const next = scene.plan(cmds[firstTurn + 1]);
    expect(next.cmds.slice(0, 4)).toEqual([
      [SC.RECALL, 0, 0x26c],
      [SC.SEND_OUT, 0, 0, 0, 0],
      [SC.RECALL, 1, 0x26c],
      [SC.SEND_OUT, 1, 0, 0, 0],
    ]);
  });
});

describe('the screen across battles', () => {
  it('never recalls a position that is already empty', () => {
    const screen = newScreen();
    screen.out[0] = false; // the last battle left the player's position empty
    const scene = new Scene(sides(), screen);
    const cmds = new Translator().lines(log('gen5ou-2703228634.log'));
    const firstTurn = cmds.findIndex((c) => c.kind === 'turn');
    cmds.slice(0, firstTurn).forEach((c) => scene.plan(c, true));
    const next = scene.plan(cmds[firstTurn + 1]);
    expect(next.cmds.slice(0, 3)).toEqual([
      [SC.SEND_OUT, 0, 0, 0, 0],
      [SC.RECALL, 1, 0x26c],
      [SC.SEND_OUT, 1, 0, 0, 0],
    ]);
    // The planned command is turn 1's switch-out, which empties the player's position again.
    expect(next.cmds.at(-1)).toEqual([SC.OP_CLEAR_FOR_SWITCH, expect.any(Number)]);
    expect(screen.out.slice(0, 2)).toEqual([false, true]);
  });
});

describe('monSpec', () => {
  it('falls back to the species name when the font can’t draw the nickname', () => {
    const mon = { name: '肥陀', species: 'Forretress', level: 100, gender: 'F' as const, shiny: false };
    expect(monSpec(mon, { hp: 100, maxHp: 100 }, null)?.nickname).toBe('Forretress');
    expect(monSpec({ ...mon, name: 'Pokémon♀' }, { hp: 100, maxHp: 100 }, null)?.nickname).toBe('Pokémon♀');
  });

  it('uses exact HP when Showdown gives it, and estimates max HP from a percentage', () => {
    const mon = { name: 'Chompy', species: 'Garchomp', level: 50, gender: 'M' as const, shiny: true };
    expect(monSpec(mon, { hp: 150, maxHp: 183 }, null)).toMatchObject({ species: 445, form: 0, hp: 150, maxHp: 183, nickname: 'Chompy', shiny: true });
    const est = estimateMaxHp(108, 50);
    expect(monSpec(mon, { hp: 50, maxHp: 100 }, 'brn')).toMatchObject({ maxHp: est, hp: Math.round(est / 2), status: 'brn' });
    expect(monSpec({ ...mon, species: 'Rotom-Wash' }, { hp: 1, maxHp: 100 }, null)).toMatchObject({ species: 479, form: 2, hp: 1 });
  });
});

describe('Showdown decides HP', () => {
  it('says what HP each hit, faint and switch-in should leave, to check the game against', () => {
    const steps = plan('gen5ou-2703228634.log');
    const i = steps.findIndex((s) => s.cmd.kind === 'move' && s.cmd.move === 'Foul Play');
    const [subtract] = steps[i + 1].step.cmds;
    const [after] = steps[i + 1].step.hp;
    expect(after.monId).toBe(subtract[1]); // the Pokémon that was hit
    expect(after.hp + subtract[2]).toBeLessThanOrEqual(after.maxHp);
    const faint = steps.find((s) => s.cmd.kind === 'faint')!;
    expect(faint.step.hp).toEqual([expect.objectContaining({ hp: 0 })]);
    const switchIn = steps.find((s) => s.cmd.kind === 'switchIn')!;
    expect(switchIn.step.hp).toEqual([expect.objectContaining({ hp: switchIn.step.writes[0].mon.hp, maxHp: switchIn.step.writes[0].mon.maxHp })]);
  });
});

describe('the end of a battle', () => {
  const end = (winner: string | null, winBgm = 1263) => {
    const scene = new Scene(sides(), newScreen(), winBgm);
    new Translator().lines(log('gen5ou-2703228634.log')).forEach((cmd) => scene.plan(cmd, true));
    // What follows the catch-up's send-outs.
    return scene.plan({ kind: 'end', winner }).cmds.filter(([n]) => n === SC.PLAY_BGM || n === SC.MSG_STD);
  };

  it('plays the victory music and "Player defeated X!" when the near side wins', () => {
    expect(end('frosssted')).toEqual([
      [SC.PLAY_BGM, 1263],
      [SC.MSG_STD, 0x2c, 1],
    ]);
  });

  it('says the near side lost, or drew', () => {
    expect(end('MajesticKath')).toEqual([[SC.MSG_STD, 0x2e, 1]]);
    expect(end(null)).toEqual([[SC.MSG_STD, 0x2f, 1]]);
  });

  it('packs the music as one halfword', () => {
    expect([...encodeBlock([[SC.PLAY_BGM, 1263]])]).toEqual([0x00, 0x55, 0x04, 0xef]);
  });
});
