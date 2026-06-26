// ===========================================================================
//  Персонажи (выжившие). У каждого аккаунта может быть несколько персонажей.
//  У персонажа: имя, цвет, уровень и сохранённые позиция и статы выживания.
//  Хранилище — data/characters.json. Зависимостей нет.
// ===========================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'characters.json');

const MAX_PER_ACCOUNT = 6;

// Палитра цветов выживших (чтобы отличать друг друга, пока нет спрайта)
const COLORS = ['#e94560', '#4ade80', '#facc15', '#38bdf8', '#a78bfa', '#fb923c', '#f472b6', '#2dd4bf'];

// id -> { id, owner, name, color, level, x, y, createdAt }
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
  return { id: c.id, name: c.name, color: c.color || COLORS[0], level: c.level };
}

function listByOwner(owner) {
  return [...chars.values()].filter(c => c.owner === owner).map(publicView);
}

function nameTaken(name) {
  const lower = name.toLowerCase();
  return [...chars.values()].some(c => c.name.toLowerCase() === lower);
}

function create(owner, name) {
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 16) return { error: 'Имя персонажа: от 2 до 16 символов' };
  if (!/^[a-zA-Zа-яА-ЯёЁ]+$/.test(name)) return { error: 'Имя: только буквы, без пробелов и цифр' };
  if (nameTaken(name)) return { error: 'Имя персонажа уже занято' };
  if (listByOwner(owner).length >= MAX_PER_ACCOUNT) return { error: `Максимум ${MAX_PER_ACCOUNT} персонажей на аккаунт` };

  const c = {
    id: crypto.randomBytes(8).toString('hex'),
    owner, name,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
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

module.exports = { listByOwner, create, getOwned, remove, saveState, publicView };
