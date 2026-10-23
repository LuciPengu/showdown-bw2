// Reading and writing the DS's main RAM inside the emulator's WebAssembly heap.

export const MAIN_RAM = 0x02000000;
const MAIN_RAM_MASK = 0x3fffff; // 4 MB, mirrored up to 0x02FFFFFF
/** Where boot leaves a copy of the cartridge header: 0x027FFE00, i.e. this offset in main RAM. */
const HEADER_COPY = 0x027ffe00 & MAIN_RAM_MASK;
/** Bytes into the ARM9 binary to compare: past the secure area, before any compressed part. */
const ARM9_PROBE = 0x800;
const PROBE_LEN = 64;

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, true);

/**
 * Finds main RAM in `heap`: the heap offset of DS address 0x02000000, or null.
 * Looks for the header copy at 0x027FFE00, then checks that the ARM9 binary is
 * where the header says it's loaded, so the ROM's own header in the heap
 * doesn't count.
 */
export function findMainRam(heap: Uint8Array, rom: Uint8Array): number | null {
  const arm9Rom = u32(rom, 0x20);
  const arm9Ram = u32(rom, 0x28);
  const probe = rom.subarray(arm9Rom + ARM9_PROBE, arm9Rom + ARM9_PROBE + PROBE_LEN);
  const probeAt = arm9Ram - MAIN_RAM + ARM9_PROBE;

  // malloc'd blocks are 4-aligned, so scan words with the native indexOf.
  const words = new Uint32Array(heap.buffer, heap.byteOffset, Math.floor(heap.byteLength / 4));
  const first = u32(rom, 0);
  for (let i = words.indexOf(first); i >= 0; i = words.indexOf(first, i + 1)) {
    const at = i * 4;
    const base = at - HEADER_COPY;
    if (base < 0 || !same(heap, at, rom, 0, 0x20)) continue;
    if (same(heap, base + probeAt, probe, 0, PROBE_LEN)) return base;
  }
  return null;
}

function same(a: Uint8Array, aAt: number, b: Uint8Array, bAt: number, n: number): boolean {
  if (aAt + n > a.length || bAt + n > b.length) return false;
  for (let k = 0; k < n; k++) if (a[aAt + k] !== b[bAt + k]) return false;
  return true;
}

/**
 * Main RAM by DS address. `heap` is a getter because the wasm memory can grow,
 * which replaces its buffer.
 */
export class DsRam {
  constructor(
    private readonly heap: () => Uint8Array,
    readonly base: number,
  ) {}

  private view(addr: number, n: number): DataView {
    if (addr < MAIN_RAM || addr + n > 0x03000000) throw new RangeError(`0x${addr.toString(16)} isn't main RAM`);
    const h = this.heap();
    return new DataView(h.buffer, h.byteOffset + this.base + ((addr - MAIN_RAM) & MAIN_RAM_MASK), n);
  }

  read8(addr: number): number {
    return this.view(addr, 1).getUint8(0);
  }
  read16(addr: number): number {
    return this.view(addr, 2).getUint16(0, true);
  }
  read32(addr: number): number {
    return this.view(addr, 4).getUint32(0, true);
  }
  write8(addr: number, v: number): void {
    this.view(addr, 1).setUint8(0, v);
  }
  write16(addr: number, v: number): void {
    this.view(addr, 2).setUint16(0, v, true);
  }
  write32(addr: number, v: number): void {
    this.view(addr, 4).setUint32(0, v >>> 0, true);
  }

  /** A copy of `n` bytes from `addr`. */
  bytes(addr: number, n: number): Uint8Array {
    const v = this.view(addr, n);
    return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + n));
  }

  writeBytes(addr: number, data: Uint8Array): void {
    const v = this.view(addr, data.length);
    new Uint8Array(v.buffer, v.byteOffset, data.length).set(data);
  }
}
