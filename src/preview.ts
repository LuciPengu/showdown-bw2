// A stand-in renderer: draws the battle in the page with Showdown's BW sprites
// and BW2-style text, so the translator can be checked before the emulator
// renderer exists.

import type { Command, Hp, MonView, Slot, Status, Weather } from './bw/commands';
import { describe, makeNamer, weatherEndText } from './bw/english';
import type { Renderer } from './director';
import { toID } from './showdown/protocol';

/** Milliseconds each command holds the screen at 1× speed. */
const HOLD: Partial<Record<Command['kind'], number>> = {
  start: 1200, switchIn: 1000, switchOut: 700, move: 1100, charge: 900, cant: 900, hp: 650, faint: 900,
  status: 800, boost: 700, clearBoosts: 700, ability: 900, formChange: 800, transform: 900, weather: 800,
  field: 800, sideCondition: 800, text: 800, turn: 250, end: 1500,
};

interface Mon {
  mon: MonView;
  hp: Hp;
  status: Status | null;
  fainted: boolean;
  el: HTMLElement;
}

const HYPHENATED = new Set(['porygonz', 'hooh']);

/** Showdown sprite id: `Thundurus-Therian` → `thundurus-therian`, `Mr. Mime` → `mrmime`. */
export function spriteId(species: string): string {
  if (HYPHENATED.has(toID(species))) return toID(species);
  const [base, ...forme] = species.split('-');
  return forme.length ? `${toID(base)}-${toID(forme.join(''))}` : toID(base);
}

export class PreviewRenderer implements Renderer {
  speed = 1;
  private mons = new Map<string, Mon>();
  private trainers = ['', ''];
  private weather: Weather | null = null;
  private turn = 0;
  private readonly n = makeNamer((slot) => this.mons.get(key(slot))?.mon.name);

  constructor(
    private readonly sides: [near: HTMLElement, far: HTMLElement],
    private readonly textbox: HTMLElement,
    private readonly status: HTMLElement,
    private readonly log: HTMLElement,
  ) {}

  reset(): void {
    this.mons.clear();
    this.sides.forEach((s) => s.replaceChildren());
    this.textbox.textContent = '';
    this.log.replaceChildren();
    this.weather = null;
    this.turn = 0;
    this.trainers = ['', ''];
    this.renderStatus();
  }

  async play(cmd: Command, instant: boolean): Promise<void> {
    const before = this.weather;
    this.apply(cmd);
    let line = describe(cmd, this.n, (side) => this.trainers[side]);
    if (cmd.kind === 'weather' && !cmd.weather && before) line = weatherEndText(before);
    if (cmd.kind === 'turn') this.addLog(`Turn ${cmd.turn}`, 'turn', instant);
    else if (line) this.addLog(line, cmd.kind, instant);
    if (instant) return;
    if (line) this.textbox.textContent = line;
    if (cmd.kind === 'move' && cmd.animate) this.flash(cmd.user, cmd.targets);
    await sleep((HOLD[cmd.kind] ?? 500) / this.speed);
  }

  private apply(cmd: Command): void {
    switch (cmd.kind) {
      case 'start':
        this.trainers = [cmd.trainers[0].name, cmd.trainers[1].name];
        break;
      case 'switchIn': {
        this.mons.get(key(cmd.slot))?.el.remove();
        const m: Mon = { mon: cmd.mon, hp: cmd.hp, status: cmd.status, fainted: false, el: this.monElement(cmd.slot, cmd.mon) };
        this.mons.set(key(cmd.slot), m);
        this.sides[cmd.slot.side].append(m.el);
        this.drawMon(m);
        break;
      }
      case 'switchOut':
        this.mons.get(key(cmd.slot))?.el.classList.add('gone');
        break;
      case 'hp': {
        const m = this.mons.get(key(cmd.slot));
        if (m) {
          m.hp = cmd.hp;
          this.drawMon(m);
        }
        break;
      }
      case 'faint': {
        const m = this.mons.get(key(cmd.slot));
        if (m) {
          m.fainted = true;
          m.hp = { ...m.hp, hp: 0 };
          m.el.classList.add('fainted');
          this.drawMon(m);
        }
        break;
      }
      case 'status': {
        const m = this.mons.get(key(cmd.slot));
        if (m) {
          m.status = cmd.status;
          this.drawMon(m);
        }
        break;
      }
      case 'formChange': {
        const m = this.mons.get(key(cmd.slot));
        if (m) {
          m.mon = cmd.mon;
          setSprite(m.el.querySelector('img')!, cmd.slot, cmd.mon);
          this.drawMon(m);
        }
        break;
      }
      case 'weather':
        this.weather = cmd.weather;
        break;
      case 'turn':
        this.turn = cmd.turn;
        break;
    }
    this.renderStatus();
  }

  private monElement(slot: Slot, mon: MonView): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mon';
    el.innerHTML = `
      <div class="hpbox">
        <div class="hpbox-top"><span class="mon-name"></span><span class="mon-level"></span></div>
        <div class="hpbar"><div class="hpbar-fill"></div></div>
        <div class="hpbox-bottom"><span class="mon-status"></span><span class="mon-hp"></span></div>
      </div>
      <div class="platform"><img alt="" /></div>`;
    setSprite(el.querySelector('img')!, slot, mon);
    return el;
  }

  private drawMon(m: Mon): void {
    const q = (s: string) => m.el.querySelector<HTMLElement>(s)!;
    const pct = m.hp.maxHp ? Math.max(0, Math.min(1, m.hp.hp / m.hp.maxHp)) : 0;
    q('.mon-name').textContent = m.mon.name + (m.mon.gender === 'M' ? ' ♂' : m.mon.gender === 'F' ? ' ♀' : '');
    q('.mon-level').textContent = `Lv${m.mon.level}`;
    q('.mon-status').textContent = m.fainted ? 'FNT' : (m.status?.toUpperCase() ?? '');
    q('.mon-status').dataset.status = m.fainted ? 'fnt' : (m.status ?? '');
    q('.mon-hp').textContent = m.hp.maxHp === 100 ? `${Math.round(pct * 100)}%` : `${m.hp.hp}/${m.hp.maxHp}`;
    const fill = q('.hpbar-fill');
    fill.style.width = `${pct * 100}%`;
    fill.dataset.level = pct > 0.5 ? 'high' : pct > 0.2 ? 'mid' : 'low';
  }

  private flash(user: Slot, targets: Slot[]): void {
    const pulse = (slot: Slot, cls: string) => {
      const el = this.mons.get(key(slot))?.el;
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth; // restart the animation
      el.classList.add(cls);
    };
    pulse(user, 'attacking');
    for (const t of targets) if (key(t) !== key(user)) pulse(t, 'hit');
  }

  private renderStatus(): void {
    const parts = [this.turn ? `Turn ${this.turn}` : ''];
    if (this.weather) parts.push({ RainDance: 'Rain', SunnyDay: 'Sun', Sandstorm: 'Sandstorm', Hail: 'Hail' }[this.weather]);
    this.status.textContent = parts.filter(Boolean).join(' · ');
  }

  private addLog(text: string, kind: string, instant: boolean): void {
    const li = document.createElement('li');
    li.textContent = text;
    li.dataset.kind = kind;
    if (instant) li.classList.add('history');
    this.log.append(li);
    li.scrollIntoView({ block: 'nearest' });
  }
}

function setSprite(img: HTMLImageElement, slot: Slot, mon: MonView): void {
  const dir = `gen5ani${slot.side === 0 ? '-back' : ''}${mon.shiny ? '-shiny' : ''}`;
  img.src = `https://play.pokemonshowdown.com/sprites/${dir}/${spriteId(mon.species)}.gif`;
  img.alt = mon.species;
  img.onerror = () => {
    img.onerror = null;
    img.src = `https://play.pokemonshowdown.com/sprites/gen5${slot.side === 0 ? '-back' : ''}/${spriteId(mon.species)}.png`;
  };
}

function key(slot: Slot): string {
  return `${slot.side}:${slot.pos}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
