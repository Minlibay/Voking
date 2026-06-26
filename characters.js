// ===========================================================================
//  Персонажи. Каждый аккаунт может иметь несколько персонажей (как в WoW).
//  У персонажа свои имя, класс, уровень и сохранённая позиция в мире.
//  Хранилище — data/characters.json. Зависимостей нет.
// ===========================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'characters.json');

const MAX_PER_ACCOUNT = 6;

// Классы в духе WoW: цвет персонажа и иконка
const CLASSES = {
  warrior:  { name: 'Воин',          color: '#c79c6e', icon: '⚔️' },
  mage:     { name: 'Маг',           color: '#69ccf0', icon: '🔮' },
  rogue:    { name: 'Разбойник',     color: '#fff569', icon: '🗡️' },
  priest:   { name: 'Жрец',          color: '#f0f0f0', icon: '✨' },
  hunter:   { name: 'Охотник',       color: '#abd473', icon: '🏹' },
  warlock:  { name: 'Чернокнижник',  color: '#9482c9', icon: '💀' },
};

// id -> { id, owner, name, klass, level, x, y, createdAt }
let chars = new Map();

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    chars = new Map(arr.map(c => [c.id, c]));
  } catch { chars = new Map(); }
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify([...chars.values()], null, 2));
}

// Публичная форма персонажа (без служебных полей)
function publicView(c) {
  const cls = CLASSES[c.klass];
  return { id: c.id, name: c.name, klass: c.klass, className: cls.name, color: cls.color, icon: cls.icon, level: c.level };
}

function listByOwner(owner) {
  return [...chars.values()].filter(c => c.owner === owner).map(publicView);
}

function nameTaken(name) {
  const lower = name.toLowerCase();
  return [...chars.values()].some(c => c.name.toLowerCase() === lower);
}

function create(owner, name, klass) {
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 16) return { error: 'Имя персонажа: от 2 до 16 символов' };
  if (!/^[a-zA-Zа-яА-ЯёЁ]+$/.test(name)) return { error: 'Имя: только буквы, без пробелов и цифр' };
  if (!CLASSES[klass]) return { error: 'Неизвестный класс' };
  if (nameTaken(name)) return { error: 'Имя персонажа уже занято' };
  if (listByOwner(owner).length >= MAX_PER_ACCOUNT) return { error: `Максимум ${MAX_PER_ACCOUNT} персонажей на аккаунт` };

  const c = {
    id: crypto.randomBytes(8).toString('hex'),
    owner, name, klass,
    level: 1,
    x: null, y: null,              // позиция назначится при первом входе в мир
    // статы выживания (null = ещё не инициализированы, выставятся при входе)
    health: null, hunger: null, energy: null,
    createdAt: Date.now(),
  };
  chars.set(c.id, c);
  save();
  return { character: publicView(c) };
}

// Возвращает «сырого» персонажа, если он принадлежит этому владельцу
function getOwned(id, owner) {
  const c = chars.get(id);
  return c && c.owner === owner ? c : null;
}

function remove(id, owner) {
  const c = getOwned(id, owner);
  if (!c) return { error: 'Персонаж не найден' };
  chars.delete(id);
  save();
  return { ok: true };
}

// Сохраняет позицию и статы выживания персонажа
function saveState(id, state) {
  const c = chars.get(id);
  if (!c) return;
  if (state.x != null) c.x = state.x;
  if (state.y != null) c.y = state.y;
  if (state.health != null) c.health = state.health;
  if (state.hunger != null) c.hunger = state.hunger;
  if (state.energy != null) c.energy = state.energy;
  save();
}

load();

module.exports = { CLASSES, listByOwner, create, getOwned, remove, saveState, publicView };
