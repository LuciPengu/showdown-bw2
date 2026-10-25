// Stands in for the userscript and Showdown: plays a two-turn battle where we're p1,
// and prints each /choose the app sends back.
//
//   node scripts/fake-showdown.mjs [room] [--mega | --tera]
//
// --mega and --tera offer Garchomp a Mega Evolution or Terastallization on turn 1
// (the Bag button), and play it if the choice takes it.
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const ROOM = args.find((a) => !a.startsWith('--')) || 'battle-gen5ou-556';
const gimmick = args.includes('--mega') ? { canMegaEvo: true } : args.includes('--tera') ? { canTerastallize: 'Fairy' } : {};
const ws = new WebSocket('ws://localhost:5173/relay?role=tap', { headers: { Origin: 'https://play.pokemonshowdown.com' } });
const say = (lines) => ws.send(`>${ROOM}\n${lines.join('\n')}`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const mon = (ident, details, condition, active, moves) => ({ ident, details, condition, active, moves });
const team = (chompHp, active) => [
  mon('p1: Chompy', 'Garchomp, L50, F', `${chompHp}/183`, active === 'Chompy', ['earthquake', 'outrage', 'hiddenpowerfire70', 'swordsdance']),
  mon('p1: Starmie', 'Starmie, L50', '135/135', active === 'Starmie', ['surf', 'thunderbolt', 'icebeam', 'recover']),
  mon('p1: Ferrothorn', 'Ferrothorn, L50, M', '160/160', active === 'Ferrothorn', ['powerwhip', 'gyroball', 'leechseed', 'stealthrock']),
  mon('p1: Volcarona', 'Volcarona, L50, F', '160/160', active === 'Volcarona', ['fierydance', 'bugbuzz', 'quiverdance', 'gigadrain']),
  mon('p1: Excadrill', 'Excadrill, L50, M', '185/185', active === 'Excadrill', ['earthquake', 'ironhead', 'rockslide', 'swordsdance']),
  mon('p1: Scizor', 'Scizor, L50, M', '145/145', active === 'Scizor', ['bulletpunch', 'uturn', 'superpower', 'pursuit']),
];
const chompMoves = [
  { move: 'Earthquake', id: 'earthquake', pp: 16, maxpp: 16 },
  { move: 'Outrage', id: 'outrage', pp: 16, maxpp: 16 },
  { move: 'Hidden Power Fire 70', id: 'hiddenpowerfire70', pp: 24, maxpp: 24 },
  { move: 'Swords Dance', id: 'swordsdance', pp: 32, maxpp: 32 },
];
const request = (rqid, chompHp, active, moves, extra = {}) =>
  `|request|${JSON.stringify({ rqid, active: [{ moves, ...extra }], side: { name: 'Me', id: 'p1', pokemon: team(chompHp, active) } })}`;

let step = 0;
ws.on('open', () => {
  log('connected as the userscript');
  say(['|init|battle', '|title|Me vs. Foe', '|gametype|singles', '|player|p1|Me|1|', '|player|p2|Foe|2|', '|teamsize|p1|6', '|teamsize|p2|6', '|gen|5', '|tier|[Gen 5] OU']);
  setTimeout(() => {
    say([request(2, 183, 'Chompy', chompMoves, gimmick)]);
    say(['|', '|start', '|switch|p1a: Chompy|Garchomp, L50, F|183/183', '|switch|p2a: Heatran|Heatran, L50, M|100/100', '|turn|1']);
  }, 500);
});
ws.on('message', (data) => {
  const m = JSON.parse(String(data));
  if (m.t !== 'send') return;
  log('APP SENT:', m.room, m.text);
  step++;
  setTimeout(() => {
    if (step === 1) {
      const mega = / mega\b/.test(m.text) ? ['|detailschange|p1a: Chompy|Garchomp-Mega, L50, F', '|-mega|p1a: Chompy|Garchomp|Garchompite'] : [];
      const tera = / terastallize\b/.test(m.text) ? ['|-terastallize|p1a: Chompy|Fairy'] : [];
      say([request(3, 90, 'Chompy', chompMoves.map((x, i) => (i === 0 ? { ...x, pp: 15 } : x)))]);
      say(['|', ...mega, ...tera, '|move|p1a: Chompy|Earthquake|p2a: Heatran', '|-supereffective|p2a: Heatran', '|-damage|p2a: Heatran|20/100',
        '|move|p2a: Heatran|Earth Power|p1a: Chompy', '|-damage|p1a: Chompy|90/183', '|', '|upkeep', '|turn|2']);
    } else if (step === 2) {
      // Starmie comes in and faints: Showdown asks for a replacement.
      const fainted = team(90, 'Starmie').map((p) => (p.ident === 'p1: Starmie' ? { ...p, condition: '0 fnt' } : p));
      say([`|request|${JSON.stringify({ rqid: 4, forceSwitch: [true], side: { name: 'Me', id: 'p1', pokemon: fainted } })}`]);
      say(['|', '|switch|p1a: Starmie|Starmie, L50|135/135', '|move|p2a: Heatran|Fire Blast|p1a: Starmie', '|-damage|p1a: Starmie|0 fnt', '|faint|p1a: Starmie', '|', '|upkeep']);
    } else if (step === 3) {
      log('done: three choices came back');
      setTimeout(() => process.exit(0), 500);
    }
  }, 800);
});
setTimeout(() => {
  log('timed out');
  process.exit(1);
}, 300000);
