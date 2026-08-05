// views/sessionDetail.js — one session: its feed, its state, its composer.
//
// Polling contract:
//   * exactly one poller for the whole view (session + activities in one tick)
//   * activities are fetched incrementally with filter create_time>"<lastSeen>"
//   * everything is de-duplicated by activity.name, so an overlapping window or
//     a repeated page can never double-render
//   * the poller stops entirely once the session reaches a settled state; a
//     manual refresh button takes over from there

import { api, ApiError, sessionId } from '../api.js';
import { ACTIVE_STATES, activePollMs } from '../config.js';
import { createPoller } from '../poller.js';
import { renderActivity } from '../activity.js';
import {
  el,
  icon,
  iconButton,
  stateBadge,
  stateLabel,
  spinner,
  clear,
  toast,
  confirmSheet,
  actionSheet,
  autoGrow,
  emptyState,
  openExternal,
  formatTime,
} from '../ui.js';
import { bitbucket } from '../bitbucket.js';
import { getSessionOrigin, getBitbucketCredential } from '../storage.js';

const NEAR_BOTTOM_PX = 140;

function parseSourceName(name) {
  if (typeof name !== 'string') return null;
  const parts = name.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

function sessionTitle(session) {
  if (!session) return 'Task';
  if (session.title && String(session.title).trim()) return String(session.title).trim();
  const prompt = String(session.prompt || '').trim();
  if (prompt) {
    const firstLine = prompt.split(/\r?\n/)[0].trim();
    if (firstLine) return firstLine.length > 90 ? firstLine.slice(0, 89) + '…' : firstLine;
  }
  return 'Untitled task';
}

function pullRequestOf(session) {
  if (!session || !Array.isArray(session.outputs)) return null;
  for (const output of session.outputs) {
    if (output && output.pullRequest && output.pullRequest.url) return output.pullRequest;
  }
  return null;
}

/**
 * @param {HTMLElement} container
 * @param {{id:string}} params
 * @param {Object} ctx
 * @returns {() => void} unmount
 */
export function mount(container, params, ctx) {
  const id = params && params.id ? String(params.id) : '';

  let destroyed = false;
  let session = null;
  let loadError = null;
  let firstLoadDone = false;
  let lastRenderedState = null;
  let sending = false;
  let approving = false;
  /** Set when this task started from a Bitbucket repository (see js/bridge.js). */
  const origin = getSessionOrigin(id);
  let creatingPr = false;

  /** name -> activity (includes optimistic placeholders) */
  const byName = new Map();
  /** names currently in the DOM, in order */
  let renderedNames = [];
  /** newest createTime we have seen, for the incremental filter */
  let lastSeen = null;
  /** optimistic user messages awaiting their real counterpart */
  let pending = [];

  const abortController = new AbortController();

  /* ------------------------------------------------------------------ */
  /* Chrome                                                              */
  /* ------------------------------------------------------------------ */

  const backBtn = iconButton(
    'chevron-left',
    'Back to sessions',
    () => {
      if (ctx && ctx.navigate) ctx.navigate('/');
    },
    'icon-btn--back'
  );

  const titleEl = el('h1', 'app-title detail-title', 'Task');
  const badgeSlot = el('span', 'detail-badge');
  const titleBlock = el('div', 'detail-titleblock', titleEl, badgeSlot);

  const headerActions = el('div', 'header-actions');
  const header = el('header', 'app-header detail-header', backBtn, titleBlock, headerActions);

  const statusStrip = el('div', { class: 'status-strip', hidden: true });

  const feedItems = el('div', 'feed-items');
  const feedIntro = el('div', 'feed-intro');
  const feedPlaceholder = el('div', 'feed-placeholder');
  const feed = el('div', { class: 'scroll feed' }, feedIntro, feedItems, feedPlaceholder);

  const composerInput = el('textarea', {
    class: 'input textarea composer-input',
    rows: 1,
    placeholder: 'Message Jules…',
    'aria-label': 'Message Jules',
  });
  const sendBtn = el(
    'button',
    { class: 'send-btn', type: 'submit', 'aria-label': 'Send message', title: 'Send message', disabled: true },
    icon('arrow-up', { size: 20, stroke: 2.4 })
  );
  const composer = el('form', 'composer', composerInput, sendBtn);

  const pane = el('div', 'pane-body session-detail', header, statusStrip, feed, composer);
  container.appendChild(pane);

  const growComposer = autoGrow(composerInput, 160);

  /* ------------------------------------------------------------------ */
  /* Scroll helpers                                                      */
  /* ------------------------------------------------------------------ */

  function isNearBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < NEAR_BOTTOM_PX;
  }

  function scrollToBottom(smooth) {
    requestAnimationFrame(() => {
      if (destroyed) return;
      try {
        feed.scrollTo({ top: feed.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      } catch (_err) {
        feed.scrollTop = feed.scrollHeight;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Header + status strip                                               */
  /* ------------------------------------------------------------------ */

  function renderHeader() {
    titleEl.textContent = sessionTitle(session);

    clear(badgeSlot);
    if (session && session.state) badgeSlot.appendChild(stateBadge(session.state));

    clear(headerActions);

    const pr = pullRequestOf(session);
    if (pr) {
      const prBtn = el(
        'button',
        { class: 'btn btn--tonal btn--tight', type: 'button', title: pr.title || 'Open pull request' },
        icon('pr', { size: 17 }),
        el('span', 'btn-label', 'Pull request')
      );
      prBtn.addEventListener('click', () => openExternal(pr.url));
      headerActions.appendChild(prBtn);
    }

    // Tasks that came from Bitbucket get a PR button of their own: Jules has no
    // idea Bitbucket exists, so the app opens the pull request on its behalf.
    if (origin && session && !ACTIVE_STATES.has(session.state)) {
      const bbBtn = el(
        'button',
        { class: 'btn btn--tonal btn--tight', type: 'button', title: 'Open a pull request on Bitbucket' },
        icon('pr', { size: 17 }),
        el('span', 'btn-label', 'Bitbucket PR')
      );
      bbBtn.addEventListener('click', openBitbucketPr);
      headerActions.appendChild(bbBtn);
    }

    if (session && session.url) {
      const openBtn = el(
        'button',
        { class: 'btn btn--plain btn--tight', type: 'button', title: 'Open this session on jules.google.com' },
        icon('external', { size: 17 }),
        el('span', 'btn-label', 'Open in Jules')
      );
      openBtn.addEventListener('click', () => openExternal(session.url));
      headerActions.appendChild(openBtn);
    }

    headerActions.appendChild(
      iconButton('refresh', 'Refresh', () => {
        refreshNow(true);
      }, 'js-refresh')
    );

    headerActions.appendChild(iconButton('dots', 'More actions', openMenu));
  }

  /**
   * Open a pull request on Bitbucket for a task that started there.
   *
   * Jules pushes its work to a branch — on the GitHub mirror (mirror mode, from
   * where the back-sync workflow carries it to Bitbucket) or straight to
   * Bitbucket (direct mode). Either way the PR itself has to be opened here,
   * because Jules has no concept of Bitbucket.
   */
  async function openBitbucketPr() {
    if (creatingPr || !origin) return;
    if (!getBitbucketCredential()) {
      toast('Connect Bitbucket first.', { tone: 'error' });
      if (ctx && ctx.navigate) ctx.navigate('/bitbucket');
      return;
    }

    // Three ways to learn the branch, best first:
    //   direct mode  — the app chose the name itself
    //   mirror mode  — Jules opened a PR on GitHub, whose headRef is the branch
    //   otherwise    — ask, since only the activity feed knows
    const pr = pullRequestOf(session);
    let branch = origin.workBranch || (pr && pr.headRef ? String(pr.headRef) : '');
    if (!branch) {
      const guess = window.prompt(
        'Which branch did Jules push? (shown in the activity feed, usually starting with "jules/")',
        'jules/'
      );
      branch = guess ? String(guess).trim() : '';
      if (!branch) return;
    }

    const target = origin.branch || 'main';
    const ok = await confirmSheet(
      'Open a pull request on Bitbucket from “' + branch + '” into “' + target + '”?',
      { confirmLabel: 'Create pull request', title: 'Bitbucket pull request' }
    );
    if (!ok || destroyed) return;

    creatingPr = true;
    try {
      const pr = await bitbucket.createPullRequest({
        workspace: origin.workspace,
        repo: origin.repo,
        title: sessionTitle(session),
        sourceBranch: branch,
        destinationBranch: target,
        description: 'Created by Jules.\n\nSession: ' + (session && session.url ? session.url : id),
      });
      if (destroyed) return;
      creatingPr = false;
      const url = pr && pr.links && pr.links.html && pr.links.html.href ? pr.links.html.href : '';
      toast('Pull request created.', url ? { action: { label: 'Open', onClick: () => openExternal(url) } } : undefined);
    } catch (err) {
      if (destroyed) return;
      creatingPr = false;
      const message = (err && err.message) || 'Could not create the pull request.';
      // The most common cause is the branch not being on Bitbucket yet — in
      // mirror mode the back-sync workflow may still be running.
      toast(
        /branch/i.test(message)
          ? message + ' If this task used a mirror, wait for the sync workflow to finish and try again.'
          : message,
        { tone: 'error' }
      );
    }
  }

  function renderStatusStrip() {
    clear(statusStrip);
    statusStrip.className = 'status-strip';

    if (!session) {
      statusStrip.hidden = true;
      return;
    }

    if (session.state === 'AWAITING_PLAN_APPROVAL') {
      statusStrip.classList.add('status-strip--attention');
      statusStrip.appendChild(el('span', 'status-dot'));
      statusStrip.appendChild(el('span', 'status-text', 'Jules is waiting for your approval'));
      const jump = el('button', { class: 'btn btn--link', type: 'button' }, 'Jump to plan');
      jump.addEventListener('click', () => {
        const cards = feedItems.querySelectorAll('[data-plan="1"]');
        const target = cards.length ? cards[cards.length - 1] : null;
        if (target) {
          try {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } catch (_err) {
            target.scrollIntoView();
          }
          target.classList.add('is-flashing');
          setTimeout(() => target.classList.remove('is-flashing'), 1400);
        } else {
          scrollToBottom(true);
        }
      });
      statusStrip.appendChild(jump);
      statusStrip.hidden = false;
      return;
    }

    if (session.state === 'AWAITING_USER_FEEDBACK') {
      statusStrip.classList.add('status-strip--attention');
      statusStrip.appendChild(el('span', 'status-dot'));
      statusStrip.appendChild(el('span', 'status-text', 'Jules asked you a question'));
      const reply = el('button', { class: 'btn btn--link', type: 'button' }, 'Reply');
      reply.addEventListener('click', () => {
        scrollToBottom(true);
        try {
          composerInput.focus();
        } catch (_err) {
          /* best effort */
        }
      });
      statusStrip.appendChild(reply);
      statusStrip.hidden = false;
      return;
    }

    if (session.archived) {
      statusStrip.classList.add('status-strip--muted');
      statusStrip.appendChild(el('span', 'status-text', 'This session is archived.'));
      statusStrip.hidden = false;
      return;
    }

    statusStrip.hidden = true;
  }

  function renderIntro() {
    clear(feedIntro);
    if (!session) return;

    const bits = [];
    const parsed = parseSourceName(session.sourceContext && session.sourceContext.source);
    if (parsed) {
      let repoText = parsed.owner + '/' + parsed.repo;
      const branch =
        session.sourceContext.githubRepoContext && session.sourceContext.githubRepoContext.startingBranch;
      if (branch) repoText += ' · ' + branch;
      bits.push(repoText);
    } else {
      bits.push('No repository (scratch VM)');
    }
    if (session.createTime) bits.push('started ' + formatTime(session.createTime));

    feedIntro.appendChild(el('div', 'feed-intro-line', bits.join(' · ')));
  }

  /* ------------------------------------------------------------------ */
  /* Feed                                                                */
  /* ------------------------------------------------------------------ */

  function orderedActivities() {
    return Array.from(byName.values()).sort((a, b) => {
      const at = Date.parse(a.createTime) || 0;
      const bt = Date.parse(b.createTime) || 0;
      if (at !== bt) return at - bt;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function approveHandler() {
    if (approving) return Promise.resolve();
    approving = true;
    return api
      .approvePlan(id, { signal: abortController.signal })
      .then(() => {
        if (destroyed) return null;
        toast('Plan approved — Jules is starting.');
        return refreshNow(true);
      })
      .catch((err) => {
        if (destroyed || (err && err.name === 'AbortError')) return null;
        // The most common failure is approving a plan that is no longer
        // pending (another device beat us to it). Re-syncing fixes the UI.
        toast(
          err instanceof ApiError && err.status === 400
            ? 'That plan is no longer waiting for approval — refreshing.'
            : (err && err.message) || 'Could not approve the plan.',
          { tone: 'error' }
        );
        return refreshNow(true);
      })
      .then(() => {
        approving = false;
      });
  }

  function renderOne(activity) {
    return renderActivity(activity, {
      sessionState: session ? session.state : undefined,
      onApprove: approveHandler,
    });
  }

  function renderPlaceholder() {
    clear(feedPlaceholder);
    if (!session) return;
    if (renderedNames.length) return;

    if (!firstLoadDone) {
      const skeleton = el('div', 'skeletons');
      for (let i = 0; i < 3; i += 1) {
        skeleton.appendChild(el('div', 'skel skel-bubble'));
      }
      feedPlaceholder.appendChild(skeleton);
      return;
    }

    const card = el('div', 'card starting-card');
    card.appendChild(el('div', 'starting-head', spinner({ size: 18 }), el('span', null, ACTIVE_STATES.has(session.state) ? 'Jules is getting started…' : 'Nothing recorded yet')));
    if (session.prompt) {
      card.appendChild(el('div', 'starting-label', 'Your request'));
      card.appendChild(el('div', 'starting-prompt', String(session.prompt)));
    }
    feedPlaceholder.appendChild(card);
  }

  function prefixMatches(ordered) {
    for (let i = 0; i < renderedNames.length; i += 1) {
      if (!ordered[i] || ordered[i].name !== renderedNames[i]) return false;
    }
    return true;
  }

  function syncFeed(force) {
    const ordered = orderedActivities();
    const stick = isNearBottom();
    const previousTop = feed.scrollTop;

    const needsRebuild =
      force || ordered.length < renderedNames.length || !prefixMatches(ordered);

    if (needsRebuild) {
      clear(feedItems);
      renderedNames = [];
      for (const activity of ordered) {
        feedItems.appendChild(renderOne(activity));
        renderedNames.push(activity.name);
      }
      renderPlaceholder();
      if (stick) scrollToBottom();
      else feed.scrollTop = previousTop;
      return;
    }

    if (ordered.length > renderedNames.length) {
      for (let i = renderedNames.length; i < ordered.length; i += 1) {
        feedItems.appendChild(renderOne(ordered[i]));
        renderedNames.push(ordered[i].name);
      }
      renderPlaceholder();
      if (stick) scrollToBottom();
      return;
    }

    renderPlaceholder();
  }

  /**
   * Merge a batch of activities. Returns true when anything changed.
   * @param {Array<Object>} batch
   */
  function ingest(batch) {
    if (!Array.isArray(batch) || !batch.length) return false;
    let changed = false;

    for (const activity of batch) {
      if (!activity || !activity.name) continue;

      // Retire the optimistic bubble this activity corresponds to. The real
      // activity has a server-assigned name, so name-dedupe alone cannot match
      // it — the text is the only link we have.
      if (activity.userMessaged && pending.length) {
        const text = String(activity.userMessaged.userMessage || '').trim();
        const index = pending.findIndex((entry) => entry.text === text);
        if (index >= 0) {
          byName.delete(pending[index].name);
          pending.splice(index, 1);
          changed = true;
        }
      }

      if (!byName.has(activity.name)) changed = true;
      byName.set(activity.name, activity);

      if (activity.createTime) {
        if (!lastSeen || Date.parse(activity.createTime) > Date.parse(lastSeen)) {
          lastSeen = activity.createTime;
        }
      }
    }

    return changed;
  }

  /* ------------------------------------------------------------------ */
  /* Loading                                                             */
  /* ------------------------------------------------------------------ */

  function showFatalError(err) {
    clear(feedIntro);
    clear(feedItems);
    clear(feedPlaceholder);
    renderedNames = [];

    const notFound = err instanceof ApiError && err.status === 404;
    const isNetwork = err instanceof ApiError && err.isNetwork;

    feedPlaceholder.appendChild(
      emptyState({
        icon: isNetwork ? 'wifi' : 'alert',
        title: notFound ? 'Session not found' : isNetwork ? 'No connection' : 'Could not load this session',
        body: notFound
          ? 'It may have been deleted from Jules.'
          : isNetwork
            ? 'Check your connection — this screen will catch up once you are back online.'
            : (err && err.message) || 'Something went wrong.',
        action: notFound
          ? {
              label: 'Back to sessions',
              onClick: () => {
                if (ctx && ctx.navigate) ctx.navigate('/');
              },
            }
          : { label: 'Try again', onClick: () => refreshNow(true) },
      })
    );

    composer.hidden = true;
    statusStrip.hidden = true;
  }

  async function tick() {
    const previousState = session ? session.state : null;

    const [nextSession, activities] = await Promise.all([
      api.getSession(id, { signal: abortController.signal }),
      api.listAllActivities(id, {
        sinceCreateTime: lastSeen || undefined,
        signal: abortController.signal,
      }),
    ]);

    if (destroyed) return;

    session = nextSession;
    loadError = null;
    firstLoadDone = true;
    composer.hidden = false;

    const changed = ingest(activities);
    const stateChanged = previousState !== session.state || lastRenderedState !== session.state;

    renderHeader();
    renderStatusStrip();
    renderIntro();

    if (changed || stateChanged) {
      // A state change alters what the plan card renders (the Approve button),
      // so the whole feed is rebuilt rather than patched.
      syncFeed(stateChanged);
      lastRenderedState = session.state;
    } else {
      renderPlaceholder();
    }

    updateComposerState();
    applyPollingMode();

    if (ctx && typeof ctx.sessionsChanged === 'function' && stateChanged && previousState !== null) {
      ctx.sessionsChanged();
    }
  }

  async function refreshNow(showFeedback) {
    const refreshBtn = headerActions.querySelector('.js-refresh');
    if (refreshBtn && showFeedback) {
      refreshBtn.classList.add('is-spinning');
      setTimeout(() => refreshBtn.classList.remove('is-spinning'), 700);
    }
    try {
      await tick();
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      handleTickError(err);
    }
  }

  function handleTickError(err) {
    if (!firstLoadDone) {
      loadError = err;
      showFatalError(err);
      poller.stop();
      return;
    }
    if (err instanceof ApiError && err.status === 404) {
      showFatalError(err);
      poller.stop();
      return;
    }
    // Transient: the poller's own backoff handles it, stay quiet.
  }

  /* ------------------------------------------------------------------ */
  /* Composer                                                            */
  /* ------------------------------------------------------------------ */

  function updateComposerState() {
    const hasText = String(composerInput.value || '').trim().length > 0;
    sendBtn.disabled = sending || !hasText;
    composerInput.disabled = sending;
    composerInput.placeholder =
      session && session.state === 'AWAITING_USER_FEEDBACK' ? 'Answer Jules…' : 'Message Jules…';
  }

  async function sendMessage() {
    const text = String(composerInput.value || '').trim();
    if (!text || sending) return;

    sending = true;
    updateComposerState();

    const optimistic = {
      name: 'local:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8),
      createTime: new Date().toISOString(),
      originator: 'user',
      userMessaged: { userMessage: text },
      __optimistic: true,
    };
    pending.push({ name: optimistic.name, text });
    byName.set(optimistic.name, optimistic);

    composerInput.value = '';
    growComposer();
    syncFeed(false);
    scrollToBottom(true);

    try {
      await api.sendMessage(id, text, { signal: abortController.signal });
      if (destroyed) return;
      sending = false;
      updateComposerState();
      // Restart polling: a reply usually wakes a settled session back up.
      if (!poller.isRunning()) poller.start();
      else poller.kick();
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      sending = false;

      byName.delete(optimistic.name);
      pending = pending.filter((entry) => entry.name !== optimistic.name);
      composerInput.value = text;
      growComposer();
      syncFeed(true);
      updateComposerState();

      toast(
        err instanceof ApiError && err.isNetwork
          ? 'Could not reach Jules — your message was not sent.'
          : (err && err.message) || 'Could not send that message.',
        { tone: 'error' }
      );
    }
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage();
  });
  composerInput.addEventListener('input', updateComposerState);
  composerInput.addEventListener('keydown', (event) => {
    // Enter inserts a newline (it is the only sensible behaviour on a soft
    // keyboard); Cmd/Ctrl+Enter sends, for people on a hardware keyboard.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendMessage();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Overflow menu                                                       */
  /* ------------------------------------------------------------------ */

  async function openMenu() {
    if (!session) return;

    const items = [
      session.archived
        ? { label: 'Unarchive', value: 'unarchive' }
        : { label: 'Archive', value: 'archive' },
      { label: 'Delete session', value: 'delete', destructive: true },
    ];

    const choice = await actionSheet(items, { title: sessionTitle(session) });
    if (!choice || destroyed) return;

    if (choice === 'archive' || choice === 'unarchive') {
      try {
        if (choice === 'archive') await api.archiveSession(id, { signal: abortController.signal });
        else await api.unarchiveSession(id, { signal: abortController.signal });
        if (destroyed) return;
        toast(choice === 'archive' ? 'Session archived.' : 'Session unarchived.');
        if (ctx && typeof ctx.sessionsChanged === 'function') ctx.sessionsChanged();
        await refreshNow(false);
      } catch (err) {
        if (destroyed || (err && err.name === 'AbortError')) return;
        toast((err && err.message) || 'That did not work.', { tone: 'error' });
      }
      return;
    }

    if (choice === 'delete') {
      const confirmed = await confirmSheet(
        'This permanently removes the session and its history from Jules. It cannot be undone.',
        { title: 'Delete this session?', confirmLabel: 'Delete', destructive: true }
      );
      if (!confirmed || destroyed) return;
      try {
        await api.deleteSession(id, { signal: abortController.signal });
        if (destroyed) return;
        poller.stop();
        toast('Session deleted.');
        if (ctx && typeof ctx.sessionsChanged === 'function') ctx.sessionsChanged();
        if (ctx && ctx.navigate) ctx.navigate('/', { replace: true });
      } catch (err) {
        if (destroyed || (err && err.name === 'AbortError')) return;
        toast((err && err.message) || 'Could not delete the session.', { tone: 'error' });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Polling                                                             */
  /* ------------------------------------------------------------------ */

  const poller = createPoller({
    tick,
    getInterval: activePollMs,
    onError: handleTickError,
  });

  function applyPollingMode() {
    if (!session) return;
    const shouldPoll = ACTIVE_STATES.has(session.state);
    if (shouldPoll && !poller.isRunning()) poller.start();
    if (!shouldPoll && poller.isRunning()) poller.stop();
    pane.classList.toggle('is-settled', !shouldPoll);
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  if (!id) {
    showFatalError(new ApiError('No session was specified.', { status: 404 }));
  } else {
    renderHeader();
    renderPlaceholder();
    if (ctx && typeof ctx.setActiveSession === 'function') ctx.setActiveSession(id);
    poller.start();
  }

  return function unmount() {
    destroyed = true;
    poller.stop();
    abortController.abort();
    if (ctx && typeof ctx.setActiveSession === 'function') ctx.setActiveSession(null);
    if (pane.parentNode) pane.parentNode.removeChild(pane);
  };
}

export default { mount };
