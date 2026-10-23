// Where battle messages come from.

export type Status = (text: string, ok: boolean) => void;

/** Fetches a finished battle's log. Takes a replay link or a bare id like `gen5ou-2703228634`. */
export async function fetchReplay(input: string): Promise<{ room: string; log: string }> {
  const id = /([a-z0-9]+-\d+(?:-[a-z0-9]+)?)(?:\.json|\.log)?\/?(?:\?.*)?$/i.exec(input.trim())?.[1];
  if (!id) throw new Error("That doesn't look like a replay link.");
  const res = await fetch(`https://replay.pokemonshowdown.com/${id}.json`);
  if (!res.ok) throw new Error(`Replay ${id} wasn't found (HTTP ${res.status}).`);
  const json = (await res.json()) as { log?: string };
  if (!json.log) throw new Error(`Replay ${id} has no log.`);
  return { room: `battle-${id}`, log: json.log };
}

/** `https://play.pokemonshowdown.com/battle-gen5ou-123` → `battle-gen5ou-123` */
export function battleRoom(input: string): string | null {
  return /(battle-[a-z0-9]+-\d+(?:-[a-z0-9]+)?)/i.exec(input.trim())?.[1]?.toLowerCase() ?? null;
}

const SHOWDOWN_SERVER = 'wss://sim3.psim.us/showdown/websocket';

/**
 * Joins a battle as a guest spectator, straight from the page. Works for any
 * battle that isn't hidden; your own hidden battles need the userscript tap.
 */
export function spectate(room: string, onMessage: (msg: string) => void, status: Status): () => void {
  const ws = new WebSocket(SHOWDOWN_SERVER);
  let joined = false;
  ws.onopen = () => status('Connected to Showdown', true);
  ws.onmessage = (e) => {
    const msg = String(e.data);
    if (!joined && msg.includes('|challstr|')) {
      joined = true;
      ws.send(`|/join ${room}`);
      status(`Watching ${room}`, true);
    }
    if (msg.startsWith(`>${room}`) && msg.includes('|noinit|')) {
      status(`Couldn't join ${room}: it's over, hidden or doesn't exist`, false);
    }
    onMessage(msg);
  };
  ws.onclose = () => status('Disconnected from Showdown', false);
  ws.onerror = () => status("Couldn't reach Showdown", false);
  return () => ws.close();
}

/** The relay connection: stop listening, or send a battle command through the userscript. */
export interface Relay {
  stop(): void;
  /** Sends `text` to a battle room as the logged-in player. False if no userscript is connected. */
  send(room: string, text: string): boolean;
}

/**
 * Listens to the dev server's relay, which forwards everything the userscript
 * taps from your own Showdown tab, and carries choices back. Reconnects on its own.
 */
export function listenToRelay(onMessage: (msg: string) => void, onBacklog: (msgs: string[]) => void, status: Status): Relay {
  let ws: WebSocket | null = null;
  let stopped = false;
  let taps = 0;
  const connect = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay?role=app`);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { t: 'msg'; data: string } | { t: 'backlog'; data: string[] } | { t: 'taps'; n: number };
      if (m.t === 'msg') onMessage(m.data);
      else if (m.t === 'backlog') onBacklog(m.data);
      else {
        taps = m.n;
        status(m.n ? `Userscript connected (${m.n} tab${m.n > 1 ? 's' : ''})` : 'Waiting for the userscript', m.n > 0);
      }
    };
    ws.onclose = () => {
      taps = 0;
      status('Relay offline', false);
      if (!stopped) setTimeout(connect, 2000);
    };
  };
  connect();
  return {
    stop() {
      stopped = true;
      ws?.close();
    },
    send(room, text) {
      if (!ws || ws.readyState !== WebSocket.OPEN || !taps) return false;
      ws.send(JSON.stringify({ t: 'send', room, text }));
      return true;
    },
  };
}
