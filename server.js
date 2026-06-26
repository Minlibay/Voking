// ===========================================================================
//  Voking Online — игровой сервер (основа MMO)
//  Node.js + WebSocket. Держит общий мир и связывает игроков в реальном времени.
// ===========================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const characters = require('./characters');
const world = require('./world');

const PORT = process.env.PORT || 3000;

// --- Параметры мира -------------------------------------------------------
const WORLD = { width: 2000, height: 2000 };
const TICK_RATE = 20;            // сколько раз в секунду рассылаем состояние мира
const PLAYER_RADIUS = 18;

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

// Читает тело запроса и парсит JSON (с ограничением размера).
// Для загрузки картинок в админке лимит выше.
function readJsonBody(req, maxBytes = 1e5) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve(null); }
    });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  // --- API аутентификации --------------------------------------------------
  if (urlPath.startsWith('/api/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Только POST' });
    // загрузка спрайтов в админке может быть крупной — поднимаем лимит
    const maxBytes = urlPath.startsWith('/api/admin/upload') ? 9e6 : 1e5;
    const body = await readJsonBody(req, maxBytes);
    if (!body) return sendJson(res, 400, { error: 'Некорректный запрос (возможно, файл слишком большой)' });

    if (urlPath === '/api/register') {
      const result = auth.register(body.username, body.password);
      return sendJson(res, result.error ? 400 : 200, result);
    }
    if (urlPath === '/api/login') {
      const result = auth.login(body.username, body.password);
      return sendJson(res, result.error ? 401 : 200, result);
    }

    // --- Дальше идут методы, требующие действующего токена -----------------
    const account = auth.verifyToken(body.token);
    if (urlPath.startsWith('/api/characters/')) {
      if (!account) return sendJson(res, 401, { error: 'Нужна авторизация' });

      if (urlPath === '/api/characters/list') {
        return sendJson(res, 200, { characters: characters.listByOwner(account) });
      }
      if (urlPath === '/api/characters/create') {
        const result = characters.create(account, body.name, body.klass);
        return sendJson(res, result.error ? 400 : 200, result);
      }
      if (urlPath === '/api/characters/delete') {
        const result = characters.remove(body.id, account);
        return sendJson(res, result.error ? 400 : 200, result);
      }
    }

    // --- Админка (только для аккаунтов-админов) ---------------------------
    if (urlPath.startsWith('/api/admin/')) {
      const admin = auth.verifyAdmin(body.token);
      if (!admin) return sendJson(res, 403, { error: 'Доступ только для администратора' });

      if (urlPath === '/api/admin/check') {
        return sendJson(res, 200, { isAdmin: true, config: world.publicConfig() });
      }
      let result;
      if (urlPath === '/api/admin/upload-sprite') result = world.uploadClassSprite(body.klass, body.dataUrl);
      else if (urlPath === '/api/admin/upload-object') result = world.uploadObjectSprite(body.name, body.dataUrl);
      else if (urlPath === '/api/admin/set-ground') result = world.setGround(body.colorA, body.colorB);
      else if (urlPath === '/api/admin/add-object') result = world.addObject(body.sprite, body.x, body.y, body.scale);
      else if (urlPath === '/api/admin/remove-object') result = world.removeObject(body.id);
      else return sendJson(res, 404, { error: 'Неизвестный метод админки' });

      if (result && !result.error) {
        // мгновенно рассылаем новый мир всем игрокам в онлайне
        broadcast({ type: 'world', config: world.publicConfig() });
      }
      return sendJson(res, result && result.error ? 400 : 200, { ...result, config: world.publicConfig() });
    }

    return sendJson(res, 404, { error: 'Неизвестный метод API' });
  }

  // браузер сам просит favicon — отвечаем пусто, чтобы не было 404
  if (urlPath === '/favicon.ico') { res.writeHead(204); return res.end(); }

  // --- Статика -------------------------------------------------------------
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
        // 1) проверяем токен -> аккаунт
        const account = auth.verifyToken(msg.token);
        if (!account) {
          send(ws, { type: 'authError', message: 'Сессия недействительна, войдите заново' });
          ws.close();
          break;
        }
        // 2) проверяем, что выбранный персонаж принадлежит этому аккаунту
        const character = characters.getOwned(msg.characterId, account);
        if (!character) {
          send(ws, { type: 'authError', message: 'Персонаж не найден' });
          ws.close();
          break;
        }
        // 3) грузим сохранённую позицию (или ставим в центр мира при первом входе)
        const cls = characters.CLASSES[character.klass];
        player = {
          id,
          charId: character.id,
          name: character.name,
          klass: character.klass,
          x: character.x == null ? WORLD.width / 2 : character.x,
          y: character.y == null ? WORLD.height / 2 : character.y,
          color: cls.color,
          dir: 0,
          ws,
        };
        players.set(id, player);

        send(ws, { type: 'welcome', id, world: WORLD, radius: PLAYER_RADIUS, x: player.x, y: player.y, config: world.publicConfig() });
        broadcast({ type: 'chat', from: 'СИСТЕМА', text: `${player.name} зашёл в мир` });
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
      // сохраняем позицию персонажа, чтобы при следующем входе он был там же
      characters.savePosition(player.charId, Math.round(player.x), Math.round(player.y));
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
    snapshot.push({ id: p.id, name: p.name, klass: p.klass, x: Math.round(p.x), y: Math.round(p.y), color: p.color, dir: p.dir });
  }
  broadcast({ type: 'state', players: snapshot });
}, 1000 / TICK_RATE);

// Раз в 15 секунд сохраняем позиции активных персонажей
setInterval(() => {
  for (const p of players.values()) {
    characters.savePosition(p.charId, Math.round(p.x), Math.round(p.y));
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`\n  🌍 Voking Online запущен`);
  console.log(`  Открой в браузере:  http://localhost:${PORT}`);
  console.log(`  Чтобы играть вдвоём — открой ссылку в нескольких вкладках или на других устройствах в сети.\n`);
});
