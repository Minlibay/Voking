// ===========================================================================
//  Состояние мира, редактируемое из админки:
//   - цвета земли (тайлы в шахматку)
//   - объекты на карте (деревья, камни и т.п.)
//   - загруженные спрайты классов и объектов
//  Хранилище: data/world.json + картинки в public/sprites/.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'world.json');
const SPRITES_DIR = path.join(__dirname, 'public', 'sprites');
const OBJ_SPRITES_DIR = path.join(SPRITES_DIR, 'objects');

let config = {
  ground: { colorA: '#1f3d2b', colorB: '#24472f' },
  objects: [],   // { id, sprite, x, y, scale }
};

function ensureDirs() {
  for (const d of [DATA_DIR, SPRITES_DIR, OBJ_SPRITES_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function load() {
  ensureDirs();
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    config = { ...config, ...saved };
  } catch { /* первый запуск — значения по умолчанию */ }
}

function save() {
  ensureDirs();
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2));
}

// Единый спрайт игрока (выжившего) — URL или null. ?v= для сброса кэша.
function playerSprite() {
  const p = path.join(SPRITES_DIR, 'player.png');
  return fs.existsSync(p) ? `/sprites/player.png?v=${Math.floor(fs.statSync(p).mtimeMs)}` : null;
}

// Список загруженных спрайтов объектов
function objectSprites() {
  ensureDirs();
  return fs.readdirSync(OBJ_SPRITES_DIR)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .map(f => ({ name: f, url: `/sprites/objects/${f}` }));
}

// Полный публичный конфиг для клиентов
function publicConfig() {
  return {
    ground: config.ground,
    objects: config.objects,
    playerSprite: playerSprite(),
    objectSprites: objectSprites(),
  };
}

// Декодирует data:URL картинки и сохраняет в файл. Возвращает текст ошибки или null.
function saveDataUrl(filePath, dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return 'Нужен файл PNG, JPEG или WebP';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) return 'Файл больше 6 МБ';
  ensureDirs();
  fs.writeFileSync(filePath, buf);
  return null;
}

function uploadPlayerSprite(dataUrl) {
  const err = saveDataUrl(path.join(SPRITES_DIR, 'player.png'), dataUrl);
  return err ? { error: err } : { ok: true };
}

function uploadObjectSprite(name, dataUrl) {
  name = String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  if (!name) return { error: 'Имя объекта: латинские буквы, цифры, _ или -' };
  const err = saveDataUrl(path.join(OBJ_SPRITES_DIR, name + '.png'), dataUrl);
  return err ? { error: err } : { ok: true, name: name + '.png' };
}

function setGround(colorA, colorB) {
  const ok = (c) => /^#[0-9a-fA-F]{6}$/.test(c);
  if (!ok(colorA) || !ok(colorB)) return { error: 'Цвет в формате #rrggbb' };
  config.ground = { colorA, colorB };
  save();
  return { ok: true };
}

function addObject(sprite, x, y, scale) {
  sprite = String(sprite || '');
  if (!fs.existsSync(path.join(OBJ_SPRITES_DIR, sprite))) return { error: 'Спрайт объекта не найден' };
  const o = {
    id: crypto.randomBytes(6).toString('hex'),
    sprite,
    x: Math.round(Number(x) || 0),
    y: Math.round(Number(y) || 0),
    scale: Math.min(4, Math.max(0.2, Number(scale) || 1)),
  };
  config.objects.push(o);
  save();
  return { ok: true, object: o };
}

function removeObject(id) {
  config.objects = config.objects.filter(o => o.id !== id);
  save();
  return { ok: true };
}

load();

module.exports = {
  publicConfig,
  uploadPlayerSprite, uploadObjectSprite, setGround, addObject, removeObject,
};
