import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Command } from '../src/bw/commands';
import { describe as describeCmd, makeNamer } from '../src/bw/english';
import { baseSpecies, parseDetails, parseHpStatus, parseLine, parseRef, splitMessage } from '../src/showdown/protocol';
import { Session } from '../src/session';
import { Translator } from '../src/translate';

const fixtures = new URL('./fixtures/', import.meta.url);
const log = (name: string) => readFileSync(new URL(name, fixtures), 'utf8').split('\n');

describe('protocol', () => {
  it('names a species without its form, as the games do', () => {
    expect(['Arcanine-Hisui', 'Charizard-Mega-Y', 'Tauros-Paldea-Aqua', 'Garchomp', 'Ho-Oh', 'Porygon-Z', 'Kommo-o-Totem', 'Chi-Yu'].map(baseSpecies)).toEqual([
      'Arcanine', 'Charizard', 'Tauros', 'Garchomp', 'Ho-Oh', 'Porygon-Z', 'Kommo-o', 'Chi-Yu',
    ]);
  });

  it('splits args from tags', () => {
    expect(parseLine('|-damage|p2a: Amoonguss|88/100|[from] ability: Iron Barbs|[of] p1a: Ferrothorn')).toEqual({
      cmd: '-damage',
      args: ['p2a: Amoonguss', '88/100'],
      kw: { from: 'ability: Iron Barbs', of: 'p1a: Ferrothorn' },
    });
    expect(parseLine('|move|p1a: Kyurem|Outrage|p2a: Skarmory|[from]lockedmove')?.kw).toEqual({ from: 'lockedmove' });
    expect(parseLine('|move|p1a: Zapdos|Roost|p1a: Zapdos|[still]')?.kw).toEqual({ still: '' });
  });

  it('keeps pipes in chat text', () => {
    expect(parseLine('|c|☆frosssted|a | b')?.args).toEqual(['☆frosssted', 'a | b']);
  });

  it('parses refs, details and hp', () => {
    expect(parseRef('p2a: Heatran')).toEqual({ side: 'p2', pos: 0, name: 'Heatran' });
    expect(parseRef('p2: MajesticKath')).toEqual({ side: 'p2', pos: null, name: 'MajesticKath' });
    expect(parseRef('p1b')).toEqual({ side: 'p1', pos: 1, name: '' });
    expect(parseDetails('Thundurus-Therian, L84, M, shiny')).toEqual({ species: 'Thundurus-Therian', level: 84, gender: 'M', shiny: true });
    expect(parseHpStatus('17/100 brn')).toEqual({ hp: 17, maxHp: 100, status: 'brn', fainted: false });
    expect(parseHpStatus('0 fnt')).toEqual({ hp: 0, maxHp: 0, status: null, fainted: true });
  });

  it('splits room messages', () => {
    expect(splitMessage('>battle-gen5ou-1\n|turn|2')).toEqual({ room: 'battle-gen5ou-1', lines: ['|turn|2'] });
    expect(splitMessage('|updateuser| Neal|1|1|{}').room).toBe('');
  });
});

describe('translator', () => {
  const opening = () => new Translator().lines(log('gen5ou-2703228634.log'));

  it('starts the battle with both trainers, p1 near by default', () => {
    const start = opening().find((c) => c.kind === 'start');
    expect(start).toMatchObject({ gameType: 'singles', trainers: [{ name: 'frosssted' }, { name: 'MajesticKath' }] });
  });

  it('shows the ability popup before the weather it causes', () => {
    const cmds = opening();
    const i = cmds.findIndex((c) => c.kind === 'ability' && c.ability === 'Drizzle');
    expect(cmds[i]).toEqual({ kind: 'ability', slot: { side: 0, pos: 0 }, ability: 'Drizzle' });
    expect(cmds[i + 1]).toMatchObject({ kind: 'weather', weather: 'RainDance', upkeep: false });
  });

  it('withdraws the old Pokémon before a voluntary switch', () => {
    const cmds = opening();
    const i = cmds.findIndex((c) => c.kind === 'switchIn' && c.mon.species === 'Ferrothorn');
    expect(cmds[i - 1]).toMatchObject({ kind: 'switchOut', mon: { species: 'Politoed' } });
  });

  it('puts effectiveness text after the HP drop, as BW2 does', () => {
    const cmds = opening();
    const i = cmds.findIndex((c) => c.kind === 'move' && c.move === 'Foul Play');
    expect(cmds.slice(i, i + 5).map((c) => c.kind + (c.kind === 'text' ? `:${c.key}` : ''))).toEqual([
      'move',
      'hp',
      'text:resisted',
      'ability', // Iron Barbs
      'hp',
    ]);
    expect(cmds[i + 1]).toMatchObject({ kind: 'hp', hit: { crit: false, effectiveness: 'resisted' } });
    expect(cmds[i + 4]).toMatchObject({ kind: 'hp', slot: { side: 1, pos: 0 }, from: { kind: 'ability', name: 'Iron Barbs' }, of: { side: 0, pos: 0 } });
    expect(cmds[i + 4]).not.toHaveProperty('hit');
  });

  it('flags a missed move and prints the miss once', () => {
    const t = new Translator();
    const cmds = t.lines(log('gen5ou-2703216636.log').slice(0, 83));
    expect(cmds.find((c) => c.kind === 'move' && c.move === 'Power Whip')).toMatchObject({ missed: true });
    expect(cmds.filter((c) => c.kind === 'text' && c.key === 'miss')).toHaveLength(1);
  });

  it('draws the viewer’s side near', () => {
    const t = new Translator({ viewer: () => 'Majestic Kath' });
    const cmds = t.lines(log('gen5ou-2703228634.log'));
    expect(cmds.find((c) => c.kind === 'start')).toMatchObject({ trainers: [{ name: 'MajesticKath' }, { name: 'frosssted' }] });
    expect(cmds.find((c) => c.kind === 'switchIn')).toMatchObject({ slot: { side: 1 }, mon: { species: 'Politoed' } });
  });

  it.each(readdirSync(fixtures).filter((f) => f.endsWith('.log')))('handles every battle line in %s', (name) => {
    const t = new Translator();
    const cmds = t.lines(log(name));
    expect([...t.unhandled.keys()]).toEqual([]);
    expect(cmds.filter((c) => c.kind === 'end')).toHaveLength(1);
    // Every command that refers to a slot refers to one with a Pokémon in it.
    const filled = new Set<string>();
    for (const c of cmds) {
      if (c.kind === 'switchIn') filled.add(`${c.slot.side}:${c.slot.pos}`);
      for (const s of slotsOf(c)) expect(filled.has(`${s.side}:${s.pos}`), `${c.kind} before a switch-in`).toBe(true);
    }
    // And every command reads as a line of battle text without throwing.
    const n = makeNamer(() => 'X');
    for (const c of cmds) describeCmd(c, n, () => 'Trainer');
  });
});

describe('english', () => {
  it('lowercases the foe mid-sentence', () => {
    const n = makeNamer(() => 'Landorus');
    const cmd: Command = { kind: 'hp', slot: { side: 1, pos: 0 }, hp: { hp: 88, maxHp: 100 }, change: 'damage', from: { kind: 'other', name: 'Stealth Rock' } };
    expect(describeCmd(cmd, n, () => '')).toBe("Pointed stones dug into the foe's Landorus!");
  });
});

describe('session', () => {
  it('catches up instantly on a battle joined mid-way and animates only the latest turn', () => {
    const lines = log('gen5ou-2703228634.log');
    const lastTurn = lines.findLastIndex((l) => l.startsWith('|turn|'));
    const batches: { instant: boolean; kinds: string[] }[] = [];
    const s = new Session({ follow() {}, commands: (cmds, instant) => batches.push({ instant, kinds: cmds.map((c) => c.kind) }) });
    s.receive(`>battle-gen5ou-1\n|init|battle\n${lines.slice(0, lastTurn + 1).join('\n')}`);
    expect(batches.map((b) => b.instant)).toEqual([true, false]);
    expect(batches[1].kinds).toEqual(['turn']);
  });

  it('follows the newest battle', () => {
    const follows: string[] = [];
    const s = new Session({ follow: (room) => follows.push(room), commands() {} });
    s.receive('>battle-gen5ou-1\n|init|battle\n|gen|5');
    s.receive('>battle-gen5ou-2\n|init|battle\n|gen|5');
    s.receive('>battle-gen5ou-1\n|turn|3');
    expect(follows).toEqual(['battle-gen5ou-1', 'battle-gen5ou-2']);
    expect(s.followed).toBe('battle-gen5ou-2');
  });
});

function slotsOf(c: Command) {
  switch (c.kind) {
    case 'move':
      return [c.user, ...c.targets];
    case 'charge':
      return [c.user];
    case 'hp':
    case 'faint':
    case 'status':
    case 'boost':
    case 'ability':
    case 'cant':
    case 'switchOut':
    case 'formChange':
      return [c.slot];
    default:
      return [];
  }
}
