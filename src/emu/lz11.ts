// LZ11, the compression BW2's sprites use: 0x11, the size in 24 bits, then
// groups of a flag byte and eight literals or back-references.

/** Decompresses LZ11 data. */
export function lz11Decompress(data: Uint8Array): Uint8Array {
  if (data[0] !== 0x11) throw new Error('not LZ11 data');
  let size = data[1] | (data[2] << 8) | (data[3] << 16);
  let i = 4;
  if (size === 0) {
    size = (data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24)) >>> 0;
    i = 8;
  }
  const out = new Uint8Array(size);
  let o = 0;
  while (o < size) {
    const flags = data[i++];
    for (let bit = 0x80; bit && o < size; bit >>= 1) {
      if (!(flags & bit)) {
        out[o++] = data[i++];
        continue;
      }
      const a = data[i];
      let n: number;
      let disp: number;
      if (a >> 4 === 0) {
        n = (((a & 0xf) << 4) | (data[i + 1] >> 4)) + 0x11;
        disp = (((data[i + 1] & 0xf) << 8) | data[i + 2]) + 1;
        i += 3;
      } else if (a >> 4 === 1) {
        n = (((a & 0xf) << 12) | (data[i + 1] << 4) | (data[i + 2] >> 4)) + 0x111;
        disp = (((data[i + 2] & 0xf) << 8) | data[i + 3]) + 1;
        i += 4;
      } else {
        n = (a >> 4) + 1;
        disp = (((a & 0xf) << 8) | data[i + 1]) + 1;
        i += 2;
      }
      for (let k = 0; k < n && o < size; k++, o++) out[o] = out[o - disp];
    }
  }
  return out;
}

const MAX_DISP = 0x1000;
const MAX_LEN = 0x10110;

/**
 * Compresses with LZ11. Back-references reach at least 2 bytes back, as
 * decompressors that write 16 bits at a time need.
 */
export function lz11Compress(data: Uint8Array): Uint8Array {
  const out: number[] = [0x11, data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff];
  // The last few places each 3-byte prefix was seen.
  const seen = new Map<number, number[]>();
  const key = (at: number) => data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
  const remember = (at: number) => {
    if (at + 2 >= data.length) return;
    const k = key(at);
    const list = seen.get(k);
    if (list) {
      list.push(at);
      if (list.length > 32) list.shift();
    } else seen.set(k, [at]);
  };
  let i = 0;
  while (i < data.length) {
    const flagAt = out.length;
    out.push(0);
    let flags = 0;
    for (let bit = 0x80; bit && i < data.length; bit >>= 1) {
      let bestLen = 0;
      let bestDisp = 0;
      if (i + 2 < data.length) {
        for (const from of seen.get(key(i)) ?? []) {
          const disp = i - from;
          if (disp < 2 || disp > MAX_DISP) continue;
          let n = 0;
          while (n < MAX_LEN && i + n < data.length && data[from + n] === data[i + n]) n++;
          if (n > bestLen) {
            bestLen = n;
            bestDisp = disp;
          }
        }
      }
      if (bestLen >= 3) {
        flags |= bit;
        const d = bestDisp - 1;
        if (bestLen <= 0x10) out.push(((bestLen - 1) << 4) | (d >> 8), d & 0xff);
        else if (bestLen <= 0x110) {
          const n = bestLen - 0x11;
          out.push(n >> 4, ((n & 0xf) << 4) | (d >> 8), d & 0xff);
        } else {
          const n = bestLen - 0x111;
          out.push(0x10 | (n >> 12), (n >> 4) & 0xff, ((n & 0xf) << 4) | (d >> 8), d & 0xff);
        }
        for (let k = 0; k < bestLen; k++) remember(i + k);
        i += bestLen;
      } else {
        out.push(data[i]);
        remember(i);
        i++;
      }
    }
    out[flagAt] = flags;
  }
  while (out.length % 4) out.push(0);
  return new Uint8Array(out);
}
