// views/dashboard.js — the session list.
//
// Lives permanently in the sidebar pane on wide layouts, and is the root screen
// on narrow ones. It owns its own refresh poller and exposes a small handle
// (refresh / setActive) to app.js so other views can nudge it.

import { api, ApiError, sessionId } from '../api.js';
import { ACTIVE_STATES, sessionsRefreshMs } from '../config.js';
import { createPoller } from '../poller.js';
import { el, icon, iconButton, stateBadge, timeAgo, emptyState, segmented, spinner, clear, toast } from '../ui.js';

const FILTERS = [
  { label: 'Active', value: 'active' },
  { label: 'All', value: 'all' },
  { label: 'Archived', value: 'archived' },
];

/** "sources/github/acme/widgets" -> {owner:"acme", repo:"widgets"} */
function parseSourceName(name) {
  if (typeof name !== 'string') return null;
  const parts = name.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

function sessionRepoLabel(session) {
  const source = session && session.sourceContext ? session.sourceContext.source : null;
  const parsed = parseSourceName(source);
  if (!parsed) return 'Scratch VM';
  return parsed.repo;
}

function sessionRepoTitle(session) {
  const source = session && session.sourceContext ? session.sourceContext.source : null;
  const parsed = parseSourceName(source);
  if (!parsed) return 'No repository (scratch VM)';
  return parsed.owner + '/' + parsed.repo;
}

/** Title, falling back to the first line of the prompt, then to the id. */
function sessionTitle(session) {
  if (session.title && String(session.title).trim()) return String(session.title).trim();
  const prompt = String(session.prompt || '').trim();
  if (prompt) {
    const firstLine = prompt.split(/\r?\n/)[0].trim();
    if (firstLine) return firstLine.length > 120 ? firstLine.slice(0, 119) + '…' : firstLine;
  }
  return 'Untitled task';
}

function hasPullRequest(session) {
  if (!Array.isArray(session.outputs)) return false;
  return session.outputs.some((output) => output && output.pullRequest && output.pullRequest.url);
}

/**
 * @param {HTMLElement} container
 * @param {Object} params
 * @param {Object} ctx
 * @returns {() => void} unmount
 */
export function mount(container, params, ctx) {
  let destroyed = false;
  let filterValue = 'active';
  let sessions = [];
  let nextPageToken = null;
  let activeId = (ctx && ctx.getActiveSession && ctx.getActiveSession()) || null;
  let loading = true;
  let loadError = null;
  let abortController = null;

  /* ---------- chrome ---------- */

  const header = el('header', 'app-header');
  header.appendChild(el('h1', 'app-title', 'Jules'));

  const headerActions = el('div', 'header-actions');
  const refreshBtn = iconButton('refresh', 'Refresh sessions', () => {
    manualRefresh();
  });
  headerActions.appendChild(refreshBtn);
  headerActions.appendChild(
    iconButton('sliders', 'Settings', () => {
      if (ctx && ctx.navigate) ctx.navigate('/settings');
    })
  );
  headerActions.appendChild(
    iconButton(
      'plus',
      'New task',
      () => {
        if (ctx && ctx.navigate) ctx.navigate('/new');
      },
      'icon-btn--accent'
    )
  );
  header.appendChild(headerActions);

  const seg = segmented({
    options: FILTERS,
    value: filterValue,
    ariaLabel: 'Filter sessions',
    onChange: (value) => {
      filterValue = value;
      sessions = [];
      nextPageToken = null;
      loading = true;
      loadError = null;
      render();
      poller.kick();
    },
  });
  const filterBar = el('div', 'filter-bar', seg.node);

  const list = el('div', { class: 'scroll session-list', role: 'list' });

  const pane = el('div', 'pane-body dashboard');
  pane.appendChild(header);
  pane.appendChild(filterBar);
  pane.appendChild(list);
  container.appendChild(pane);

  /* ---------- rendering ---------- */

  function skeleton() {
    const wrap = el('div', 'skeletons');
    for (let i = 0; i < 5; i += 1) {
      wrap.appendChild(
        el(
          'div',
          'skel-row',
          el('div', 'skel skel-line skel-line--title'),
          el('div', 'skel skel-line skel-line--sub')
        )
      );
    }
    return wrap;
  }

  function sessionRow(session) {
    const id = session.id || sessionId(session.name);
    const row = el('button', {
      class: 'session-row' + (id && id === activeId ? ' session-row--active' : ''),
      type: 'button',
      role: 'listitem',
      dataset: { id },
    });

    const main = el('div', 'session-main');
    main.appendChild(el('div', 'session-title', sessionTitle(session)));

    const sub = el('div', 'session-sub');
    sub.appendChild(stateBadge(session.state, { compact: true }));
    sub.appendChild(
      el('span', { class: 'session-repo', title: sessionRepoTitle(session) }, sessionRepoLabel(session))
    );
    if (hasPullRequest(session)) {
      sub.appendChild(el('span', { class: 'pr-dot', title: 'Has a pull request', 'aria-label': 'Has a pull request' }));
    }
    if (session.archived) {
      sub.appendChild(el('span', 'session-flag', 'Archived'));
    }
    sub.appendChild(el('span', 'session-time', timeAgo(session.updateTime || session.createTime)));
    main.appendChild(sub);

    row.appendChild(main);
    row.appendChild(el('span', 'session-chevron', icon('chevron-right', { size: 18, stroke: 2.2 })));

    row.addEventListener('click', () => {
      if (!id) return;
      if (ctx && ctx.navigate) ctx.navigate('/session/' + encodeURIComponent(id));
    });

    return row;
  }

  function render() {
    // Preserve where the user was scrolled to across refreshes.
    const scrollTop = list.scrollTop;
    clear(list);

    if (loading && !sessions.length) {
      list.appendChild(skeleton());
      return;
    }

    if (loadError && !sessions.length) {
      const isNetwork = loadError instanceof ApiError && loadError.isNetwork;
      list.appendChild(
        emptyState({
          icon: isNetwork ? 'wifi' : 'alert',
          title: isNetwork ? 'No connection' : 'Could not load sessions',
          body: isNetwork
            ? 'Your sessions will appear as soon as you are back online.'
            : (loadError && loadError.message) || 'Something went wrong.',
          action: { label: 'Try again', onClick: manualRefresh },
        })
      );
      return;
    }

    if (!sessions.length) {
      if (filterValue === 'archived') {
        list.appendChild(
          emptyState({
            icon: 'archive',
            title: 'Nothing archived',
            body: 'Sessions you archive from the task screen show up here.',
          })
        );
      } else if (filterValue === 'active') {
        list.appendChild(
          emptyState({
            icon: 'inbox',
            title: 'Nothing running',
            body: 'No task is in progress right now. Switch to All to see finished work.',
            action: {
              label: 'Start a task',
              onClick: () => {
                if (ctx && ctx.navigate) ctx.navigate('/new');
              },
            },
          })
        );
      } else {
        list.appendChild(
          emptyState({
            icon: 'sparkle',
            title: 'No sessions yet',
            body: 'Describe something you want done and Jules will get to work on it.',
            action: {
              label: 'Start a task',
              onClick: () => {
                if (ctx && ctx.navigate) ctx.navigate('/new');
              },
            },
          })
        );
      }
      return;
    }

    for (const session of sessions) {
      list.appendChild(sessionRow(session));
    }

    if (nextPageToken) {
      const moreBtn = el('button', { class: 'btn btn--plain load-more', type: 'button' }, 'Load older sessions');
      moreBtn.addEventListener('click', async () => {
        moreBtn.disabled = true;
        clear(moreBtn);
        moreBtn.appendChild(spinner({ size: 18 }));
        try {
          await load({ append: true });
        } catch (_err) {
          /* load() already reported it */
        }
      });
      list.appendChild(moreBtn);
    }

    if (loading) {
      list.appendChild(el('div', 'list-footer', spinner({ size: 18 })));
    }

    list.scrollTop = scrollTop;
  }

  /* ---------- data ---------- */

  function requestOptions() {
    const options = { pageSize: 50 };
    if (filterValue === 'archived') options.filter = 'archived = true';
    return options;
  }

  async function load(options = {}) {
    if (destroyed) return;
    const append = Boolean(options.append);

    if (abortController && !append) abortController.abort();
    const controller = new AbortController();
    if (!append) abortController = controller;

    const requested = filterValue;
    const query = requestOptions();
    if (append && nextPageToken) query.pageToken = nextPageToken;
    query.signal = controller.signal;

    loading = true;
    if (!append) render();

    try {
      const data = await api.listSessions(query);
      if (destroyed || requested !== filterValue) return;

      const batch = Array.isArray(data.sessions) ? data.sessions : [];
      const visible = filterValue === 'active' ? batch.filter((s) => ACTIVE_STATES.has(s.state)) : batch;

      sessions = append ? sessions.concat(visible) : visible;
      nextPageToken = data.nextPageToken || null;
      loadError = null;
      loading = false;
      render();
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      loading = false;
      loadError = err;
      render();
      throw err;
    }
  }

  function manualRefresh() {
    refreshBtn.classList.add('is-spinning');
    setTimeout(() => refreshBtn.classList.remove('is-spinning'), 700);
    nextPageToken = null;
    poller.kick();
    // kick() is a no-op while a tick is in flight or the tab is hidden, so make
    // sure a manual tap always does something.
    if (!poller.isRunning()) {
      load().catch(() => {});
    }
  }

  /* ---------- polling ---------- */

  const poller = createPoller({
    tick: () => load(),
    getInterval: sessionsRefreshMs,
    onError: (err, failures) => {
      // Stay quiet about transient blips; the empty state covers a cold failure.
      if (failures === 2 && err instanceof ApiError && !err.isNetwork && !err.isAuth) {
        toast('Trouble refreshing the session list.');
      }
    },
  });
  poller.start();

  /* ---------- handle exposed to app.js ---------- */

  const handle = {
    refresh() {
      nextPageToken = null;
      poller.kick();
    },
    setActive(id) {
      activeId = id || null;
      const rows = list.querySelectorAll('.session-row');
      for (const row of rows) {
        row.classList.toggle('session-row--active', Boolean(activeId) && row.dataset.id === activeId);
      }
    },
  };
  if (ctx && typeof ctx.registerDashboard === 'function') ctx.registerDashboard(handle);

  render();

  return function unmount() {
    destroyed = true;
    poller.stop();
    if (abortController) abortController.abort();
    if (ctx && typeof ctx.registerDashboard === 'function') ctx.registerDashboard(null);
    if (pane.parentNode) pane.parentNode.removeChild(pane);
  };
}

export default { mount };
