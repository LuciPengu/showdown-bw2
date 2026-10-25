import { describe, expect, it } from 'vitest';
import { DONORS } from '../src/bw/later';
import { BorrowingDex, nativeDex } from '../src/emu/dex';

/** BW2's form counts for the species these tests use: Rotom has six, the rest one. */
const forms = (num: number) => (num === 479 ? 6 : 1);

describe('the dex', () => {
  it('gives BW2 its own Pokémon and moves as they are', () => {
    const dex = new BorrowingDex(forms);
    expect(dex.species('Garchomp')).toEqual({ num: 445, form: 0, baseHp: 108, native: true });
    expect(dex.species('Rotom-Wash')).toEqual({ num: 479, form: 2, baseHp: 50, native: true });
    expect(dex.move('Earthquake')).toBe(89);
    expect(dex.move('hiddenpowerfire60')).toBe(237);
    expect(dex.takeWork()).toEqual([]);
  });

  it('lends a later Pokémon a slot Gen 9 has no use for, the same one all battle', () => {
    const dex = new BorrowingDex(forms);
    const meow = dex.species('Meowscarada')!;
    expect(meow).toMatchObject({ form: 0, baseHp: 76, native: false });
    expect(DONORS.species.either).toContain(meow.num);
    expect(dex.species('Meowscarada')).toEqual(meow);
    expect(dex.takeWork()).toEqual([{ kind: 'sprite', species: meow.num, spriteId: 'meowscarada' }]);
    const tusk = dex.species('Great Tusk')!;
    expect(DONORS.species.genderless).toContain(tusk.num);
    expect(dex.species('Charizard-Mega-X')!.num).not.toBe(6); // BW2 has no Mega form
    dex.reset();
    expect(dex.species('Meowscarada')!.num).toBe(meow.num);
  });

  it('lends a later move a slot, with its name and data, and a Gen 5 animation', () => {
    const dex = new BorrowingDex(forms);
    const moon = dex.move('Moonblast')!;
    expect(DONORS.moves).toContain(moon);
    expect(dex.move('moonblast')).toBe(moon);
    expect(dex.moveAnimation('Moonblast')).toBe(236);
    expect(dex.moveAnimation('Earthquake')).toBe(89);
    expect(dex.takeWork()).toEqual([{ kind: 'move', move: moon, name: 'Moonblast', type: 17, category: 2, pp: 15, power: 95, accuracy: 100 }]);
    expect(dex.moveFor(moon, ['earthquake', 'moonblast'])).toBe('moonblast');
  });

  it('takes turns with ability donors, giving a native ability its name back', () => {
    const dex = new BorrowingDex(forms);
    const first = dex.ability('Protosynthesis')!;
    const second = dex.ability('Good as Gold')!;
    expect(DONORS.abilities).toEqual([first, second]);
    expect(dex.ability('Protosynthesis')).toBe(first);
    const third = dex.ability('Quark Drive');
    expect(third).toBe(first);
    expect(dex.ability('Multitype')).toBe(121);
    expect(dex.takeWork().map((w) => w.kind === 'name' && w.name)).toEqual(['Protosynthesis', 'Good as Gold', 'Quark Drive', 'Multitype']);
    expect(dex.ability('Levitate')).toBe(26);
  });

  it('knows only BW2 itself without borrowing', () => {
    expect(nativeDex.species('Meowscarada')).toBeNull();
    expect(nativeDex.move('Moonblast')).toBeNull();
  });
});
