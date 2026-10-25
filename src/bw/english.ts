// Battle text in Black 2 / White 2's wording, for the preview. The emulator
// renderer will use the game's own text instead.

import type { Command, Effect, Slot, Stat, Status, Weather } from './commands';

const STAT_NAMES: Record<Stat, string> = {
  atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', accuracy: 'accuracy', evasion: 'evasiveness',
};

const STATUS_GAINED: Record<Status, string> = {
  brn: '{0} was burned!',
  par: '{0} is paralyzed! It may be unable to move!',
  slp: '{0} fell asleep!',
  frz: '{0} was frozen solid!',
  psn: '{0} was poisoned!',
  tox: '{0} was badly poisoned!',
};

const WEATHER_TEXT: Record<Weather, [start: string, upkeep: string, end: string]> = {
  RainDance: ['It started to rain!', 'Rain continues to fall.', 'The rain stopped.'],
  SunnyDay: ['The sunlight turned harsh!', 'The sunlight is strong.', 'The sunlight faded.'],
  Sandstorm: ['A sandstorm kicked up!', 'The sandstorm rages.', 'The sandstorm subsided.'],
  Hail: ['It started to hail!', 'Hail continues to fall.', 'The hail stopped.'],
  Snow: ['It started to snow!', 'The snow continues to fall.', 'The snow stopped.'],
};

const CANT: Record<string, string> = {
  par: '{0} is paralyzed! It can\'t move!',
  slp: '{0} is fast asleep.',
  frz: '{0} is frozen solid!',
  flinch: '{0} flinched!',
  recharge: '{0} must recharge!',
  Taunt: '{0} can\'t use {1} after the taunt!',
  Disable: '{0}\'s {1} is disabled!',
  Truant: '{0} is loafing around!',
  Focus_Punch: '{0} lost its focus and couldn\'t move!',
  nopp: 'But there was no PP left for the move!',
};

/** Names Pokémon the way BW2 does: "Heatran" on your side, "The foe's Heatran" on the other. */
export type Namer = (slot: Slot | undefined, capital?: boolean) => string;

export function makeNamer(name: (slot: Slot) => string | undefined): Namer {
  return (slot, capital = true) => {
    if (!slot) return '';
    const n = name(slot) ?? '???';
    return slot.side === 0 ? n : `${capital ? 'The' : 'the'} foe's ${n}`;
  };
}

/** The line BW2 would print for a command, or null if it shows none. */
export function describe(cmd: Command, n: Namer, trainerName: (side: 0 | 1) => string): string | null {
  const fill = (s: string, ...xs: string[]) => s.replace(/\{(\d)\}/g, (_, i) => xs[Number(i)] ?? '');
  switch (cmd.kind) {
    case 'start':
      return `${cmd.trainers[1].name} would like to battle!`;
    case 'switchIn':
      if (cmd.how === 'drag') return `${n(cmd.slot)} was dragged out!`;
      if (cmd.how === 'replace') return null;
      return cmd.slot.side === 0 ? `Go! ${cmd.mon.name}!` : `${trainerName(1)} sent out ${cmd.mon.name}!`;
    case 'switchOut':
      return cmd.slot.side === 0 ? `${cmd.mon.name}, come back!` : `${trainerName(1)} withdrew ${cmd.mon.name}!`;
    case 'move':
      return cmd.announce ? `${n(cmd.user)} used ${cmd.move}!` : null;
    case 'charge':
      return `${n(cmd.user)} is charging up ${cmd.move}!`;
    case 'cant': {
      const t = CANT[cmd.reason] ?? CANT[cmd.reason.replace(/ /g, '_')];
      return fill(t ?? `${n(cmd.slot)} can't move! (${cmd.reason})`, n(cmd.slot), cmd.move ?? '');
    }
    case 'hp':
      return hpText(cmd.from, cmd.change, n(cmd.slot), n(cmd.slot, false), n(cmd.of, false));
    case 'faint':
      return `${n(cmd.slot)} fainted!`;
    case 'status':
      return cmd.status ? fill(STATUS_GAINED[cmd.status], n(cmd.slot)) : `${n(cmd.slot)}'s status returned to normal!`;
    case 'boost': {
      const stat = STAT_NAMES[cmd.stat];
      if (cmd.absolute) return `${n(cmd.slot)} maximized its ${stat}!`;
      // The translator negates unboosts, so a failed one is -0.
      if (cmd.stages === 0) return `${n(cmd.slot)}'s ${stat} won't go any ${Object.is(cmd.stages, -0) ? 'lower' : 'higher'}!`;
      const size = Math.abs(cmd.stages);
      const word = cmd.stages > 0 ? ['rose', 'sharply rose', 'rose drastically'][Math.min(size, 3) - 1] : ['fell', 'harshly fell', 'severely fell'][Math.min(size, 3) - 1];
      return `${n(cmd.slot)}'s ${stat} ${word}!`;
    }
    case 'clearBoosts':
      return cmd.slot ? `${n(cmd.slot)}'s stat changes were removed!` : 'All stat changes were eliminated!';
    case 'ability':
      return `[${n(cmd.slot)}'s ${cmd.ability}]`;
    case 'formChange':
      return `${n(cmd.slot)} changed form!`;
    case 'tera':
      return `${n(cmd.slot)} terastallized into the ${cmd.type} type!`;
    case 'transform':
      return `${n(cmd.slot)} transformed into ${n(cmd.into, false).replace(/^the foe's /, '')}!`;
    case 'weather': {
      const w = cmd.weather;
      if (!w) return null; // the end text needs the old weather; the renderer handles it
      return WEATHER_TEXT[w][cmd.upkeep ? 1 : 0];
    }
    case 'field':
      return fieldText(cmd.condition, cmd.active);
    case 'sideCondition':
      return sideText(cmd.condition, cmd.active, cmd.side === 0 ? 'your team' : 'the foe\'s team');
    case 'text':
      return textLine(cmd, n);
    case 'turn':
      return null;
    case 'end':
      return cmd.winner ? `${cmd.winner} won the battle!` : 'The battle ended in a draw!';
  }
}

export function weatherEndText(w: Weather): string {
  return WEATHER_TEXT[w][2];
}

/** `who` starts a sentence; `whom` sits mid-sentence ("the foe's X"). */
function hpText(from: Effect | undefined, change: 'damage' | 'heal' | 'set', who: string, whom: string, of: string): string | null {
  if (!from) return null;
  const name = from.name;
  if (change === 'heal') {
    if (from.kind === 'item') return `${who} restored a little HP using its ${name}!`;
    if (name === 'drain') return `${of || 'The target'} had its energy drained!`;
    if (from.kind === 'ability') return `${who} restored HP using its ${name}!`;
    return `${who}'s HP was restored.`;
  }
  switch (name) {
    case 'Stealth Rock': return `Pointed stones dug into ${whom}!`;
    case 'Spikes': return `${who} is hurt by spikes!`;
    case 'brn': return `${who} is hurt by its burn!`;
    case 'psn': case 'tox': return `${who} is hurt by poison!`;
    case 'Sandstorm': return `${who} is buffeted by the sandstorm!`;
    case 'Hail': return `${who} is buffeted by the hail!`;
    case 'Recoil': return `${who} is damaged by recoil!`;
    case 'confusion': return 'It hurt itself in its confusion!';
    case 'Life Orb': return `${who} lost some of its HP!`;
  }
  if (from.kind === 'item') return `${who} was hurt by ${of ? `${of}'s` : 'its'} ${name}!`;
  if (from.kind === 'ability') return `${who} was hurt by ${of ? `${of}'s` : 'its'} ${name}!`;
  return `${who} was hurt by ${name}!`;
}

/** Terrains (Gen 6 on) as the later games word them; other field conditions plainly. */
const TERRAINS: Record<string, [start: string, end: string]> = {
  'Electric Terrain': ['An electric current ran across the battlefield!', 'The electricity disappeared from the battlefield.'],
  'Grassy Terrain': ['Grass grew to cover the battlefield!', 'The grass disappeared from the battlefield.'],
  'Misty Terrain': ['Mist swirled around the battlefield!', 'The mist disappeared from the battlefield.'],
  'Psychic Terrain': ['The battlefield got weird!', 'The weirdness disappeared from the battlefield!'],
};

function fieldText(condition: string, active: boolean): string {
  const terrain = TERRAINS[condition];
  if (terrain) return terrain[active ? 0 : 1];
  return `${condition} ${active ? 'took effect' : 'wore off'}!`;
}

function sideText(condition: string, active: boolean, team: string): string {
  const cap = team[0].toUpperCase() + team.slice(1);
  if (condition === 'Stealth Rock') return active ? `Pointed stones float in the air around ${team}!` : `The pointed stones disappeared from around ${team}!`;
  if (condition === 'Spikes') return active ? `Spikes were scattered all around the feet of ${team}!` : `The spikes disappeared from around ${team}!`;
  if (condition === 'Toxic Spikes') return active ? `Poison spikes were scattered all around the feet of ${team}!` : `The poison spikes disappeared from around ${team}!`;
  return `${cap}'s ${condition} ${active ? 'started' : 'wore off'}!`;
}

function textLine(cmd: Extract<Command, { kind: 'text' }>, n: Namer): string | null {
  const who = n(cmd.slot);
  const a = cmd.args[0] ?? '';
  switch (cmd.key) {
    case 'crit': return 'A critical hit!';
    case 'superEffective': return "It's super effective!";
    case 'resisted': return "It's not very effective...";
    case 'immune': return `It doesn't affect ${n(cmd.slot, false)}...`;
    case 'miss': return cmd.target ? `${n(cmd.target)} avoided the attack!` : `${who}'s attack missed!`;
    case 'fail': return 'But it failed!';
    case 'noTarget': return 'But there was no target...';
    case 'nothing': return 'But nothing happened!';
    case 'hitCount': return `Hit ${a} time${a === '1' ? '' : 's'}!`;
    case 'volatileStart': {
      const boosted = /^(?:protosynthesis|quarkdrive)(atk|def|spa|spd|spe)$/.exec(a);
      if (boosted) return `${who}'s ${STAT_NAMES[boosted[1] as Stat]} was heightened!`;
      if (a === 'Flash Fire') return `The power of ${n(cmd.slot, false)}'s Fire-type moves rose!`;
      return a === 'Substitute' ? `${who} put in a substitute!` : a === 'confusion' ? `${who} became confused!` : `${who}: ${a} started.`;
    }
    case 'volatileEnd':
      if (a === 'Leech Seed' && cmd.from?.name === 'Rapid Spin') return `${who} was freed from Leech Seed!`;
      if (a === 'Protosynthesis' || a === 'Quark Drive') return `The effects of ${n(cmd.slot, false)}'s ${a} wore off!`;
      return a === 'Substitute' ? `${who}'s substitute faded!` : a === 'confusion' ? `${who} snapped out of its confusion!` : `${who}: ${a} ended.`;
    case 'activate':
      if (a === 'Protosynthesis' || a === 'Quark Drive') {
        if (cmd.args.includes('fromitem')) return `${who} used its Booster Energy to activate ${a}!`;
        return `The ${a === 'Protosynthesis' ? 'harsh sunlight' : 'Electric Terrain'} activated ${n(cmd.slot, false)}'s ${a}!`;
      }
      if (a === 'Supreme Overlord') return `${who} gained strength from the fallen!`;
      return a === 'Protect' ? `${who} protected itself!` : a === 'confusion' ? `${who} is confused!` : `${who}: ${a}!`;
    case 'singleTurn': return a === 'Protect' ? `${who} protected itself!` : `${who}: ${a}!`;
    case 'singleMove': return `${who}: ${a}!`;
    case 'item': return cmd.from?.name === 'Harvest' ? `${who} harvested one ${a}!` : `${who} has ${a}!`;
    case 'endItem': return cmd.from?.name === 'Knock Off' ? `${n(cmd.target)} knocked off ${n(cmd.slot, false)}'s ${a}!` : `${who}'s ${a} was used up!`;
    case 'endAbility': return `${who}'s ${a} was suppressed!`;
    case 'cureTeam': return 'A bell chimed!';
    case 'message': return a;
  }
}
