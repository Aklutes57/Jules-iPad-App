// config.js — every tunable constant lives here.

import { getSetting } from './storage.js';

export const CONFIG = {
  // The one and only absolute URL in this app. The Jules REST API is alpha;
  // when it graduates, this single string is what changes.
  API_BASE_DEFAULT: 'https://jules.googleapis.com/v1alpha',

  // How often to re-poll a session that is actively doing something.
  POLL_ACTIVE_MS: 4000,
  // Fallback cadence for anything that polls while nothing is happening.
  POLL_IDLE_MS: 30000,
  // How often the session list refreshes itself.
  SESSIONS_REFRESH_MS: 15000,

  APP_VERSION: '1.0.0',
};

/** Session states that mean "Jules is still working on this". */
export const ACTIVE_STATES = new Set([
  'QUEUED',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER_FEEDBACK',
  'IN_PROGRESS',
]);

/** Session states where nothing more will happen without the user. */
export const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'PAUSED']);

/** User-selectable polling speeds, surfaced in Settings. */
export const POLL_PRESETS = {
  fast: 3000,
  normal: 5000,
  relaxed: 10000,
};

export const DEFAULT_POLL_SPEED = 'normal';

/** Multiplier applied to the session-list refresh for each speed. */
const SESSIONS_REFRESH_FACTOR = {
  fast: 0.7,
  normal: 1,
  relaxed: 2,
};

/** @returns {string} one of the POLL_PRESETS keys. */
export function pollSpeed() {
  const value = getSetting('pollSpeed', DEFAULT_POLL_SPEED);
  return Object.prototype.hasOwnProperty.call(POLL_PRESETS, value) ? value : DEFAULT_POLL_SPEED;
}

/** Poll interval to use while a session is in an ACTIVE_STATES state. */
export function activePollMs() {
  const ms = POLL_PRESETS[pollSpeed()];
  return typeof ms === 'number' ? ms : CONFIG.POLL_ACTIVE_MS;
}

/** Poll interval for the session list. */
export function sessionsRefreshMs() {
  const factor = SESSIONS_REFRESH_FACTOR[pollSpeed()] || 1;
  return Math.round(CONFIG.SESSIONS_REFRESH_MS * factor);
}

/**
 * Resolve the API base: a deliberate override from Settings, else the default.
 * @returns {string} base URL with no trailing slash.
 */
export function apiBase() {
  const override = getSetting('apiBase', null);
  const base = typeof override === 'string' && override.trim() ? override.trim() : CONFIG.API_BASE_DEFAULT;
  return base.replace(/\/+$/, '');
}

/**
 * Is this URL safe to accept from a `?apiBase=` link?
 *
 * Only loopback addresses qualify. Without this rule anyone could send a link
 * like `...?apiBase=https://evil.example` and the app would happily post the
 * user's API key to them on the next request.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isLocalApiBase(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch (_err) {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}

/**
 * Loose validity check for a manually typed API base (Settings > Advanced).
 * @param {string} value
 * @returns {boolean}
 */
export function isPlausibleApiBase(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_err) {
    return false;
  }
}
