// Parsing for the Pokémon Showdown battle protocol.
// Reference: https://github.com/smogon/pokemon-showdown/blob/master/sim/SIM-PROTOCOL.md

/** One protocol line: `|cmd|arg|arg|[tag] value`. */
export interface Line {
  cmd: string;
  args: string[];
  /** `[from] ability: Drizzle` becomes `{ from: 'ability: Drizzle' }`; bare `[still]` becomes `{ still: '' }`. */
  kw: Record<string, string>;
}

/** Commands whose last argument is free text that may itself contain `|`. */
const TEXT_TAIL: Record<string, number> = { c: 1, 'c:': 2, chat: 1, raw: 0, html: 0, error: 0, request: 0, '-message': 0 };

export function parseLine(raw: string): Line | null {
  if (!raw.startsWith('|')) return null;
  const parts = raw.slice(1).split('|');
  const cmd = parts.shift() ?? '';
  const tail = TEXT_TAIL[cmd];
  if (tail !== undefined) {
    return { cmd, args: [...parts.slice(0, tail), parts.slice(tail).join('|')], kw: {} };
  }
  const args: string[] = [];
  const kw: Record<string, string> = {};
  for (const part of parts) {
    const tag = /^\[([a-z]+)\]\s?(.*)$/i.exec(part);
    if (tag) kw[tag[1]] = tag[2];
    else args.push(part);
  }
  return { cmd, args, kw };
}

/** A websocket message: an optional `>roomid` header, then protocol lines. */
export function splitMessage(message: string): { room: string; lines: string[] } {
  if (!message.startsWith('>')) return { room: '', lines: message.split('\n') };
  const nl = message.indexOf('\n');
  if (nl < 0) return { room: message.slice(1).trim(), lines: [] };
  return { room: message.slice(1, nl).trim(), lines: message.slice(nl + 1).split('\n') };
}

export type SideId = 'p1' | 'p2';

/** `p2a: Heatran` → side p2, position 0, name Heatran. `p2: Name` (a side) has no position. */
export interface PokemonRef {
  side: SideId;
  pos: number | null;
  name: string;
}

export function parseRef(s: string | undefined): PokemonRef | null {
  const m = /^(p[12])([a-c]?)(?::\s*(.*))?$/.exec((s ?? '').trim());
  if (!m) return null;
  return { side: m[1] as SideId, pos: m[2] ? m[2].charCodeAt(0) - 97 : null, name: m[3] ?? '' };
}

export interface Details {
  species: string;
  level: number;
  gender: 'M' | 'F' | null;
  shiny: boolean;
}

/** `Thundurus-Therian, L84, M, shiny` */
export function parseDetails(s: string): Details {
  const [species, ...rest] = s.split(', ');
  const d: Details = { species: species.trim(), level: 100, gender: null, shiny: false };
  for (const r of rest) {
    if (r === 'M' || r === 'F') d.gender = r;
    else if (r === 'shiny') d.shiny = true;
    else if (/^L\d+$/.test(r)) d.level = Number(r.slice(1));
  }
  return d;
}

export const STATUSES = ['brn', 'par', 'slp', 'frz', 'psn', 'tox'] as const;
export type Status = (typeof STATUSES)[number];

export interface HpStatus {
  hp: number;
  /** 0 when the line doesn't say (`0 fnt`). 100 for HP shown as a percentage. */
  maxHp: number;
  status: Status | null;
  fainted: boolean;
}

/** `17/100 brn`, `254/341`, `0 fnt` */
export function parseHpStatus(s: string | undefined): HpStatus {
  const [hpPart = '0', statusPart] = (s ?? '').trim().split(' ');
  const [hp, max] = hpPart.split('/');
  const status = (STATUSES as readonly string[]).includes(statusPart ?? '') ? (statusPart as Status) : null;
  return { hp: Number(hp) || 0, maxHp: Number(max) || 0, status, fainted: statusPart === 'fnt' };
}

/** Showdown's `toID`: lowercase letters and digits only. */
export function toID(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
