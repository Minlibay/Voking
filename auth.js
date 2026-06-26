// ===========================================================================
//  Аутентификация: регистрация, вход, токены сессий.
//  Пароли НЕ хранятся в открытом виде — только соль + scrypt-хеш.
//  Хранилище — простой JSON-файл (data/users.json). Зависимостей нет.
// ===========================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// username -> { username, salt, hash, createdAt }
let users = new Map();
// token -> { username, createdAt }
const sessions = new Map();

// --- Загрузка/сохранение ---------------------------------------------------
function load() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    users = new Map(arr.map(u => [u.username.toLowerCase(), u]));
  } catch {
    users = new Map();   // файла ещё нет — это нормально при первом запуске
  }
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify([...users.values()], null, 2));
}

// --- Пароли ----------------------------------------------------------------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

// Сравнение в постоянное время, чтобы не утекало по таймингу
function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// --- Валидация ввода -------------------------------------------------------
function validate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return 'Неверные данные';
  username = username.trim();
  if (username.length < 3 || username.length > 16) return 'Имя: от 3 до 16 символов';
  if (!/^[a-zA-Zа-яА-Я0-9_]+$/.test(username)) return 'Имя: только буквы, цифры и _';
  if (password.length < 6) return 'Пароль: минимум 6 символов';
  return null;
}

// Кто админ — определяется конфигом (config.json / ADMIN_USERS), а не записью аккаунта
const config = require('./config');

// --- Публичный API ---------------------------------------------------------
function register(username, password) {
  const err = validate(username, password);
  if (err) return { error: err };

  username = username.trim();
  if (users.has(username.toLowerCase())) return { error: 'Такое имя уже занято' };

  const salt = crypto.randomBytes(16).toString('hex');
  const user = { username, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
  users.set(username.toLowerCase(), user);
  save();

  return login(username, password);
}

function login(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return { error: 'Неверные данные' };
  const user = users.get(username.trim().toLowerCase());
  if (!user) return { error: 'Неверное имя или пароль' };
  if (!safeEqual(hashPassword(password, user.salt), user.hash)) {
    return { error: 'Неверное имя или пароль' };
  }
  const token = newToken();
  sessions.set(token, { username: user.username, createdAt: Date.now() });
  return { token, username: user.username, isAdmin: config.isAdmin(user.username) };
}

// Возвращает имя пользователя по токену, либо null
function verifyToken(token) {
  const s = sessions.get(token);
  return s ? s.username : null;
}

// Возвращает имя админа по токену, либо null (если не админ / токен невалиден).
// Админство берётся из config.json «на лету», без перезапуска сервера.
function verifyAdmin(token) {
  const s = sessions.get(token);
  if (!s) return null;
  return config.isAdmin(s.username) ? s.username : null;
}

function logout(token) {
  sessions.delete(token);
}

load();

module.exports = { register, login, verifyToken, verifyAdmin, logout };
