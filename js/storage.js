// storage.js — all persistence for the app.
//
// Everything here is defensive: iPad Safari in Private Browsing throws on
// localStorage access, and Safari also evicts localStorage for sites that
// haven't been used in ~7 days. So every call is wrapped in try/catch, and an
// in-memory fallback keeps the current visit working even when nothing can be
// written to disk.

const KEY_API = 'jules.apiKey';
const KEY_SETTINGS = 'jules.settings';
const KEY_BITBUCKET = 'jules.bitbucket';

// Used only when localStorage is unavailable (private mode / disabled storage).
const memory = {
  apiKey: null,
  settings: null,
  bitbucket: null,
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
/* Bitbucket credential                                                */
/* ------------------------------------------------------------------ */
//
// Stored separately from the Jules key so "forget one" never touches the other.
// Shape: { mode: 'basic'|'bearer', email: string, token: string }
//   basic  — an Atlassian API token (id.atlassian.com > Security > API tokens)
//            sent as HTTP Basic `email:token`. App passwords are gone: Atlassian
//            removed them on 2026-07-28.
//   bearer — a repository/workspace access token, sent as `Bearer <token>`.
//            Narrower blast radius, but it cannot enumerate workspaces.

/** @returns {{mode:string,email:string,token:string}|null} */
export function getBitbucketCredential() {
  const raw = rawGet(KEY_BITBUCKET);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.token) {
        return {
          mode: parsed.mode === 'bearer' ? 'bearer' : 'basic',
          email: typeof parsed.email === 'string' ? parsed.email : '',
          token: String(parsed.token),
        };
      }
    } catch (_err) {
      /* Corrupt blob — behave as if nothing were stored. */
    }
  }
  return memory.bitbucket;
}

/**
 * @param {{mode?:string, email?:string, token:string}} credential
 * @returns {boolean} true when it reached persistent storage.
 */
export function setBitbucketCredential(credential) {
  if (!credential || !credential.token) return clearBitbucketCredential();
  const record = {
    mode: credential.mode === 'bearer' ? 'bearer' : 'basic',
    email: String(credential.email || '').trim(),
    token: String(credential.token).trim(),
  };
  memory.bitbucket = record;
  try {
    return rawSet(KEY_BITBUCKET, JSON.stringify(record));
  } catch (_err) {
    return false;
  }
}

/** @returns {boolean} */
export function clearBitbucketCredential() {
  memory.bitbucket = null;
  return rawRemove(KEY_BITBUCKET);
}

/* ------------------------------------------------------------------ */
/* Bitbucket -> GitHub mirror links                                    */
/* ------------------------------------------------------------------ */
//
// Jules can only see GitHub repositories, so a Bitbucket repo reaches it
// through a mirror. This map remembers which GitHub source stands in for which
// Bitbucket repo: { "workspace/repo": { sourceName, label } }.

/** @returns {Object<string,{sourceName:string,label:string}>} */
export function getMirrorLinks() {
  const all = getSetting('mirrorLinks', null);
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}

/**
 * @param {string} workspace
 * @param {string} repo
 * @returns {{sourceName:string,label:string}|null}
 */
export function getMirrorLink(workspace, repo) {
  const key = String(workspace || '') + '/' + String(repo || '');
  const link = getMirrorLinks()[key];
  return link && link.sourceName ? link : null;
}

/**
 * @param {string} workspace
 * @param {string} repo
 * @param {{sourceName:string,label?:string}|null} link passing null unlinks.
 */
export function setMirrorLink(workspace, repo, link) {
  const key = String(workspace || '') + '/' + String(repo || '');
  const all = getMirrorLinks();
  if (!link || !link.sourceName) delete all[key];
  else all[key] = { sourceName: String(link.sourceName), label: String(link.label || '') };
  return setSetting('mirrorLinks', all);
}

/* ------------------------------------------------------------------ */
/* Which sessions came from Bitbucket                                  */
/* ------------------------------------------------------------------ */
//
// Jules has no idea a task originated in Bitbucket, so the app remembers.
// This is what lets a finished session offer "Create Bitbucket pull request".
// Bounded to the most recent entries — this is a convenience, not a record.

const MAX_SESSION_LINKS = 60;

/** @returns {Object<string,Object>} */
export function getSessionOrigins() {
  const all = getSetting('sessionOrigins', null);
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}

/**
 * @param {string} id session id
 * @returns {{workspace:string,repo:string,branch:string,mode:string,workBranch:string}|null}
 */
export function getSessionOrigin(id) {
  if (!id) return null;
  const found = getSessionOrigins()[String(id)];
  return found && typeof found === 'object' ? found : null;
}

/**
 * @param {string} id
 * @param {Object} origin
 */
export function setSessionOrigin(id, origin) {
  if (!id) return false;
  const all = getSessionOrigins();
  all[String(id)] = Object.assign({ savedAt: new Date().toISOString() }, origin);

  const keys = Object.keys(all);
  if (keys.length > MAX_SESSION_LINKS) {
    keys
      .sort((a, b) => String(all[a].savedAt || '').localeCompare(String(all[b].savedAt || '')))
      .slice(0, keys.length - MAX_SESSION_LINKS)
      .forEach((key) => delete all[key]);
  }
  return setSetting('sessionOrigins', all);
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
