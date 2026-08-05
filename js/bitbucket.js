// bitbucket.js — the only module that talks to the Bitbucket Cloud REST API.
//
// Why this can exist at all in a page with no backend:
//   api.bitbucket.org/2.0 answers CORS preflights with
//     access-control-allow-origin: *
//     access-control-allow-headers: ... authorization, content-type ...
//   and keeps those headers on error responses too, so the browser can read
//   both successes and failures. (Verified by direct probe, Aug 2026. The old
//   "Atlassian APIs don't do CORS" advice is out of date for Bitbucket Cloud.)
//
// Because allow-origin is the wildcard `*`, requests must use
// credentials:'omit' — a wildcard and cookie credentials are mutually
// exclusive, and we send the Authorization header explicitly anyway.
//
// Credentials (Aug 2026): app passwords were removed on 2026-07-28. What works:
//   basic  — Atlassian API token with Bitbucket scopes, sent as email:token
//   bearer — repository/workspace access token
// OAuth is not an option for a static app: Bitbucket Cloud has no PKCE support
// and the token endpoint demands a client secret we could never keep secret.

import { bitbucketApiBase } from './config.js';
import { getBitbucketCredential } from './storage.js';

const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

/** Scopes the connect screen tells the user to tick. */
export const REQUIRED_SCOPES = [
  'read:workspace:bitbucket',
  'read:repository:bitbucket',
  'write:repository:bitbucket',
  'read:pullrequest:bitbucket',
  'write:pullrequest:bitbucket',
];

export const TOKEN_CREATE_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** Thrown for every failed Bitbucket request. `status === 0` means "never got there". */
export class BitbucketError extends Error {
  /**
   * @param {string} message
   * @param {{status?:number, serverMessage?:string, detail?:string, retryAfterMs?:number|null}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'BitbucketError';
    this.status = typeof info.status === 'number' ? info.status : 0;
    /** Verbatim `error.message` from Atlassian, for the diagnostics panel. */
    this.serverMessage = info.serverMessage || '';
    this.detail = info.detail || '';
    this.retryAfterMs = typeof info.retryAfterMs === 'number' ? info.retryAfterMs : null;
  }

  get isAuth() {
    return this.status === 401 || this.status === 403;
  }

  get isNetwork() {
    return this.status === 0;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffFor(attempt) {
  const base = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 250);
}

/**
 * Base64 that survives non-ASCII (an email address can contain anything).
 * @param {string} value
 */
function base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * @param {{mode?:string,email?:string,token:string}} credential
 * @returns {string} value for the Authorization header.
 */
export function authHeader(credential) {
  if (!credential || !credential.token) return '';
  if (credential.mode === 'bearer') return 'Bearer ' + credential.token;
  return 'Basic ' + base64(String(credential.email || '') + ':' + credential.token);
}

function buildUrl(path, query) {
  const url = new URL(bitbucketApiBase() + path);
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
  // Bitbucket's shape: {"type":"error","error":{"message":"...","detail":"..."}}
  const inner = body.json && body.json.error ? body.json.error : null;
  const serverMessage =
    inner && typeof inner.message === 'string' ? inner.message : (body.text || '').slice(0, 2000);
  const detail = inner && typeof inner.detail === 'string' ? inner.detail : '';
  const message = serverMessage || 'Bitbucket request failed with status ' + res.status;
  const retryAfter = Number(res.headers.get('Retry-After'));
  return new BitbucketError(message, {
    status: res.status,
    serverMessage,
    detail,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 60000) : null,
  });
}

/**
 * One Bitbucket API call, retrying 429/5xx.
 *
 * @param {string} path e.g. "/workspaces"
 * @param {{method?:string, body?:Object, query?:Object, signal?:AbortSignal,
 *          credentialOverride?:Object, retries?:number, absoluteUrl?:string}} [options]
 * @returns {Promise<Object>}
 */
export async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const credential = options.credentialOverride || getBitbucketCredential();
  const retries = typeof options.retries === 'number' ? options.retries : MAX_RETRIES;

  if (!credential || !credential.token) {
    throw new BitbucketError('Bitbucket is not connected on this device.', { status: 401 });
  }

  const url = options.absoluteUrl || buildUrl(path, options.query);
  const headers = {
    Authorization: authHeader(credential),
    Accept: 'application/json',
  };
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
        // Must stay 'omit': Bitbucket replies with allow-origin `*`, which the
        // browser refuses to combine with credentialed requests.
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new BitbucketError('Could not reach Bitbucket.', {
        status: 0,
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
      await sleep(err.retryAfterMs !== null ? err.retryAfterMs : backoffFor(attempt));
      continue;
    }
    throw err;
  }
}

/**
 * Walk Bitbucket's `next` links and collect every `values` entry.
 * @param {string} path
 * @param {{query?:Object, signal?:AbortSignal, credentialOverride?:Object, maxPages?:number}} [options]
 * @returns {Promise<Array<Object>>}
 */
async function collect(path, options = {}) {
  const maxPages = options.maxPages || 10;
  const all = [];
  let data = await request(path, {
    query: Object.assign({ pagelen: 100 }, options.query),
    signal: options.signal,
    credentialOverride: options.credentialOverride,
  });
  for (let page = 0; page < maxPages; page += 1) {
    const batch = Array.isArray(data.values) ? data.values : [];
    for (const item of batch) all.push(item);
    if (!data.next) break;
    data = await request('', {
      absoluteUrl: data.next,
      signal: options.signal,
      credentialOverride: options.credentialOverride,
    });
  }
  return all;
}

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/** Flatten a Bitbucket repository object into what the UI needs. */
export function repoOf(raw) {
  const fullName = raw && raw.full_name ? String(raw.full_name) : '';
  const parts = fullName.split('/');
  return {
    workspace: parts[0] || (raw && raw.workspace && raw.workspace.slug ? raw.workspace.slug : ''),
    slug: raw && raw.slug ? String(raw.slug) : parts[1] || '',
    fullName,
    isPrivate: Boolean(raw && raw.is_private),
    mainBranch: raw && raw.mainbranch && raw.mainbranch.name ? String(raw.mainbranch.name) : '',
    updatedOn: raw && raw.updated_on ? String(raw.updated_on) : '',
    webUrl:
      raw && raw.links && raw.links.html && raw.links.html.href
        ? String(raw.links.html.href)
        : fullName
          ? 'https://bitbucket.org/' + fullName
          : '',
  };
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

export const bitbucket = {
  /**
   * Cheapest "does this credential work?" probe.
   *
   * A repo-scoped bearer token legitimately cannot list workspaces, so when a
   * specific repo is supplied we probe that instead — otherwise a perfectly
   * good token would look broken.
   *
   * @param {{mode?:string,email?:string,token:string}} credential
   * @param {{workspace?:string, repo?:string, signal?:AbortSignal}} [options]
   */
  async testCredential(credential, options = {}) {
    if (options.workspace && options.repo) {
      const raw = await request(
        '/repositories/' + encodeURIComponent(options.workspace) + '/' + encodeURIComponent(options.repo),
        { credentialOverride: credential, signal: options.signal, retries: 0 }
      );
      return { kind: 'repo', repo: repoOf(raw), workspaces: [] };
    }
    const data = await request('/workspaces', {
      query: { pagelen: 100 },
      credentialOverride: credential,
      signal: options.signal,
      retries: 0,
    });
    const workspaces = Array.isArray(data.values) ? data.values : [];
    return { kind: 'workspaces', workspaces, repo: null };
  },

  /** @returns {Promise<Array<{slug:string,name:string}>>} */
  async listWorkspaces(options = {}) {
    const values = await collect('/workspaces', options);
    return values
      .map((w) => ({
        slug: w && w.slug ? String(w.slug) : '',
        name: w && w.name ? String(w.name) : w && w.slug ? String(w.slug) : '',
      }))
      .filter((w) => w.slug);
  },

  /**
   * Repositories in one workspace, most recently updated first.
   *
   * Note the bare `GET /2.0/repositories` (no workspace) was sunset on
   * 2026-04-14 and now returns 410 Gone — always scope by workspace.
   *
   * @param {string} workspace
   */
  async listRepos(workspace, options = {}) {
    const values = await collect('/repositories/' + encodeURIComponent(workspace), {
      query: { sort: '-updated_on' },
      signal: options.signal,
      credentialOverride: options.credentialOverride,
      maxPages: options.maxPages || 5,
    });
    return values.map(repoOf).filter((r) => r.slug);
  },

  /** @param {string} workspace @param {string} repo */
  async getRepo(workspace, repo, options = {}) {
    const raw = await request(
      '/repositories/' + encodeURIComponent(workspace) + '/' + encodeURIComponent(repo),
      { signal: options.signal, credentialOverride: options.credentialOverride }
    );
    return repoOf(raw);
  },

  /**
   * Branch names, default branch first.
   * @param {string} workspace @param {string} repo
   * @returns {Promise<Array<string>>}
   */
  async listBranches(workspace, repo, options = {}) {
    const values = await collect(
      '/repositories/' + encodeURIComponent(workspace) + '/' + encodeURIComponent(repo) + '/refs/branches',
      {
        query: { sort: '-target.date' },
        signal: options.signal,
        credentialOverride: options.credentialOverride,
        maxPages: options.maxPages || 3,
      }
    );
    return values.map((b) => (b && b.name ? String(b.name) : '')).filter(Boolean);
  },

  /**
   * Open a pull request.
   * @param {{workspace:string, repo:string, title:string, sourceBranch:string,
   *          destinationBranch?:string, description?:string, closeSourceBranch?:boolean,
   *          signal?:AbortSignal}} spec
   */
  createPullRequest(spec = {}) {
    const body = {
      title: String(spec.title || 'Jules changes'),
      source: { branch: { name: String(spec.sourceBranch || '') } },
    };
    if (spec.destinationBranch) body.destination = { branch: { name: String(spec.destinationBranch) } };
    if (spec.description) body.description = String(spec.description);
    if (spec.closeSourceBranch) body.close_source_branch = true;

    return request(
      '/repositories/' + encodeURIComponent(spec.workspace) + '/' + encodeURIComponent(spec.repo) + '/pullrequests',
      { method: 'POST', body, signal: spec.signal }
    );
  },
};

/* ------------------------------------------------------------------ */
/* Git URLs (used only inside generated snippets — never fetched here) */
/* ------------------------------------------------------------------ */

/**
 * HTTPS clone URL carrying a token.
 *
 * The username part is not decoration: Bitbucket routes on it.
 *   x-bitbucket-api-token-auth  for Atlassian API tokens
 *   x-token-auth                for repository/workspace/OAuth access tokens
 *
 * @param {{workspace:string, repo:string, mode?:string, token?:string}} spec
 * @returns {string}
 */
export function cloneUrl(spec = {}) {
  const path = String(spec.workspace || '') + '/' + String(spec.repo || '') + '.git';
  if (!spec.token) return 'https://bitbucket.org/' + path;
  const user = spec.mode === 'bearer' ? 'x-token-auth' : 'x-bitbucket-api-token-auth';
  return 'https://' + user + ':' + spec.token + '@bitbucket.org/' + path;
}

/** Web URL for a repo, for "open in Bitbucket" links. */
export function repoWebUrl(workspace, repo) {
  return 'https://bitbucket.org/' + String(workspace || '') + '/' + String(repo || '');
}

export default bitbucket;
