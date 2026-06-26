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

// --- Цикл дня/ночи ---------------------------------------------------------
// Длина полных игровых суток в реальных секундах (по умолчанию 10 минут).
const DAY_LENGTH_MS = (Number(process.env.DAY_LENGTH_SEC) || 600) * 1000;

// Текущее игровое время суток: { hour, minute, t } где t — доля суток [0,1)
function worldTime() {
  const t = (Date.now() % DAY_LENGTH_MS) / DAY_LENGTH_MS;
  const totalMinutes = Math.floor(t * 24 * 60);
  return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60, t };
}

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

// --- Зомби (ночная угроза) -------------------------------------------------
const ZOMBIE = {
  speed: 105,             // медленнее игрока (240) — можно убегать
  health: 100,
  damage: 7,              // урон игроку за укус
  attackRange: 34,        // дистанция укуса
  attackCooldown: 900,    // мс между укусами
  playerHitDamage: 40,    // урон зомби от удара игрока (≈3 удара)
  spawnRadius: [450, 800],// на каком расстоянии от игрока появляются
  maxPerPlayer: 6,        // размер орды на одного игрока
  spawnBatch: 2,          // сколько появляется за один спавн-тик
};

// --- Параметры выживания (продолжение) ------------------------------------
const THIRST = {
  decay: 0.35,            // жажда убывает обычно
  heatMultiplier: 2.6,    // во время жары — быстрее
  damage: 1.3,            // урон по здоровью при жажде 0
};

// --- Погода (общая для всех) ----------------------------------------------
const WEATHER = {
  changeInterval: [45000, 90000],  // как часто меняется погода (мс)
  sporeWarning: (Number(process.env.SPORE_WARNING_SEC) || 15) * 1000,   // предупреждение до волны спор
  sporeDuration: (Number(process.env.SPORE_DURATION_SEC) || 22) * 1000, // длительность волны спор
  sickChancePerSec: 0.06,          // шанс заболеть в грозу за секунду
  sickDuration: 25000,             // сколько длится болезнь
  sickDamage: 0.9,                 // урон по здоровью от болезни
  sporeDamage: 8,                  // урон вне убежища во время спор
};

// Безопасные зоны-убежища (мировые координаты, радиус). Центр — стартовая зона.
const SHELTERS = [
  { x: 1000, y: 1000, r: 170 },
  { x: 320, y: 320, r: 140 },
  { x: 1680, y: 320, r: 140 },
  { x: 320, y: 1680, r: 140 },
  { x: 1680, y: 1680, r: 140 },
];
function inShelter(p) {
  return SHELTERS.some(s => Math.hypot(p.x - s.x, p.y - s.y) <= s.r);
}

// --- Состояние --------------------------------------------------------------
const players = new Map();        // id -> { id, name, x, y, color, dir, ws }
const zombies = new Map();        // id -> { id, x, y, health, dir, lastAttack }
let nextId = 1;
let nextZombieId = 1;
let wasNight = false;             // для отслеживания смены дня/ночи

// Текущая погода: type = clear | heat | rain | spores; phase для спор: warning | active
let weather = { type: 'clear', phase: null };
// если погода зафиксирована для теста — применяем сразу, иначе первые 30с ясно
let weatherUntil = Date.now() + (process.env.FORCE_WEATHER ? 0 : 30000);
const rand = (a, b) => a + Math.random() * (b - a);

// FORCE_NIGHT=1 — всегда ночь (для тестов и отладки орды)
const FORCE_NIGHT = process.env.FORCE_NIGHT === '1';
function isNight(t = worldTime()) { return FORCE_NIGHT || t.hour < 6 || t.hour >= 20; }

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
        const result = characters.create(account, body.name);
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
      if (urlPath === '/api/admin/upload-sprite') result = world.uploadPlayerSprite(body.dataUrl);
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
        player = {
          id,
          charId: character.id,
          name: character.name,
          x: character.x == null ? SPAWN.x : character.x,
          y: character.y == null ? SPAWN.y : character.y,
          color: character.color || '#e94560',
          dir: 0,
          // статы выживания (по умолчанию полные при первом входе)
          health: character.health == null ? 100 : character.health,
          hunger: character.hunger == null ? 100 : character.hunger,
          energy: character.energy == null ? 100 : character.energy,
          thirst: character.thirst == null ? 100 : character.thirst,
          sick: false, sickUntil: 0,
          lastMoveTime: 0,
          ws,
        };
        players.set(id, player);

        send(ws, { type: 'welcome', id, world: WORLD, radius: PLAYER_RADIUS, x: player.x, y: player.y, config: world.publicConfig(), shelters: SHELTERS });
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

      case 'attack': {
        if (!player) break;
        const t = Date.now();
        if (t - (player.lastAttack || 0) < 400) break;   // кулдаун атаки
        player.lastAttack = t;
        const RANGE = 60;
        for (const [zid, z] of zombies) {
          if (Math.hypot(z.x - player.x, z.y - player.y) <= RANGE) {
            z.health -= ZOMBIE.playerHitDamage;
            if (z.health <= 0) zombies.delete(zid);
          }
        }
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
    health: Math.round(p.health), hunger: Math.round(p.hunger),
    energy: Math.round(p.energy), thirst: Math.round(p.thirst),
  };
}

// --- Игровой цикл: рассылаем снимок мира всем игрокам -----------------------
setInterval(() => {
  const snapshot = [];
  for (const p of players.values()) {
    snapshot.push({
      id: p.id, name: p.name,
      x: Math.round(p.x), y: Math.round(p.y), color: p.color, dir: p.dir,
      health: Math.round(p.health), hunger: Math.round(p.hunger),
      energy: Math.round(p.energy), thirst: Math.round(p.thirst), sick: p.sick,
    });
  }
  const zoms = [];
  for (const z of zombies.values()) {
    zoms.push({ id: z.id, x: Math.round(z.x), y: Math.round(z.y), dir: z.dir, health: Math.round(z.health) });
  }
  const weatherOut = { type: weather.type, phase: weather.phase, secondsLeft: Math.max(0, Math.ceil((weatherUntil - Date.now()) / 1000)) };
  broadcast({ type: 'state', players: snapshot, zombies: zoms, time: worldTime(), weather: weatherOut });
}, 1000 / TICK_RATE);

// Возрождает игрока, если его здоровье на нуле. Возвращает true, если возродил.
function respawnIfDead(p, reason) {
  if (p.health > 0) return false;
  p.health = 100; p.hunger = 70; p.energy = 70;
  p.x = SPAWN.x; p.y = SPAWN.y;
  send(p.ws, { type: 'death', x: p.x, y: p.y });
  broadcast({ type: 'chat', from: 'СИСТЕМА', text: `${p.name} ${reason}` });
  return true;
}

// Множитель скорости выживания (для тестов/балансировки): SURVIVAL_SPEED=60 ускоряет
const SPEED_MULT = Number(process.env.SURVIVAL_SPEED) || 1;

// --- Тик выживания: раз в секунду меняем статы, обрабатываем смерть ---------
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    const moving = now - p.lastMoveTime < 1200;

    // голод, энергия, жажда убывают (жажда быстрее в жару)
    p.hunger = Math.max(0, p.hunger - SURVIVAL.hungerDecay * SPEED_MULT);
    p.energy = Math.max(0, p.energy - (SURVIVAL.energyDecay + (moving ? SURVIVAL.moveEnergyExtra : 0)) * SPEED_MULT);
    const thirstRate = THIRST.decay * (weather.type === 'heat' ? THIRST.heatMultiplier : 1);
    p.thirst = Math.max(0, p.thirst - thirstRate * SPEED_MULT);

    // здоровье: урон от голода/жажды/усталости, иначе регенерация
    let dh = 0;
    if (p.hunger <= 0) dh -= SURVIVAL.starveDamage;
    if (p.energy <= 0) dh -= SURVIVAL.exhaustDamage;
    if (p.thirst <= 0) dh -= THIRST.damage;
    if (dh === 0 && p.hunger > SURVIVAL.regenThreshold && p.energy > SURVIVAL.regenThreshold && p.thirst > SURVIVAL.regenThreshold) {
      dh += SURVIVAL.regen;
    }

    // погода: болезнь в грозу и урон от спор вне убежища
    if (weather.type === 'rain' && !p.sick && Math.random() < WEATHER.sickChancePerSec) {
      p.sick = true; p.sickUntil = now + WEATHER.sickDuration;
      send(p.ws, { type: 'sick' });
    }
    if (p.sick) {
      dh -= WEATHER.sickDamage;
      if (now >= p.sickUntil) p.sick = false;
    }
    if (weather.type === 'spores' && weather.phase === 'active' && !inShelter(p)) {
      dh -= WEATHER.sporeDamage;
    }

    p.health = Math.max(0, Math.min(100, p.health + dh * SPEED_MULT));

    respawnIfDead(p, 'не выжил и возродился');
  }
}, 1000);

// --- Планировщик погоды ----------------------------------------------------
// FORCE_WEATHER=heat|rain|spores — зафиксировать погоду для теста/отладки.
const FORCE_WEATHER = process.env.FORCE_WEATHER || null;

function pickWeather() {
  if (FORCE_WEATHER) return FORCE_WEATHER;
  let next, tries = 0;
  do {
    const r = Math.random();
    next = r < 0.5 ? 'clear' : r < 0.72 ? 'heat' : r < 0.9 ? 'rain' : 'spores';
  } while (next === weather.type && next !== 'spores' && ++tries < 4);
  return next;
}

const WEATHER_MSG = {
  clear: '☀️ Погода прояснилась.',
  heat: '🔥 Наступила жара — пейте больше, иначе обезвоживание!',
  rain: '🌧️ Началась гроза — можно простудиться.',
};

setInterval(() => {
  const now = Date.now();
  if (now < weatherUntil) return;

  if (weather.type === 'spores' && weather.phase === 'warning') {
    weather = { type: 'spores', phase: 'active' };
    weatherUntil = now + WEATHER.sporeDuration;
    broadcast({ type: 'chat', from: 'СИСТЕМА', text: '☠️ ВОЛНА ЯДОВИТЫХ СПОР! Вне убежища — смерть!' });
    return;
  }

  const next = pickWeather();
  if (next === 'spores') {
    weather = { type: 'spores', phase: 'warning' };
    weatherUntil = now + WEATHER.sporeWarning;
    broadcast({ type: 'chat', from: 'СИСТЕМА', text: '☠️ Приближаются ядовитые споры! Срочно найдите убежище!' });
  } else {
    weather = { type: next, phase: null };
    weatherUntil = now + rand(WEATHER.changeInterval[0], WEATHER.changeInterval[1]);
    broadcast({ type: 'chat', from: 'СИСТЕМА', text: WEATHER_MSG[next] });
  }
}, 1000);

// --- Спавн орды зомби и смена дня/ночи (раз в 1.5с) -------------------------
setInterval(() => {
  const night = isNight();

  // переход дня/ночи
  if (night && !wasNight) {
    broadcast({ type: 'chat', from: 'СИСТЕМА', text: '🌙 Наступает ночь — берегитесь орды зомби!' });
  } else if (!night && wasNight) {
    zombies.clear();   // на рассвете орда исчезает
    broadcast({ type: 'chat', from: 'СИСТЕМА', text: '☀️ Рассвет — орда отступила.' });
  }
  wasNight = night;

  // спавн зомби ночью рядом со случайными игроками (DISABLE_ZOMBIES=1 — выкл для тестов)
  if (night && players.size > 0 && !process.env.DISABLE_ZOMBIES) {
    const cap = players.size * ZOMBIE.maxPerPlayer;
    const targets = [...players.values()];
    for (let n = 0; n < ZOMBIE.spawnBatch && zombies.size < cap; n++) {
      const tp = targets[Math.floor(Math.random() * targets.length)];
      const ang = Math.random() * Math.PI * 2;
      const [rmin, rmax] = ZOMBIE.spawnRadius;
      const dist = rmin + Math.random() * (rmax - rmin);
      const z = {
        id: nextZombieId++,
        x: clamp(tp.x + Math.cos(ang) * dist, 0, WORLD.width),
        y: clamp(tp.y + Math.sin(ang) * dist, 0, WORLD.height),
        health: ZOMBIE.health, dir: 0, lastAttack: 0,
      };
      zombies.set(z.id, z);
    }
  }
}, 1500);

// --- ИИ зомби: движение к ближайшему игроку и укусы (10 раз в секунду) ------
const ZOMBIE_DT = 0.1;
setInterval(() => {
  if (zombies.size === 0) return;
  const now = Date.now();
  for (const z of zombies.values()) {
    // ближайший игрок
    let target = null, best = Infinity;
    for (const p of players.values()) {
      const d = Math.hypot(p.x - z.x, p.y - z.y);
      if (d < best) { best = d; target = p; }
    }
    if (!target) continue;

    if (best > ZOMBIE.attackRange) {
      const vx = (target.x - z.x) / best, vy = (target.y - z.y) / best;
      z.x += vx * ZOMBIE.speed * ZOMBIE_DT;
      z.y += vy * ZOMBIE.speed * ZOMBIE_DT;
      z.dir = Math.atan2(vy, vx);
    } else if (now - z.lastAttack >= ZOMBIE.attackCooldown) {
      z.lastAttack = now;
      target.health = Math.max(0, target.health - ZOMBIE.damage);
      send(target.ws, { type: 'hurt' });
      respawnIfDead(target, 'был растерзан ордой зомби и возродился');
    }
  }
}, ZOMBIE_DT * 1000);

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
