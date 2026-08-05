// router.js — a hash router.
//
// Hash routing (rather than the History API) is deliberate: this app is served
// from a plain static host such as GitHub Pages at an arbitrary sub-path, with
// no server-side rewrite available. Every URL stays a real, reloadable URL.
//
// Routes:
//   #/                  dashboard
//   #/onboarding        paste-your-key screen  (?problem=1 for "key stopped working")
//   #/new               new task
//   #/session/:id       session detail
//   #/settings          settings

/**
 * @typedef {{name:string, params:Object<string,string>, query:Object<string,string>, path:string}} Route
 */

/**
 * @param {string} hash raw `location.hash`
 * @returns {Route}
 */
export function parseHash(hash) {
  let raw = String(hash == null ? '' : hash);
  if (raw.charAt(0) === '#') raw = raw.slice(1);
  if (raw.charAt(0) !== '/') raw = '/' + raw;

  /** @type {Object<string,string>} */
  const query = {};
  const questionMark = raw.indexOf('?');
  if (questionMark >= 0) {
    const search = raw.slice(questionMark + 1);
    raw = raw.slice(0, questionMark);
    try {
      const params = new URLSearchParams(search);
      params.forEach((value, key) => {
        query[key] = value;
      });
    } catch (_err) {
      /* Unparseable query string — ignore it rather than break navigation. */
    }
  }

  const segments = raw
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch (_err) {
        return segment;
      }
    });

  const path = '/' + segments.join('/');

  if (segments.length === 0) {
    return { name: 'dashboard', params: {}, query, path: '/' };
  }
  if (segments[0] === 'onboarding') {
    return { name: 'onboarding', params: {}, query, path };
  }
  if (segments[0] === 'new') {
    return { name: 'new', params: {}, query, path };
  }
  if (segments[0] === 'settings') {
    return { name: 'settings', params: {}, query, path };
  }
  if (segments[0] === 'bitbucket') {
    return { name: 'bitbucket', params: {}, query, path };
  }
  if (segments[0] === 'session' && segments[1]) {
    return { name: 'session', params: { id: segments[1] }, query, path };
  }
  // Unknown route — land on the dashboard rather than a blank screen.
  return { name: 'dashboard', params: {}, query, path: '/' };
}

function normalize(path) {
  let next = String(path == null ? '/' : path);
  if (next.charAt(0) === '#') next = next.slice(1);
  if (next.charAt(0) !== '/') next = '/' + next;
  return next;
}

/**
 * Change the route.
 * @param {string} path e.g. "/session/abc" or "/onboarding?problem=1"
 * @param {{replace?:boolean}} [options]
 */
export function navigate(path, options = {}) {
  const target = '#' + normalize(path);
  if (window.location.hash === target) return;
  if (options.replace) {
    window.location.replace(target);
  } else {
    window.location.hash = target;
  }
}

/** The route the app is on right now. @returns {Route} */
export function currentRoute() {
  return parseHash(window.location.hash);
}

/**
 * Start listening. Calls `onChange` immediately with the current route, then on
 * every subsequent hash change.
 * @param {(route: Route) => void} onChange
 * @returns {() => void} stop function
 */
export function initRouter(onChange) {
  const handler = () => {
    onChange(currentRoute());
  };
  window.addEventListener('hashchange', handler);
  handler();
  return () => window.removeEventListener('hashchange', handler);
}
