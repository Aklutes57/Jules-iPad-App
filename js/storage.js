// storage.js — all persistence for the app.
//
// Everything here is defensive: iPad Safari in Private Browsing throws on
// localStorage access, and Safari also evicts localStorage for sites that
// haven't been used in ~7 days. So every call is wrapped in try/catch, and an
// in-memory fallback keeps the current visit working even when nothing can be
// written to disk.

const KEY_API = 'jules.apiKey';
const KEY_SETTINGS = 'jules.settings';

// Used only when localStorage is unavailable (private mode / disabled storage).
const memory = {
  apiKey: null,
  settings: null,
};

function rawGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (_err) {
    return null;
  }
}

function rawSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (_err) {
    return false;
  }
}

function rawRemove(key) {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * True when this browser will actually remember things between visits.
 * Used to warn the user in Private Browsing instead of silently forgetting.
 * @returns {boolean}
 */
export function isPersistent() {
  try {
    const probe = 'jules.__probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch (_err) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* API key                                                             */
/* ------------------------------------------------------------------ */

/** @returns {string|null} */
export function getApiKey() {
  const stored = rawGet(KEY_API);
  if (typeof stored === 'string' && stored.length > 0) return stored;
  return memory.apiKey;
}

/**
 * @param {string} key
 * @returns {boolean} true when the key made it to persistent storage.
 */
export function setApiKey(key) {
  const trimmed = String(key == null ? '' : key).trim();
  if (!trimmed) return clearApiKey();
  memory.apiKey = trimmed;
  return rawSet(KEY_API, trimmed);
}

/** @returns {boolean} */
export function clearApiKey() {
  memory.apiKey = null;
  return rawRemove(KEY_API);
}

/* ------------------------------------------------------------------ */
/* Settings (a single namespaced JSON blob)                            */
/* ------------------------------------------------------------------ */

function readSettings() {
  const raw = rawGet(KEY_SETTINGS);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_err) {
      // Corrupt blob — fall through and start clean rather than break the app.
    }
  }
  return memory.settings ? Object.assign({}, memory.settings) : {};
}

function writeSettings(obj) {
  memory.settings = Object.assign({}, obj);
  try {
    return rawSet(KEY_SETTINGS, JSON.stringify(obj));
  } catch (_err) {
    return false;
  }
}

/**
 * @param {string} name
 * @param {*} [fallback]
 */
export function getSetting(name, fallback = null) {
  const all = readSettings();
  if (Object.prototype.hasOwnProperty.call(all, name) && all[name] !== null && all[name] !== undefined) {
    return all[name];
  }
  return fallback;
}

/**
 * Passing null/undefined removes the setting.
 * @param {string} name
 * @param {*} value
 * @returns {boolean}
 */
export function setSetting(name, value) {
  const all = readSettings();
  if (value === null || value === undefined) delete all[name];
  else all[name] = value;
  return writeSettings(all);
}

/** @returns {Object} a copy of every stored setting. */
export function getAllSettings() {
  return readSettings();
}

/** @returns {boolean} */
export function clearSettings() {
  memory.settings = null;
  return rawRemove(KEY_SETTINGS);
}
