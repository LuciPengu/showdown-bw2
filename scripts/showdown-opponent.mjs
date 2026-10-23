// A Showdown opponent for testing the app against a real server: joins as an
// unregistered name, accepts a challenge from a user, and plays its side by itself.
//
//   node scripts/showdown-opponent.mjs <user> [format] [--forfeit-at <turn>]
//
// Showdown doesn't let unregistered names send challenges, so <user> challenges
// it (the name it prints) to [format]. It picks a random usable move, switches
// when it must, and forfeits at the given turn if one is given. It quits when the
// battle ends.

import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const format = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))[1] ?? 'gen5randombattle';
const forfeitAt = Number(args[args.indexOf('--forfeit-at') + 1]) || (args.includes('--forfeit-at') ? 0 : Infinity);
if (!target) {
  console.error('usage: node scripts/showdown-opponent.mjs <user> [format] [--forfeit-at <turn>]');
  process.exit(1);
}

const name = `bw2test${Math.floor(Math.random() * 1e6)}`;
const ws = new WebSocket('wss://sim3.psim.us/showdown/websocket');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const send = (room, text) => ws.send(`${room}|${text}`);
let battle = '';

ws.on('message', async (data) => {
  const msg = String(data);
  const room = msg.startsWith('>') ? msg.slice(1, msg.indexOf('\n')) : '';
  if (process.env.VERBOSE && !room.startsWith('battle-')) log('<', msg.slice(0, 300));
  for (const line of msg.split('\n')) {
    const [, cmd, ...rest] = line.split('|');
    if (cmd === 'challstr') {
      const res = await fetch('https://play.pokemonshowdown.com/~~showdown/action.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ act: 'getassertion', userid: name, challstr: rest.join('|') }),
      });
      const assertion = await res.text();
      if (!assertion || assertion.startsWith(';')) throw new Error(`couldn't take the name ${name}: ${assertion}`);
      send('', `/trn ${name},0,${assertion}`);
    } else if (cmd === 'updateuser' && rest[0].trim() === name && rest[1] === '1') {
      log(`signed in as ${name}; waiting for ${target} to challenge it to ${format}`);
      send('', '/utm null');
    } else if (cmd === 'updatechallenges') {
      const from = JSON.parse(rest.join('|')).challengesFrom ?? {};
      for (const [user, f] of Object.entries(from)) {
        if (user !== toID(target)) continue;
        if (f !== format) log(`${user} challenged to ${f}, not ${format}; accepting anyway`);
        send('', `/accept ${user}`);
      }
    } else if (cmd === 'pm' && toID(rest[0]) === toID(target) && rest[2]?.startsWith('/challenge')) {
      // Challenges come as PMs: |pm| user|me|/challenge format|…
      log(`${target} challenged: ${rest[2]}`);
      send('', `/accept ${toID(target)}`);
    } else if (cmd === 'pm' && rest.join('|').includes('/error')) {
      log('error:', rest.slice(2).join('|'));
    } else if (cmd === 'popup') {
      log('popup:', rest.join('|'));
    } else if (cmd === 'init' && rest[0] === 'battle') {
      battle = room;
      log(`battle started: https://play.pokemonshowdown.com/${room}`);
    } else if (cmd === 'turn' && room === battle) {
      log('turn', rest[0]);
      if (Number(rest[0]) >= forfeitAt) {
        log('forfeiting');
        send(battle, '/forfeit');
      }
    } else if (cmd === 'request' && rest.join('|')) {
      choose(room, JSON.parse(rest.join('|')));
    } else if (cmd === 'error' && room === battle && /Invalid choice|Can't/.test(rest.join('|'))) {
      log('error:', rest.join('|'), '— choosing the default');
      send(battle, '/choose default');
    } else if ((cmd === 'win' || cmd === 'tie') && room === battle) {
      log(cmd === 'win' ? `${rest[0]} won` : 'tie');
      send(battle, '/leave');
      setTimeout(() => process.exit(0), 1000);
    }
  }
});

function toID(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A random move that isn't disabled; otherwise, the default choice (a forced switch, team preview). */
function choose(room, req) {
  if (req.wait) return;
  const rqid = req.rqid !== undefined ? `|${req.rqid}` : '';
  const moves = req.active?.[0]?.moves?.map((m, i) => ({ ...m, slot: i + 1 })).filter((m) => !m.disabled && m.pp !== 0) ?? [];
  if (req.forceSwitch || req.teamPreview || !moves.length) return send(room, `/choose default${rqid}`);
  const pick = moves[Math.floor(Math.random() * moves.length)];
  log(`using ${pick.move}`);
  send(room, `/choose move ${pick.slot}${rqid}`);
}

ws.on('close', () => log('disconnected'));
