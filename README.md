# Showdown in BW2

Pokémon Showdown battles, drawn by Pokémon Black 2 / White 2.

Showdown decides everything that happens in a battle. This app turns Showdown's battle
messages into a list of things for the screen to show, such as "play Thunderbolt from
here to there," "drain this HP bar to 43%" or "print this line." A renderer then plays
them one at a time.

Two renderers play them side by side: a preview drawn in the page with Showdown's BW
sprites and BW2's battle text, and a real BW2 ROM in an emulator, whose own animations,
sprites and text draw the battle. In your own battles you can also pick your moves in
BW2's menus.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm test
```

To run the game in the page, choose your ROM under **Black 2 / White 2**, or let the dev
server hand it over, along with a savestate to jump to:

```sh
ROM=~/path/to/b2.nds STATE=savestates/battle-move-select.state npm run dev
```

(`SAVE=~/path/to/game.sav` loads a cartridge save instead.) Then press **Start**, and
click the page once, since browsers don't run the game before a click.

In the console:

- `window.bw.ram` is the game's main RAM (`read32`, `write16`, `bytes`, …),
  addressed like the DS, e.g. `0x02000000`.
- `window.bw.emulator.press('A')` presses a button.
- `await window.bw.keepState('name.state')` writes a savestate to `savestates/`.

Savestates need the same EmulatorJS version (4.2.3, in `public/emulatorjs`).
`savestates/` is git-ignored. It holds:

| File | Where it starts |
|---|---|
| `pwt-outside.state` | Inside the PWT, by the arena doors, with a Lv 50 team (made with PWT Unlocked's `pwt new`) |
| `battle-move-select.state` | Driftveil Tournament, round 1: Garchomp vs. Golduck at "What will Garchomp do?" |
| `battle-doubles.state` | Rental Tournament, Double Battle, round 1: Golett and Tirtouga vs. Vanillite and Lampent at "What will Golett do?" |

A doubles battle on Showdown switches the game to `battle-doubles.state` on its own, and
a singles battle switches it back to the dev server's `STATE`.

## Where battles come from

- **Watch a live battle:** paste a battle link. The page joins Showdown as a guest
  spectator. If you join mid-battle, earlier turns are drawn instantly and only new ones
  animate.
- **Play a replay:** paste a `replay.pokemonshowdown.com` link.
- **Your own battles:** install `/showdown-tap.user.js` from the running app in
  Tampermonkey or Violentmonkey. It copies your Showdown tab's messages to the dev
  server's `/relay`, and your newest battle takes over the screen with your side drawn
  near. This also covers hidden battles that spectators can't join. Chrome may ask
  whether play.pokemonshowdown.com can reach devices on your local network; allow it.

Only Gen 5 formats can be drawn faithfully. BW2 has no Fairy type, Megas or later moves.

## How it works

```
Showdown messages ─▶ Session ─▶ Translator ─▶ Commands ─▶ Director ─▶ Renderer
  (spectate / replay /  one per     protocol →      bw/commands.ts   one at a    preview now,
   userscript relay)    battle room  BW2 order                       time        emulator next
```

| File | What it does |
|---|---|
| `src/showdown/protocol.ts` | Parses protocol lines, Pokémon refs, details and HP |
| `src/translate.ts` | Turns protocol into `Command`s in the order BW2 shows things: HP drops before "It's super effective!", ability popups before their effect, and withdrawal before a switch-in |
| `src/bw/commands.ts` | Everything a renderer must be able to show |
| `src/bw/english.ts` | BW2-style battle text for the preview |
| `src/session.ts` | Routes messages to battle rooms, follows the newest battle, catches up on battles joined mid-way |
| `src/director.ts` | Queues commands so each one finishes before the next |
| `src/preview.ts` | The stand-in renderer |
| `src/emu/emulator.ts`, `public/emu.html` | EmulatorJS (melonDS) in an iframe |
| `src/emu/ram.ts` | Finds the DS's main RAM in the emulator's heap; reads and writes it |
| `src/sources.ts` | Spectating, replays, the relay client |
| `vite.config.ts` | The `/relay` websocket (accepts taps only from Showdown origins) |
| `public/showdown-tap.user.js` | The userscript |

Tests run the translator and the BW2 scene over real Gen 5 OU and Doubles OU replays in
`test/fixtures/`. `test/gaps.test.ts` keeps a list of anything BW2 can't show yet (it's
empty now), and the app lists the same for the battle on screen.

`scripts/` has tools for testing without a second person:

- `node scripts/showdown-opponent.mjs <your name> [format] [--forfeit-at <turn>]` joins
  Showdown under an unregistered name and plays the other side, picking random moves.
  Showdown doesn't let unregistered names send challenges, so you challenge it (the name
  it prints). For formats that aren't random it brings a Gen 5 team; use the same one
  on your side (it's `TEAM` in the script).
- `scripts/fake-showdown.mjs` stands in for Showdown and the userscript entirely.
- `scripts/dumptext.py <rom> <dir>` dumps the ROM's text banks, which is where the
  message IDs in `src/emu/messages.ts` come from. `scripts/data/` (git-ignored) holds the
  battle banks.

## Playing from BW2

In your own battles, when Showdown asks you to choose, BW2's own menus open. You can tap
Fight and a move, or Pokémon and a switch, with the mouse on the touch screen, or use the
keyboard. Your pick goes back to Showdown as `/choose`. In doubles, BW2 asks for both
Pokémon and their targets.

1. Install `/showdown-tap.user.js` (v0.2.0 or later) and battle in a logged-in Showdown
   tab. Pick your lead at team preview in that tab.
2. In the app, start BW2 and let it take over the savestate battle.
3. From the first turn on, choose in the game. The Showdown tab still works too, and
   whichever choice reaches Showdown first counts.

How it works (`src/play.ts`, `src/emu/bw2.ts`):

- **Your team.** On the first request after team preview, the app writes your whole team
  into BW2's party: species, nickname, level, HP, status and moves. The PWT battle only
  built three battle Pokémon per side, so slots 4–6 borrow the paused server's own
  `BattleMon`s. Their records move into the client's `PokeParty`, and its count goes
  to 6, which the Pokémon menu reads. HP IVs and EVs are chosen so that the game's own
  stat formula gives Showdown's max HP.
- **The menu.** Once a request's turn has finished playing (the director is idle and
  Showdown has been quiet for 0.7 s), the app writes the active Pokémon's moves and PP.
  Then it hands the client `BTL_ACMD_SELECT_ACTION`, or `BTL_ACMD_SELECT_CHANGE_FAINTED`
  for a forced switch. The client runs its normal menu and answers with a
  `BattleAction`.
- **The choice.** A fight carries the move's number, which matches the request's move
  slot, and a target battle position. A switch carries a party slot, which maps to the
  Showdown Pokémon written there. The choice goes out as `room|/choose move N|rqid` or
  `switch N` through the relay, and the userscript sends it with the Showdown client's
  own `app.send`. In doubles there's one part per position (`move 1 2, switch 4`):
  targets are Showdown's (foes 1 and 2, allies −1 and −2) and only go with moves that
  take one, and a position with nothing to choose passes. Bag and Run have no Showdown
  equivalent: you're asked again.
- **Menus nobody needs any more.** A menu opened for a request that has been replaced,
  or still open when the battle ends, is closed by answering it (pressing A), so the
  game cleans up after itself. Requests from the relay's backlog (history replayed when
  the page loads) don't open menus.

Mouse taps need the core's `melonds_touch_mode` set to `Touch`, which `public/emu.html`
does by default. A tap has to last a frame or so, like a real click; instant synthetic
clicks (from browser automation) don't register.

Checked live against a real, logged-in Showdown tab (with `scripts/showdown-opponent.mjs`
on the other side): in Gen 5 Random Battle, a move, a switch and a forced switch after a
faint, all picked in BW2's menus; in Gen 5 Doubles OU, moves with picked targets for
both Pokémon.

The game keeps running while its tab is hidden (say, while you watch your Showdown tab).
`public/emu.html` tells RetroArch the page is always visible, since it pauses otherwise,
and while the page is really hidden the core gets its frames from a worker's timer
(timers in a hidden page itself are throttled to a tick a second or less). The bridge's
timeouts count the game's frames, so a paused game never gets commands skipped.

## Drawing in BW2

BW2's battle is split in two. The logic side (the server) packs display commands into a
byte queue (`SC_MOVE_ANIM`, `SC_DAMAGE`, `SC_SEND_OUT`, …). The client side reads that
queue and calls the battle view. In a local battle they share an adapter in RAM: the
server writes a command there, and the client runs it and sets `returned`.

`src/emu/bw2.ts` takes that over:

1. It finds the player's client by its pointer to the adapter (`sAdapters` at
   `0x021dd86c`) and its main loop (`0x021b19d5`). From there it reaches the main module
   and the server.
2. It sets the server's `state` to 2, which leaves BW2's own battle logic doing nothing.
3. If the move menu is open, it answers the menu, so the menu closes the normal way and
   the client goes idle.
4. For each command, it writes a `BTL_ACMD_SERVER_CMD` block (packed by
   `src/bw/servercmd.ts`) into the adapter and clears `returned`. The client plays the
   block with the game's own handlers, and the bridge waits until it answers.

With the dev server started with `STATE=savestates/battle-move-select.state`, this
happens on its own once the game runs. In any other battle, press **Take over this
battle**. The director then plays every command in both the preview and the game.

Before taking over, the app keeps a snapshot of the game. When Showdown's battle ends,
BW2 shows its own result (the victory music, then "Player defeated PKMN Trainer X!",
"lost against" or "battled to a draw"; "Player" is literal in this ROM's text), and a few
seconds later the game goes back to that snapshot, ready for the next battle. So the game
never leaves a battle and never saves the rewritten party.

`src/emu/scene.ts` turns each command into BW2 server commands, in the order BW2's own
server sends them. It keeps a copy of BW2's side of things: party order by mon ID, HP in
BW2's units, and which positions have a Pokémon on screen.

| Showdown event | In BW2 |
|---|---|
| Battle start | Both trainers renamed to the Showdown players (`src/emu/trainers.ts`): "PKMN Trainer X sent out Y!" |
| Switch in | Rewrites a benched party slot with the Showdown Pokémon (`src/emu/party.ts`), then `OP_SEND_IN` + `SEND_OUT`: real sprite (species, form, gender, shiny), nickname, level, HP and status in the HP box, "Go! X!" |
| Switch out | `RECALL_MSG` + `RECALL` |
| Move | "X used Y!" (`MOVE_MSG`), then the move's animation |
| HP change | `OP_SUBTRACT_HP`/`OP_ADD_HP`, then `DAMAGE` (hit flash and the effectiveness sound) or the gauge alone, then the cause's line (Stealth Rock, burn, Leftovers, …) |
| Faint | The gauge empties, "X fainted!", and the faint animation |
| Status | Condition, gauge icon, the status animation and its line; cures too |
| Stat changes | `OP_RAISE/LOWER_STAT_STAGE`, the stat effect, "X's Attack rose sharply!" |
| Ability | The ability popup with the right ability |
| Weather | Start and end with the game's own animation and text; a replay of the animation each turn |
| Battle text | Crits, effectiveness, misses, Protect, confusion, Substitute, hazards, can't-move reasons, … from the ROM's text banks (`src/emu/messages.ts`) |
| Items | Reveals and losses: Air Balloon, Frisk, Trick, Thief, Knock Off, Focus Sash, Eject Button, damage-halving berries |
| Field and sides | Trick Room, Gravity, Magic Room, Wonder Room; Reflect, Light Screen, Safeguard, Mist, Tailwind, Lucky Chant |
| Volatiles | Taunt, Encore, Disable, Torment, Yawn, Attract, Ingrain, Aqua Ring, Magnet Rise, Curse, Perish Song, Stockpile, Illusion; their can't-move lines |
| Charge turns | Fly, Dig, Dive, Bounce, Shadow Force, Solar Beam, Skull Bash, Sky Attack, … |
| Battle end | The victory music and the result line |

Joining a battle midway applies its history to BW2's battle data only, then sends the
right Pokémon out before the first new animation.

Writing a party slot follows BW2's in-RAM format: the PK5 record is written plain, with
flags 0x0003 meaning "already decrypted" and a PID whose bits 13–17 are clear so the blocks
stay in order. Gender comes from the PID against the species' gender ratio, and shininess
from the IDs. Species data (gender ratio, growth rate, first ability) is read from the
ROM's `a/0/1/6` at boot (`src/emu/rom.ts`).

Trainer names longer than the PWT's own don't fit its name buffer, so they go into
buffers of ours in the paused server's command queue (unused while it's paused), and the
original pointers go back before the game would free them.

Limits:
- **Singles and doubles only.** There are no triples or rotation savestates.
- **The opponent's sprite is still the PWT trainer's**, though the name is Showdown's.
- **Spread moves** animate toward their first target, and each target's hit flashes in
  turn rather than all at once.
- **Some lines are missing.** Lines Gen 5 doesn't have show only in the preview; the app
  lists anything else BW2 couldn't show for the battle on screen.
- **Unreadable names** (e.g. Chinese) show as the species name, or "Player"/"Opponent"
  for trainers, since the US game's font has Latin letters only.

Names and addresses come from [pokebw2](https://github.com/fuddlesworth/pokebw2), a
clean-room decompilation of Black 2 (overlay 167: logic, client, `btlv_core`; overlay
168: effects, sprites, gauges). Struct offsets were read from the game's own
instructions. The "251 Edition" ROM's overlays 167 and 168 load at the same addresses
with the same sizes as the clean game, and all 20,700 call sites and pointers that
pokebw2 lists for them match.
