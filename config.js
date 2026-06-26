// ===========================================================================
//  Конфигурация сервера из config.json (рядом с server.js).
//  Сейчас здесь список администраторов. Файл перечитывается «на лету»,
//  поэтому правки применяются без перезапуска сервера.
// ===========================================================================

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'config.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};   // нет файла или битый JSON — пустая конфигурация
  }
}

// Множество логинов-админов: из config.json + переменной ADMIN_USERS (совместимость)
function adminSet() {
  const cfg = load();
  const fromFile = Array.isArray(cfg.admins) ? cfg.admins : [];
  const fromEnv = (process.env.ADMIN_USERS || '').split(',');
  return new Set([...fromFile, ...fromEnv].map(s => String(s).trim().toLowerCase()).filter(Boolean));
}

function isAdmin(username) {
  if (!username) return false;
  return adminSet().has(String(username).trim().toLowerCase());
}

module.exports = { isAdmin, load };
