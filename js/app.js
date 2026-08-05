// app.js — boot, shell, routing, service worker, global error handling.
//
// The shell is two panes. On a wide layout the session list lives in the left
// pane permanently and the routed view fills the right one. On a narrow layout
// only one pane is visible at a time; which one is decided in CSS from
// body[data-route], so no JavaScript runs on resize.

import { isLocalApiBase } from './config.js';
import { getApiKey, setSetting } from './storage.js';
import { initRouter, navigate } from './router.js';
import { toast, el, clear, icon } from './ui.js';

import * as onboardingView from './views/onboarding.js';
import * as dashboardView from './views/dashboard.js';
import * as newSessionView from './views/newSession.js';
import * as sessionDetailView from './views/sessionDetail.js';
import * as settingsView from './views/settings.js';
import * as bitbucketView from './views/bitbucket.js';

/* ------------------------------------------------------------------ */
/* Shell references                                                    */
/* ------------------------------------------------------------------ */

const sidebarPane = document.getElementById('pane-sidebar');
const detailPane = document.getElementById('pane-detail');
const offlineBanner = document.getElementById('offline-banner');

let unmountSidebar = null;
let unmountDetail = null;
let dashboardHandle = null;
let activeSessionId = null;
let mountedDetailRoute = null;
let bootWarning = null;

/* ------------------------------------------------------------------ */
/* ?apiBase= — a testing hook that must not become an exfiltration hole */
/* ------------------------------------------------------------------ */

function consumeApiBaseParam() {
  let url;
  try {
    url = new URL(window.location.href);
  } catch (_err) {
    return;
  }

  // Both API bases can be pointed at a local mock for testing. Neither may be
  // pointed anywhere else from a link: accepting an arbitrary origin here would
  // hand this user's API key (or Bitbucket token) to whoever sent the link.
  const overrides = [
    { param: 'apiBase', setting: 'apiBase', label: 'Jules' },
    { param: 'bitbucketApiBase', setting: 'bitbucketApiBase', label: 'Bitbucket' },
  ];

  let touched = false;
  for (const entry of overrides) {
    if (!url.searchParams.has(entry.param)) continue;
    touched = true;
    const raw = url.searchParams.get(entry.param) || '';
    url.searchParams.delete(entry.param);

    if (isLocalApiBase(raw)) {
      setSetting(entry.setting, raw.trim().replace(/\/+$/, ''));
      bootWarning = 'Using a local ' + entry.label + ' API base for testing: ' + raw;
    } else {
      bootWarning =
        'Ignored the ' + entry.param + ' in that link — only localhost addresses are allowed this way.';
    }
  }

  if (!touched) return;

  // Strip the parameters from the address bar either way, so a reload cannot
  // re-apply them and the URL stays shareable.
  try {
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch (_err) {
    /* replaceState can throw in exotic sandboxes; not fatal. */
  }
}

/* ------------------------------------------------------------------ */
/* Service worker                                                      */
/* ------------------------------------------------------------------ */

let reloadPending = false;

function offerUpdate(worker) {
  if (!worker || worker.__julesOffered) return;
  worker.__julesOffered = true;
  toast('A new version of Jules is ready.', {
    duration: 20000,
    action: {
      label: 'Reload',
      onClick: () => {
        reloadPending = true;
        try {
          worker.postMessage({ type: 'SKIP_WAITING' });
        } catch (_err) {
          window.location.reload();
        }
      },
    },
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only reload when *we* asked the waiting worker to take over. Reloading on
    // the very first install would be a pointless flash on the user's first visit.
    if (!reloadPending) return;
    reloadPending = false;
    window.location.reload();
  });

  let registration;
  try {
    registration = await navigator.serviceWorker.register('./sw.js', {
      scope: './',
      updateViaCache: 'none',
    });
  } catch (_err) {
    // No service worker (file://, http on a non-localhost host, or blocked).
    // The app works fine without one; it just will not run offline.
    return;
  }

  const track = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
    });
  };

  if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
  registration.addEventListener('updatefound', () => track(registration.installing));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    registration.update().catch(() => {});
  });
}

/* ------------------------------------------------------------------ */
/* Online / offline banner                                             */
/* ------------------------------------------------------------------ */

function renderOfflineBanner() {
  if (!offlineBanner) return;
  const online = navigator.onLine !== false;
  offlineBanner.hidden = online;
  document.body.classList.toggle('has-banner', !online);
  if (online) {
    clear(offlineBanner);
    return;
  }
  clear(offlineBanner);
  offlineBanner.appendChild(el('span', 'offline-icon', icon('wifi', { size: 16 })));
  offlineBanner.appendChild(el('span', null, 'No internet connection — Jules will catch up when you are back.'));
}

/* ------------------------------------------------------------------ */
/* Auth errors                                                         */
/* ------------------------------------------------------------------ */

let authErrorHandledAt = 0;

function onAuthError() {
  const now = Date.now();
  // Several pollers can fail at once; only react to the first.
  if (now - authErrorHandledAt < 8000) return;
  authErrorHandledAt = now;

  if (!getApiKey()) {
    navigate('/onboarding', { replace: true });
    return;
  }

  // Tear the whole app down first so no poller keeps hammering a dead key.
  teardownDetail();
  teardownSidebar();
  navigate('/onboarding?problem=1', { replace: true });
}

/* ------------------------------------------------------------------ */
/* View mounting                                                       */
/* ------------------------------------------------------------------ */

const ctx = {
  navigate,

  registerDashboard(handle) {
    dashboardHandle = handle;
    if (handle && activeSessionId) handle.setActive(activeSessionId);
  },

  sessionsChanged() {
    if (dashboardHandle) dashboardHandle.refresh();
  },

  setActiveSession(id) {
    activeSessionId = id || null;
    if (dashboardHandle) dashboardHandle.setActive(activeSessionId);
  },

  getActiveSession() {
    return activeSessionId;
  },

  onKeySaved() {
    authErrorHandledAt = 0;
    navigate('/', { replace: true });
  },

  onKeyForgotten() {
    teardownDetail();
    teardownSidebar();
    navigate('/onboarding', { replace: true });
  },

  isWide() {
    return window.matchMedia('(min-width: 768px)').matches;
  },
};

function teardownDetail() {
  if (typeof unmountDetail === 'function') {
    try {
      unmountDetail();
    } catch (_err) {
      /* A broken unmount must not wedge navigation. */
    }
  }
  unmountDetail = null;
  mountedDetailRoute = null;
  if (detailPane) clear(detailPane);
}

function teardownSidebar() {
  if (typeof unmountSidebar === 'function') {
    try {
      unmountSidebar();
    } catch (_err) {
      /* as above */
    }
  }
  unmountSidebar = null;
  dashboardHandle = null;
  if (sidebarPane) clear(sidebarPane);
}

/** The right-hand pane on a wide layout when no session is open. */
function mountDetailPlaceholder() {
  const node = el(
    'div',
    'pane-body placeholder',
    el(
      'div',
      'placeholder-inner',
      el('div', 'placeholder-icon', icon('sparkle', { size: 40, stroke: 1.4 })),
      el('h2', 'placeholder-title', 'Pick a task'),
      el('p', 'placeholder-body', 'Choose something from the list, or start a new task.')
    )
  );
  detailPane.appendChild(node);
  return () => {
    if (node.parentNode) node.parentNode.removeChild(node);
  };
}

function ensureSidebar() {
  if (unmountSidebar || !sidebarPane) return;
  unmountSidebar = dashboardView.mount(sidebarPane, {}, ctx);
}

function handleRoute(route) {
  const hasKey = Boolean(getApiKey());

  // --- auth gate -----------------------------------------------------
  if (!hasKey && route.name !== 'onboarding') {
    navigate('/onboarding', { replace: true });
    return;
  }
  if (hasKey && route.name === 'onboarding' && !route.query.problem) {
    navigate('/', { replace: true });
    return;
  }

  document.body.dataset.route = route.name;

  // --- sidebar -------------------------------------------------------
  if (route.name === 'onboarding' || !hasKey) teardownSidebar();
  else ensureSidebar();

  // --- detail --------------------------------------------------------
  // A key that identifies "the same mounted view", so tapping the already-open
  // session does not tear it down and lose the feed.
  const detailKey = route.name + ':' + (route.params.id || '') + ':' + (route.query.problem || '');
  if (mountedDetailRoute === detailKey) {
    if (route.name === 'session') ctx.setActiveSession(route.params.id);
    return;
  }

  teardownDetail();
  mountedDetailRoute = detailKey;

  if (route.name !== 'session') ctx.setActiveSession(null);

  switch (route.name) {
    case 'onboarding':
      unmountDetail = onboardingView.mount(detailPane, route.query, ctx);
      break;
    case 'new':
      unmountDetail = newSessionView.mount(detailPane, route.params, ctx);
      break;
    case 'session':
      unmountDetail = sessionDetailView.mount(detailPane, route.params, ctx);
      break;
    case 'settings':
      unmountDetail = settingsView.mount(detailPane, route.params, ctx);
      break;
    case 'bitbucket':
      unmountDetail = bitbucketView.mount(detailPane, route.params, ctx);
      break;
    default:
      unmountDetail = mountDetailPlaceholder();
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  if (!sidebarPane || !detailPane) return;

  consumeApiBaseParam();

  window.addEventListener('jules:auth-error', onAuthError);
  window.addEventListener('online', renderOfflineBanner);
  window.addEventListener('offline', renderOfflineBanner);
  renderOfflineBanner();

  initRouter(handleRoute);

  registerServiceWorker();

  if (bootWarning) {
    const message = bootWarning;
    bootWarning = null;
    setTimeout(() => toast(message, { duration: 8000 }), 400);
  }

  // Last line of defence: an unhandled rejection should never leave the user
  // staring at a screen that silently stopped working.
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    if (reason && reason.name === 'AbortError') return;
    if (reason && reason.name === 'ApiError') return; // views report these themselves
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
