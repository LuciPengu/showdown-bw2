// Does on the cart what borrowed slots need (dex.ts): a later move's name,
// "X used Y!" lines and data in the slot of a move Gen 9 doesn't have; an
// ability's or item's name; a Pokémon's sprites. A new battle puts the cart
// back as it came.

import { DONORS } from '../bw/later';
import type { CartWork } from './dex';
import type { Cart, CartArchive } from './romimage';
import { BANK, LiveBank, encodeText } from './text';

/** Puts a later Pokémon's sprites into a species' slot. */
export type SpriteWriter = (sprites: CartArchive, work: Extract<CartWork, { kind: 'sprite' }>) => Promise<void>;

/** Move data (a/0/2/1): type, category, power, accuracy (101 never misses), PP. */
const MOVE_DATA = { type: 0, category: 2, power: 3, accuracy: 4, pp: 5 } as const;

export class CartLender {
  private readonly text: CartArchive;
  private readonly moveData: CartArchive;
  private readonly sprites: CartArchive;
  private readonly banks: Record<'names' | 'messages' | 'abilities' | 'items', LiveBank>;
  /** Move data records changed, as they came. */
  private readonly moveRecords = new Map<number, Uint8Array>();
  /** Banks whose donors' room is lent. */
  private readonly lending = new Set<string>();

  constructor(
    private readonly cart: Cart,
    private readonly writeSprites: SpriteWriter,
  ) {
    this.text = cart.archive('a/0/0/2');
    this.moveData = cart.archive('a/0/2/1');
    this.sprites = cart.archive('a/0/0/4');
    const bank = (n: number) => new LiveBank(cart, this.text, n);
    this.banks = { names: bank(BANK.moves), messages: bank(BANK.moveMessages), abilities: bank(BANK.abilities), items: bank(BANK.items) };
  }

  /** Does `work`. Text and move data are written before this returns; sprites may take a moment longer. */
  apply(work: CartWork[]): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const w of work) {
      if (w.kind === 'move') this.move(w);
      else if (w.kind === 'name') this.name(w);
      else pending.push(this.writeSprites(this.sprites, w));
    }
    return Promise.all(pending).then(() => undefined);
  }

  /** Puts the cart back as it came, for a new battle. */
  reset(): void {
    for (const bank of Object.values(this.banks)) bank.restore();
    for (const [move, record] of this.moveRecords) this.cart.write(this.moveData.fileRange(move)[0], record);
    this.moveRecords.clear();
    this.lending.clear();
    this.sprites.restore();
    this.cart.clearScratch();
  }

  private move(w: Extract<CartWork, { kind: 'move' }>): void {
    const { names, messages } = this.banks;
    this.lend('moves', () => {
      names.lend(DONORS.moves);
      messages.lend(DONORS.moves.flatMap((m) => [m * 3, m * 3 + 1, m * 3 + 2]));
    });
    names.write(w.move, encodeText(w.name));
    messages.write(w.move * 3, encodeText(`{nickname:0} used\n${w.name}!`));
    messages.write(w.move * 3 + 1, encodeText(`The wild {nickname:0} used\n${w.name}!`));
    messages.write(w.move * 3 + 2, encodeText(`The foe's {nickname:0} used\n${w.name}!`));

    const [start, end] = this.moveData.fileRange(w.move);
    if (!this.moveRecords.has(w.move)) this.moveRecords.set(w.move, this.cart.rom.slice(start, end));
    const record = this.cart.rom.slice(start, end);
    record[MOVE_DATA.type] = w.type;
    record[MOVE_DATA.category] = w.category;
    record[MOVE_DATA.power] = Math.min(w.power, 255);
    record[MOVE_DATA.accuracy] = w.accuracy || 101;
    record[MOVE_DATA.pp] = w.pp;
    this.cart.write(start, record);
  }

  private name(w: Extract<CartWork, { kind: 'name' }>): void {
    if (w.what === 'ability') {
      this.lend('abilities', () => this.banks.abilities.lend(DONORS.abilityRoom));
      this.banks.abilities.write(w.num, encodeText(w.name));
    } else {
      this.lend('items', () => this.banks.items.lend(DONORS.itemRoom));
      this.banks.items.write(w.num, encodeText(w.name));
    }
  }

  /** Lends a bank's donors' room, once a battle. */
  private lend(what: string, lend: () => void): void {
    if (this.lending.has(what)) return;
    this.lending.add(what);
    lend();
  }
}
