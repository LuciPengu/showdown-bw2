// The trainers' names BW2 prints ("PKMN Trainer X sent out Y!"). Each client's
// BtlTrainerData (btl_main.h) points at a StrBuf sized to the name it was
// made with, so a longer Showdown name gets a StrBuf of ours, placed at the far
// end of the server's command queue: nothing reads there once the server is
// paused, and even during a battle's intro its commands are far shorter.

import type { DsRam } from './ram';

const MAIN_MODULE_TRAINERS = 0x20; // BtlTrainerData trainers[4], 0x28 bytes each
const TRAINER_SIZE = 0x28;
const TRAINER_NAME = 0x04; // StrBuf *
/** StrBuf (gfl/strbuf.c): capacity in characters, length, a magic word, then the characters. */
const STRBUF = { size: 0x00, length: 0x02, magic: 0x04, chars: 0x08 } as const;
const STRBUF_MAGIC = 0xb6f8d2ec;
const SERVER_QUEUE = 0xf0; // BtlServerCmdQueue: two u16 positions, then a 3000-byte buffer (0xBC0 in all)
const OUR_STRBUFS = SERVER_QUEUE + 0xbc0 - 4 * 0x40; // the last 0x100 bytes
const OUR_STRBUF_SIZE = 0x40;
/** The most characters a name keeps: Showdown's limit. */
export const MAX_NAME = 18;

/** A StrBuf holding `name`, in the game's character codes (the US font's are Unicode). */
export function encodeStrBuf(name: string, capacity = MAX_NAME + 1): Uint8Array {
  const chars = [...name].slice(0, capacity - 1).map((ch) => (ch.codePointAt(0)! > 0xffff ? 0x3f : ch.codePointAt(0)!));
  const b = new Uint8Array(STRBUF.chars + 2 * capacity);
  const v = new DataView(b.buffer);
  v.setUint16(STRBUF.size, capacity, true);
  v.setUint16(STRBUF.length, chars.length, true);
  v.setUint32(STRBUF.magic, STRBUF_MAGIC, true);
  chars.forEach((c, i) => v.setUint16(STRBUF.chars + 2 * i, c, true));
  v.setUint16(STRBUF.chars + 2 * chars.length, 0xffff, true);
  return b;
}

export class TrainerNames {
  /** Each client's own StrBuf pointer, put back before the game frees the names. */
  private readonly original = new Map<number, number>();

  constructor(
    private readonly ram: DsRam,
    private readonly mainModule: number,
    private readonly server: number,
  ) {}

  private slot(client: number): number {
    return this.mainModule + MAIN_MODULE_TRAINERS + TRAINER_SIZE * client + TRAINER_NAME;
  }

  /** The name a client's trainer has now, or null if it has none. */
  read(client: number): string | null {
    const r = this.ram;
    const buf = r.read32(this.slot(client));
    if (buf < 0x02000000 || buf >= 0x02400000 || r.read32(buf + STRBUF.magic) !== STRBUF_MAGIC) return null;
    const length = Math.min(r.read16(buf + STRBUF.length), r.read16(buf + STRBUF.size));
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(r.read16(buf + STRBUF.chars + 2 * i));
    return s;
  }

  /** Renames a client's trainer. False if the client has no trainer (no StrBuf) to rename. */
  write(client: number, name: string): boolean {
    const r = this.ram;
    const slot = this.slot(client);
    if (!this.original.has(client)) {
      if (this.read(client) === null) return false;
      this.original.set(client, r.read32(slot));
    }
    const ours = this.server + OUR_STRBUFS + OUR_STRBUF_SIZE * client;
    r.writeBytes(ours, encodeStrBuf(name));
    r.write32(slot, ours);
    return true;
  }

  /** Points every renamed trainer back at its own StrBuf, which the game frees when the battle ends. */
  restore(): void {
    for (const [client, buf] of this.original) this.ram.write32(this.slot(client), buf);
    this.original.clear();
  }
}
