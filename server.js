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
const SPAWN = { x: WORLD.width / 2, y: WORLD.height / 2 };

// --- Параметры выживания (на 1 секунду) -----------------------------------
const SURVIVAL = {
  hungerDecay: 0.4,       // голод убывает
  energyDecay: 0.3,       // энергия убывает
  moveEnergyExtra: 0.5,   // дополнительно при движении
  starveDamage: 1.5,      // урон по здоровью при голоде 0
  exhaustDamage: 0.8,     // урон по здоровью при энергии 0
  regen: 0.6,             // регенерация здоровья, когда сыт и бодр
  regenThreshold: 40,     // порог сытости/бодрости для регена
};

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
          x: character.x == null ? SPAWN.x : character.x,
          y: character.y == null ? SPAWN.y : character.y,
          color: cls.color,
          dir: 0,
          // статы выживания (по умолчанию полные при первом входе)
          health: character.health == null ? 100 : character.health,
          hunger: character.hunger == null ? 100 : character.hunger,
          energy: character.energy == null ? 100 : character.energy,
          lastMoveTime: 0,
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
        const nx = clamp(Number(msg.x) || 0, 0, WORLD.width);
        const ny = clamp(Number(msg.y) || 0, 0, WORLD.height);
        if (Math.hypot(nx - player.x, ny - player.y) > 0.5) player.lastMoveTime = Date.now();
        player.x = nx;
        player.y = ny;
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
      // сохраняем позицию и статы, чтобы при следующем входе всё продолжилось
      characters.saveState(player.charId, snapshotState(player));
      players.delete(id);
      broadcast({ type: 'chat', from: 'СИСТЕМА', text: `${player.name} вышел` });
    }
  });

  ws.on('error', () => {});
});

// Состояние персонажа для сохранения
function snapshotState(p) {
  return {
    x: Math.round(p.x), y: Math.round(p.y),
    health: Math.round(p.health), hunger: Math.round(p.hunger), energy: Math.round(p.energy),
  };
}

// --- Игровой цикл: рассылаем снимок мира всем игрокам -----------------------
setInterval(() => {
  const snapshot = [];
  for (const p of players.values()) {
    snapshot.push({
      id: p.id, name: p.name, klass: p.klass,
      x: Math.round(p.x), y: Math.round(p.y), color: p.color, dir: p.dir,
      health: Math.round(p.health), hunger: Math.round(p.hunger), energy: Math.round(p.energy),
    });
  }
  broadcast({ type: 'state', players: snapshot });
}, 1000 / TICK_RATE);

// Множитель скорости выживания (для тестов/балансировки): SURVIVAL_SPEED=60 ускоряет
const SPEED_MULT = Number(process.env.SURVIVAL_SPEED) || 1;

// --- Тик выживания: раз в секунду меняем статы, обрабатываем смерть ---------
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    const moving = now - p.lastMoveTime < 1200;

    // голод и энергия убывают (энергия быстрее в движении)
    p.hunger = Math.max(0, p.hunger - SURVIVAL.hungerDecay * SPEED_MULT);
    p.energy = Math.max(0, p.energy - (SURVIVAL.energyDecay + (moving ? SURVIVAL.moveEnergyExtra : 0)) * SPEED_MULT);

    // здоровье: урон от голода/усталости, иначе регенерация при сытости и бодрости
    let dh = 0;
    if (p.hunger <= 0) dh -= SURVIVAL.starveDamage;
    if (p.energy <= 0) dh -= SURVIVAL.exhaustDamage;
    if (dh === 0 && p.hunger > SURVIVAL.regenThreshold && p.energy > SURVIVAL.regenThreshold) {
      dh += SURVIVAL.regen;
    }
    p.health = Math.max(0, Math.min(100, p.health + dh * SPEED_MULT));

    // смерть и возрождение
    if (p.health <= 0) {
      p.health = 100; p.hunger = 70; p.energy = 70;
      p.x = SPAWN.x; p.y = SPAWN.y;
      send(p.ws, { type: 'death', x: p.x, y: p.y });
      broadcast({ type: 'chat', from: 'СИСТЕМА', text: `${p.name} не выжил и возродился` });
    }
  }
}, 1000);

// Раз в 15 секунд сохраняем позиции и статы активных персонажей
setInterval(() => {
  for (const p of players.values()) {
    characters.saveState(p.charId, snapshotState(p));
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`\n  🌍 Voking Online запущен`);
  console.log(`  Открой в браузере:  http://localhost:${PORT}`);
  console.log(`  Чтобы играть вдвоём — открой ссылку в нескольких вкладках или на других устройствах в сети.\n`);
});
