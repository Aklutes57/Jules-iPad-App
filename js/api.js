// api.js — the only module that talks to the Jules REST API.
//
// Shape of the API (v1alpha, verified Aug 2026):
//   auth      X-Goog-Api-Key header, key minted at jules.google.com/settings#api
//   errors    {"error": {"code": 401, "message": "...", "status": "UNAUTHENTICATED"}}
//   CORS      fully open, so a static page can call it directly from the browser.

import { apiBase } from './config.js';
import { getApiKey } from './storage.js';

const MAX_RETRIES = 3; // 4 attempts total for 429 / 5xx
const BASE_BACKOFF_MS = 1000; // 1s, 2s, 4s (+ jitter)
const MAX_BACKOFF_MS = 20000;

/** Thrown for every failed request. `status === 0` means "never reached the server". */
export class ApiError extends Error {
  /**
   * @param {string} message human-facing summary
   * @param {{status?:number, googleStatus?:string, serverMessage?:string, retryAfterMs?:number|null}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'ApiError';
    /** HTTP status, or 0 when the request never completed. */
    this.status = typeof info.status === 'number' ? info.status : 0;
    /** Google's symbolic status, e.g. "UNAUTHENTICATED", "RESOURCE_EXHAUSTED". */
    this.googleStatus = info.googleStatus || '';
    /** Verbatim `error.message` from the server, for the diagnostics panel. */
    this.serverMessage = info.serverMessage || '';
    this.retryAfterMs = typeof info.retryAfterMs === 'number' ? info.retryAfterMs : null;
  }

  /** True for the auth failures that mean "this key will never work". */
  get isAuth() {
    return this.status === 401 || this.status === 403;
  }

  /** True when we could not reach the network at all. */
  get isNetwork() {
    return this.status === 0;
  }
}

/** `sessions/abc123` -> `abc123`. Also passes through a bare id unchanged. */
export function sessionId(name) {
  if (!name) return '';
  const parts = String(name).split('/');
  return parts[parts.length - 1] || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffFor(attempt) {
  const base = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 250);
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60000);
  const when = Date.parse(headerValue);
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 60000));
  return null;
}

let authErrorDispatchedAt = 0;

function dispatchAuthError(err) {
  // The listener in app.js debounces further, but avoid a flood of events when
  // several pollers fail at once.
  const now = Date.now();
  if (now - authErrorDispatchedAt < 500) return;
  authErrorDispatchedAt = now;
  try {
    window.dispatchEvent(new CustomEvent('jules:auth-error', { detail: { error: err } }));
  } catch (_e) {
    /* CustomEvent unavailable — nothing useful to do. */
  }
}

function buildUrl(path, query) {
  const url = new URL(apiBase() + path);
  if (query && typeof query === 'object') {
    for (const key of Object.keys(query)) {
      const value = query[key];
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function readBody(res) {
  let text = '';
  try {
    text = await res.text();
  } catch (_err) {
    return { text: '', json: null };
  }
  if (!text) return { text: '', json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch (_err) {
    return { text, json: null };
  }
}

function errorFromResponse(res, body) {
  const googleError = body.json && body.json.error ? body.json.error : null;
  const serverMessage = googleError && typeof googleError.message === 'string'
    ? googleError.message
    : (body.text || '').slice(0, 2000);
  const googleStatus = googleError && typeof googleError.status === 'string' ? googleError.status : '';
  const message = serverMessage || ('Request failed with status ' + res.status);
  return new ApiError(message, {
    status: res.status,
    googleStatus,
    serverMessage,
    retryAfterMs: parseRetryAfter(res.headers.get('Retry-After')),
  });
}

/**
 * Perform one API call, with retries for 429 / 5xx.
 *
 * @param {string} path e.g. "/sessions" or "/sessions/abc:approvePlan"
 * @param {{method?:string, body?:Object, query?:Object, signal?:AbortSignal,
 *          apiKeyOverride?:string, retries?:number}} [options]
 * @returns {Promise<Object>} parsed JSON (an empty object for empty responses)
 */
export async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const key = options.apiKeyOverride || getApiKey();
  const retries = typeof options.retries === 'number' ? options.retries : MAX_RETRIES;

  if (!key) {
    const err = new ApiError('No API key is saved on this device.', {
      status: 401,
      googleStatus: 'CREDENTIALS_MISSING',
      serverMessage: '',
    });
    dispatchAuthError(err);
    throw err;
  }

  const url = buildUrl(path, options.query);
  const headers = { 'X-Goog-Api-Key': key };
  let payload;
  if (options.body !== undefined && options.body !== null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  for (let attempt = 0; ; attempt += 1) {
    if (options.signal && options.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: options.signal,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      // Network-level failure. We do NOT retry these: pollers already back off,
      // and failing fast keeps the offline banner responsive.
      throw new ApiError('Could not reach the Jules service.', {
        status: 0,
        googleStatus: '',
        serverMessage: err && err.message ? String(err.message) : '',
      });
    }

    if (res.ok) {
      const body = await readBody(res);
      return body.json && typeof body.json === 'object' ? body.json : {};
    }

    const body = await readBody(res);
    const err = errorFromResponse(res, body);

    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (retryable && attempt < retries) {
      const wait = err.retryAfterMs !== null ? err.retryAfterMs : backoffFor(attempt);
      await sleep(wait);
      continue;
    }

    if (err.isAuth) dispatchAuthError(err);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Sources cache                                                       */
/* ------------------------------------------------------------------ */

const SOURCES_TTL_MS = 5 * 60 * 1000;
let sourcesCache = null;
let sourcesCachedAt = 0;

/** Drop the cached repo list (called when the API key changes). */
export function clearSourcesCache() {
  sourcesCache = null;
  sourcesCachedAt = 0;
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

export const api = {
  /**
   * Cheapest possible "is this key real?" probe.
   * @param {string} key
   * @param {{signal?:AbortSignal}} [options]
   */
  testKey(key, options = {}) {
    return request('/sources', {
      query: { pageSize: 1 },
      apiKeyOverride: key,
      signal: options.signal,
      retries: 1,
    });
  },

  /** One page of connected GitHub repositories. */
  listSources(options = {}) {
    return request('/sources', {
      query: { pageSize: options.pageSize || 100, pageToken: options.pageToken },
      signal: options.signal,
      apiKeyOverride: options.apiKeyOverride,
    });
  },

  /**
   * Every connected repository, following pageToken until exhausted.
   * Results are cached for a few minutes so the New Task screen opens instantly.
   * @param {{force?:boolean, signal?:AbortSignal, apiKeyOverride?:string}} [options]
   * @returns {Promise<Array<Object>>}
   */
  async listAllSources(options = {}) {
    const fresh = sourcesCache && Date.now() - sourcesCachedAt < SOURCES_TTL_MS;
    if (fresh && !options.force && !options.apiKeyOverride) return sourcesCache;

    const all = [];
    let pageToken;
    for (let page = 0; page < 20; page += 1) {
      const data = await request('/sources', {
        query: { pageSize: 100, pageToken },
        signal: options.signal,
        apiKeyOverride: options.apiKeyOverride,
      });
      const batch = Array.isArray(data.sources) ? data.sources : [];
      for (const source of batch) all.push(source);
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    if (!options.apiKeyOverride) {
      sourcesCache = all;
      sourcesCachedAt = Date.now();
    }
    return all;
  },

  /**
   * @param {{pageSize?:number, pageToken?:string, filter?:string, signal?:AbortSignal}} [options]
   * @returns {Promise<{sessions?:Array<Object>, nextPageToken?:string}>}
   */
  listSessions(options = {}) {
    return request('/sessions', {
      query: {
        pageSize: options.pageSize || 50,
        pageToken: options.pageToken,
        filter: options.filter,
      },
      signal: options.signal,
    });
  },

  getSession(id, options = {}) {
    return request('/sessions/' + encodeURIComponent(sessionId(id)), { signal: options.signal });
  },

  /**
   * @param {{prompt:string, sourceName?:string, startingBranch?:string, title?:string,
   *          requirePlanApproval?:boolean, autoCreatePr?:boolean, signal?:AbortSignal}} spec
   */
  createSession(spec = {}) {
    const body = { prompt: String(spec.prompt || '') };

    // Omitting sourceContext entirely gives a "repoless" scratch VM session.
    if (spec.sourceName) {
      body.sourceContext = { source: spec.sourceName };
      if (spec.startingBranch) {
        body.sourceContext.githubRepoContext = { startingBranch: spec.startingBranch };
      }
    }
    if (spec.title) body.title = spec.title;
    // API-created sessions auto-approve their plan unless this is explicitly true.
    if (spec.requirePlanApproval) body.requirePlanApproval = true;
    if (spec.autoCreatePr) body.automationMode = 'AUTO_CREATE_PR';

    return request('/sessions', { method: 'POST', body, signal: spec.signal });
  },

  deleteSession(id, options = {}) {
    return request('/sessions/' + encodeURIComponent(sessionId(id)), {
      method: 'DELETE',
      signal: options.signal,
    });
  },

  archiveSession(id, options = {}) {
    return request('/sessions/' + encodeURIComponent(sessionId(id)) + ':archive', {
      method: 'POST',
      body: {},
      signal: options.signal,
    });
  },

  unarchiveSession(id, options = {}) {
    return request('/sessions/' + encodeURIComponent(sessionId(id)) + ':unarchive', {
      method: 'POST',
      body: {},
      signal: options.signal,
    });
  },

  approvePlan(id, options = {}) {
    return request('/sessions/' + encodeURIComponent(sessionId(id)) + ':approvePlan', {
      method: 'POST',
      body: {},
      signal: options.signal,
    });
  },

  sendMessage(id, prompt, options = {}) {
    return request('/sessions/' + encodeURIComponent(sessionId(id)) + ':sendMessage', {
      method: 'POST',
      body: { prompt: String(prompt || '') },
      signal: options.signal,
    });
  },

  /**
   * One page of activities.
   * `sinceCreateTime` becomes `filter=create_time>"<rfc3339>"` — the same trick
   * the official SDK uses for incremental polling.
   * @param {string} id
   * @param {{pageSize?:number, pageToken?:string, sinceCreateTime?:string, signal?:AbortSignal}} [options]
   */
  listActivities(id, options = {}) {
    const query = {
      pageSize: options.pageSize || 50,
      pageToken: options.pageToken,
    };
    if (options.sinceCreateTime) {
      query.filter = 'create_time>"' + options.sinceCreateTime + '"';
    }
    return request('/sessions/' + encodeURIComponent(sessionId(id)) + '/activities', {
      query,
      signal: options.signal,
    });
  },

  /**
   * Every activity (bounded), following pageToken.
   * @param {string} id
   * @param {{sinceCreateTime?:string, maxPages?:number, signal?:AbortSignal}} [options]
   * @returns {Promise<Array<Object>>}
   */
  async listAllActivities(id, options = {}) {
    const maxPages = options.maxPages || 10;
    const all = [];
    let pageToken;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.listActivities(id, {
        pageSize: 50,
        pageToken,
        sinceCreateTime: options.sinceCreateTime,
        signal: options.signal,
      });
      const batch = Array.isArray(data.activities) ? data.activities : [];
      for (const activity of batch) all.push(activity);
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return all;
  },

  getActivity(sid, aid, options = {}) {
    return request(
      '/sessions/' + encodeURIComponent(sessionId(sid)) + '/activities/' + encodeURIComponent(aid),
      { signal: options.signal }
    );
  },
};

export default api;
