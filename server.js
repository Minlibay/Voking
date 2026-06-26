// ===========================================================================
//  Voking Online — игровой сервер (основа MMO)
//  Node.js + WebSocket. Держит общий мир и связывает игроков в реальном времени.
// ===========================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// --- Параметры мира -------------------------------------------------------
const WORLD = { width: 2000, height: 2000 };
const TICK_RATE = 20;            // сколько раз в секунду рассылаем состояние мира
const PLAYER_RADIUS = 18;
const COLORS = ['#e94560', '#4ade80', '#facc15', '#38bdf8', '#a78bfa', '#fb923c', '#f472b6', '#2dd4bf'];

// --- Состояние --------------------------------------------------------------
const players = new Map();        // id -> { id, name, x, y, color, dir, ws }
let nextId = 1;

// --- Раздача статики (клиент игры) -----------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, 'public', path.normalize(urlPath));
  // защита от выхода за пределы public/
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — страница не найдена');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- WebSocket --------------------------------------------------------------
const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

wss.on('connection', (ws) => {
  const id = nextId++;
  let player = null;   // создаётся после получения 'join'

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        const name = String(msg.name || 'Безымянный').slice(0, 16).trim() || 'Безымянный';
        player = {
          id,
          name,
          x: Math.random() * WORLD.width,
          y: Math.random() * WORLD.height,
          color: COLORS[id % COLORS.length],
          dir: 0,
          ws,
        };
        players.set(id, player);

        // сообщаем игроку его id и параметры мира
        send(ws, { type: 'welcome', id, world: WORLD, radius: PLAYER_RADIUS });
        broadcast({ type: 'chat', from: 'СИСТЕМА', text: `${name} зашёл в мир` });
        break;
      }

      case 'move': {
        if (!player) break;
        // клиент присылает свою позицию; сервер ограничивает её границами мира
        player.x = clamp(Number(msg.x) || 0, 0, WORLD.width);
        player.y = clamp(Number(msg.y) || 0, 0, WORLD.height);
        player.dir = Number(msg.dir) || 0;
        break;
      }

      case 'chat': {
        if (!player) break;
        const text = String(msg.text || '').slice(0, 120).trim();
        if (text) broadcast({ type: 'chat', from: player.name, text });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (player) {
      players.delete(id);
      broadcast({ type: 'chat', from: 'СИСТЕМА', text: `${player.name} вышел` });
    }
  });

  ws.on('error', () => {});
});

// --- Игровой цикл: рассылаем снимок мира всем игрокам -----------------------
setInterval(() => {
  const snapshot = [];
  for (const p of players.values()) {
    snapshot.push({ id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), color: p.color, dir: p.dir });
  }
  broadcast({ type: 'state', players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`\n  🌍 Voking Online запущен`);
  console.log(`  Открой в браузере:  http://localhost:${PORT}`);
  console.log(`  Чтобы играть вдвоём — открой ссылку в нескольких вкладках или на других устройствах в сети.\n`);
});
