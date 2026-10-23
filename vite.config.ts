import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';

/** Origins allowed to send battle messages: the Showdown client and side servers. */
const TAP_ORIGINS = /^https:\/\/(play\.pokemonshowdown\.com|[a-z0-9-]+\.psim\.us)$/;
const BACKLOG = 3000;

/**
 * `/relay` on the dev server: the userscript connects with `?role=tap` and
 * sends raw Showdown messages; app pages connect with `?role=app` and get them
 * wrapped as `{t:'msg', data}`. A page that connects late gets recent messages
 * first as `{t:'backlog', data}`. A page's `{t:'send', room, text}` (a choice
 * made in BW2) goes to the userscripts, which send it to Showdown.
 */
function relay(): Plugin {
  return {
    name: 'showdown-relay',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });
      const apps = new Set<WebSocket>();
      const taps = new Set<WebSocket>();
      const backlog: string[] = [];
      const send = (to: Iterable<WebSocket>, msg: object) => {
        const s = JSON.stringify(msg);
        for (const ws of to) if (ws.readyState === WebSocket.OPEN) ws.send(s);
      };

      server.httpServer?.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/relay') return;
        const role = url.searchParams.get('role');
        const origin = req.headers.origin ?? '';
        const ownOrigin = origin === `http://${req.headers.host}`;
        if ((role === 'tap' && !TAP_ORIGINS.test(origin)) || (role === 'app' && !ownOrigin) || (role !== 'tap' && role !== 'app')) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (role === 'tap') {
            taps.add(ws);
            send(apps, { t: 'taps', n: taps.size });
            ws.on('message', (data) => {
              const msg = data.toString();
              backlog.push(msg);
              if (backlog.length > BACKLOG) backlog.splice(0, backlog.length - BACKLOG);
              send(apps, { t: 'msg', data: msg });
            });
            ws.on('close', () => {
              taps.delete(ws);
              send(apps, { t: 'taps', n: taps.size });
            });
          } else {
            apps.add(ws);
            if (backlog.length) send([ws], { t: 'backlog', data: backlog });
            send([ws], { t: 'taps', n: taps.size });
            // The page's choices, for the userscript to send to Showdown as the player.
            ws.on('message', (data) => {
              try {
                const m = JSON.parse(data.toString()) as { t?: string; room?: unknown; text?: unknown };
                if (m.t === 'send' && typeof m.room === 'string' && typeof m.text === 'string' && /^battle-[\w-]+$/.test(m.room)) {
                  send(taps, { t: 'send', room: m.room, text: m.text });
                }
              } catch {
                // not for us
              }
            });
            ws.on('close', () => apps.delete(ws));
          }
        });
      });
    },
  };
}

/**
 * `/rom`, `/save` and `/state` on the dev server serve the files named by the
 * ROM, SAVE and STATE environment variables, so the app can start the game
 * (from a save, or jumping to a savestate) without file pickers.
 *
 * `POST /savestates/<name>` writes a savestate into `savestates/`.
 */
function devFiles(): Plugin {
  const serve = (route: string, env: string, hint: string) => (server: ViteDevServer) => {
    server.middlewares.use(route, (_req, res) => {
      const path = process.env[env]?.replace(/^~(?=\/)/, homedir());
      let size = 0;
      try {
        size = path ? statSync(path).size : 0;
      } catch {
        // reported below
      }
      if (!path || !size) {
        res.statusCode = 404;
        res.end(path ? `No file at ${path}` : hint);
        return;
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(size));
      res.setHeader('Cache-Control', 'no-store');
      createReadStream(path).pipe(res);
    });
  };
  return {
    name: 'dev-files',
    configureServer(server) {
      serve('/rom', 'ROM', 'Start the dev server with ROM=/path/to/game.nds')(server);
      serve('/save', 'SAVE', 'Start the dev server with SAVE=/path/to/game.sav')(server);
      serve('/state', 'STATE', 'Start the dev server with STATE=/path/to/savestate')(server);
      server.middlewares.use('/savestates', (req, res, next) => {
        if (req.method !== 'POST') return next();
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, ''));
        if (req.headers.origin !== `http://${req.headers.host}` || !/^[\w.-]+$/.test(name)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = `${server.config.root}/savestates`;
          mkdirSync(dir, { recursive: true });
          writeFileSync(`${dir}/${name}`, Buffer.concat(chunks));
          res.end(`savestates/${name}`);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [relay(), devFiles()],
  server: { port: 5173, strictPort: true },
});
