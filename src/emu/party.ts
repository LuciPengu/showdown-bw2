// BW2's battle party data in RAM: reading each side's order and HP, and
// rewriting a party slot's Pokémon before it's sent out. Offsets were read from
// the game's instructions (overlay 167 and ARM9); see README.

import type { Status } from '../bw/commands';
import type { DsRam } from './ram';
import type { PersonalTable } from './rom';
import type { Bw2Side, MonSpec, MonWrite } from './scene';

const MAIN_MODULE_POKECON = 0xc8; // the client's BtlPokeCon, inside the main module
const MAIN_MODULE_SERVER_POKECON = 0x1b0; // the server's own copy, unused while it's paused
const POKECON_PARTIES = 0x04; // BattleParty[4], 0x1c bytes each
const PARTY_SIZE = 0x1c;
const PARTY_COUNT = 0x18; // u8
const POKECON_MONS = 0x84; // BattleMon *mons[24], by mon ID
const POKECON_SRC_PARTIES = 0x74; // PokeParty *[4]: the parties the battle was built from
/** PokeParty: capacity (u32), count (u32), then the PartyPkm records. The Pokémon menu reads its count. */
const POKEPARTY = { capacity: 0x00, count: 0x04, mons: 0x08 } as const;
/** The first mon ID of each client (the table at 0x021d6c24). */
const FIRST_MON_ID = [0, 12, 6, 18];

/** BattleMon fields. */
const BM = {
  src: 0x00, // PartyPkm *
  illusion: 0x04, // PartyPkm * shown instead, for Illusion
  exp: 0x08,
  species: 0x0c,
  maxHp: 0x0e,
  hp: 0x10,
  item: 0x12,
  baseAbility: 0x16,
  level: 0x18,
  monId: 0x19,
  baseAtk: 0x1a,
  flags: 0x1b, // bits 0–4 base form, 5 transformed, 6 Illusion
  conditions: 0x1c, // u32 each; 1–5 are the major statuses
  moves: 0x104, // BattleMoveWork[4]: truth {id, pp, maxPP, ppUp, flags}, surface (same), linked
  ability: 0x13c, // the current one (btl_pokeparam.h)
  moveCount: 0x140,
} as const;
const MOVE_WORK_SIZE = 0xe;

const PKM_SIZE = 0xdc;
const STATUS_CONDITIONS: Record<Status, number> = { par: 1, slp: 2, frz: 3, brn: 4, psn: 5, tox: 5 };
/** Party data's status word (Gen 4/5): sleep turns in bits 0–2, then a bit each. */
const PARTY_STATUS: Record<Status, number> = { slp: 3, psn: 1 << 3, brn: 1 << 4, frz: 1 << 5, par: 1 << 6, tox: 1 << 7 };

/** EXP to reach `level` on a growth curve (personal byte 0x15), as PKHeX's tables. */
export function expForLevel(growth: number, level: number): number {
  const n = Math.max(1, Math.min(100, level));
  if (n === 1) return 0;
  const n3 = n * n * n;
  const div = (a: number, b: number) => Math.trunc(a / b);
  let exp: number;
  switch (growth) {
    case 1:
      exp = n <= 49 ? div(n3 * (100 - n), 50) : n <= 67 ? div(n3 * (150 - n), 100) : n <= 97 ? div(n3 * div(1911 - 10 * n, 3), 500) : div(n3 * (160 - n), 100);
      break;
    case 2:
      exp = n <= 14 ? div(n3 * (div(n + 1, 3) + 24), 50) : n <= 35 ? div(n3 * (n + 14), 50) : div(n3 * (div(n, 2) + 32), 50);
      break;
    case 3:
      exp = div(6 * n3, 5) - 15 * n * n + 100 * n - 140;
      break;
    case 4:
      exp = div(4 * n3, 5);
      break;
    case 5:
      exp = div(5 * n3, 4);
      break;
    default:
      exp = n3;
  }
  return Math.max(0, exp);
}

/**
 * A party Pokémon (PK5, 0xDC bytes) as BW2 keeps it in RAM, stored plainly:
 * flags 0x0003 tell the game it's already decrypted, and a PID with bits
 * 13–17 clear keeps the four data blocks in their natural order.
 */
/**
 * An HP IV and EV that make the game's own formula give `maxHp`, since it
 * recalculates benched Pokémon's stats: 31 and the fewest EVs if possible.
 */
export function hpInvestment(baseHp: number, level: number, maxHp: number): { iv: number; ev: number } {
  const calc = (iv: number, ev: number) => Math.floor(((2 * baseHp + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
  for (const iv of [31, ...Array.from({ length: 31 }, (_, i) => 30 - i)]) {
    for (let ev = 0; ev <= 252; ev += 4) if (calc(iv, ev) === maxHp) return { iv, ev };
  }
  return { iv: 31, ev: 0 };
}

export function buildPk5(mon: MonSpec, personal: { baseHp: number; genderRatio: number; growth: number; ability: number }): Uint8Array {
  const b = new Uint8Array(PKM_SIZE);
  const v = new DataView(b.buffer);
  // Gender comes from the PID's low byte against the species' ratio.
  const ratio = personal.genderRatio;
  const low = mon.gender === 'F' && ratio > 0 && ratio < 255 ? 0x00 : 0xff;
  const pidHi = 0x2a40; // bits 16–17 clear
  const pid = ((pidHi << 16) | low) >>> 0;
  // Shiny when TID ^ SID ^ PIDhi ^ PIDlo < 8, with SID 0.
  const tid = (pidHi ^ low ^ (mon.shiny ? 0 : 0x100)) & 0xffff;

  v.setUint32(0x00, pid, true);
  v.setUint16(0x04, 0x0003, true);
  // Block A
  v.setUint16(0x08, mon.species, true);
  v.setUint16(0x0c, tid, true);
  v.setUint32(0x10, expForLevel(personal.growth, mon.level), true);
  b[0x14] = 70; // friendship
  b[0x15] = personal.ability;
  b[0x17] = 2; // English
  const hp = hpInvestment(personal.baseHp, mon.level, mon.maxHp);
  b[0x18] = hp.ev;
  // Block B: 31 IVs, nicknamed; gender and form.
  v.setUint32(0x38, ((0x3fffffff & ~0x1f) | hp.iv | (1 << 31)) >>> 0, true);
  const genderBits = ratio === 255 ? 2 : mon.gender === 'F' ? 1 : 0;
  b[0x40] = ((mon.form & 0x1f) << 3) | (genderBits << 1);
  // Block C: nickname, 0xFFFF-terminated, 10 characters at most.
  const name = [...mon.nickname].slice(0, 10);
  name.forEach((ch, i) => v.setUint16(0x48 + i * 2, ch.codePointAt(0)! > 0xffff ? 0x3f : ch.codePointAt(0)!, true));
  v.setUint16(0x48 + name.length * 2, 0xffff, true);
  b[0x5f] = 23; // Black 2
  // Block D: OT name, ball, met level.
  [...'Showdown'].slice(0, 7).forEach((ch, i) => v.setUint16(0x68 + i * 2, ch.charCodeAt(0), true));
  v.setUint16(0x68 + 7 * 2, 0xffff, true);
  b[0x83] = 4; // Poké Ball
  b[0x84] = Math.min(mon.level, 100);
  // Checksum of the box data.
  let sum = 0;
  for (let at = 0x08; at < 0x88; at += 2) sum = (sum + v.getUint16(at, true)) & 0xffff;
  v.setUint16(0x06, sum, true);
  // Party data
  v.setUint32(0x88, mon.status ? PARTY_STATUS[mon.status] : 0, true);
  b[0x8c] = mon.level;
  v.setUint16(0x8e, mon.hp, true);
  v.setUint16(0x90, Math.max(1, mon.maxHp), true);
  for (let at = 0x92; at <= 0x9a; at += 2) v.setUint16(at, 100, true);
  return b;
}

export interface BattleMove {
  id: number;
  pp: number;
  maxPp: number;
}

export class BattleParties {
  private readonly pokeCon: number;
  private spare: number[] | null = null;

  constructor(
    private readonly ram: DsRam,
    private readonly mainModule: number,
    private readonly personal: PersonalTable,
  ) {
    this.pokeCon = mainModule + MAIN_MODULE_POKECON;
  }

  /**
   * Gives a client `size` party slots, or as many as it can get. A battle only
   * builds a BattleMon per party member (the PWT gives three or four), so extra
   * slots borrow the paused server's own BattleMons, renumbered as this
   * client's next mon IDs. A smaller party just hides the slots past `size`.
   */
  resizeParty(client: number, size = 6): number {
    const r = this.ram;
    const party = this.party(client);
    const count = r.read8(party + PARTY_COUNT);
    const src = r.read32(this.pokeCon + POKECON_SRC_PARTIES + 4 * client);
    if (count >= size) {
      r.write8(party + PARTY_COUNT, size);
      r.write32(src + POKEPARTY.count, size);
      return size;
    }
    if (!this.spare) {
      this.spare = [];
      const server = this.mainModule + MAIN_MODULE_SERVER_POKECON;
      for (let c = 0; c < 4; c++) {
        const p = server + POKECON_PARTIES + PARTY_SIZE * c;
        const n = Math.min(r.read8(p + PARTY_COUNT), 6);
        for (let i = 0; i < n; i++) {
          const bm = r.read32(p + 4 * i);
          if (bm >= 0x02000000 && bm < 0x02400000 && r.read32(bm + BM.src)) this.spare.push(bm);
        }
      }
    }
    // The client's own PokeParty has room for six records; the borrowed BattleMons move their records there.
    const room = Math.min(r.read32(src + POKEPARTY.capacity), 6);
    let n = count;
    while (n < size && n < room && this.spare.length) {
      const bm = this.spare.shift()!;
      const monId = FIRST_MON_ID[client] + n;
      const pkm = src + POKEPARTY.mons + PKM_SIZE * n;
      r.writeBytes(pkm, r.bytes(r.read32(bm + BM.src), PKM_SIZE));
      r.write32(bm + BM.src, pkm);
      r.write8(bm + BM.monId, monId);
      r.write32(party + 4 * n, bm);
      r.write32(this.pokeCon + POKECON_MONS + 4 * monId, bm);
      n++;
    }
    r.write8(party + PARTY_COUNT, n);
    r.write32(src + POKEPARTY.count, n);
    return n;
  }

  /** A battle Pokémon's HP and max HP as the game has them, by mon ID. */
  hpOf(monId: number): { hp: number; maxHp: number } | null {
    const bm = this.ram.read32(this.pokeCon + POKECON_MONS + 4 * monId);
    if (bm < 0x02000000 || bm >= 0x02400000) return null;
    return { hp: this.ram.read16(bm + BM.hp), maxHp: this.ram.read16(bm + BM.maxHp) };
  }

  /** Sets a battle Pokémon's HP and max HP, by mon ID. The gauge shows them once told to update. */
  setHp(monId: number, hp: number, maxHp: number): void {
    const bm = this.ram.read32(this.pokeCon + POKECON_MONS + 4 * monId);
    if (bm < 0x02000000 || bm >= 0x02400000) return;
    this.ram.write16(bm + BM.maxHp, Math.max(1, maxHp));
    this.ram.write16(bm + BM.hp, hp);
  }

  /**
   * Takes the abilities and held items off the server's own Pokémon, which
   * BW2's battle logic uses while it runs a battle's intro, so it shows no
   * entry effects of its own (Intimidate, Air Balloon…). Showdown's follow.
   */
  quietServerMons(): void {
    const r = this.ram;
    const server = this.mainModule + MAIN_MODULE_SERVER_POKECON;
    for (let c = 0; c < 4; c++) {
      const p = server + POKECON_PARTIES + PARTY_SIZE * c;
      const n = Math.min(r.read8(p + PARTY_COUNT), 6);
      for (let i = 0; i < n; i++) {
        const bm = r.read32(p + 4 * i);
        if (bm < 0x02000000 || bm >= 0x02400000) continue;
        r.write16(bm + BM.ability, 0);
        r.write16(bm + BM.baseAbility, 0);
        r.write16(bm + BM.item, 0);
      }
    }
  }

  /** Sets a party slot's moves, as the Fight menu shows them. */
  writeMoves(client: number, partyIndex: number, moves: BattleMove[]): void {
    const r = this.ram;
    const bm = this.mon(client, partyIndex);
    let count = 0;
    for (let k = 0; k < 4; k++) {
      const m = moves[k];
      const at = bm + BM.moves + MOVE_WORK_SIZE * k;
      for (const half of [0, 6]) {
        r.write16(at + half, m?.id ?? 0);
        r.write8(at + half + 2, m ? Math.min(m.pp, 255) : 0);
        r.write8(at + half + 3, m ? Math.min(m.maxPp, 255) : 0);
        r.write16(at + half + 4, 0); // PP Ups, flags
      }
      r.write8(at + 12, 1); // the surface move is the true one
      if (m?.id) count++;
    }
    r.write8(bm + BM.moveCount, count);
  }

  private party(client: number): number {
    return this.pokeCon + POKECON_PARTIES + PARTY_SIZE * client;
  }

  private mon(client: number, index: number): number {
    const party = this.party(client);
    if (index >= this.ram.read8(party + PARTY_COUNT)) throw new Error(`client ${client} has no party slot ${index}`);
    return this.ram.read32(party + 4 * index);
  }

  /** Each side as the game has it now: the player (client 0) near, the opponent (client 1) far. */
  sides(): [Bw2Side, Bw2Side] {
    const side = (client: number): Bw2Side => {
      const count = this.ram.read8(this.party(client) + PARTY_COUNT);
      const order: number[] = [];
      const hp = new Map<number, { hp: number; maxHp: number }>();
      for (let i = 0; i < count; i++) {
        const mon = this.mon(client, i);
        const monId = this.ram.read8(mon + BM.monId);
        order.push(monId);
        hp.set(monId, { hp: this.ram.read16(mon + BM.hp), maxHp: this.ram.read16(mon + BM.maxHp) });
      }
      return { client, order, hp };
    };
    return [side(0), side(1)];
  }

  /** Rewrites a party slot: its PartyPkm, and the BattleMon fields that sending it in doesn't reload. */
  write({ client, partyIndex, monId, mon }: MonWrite): void {
    const r = this.ram;
    const bm = this.mon(client, partyIndex);
    if (r.read8(bm + BM.monId) !== monId) throw new Error(`party slot ${partyIndex} isn't mon ${monId}`);
    const personal = this.personal(mon.species, mon.form);
    if (!personal) throw new Error(`no species data for ${mon.species}`);
    r.writeBytes(r.read32(bm + BM.src), buildPk5(mon, personal));

    r.write32(bm + BM.illusion, 0);
    r.write32(bm + BM.exp, expForLevel(personal.growth, mon.level));
    r.write16(bm + BM.species, mon.species);
    r.write16(bm + BM.maxHp, Math.max(1, mon.maxHp));
    r.write16(bm + BM.hp, mon.hp);
    r.write16(bm + BM.item, 0);
    r.write16(bm + BM.baseAbility, personal.ability);
    r.write8(bm + BM.level, mon.level);
    r.write8(bm + BM.baseAtk, personal.baseAtk);
    r.write8(bm + BM.flags, (r.read8(bm + BM.flags) & 0x80) | (mon.form & 0x1f));
    for (let c = 1; c <= 5; c++) r.write32(bm + BM.conditions + 4 * c, 0);
    if (mon.status) {
      const value = mon.status === 'tox' ? 1 | (15 << 3) : mon.status === 'slp' ? 2 | (3 << 3) : 1;
      r.write32(bm + BM.conditions + 4 * STATUS_CONDITIONS[mon.status], value);
    }
  }
}
