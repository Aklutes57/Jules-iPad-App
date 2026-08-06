// views/newSession.js — start a task.
//
// Design notes:
//  * The repo picker is a filter-as-you-type list, not a <select>. A native
//    select with 200 repos is miserable on a touch screen.
//  * "Review plan before Jules starts" defaults ON. The API auto-approves plans
//    unless requirePlanApproval is true, and silently letting an agent push
//    changes is not a good default for a one-person app.

import { api, ApiError, sessionId } from '../api.js';
import { el, icon, iconButton, spinner, switchRow, autoGrow, clear, toast, externalLink, emptyState } from '../ui.js';

const MAX_VISIBLE_REPOS = 60;
const JULES_URL = 'https://jules.google.com';

function repoOf(source) {
  const github = source && source.githubRepo ? source.githubRepo : {};
  return {
    owner: github.owner || '',
    repo: github.repo || '',
    isPrivate: Boolean(github.isPrivate),
    defaultBranch: github.defaultBranch && github.defaultBranch.displayName ? github.defaultBranch.displayName : '',
    branches: Array.isArray(github.branches)
      ? github.branches.map((b) => (b && b.displayName ? String(b.displayName) : '')).filter(Boolean)
      : [],
    name: source && source.name ? source.name : '',
  };
}

function fullName(info) {
  return info.owner && info.repo ? info.owner + '/' + info.repo : info.repo || info.name;
}

/**
 * @param {HTMLElement} container
 * @param {Object} params
 * @param {Object} ctx
 * @returns {() => void} unmount
 */
export function mount(container, params, ctx) {
  let destroyed = false;
  let sources = [];
  let loadingSources = true;
  let sourcesError = null;
  let selected = null; // repoOf() result
  let repoless = false;
  let submitting = false;
  let abortController = new AbortController();

  /* ---------- chrome ---------- */

  const header = el('header', 'app-header');
  header.appendChild(
    iconButton(
      'chevron-left',
      'Back to sessions',
      () => {
        if (ctx && ctx.navigate) ctx.navigate('/');
      },
      'icon-btn--back'
    )
  );
  header.appendChild(el('h1', 'app-title', 'New task'));
  header.appendChild(el('div', 'header-actions'));

  const scroll = el('div', 'scroll form-scroll');
  const form = el('form', 'form');
  scroll.appendChild(form);

  const pane = el('div', 'pane-body new-session');
  pane.appendChild(header);
  pane.appendChild(scroll);
  container.appendChild(pane);

  /* ---------- repository section ---------- */

  const repoSection = el('section', 'form-section');
  repoSection.appendChild(el('h2', 'form-legend', 'Repository'));
  const repoCard = el('div', 'card repo-card');
  repoSection.appendChild(repoCard);
  form.appendChild(repoSection);

  const search = el('input', {
    class: 'input repo-search',
    type: 'search',
    placeholder: 'Search your repositories',
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    'aria-label': 'Search repositories',
  });
  const searchWrap = el('div', 'repo-search-wrap', el('span', 'repo-search-icon', icon('search', { size: 18 })), search);
  const repoResults = el('div', { class: 'repo-results', role: 'listbox', 'aria-label': 'Repositories' });
  const selectedCard = el('div', 'repo-selected');
  const branchWrap = el('div', 'row-item branch-row');

  const branchSelect = el('select', { class: 'select branch-select', 'aria-label': 'Starting branch' });
  branchWrap.appendChild(
    el('span', 'row-item-label', el('span', 'row-item-icon', icon('branch', { size: 18 })), 'Start from branch')
  );
  branchWrap.appendChild(branchSelect);

  const repolessSwitch = switchRow({
    label: 'No repository (scratch VM)',
    help: 'Jules works in an empty virtual machine — good for quick experiments and throwaway scripts.',
    checked: false,
    onChange: (checked) => {
      repoless = checked;
      renderRepoSection();
      updateSubmitState();
    },
  });

  function renderBranches() {
    clear(branchSelect);
    if (!selected) return;
    const branches = selected.branches.length ? selected.branches.slice() : [];
    if (selected.defaultBranch && branches.indexOf(selected.defaultBranch) === -1) {
      branches.unshift(selected.defaultBranch);
    }
    if (!branches.length) {
      branchSelect.appendChild(el('option', { value: '' }, 'Default branch'));
      branchSelect.disabled = true;
      return;
    }
    branchSelect.disabled = false;
    for (const branch of branches) {
      const option = el('option', { value: branch }, branch);
      if (branch === selected.defaultBranch) option.selected = true;
      branchSelect.appendChild(option);
    }
    if (selected.defaultBranch) branchSelect.value = selected.defaultBranch;
  }

  function repoRow(info) {
    const row = el('button', {
      class: 'repo-row',
      type: 'button',
      role: 'option',
      'aria-selected': selected && selected.name === info.name ? 'true' : 'false',
    });
    row.appendChild(el('span', 'repo-row-icon', icon('repo', { size: 18 })));
    const body = el('div', 'repo-row-body');
    body.appendChild(el('span', 'repo-row-name', fullName(info)));
    if (info.defaultBranch) body.appendChild(el('span', 'repo-row-branch', info.defaultBranch));
    row.appendChild(body);
    if (info.isPrivate) row.appendChild(el('span', 'repo-badge', 'Private'));
    row.addEventListener('click', () => {
      selected = info;
      search.value = '';
      renderRepoSection();
      updateSubmitState();
    });
    return row;
  }

  function renderResults() {
    clear(repoResults);
    const query = String(search.value || '').trim().toLowerCase();
    const matches = sources
      .map(repoOf)
      .filter((info) => {
        if (!query) return true;
        return fullName(info).toLowerCase().indexOf(query) !== -1;
      });

    if (!matches.length) {
      repoResults.appendChild(el('div', 'repo-none', query ? 'No repository matches “' + search.value + '”.' : 'No repositories found.'));
      return;
    }

    for (const info of matches.slice(0, MAX_VISIBLE_REPOS)) {
      repoResults.appendChild(repoRow(info));
    }
    if (matches.length > MAX_VISIBLE_REPOS) {
      repoResults.appendChild(
        el('div', 'repo-none', 'Showing ' + MAX_VISIBLE_REPOS + ' of ' + matches.length + ' — keep typing to narrow it down.')
      );
    }
  }

  function renderRepoSection() {
    clear(repoCard);

    if (repoless) {
      repoCard.appendChild(repolessSwitch.row);
      repoCard.appendChild(
        el(
          'div',
          'row-item repo-note',
          'Jules will start from a blank machine. Nothing will be read from or written to your repositories.'
        )
      );
      return;
    }

    if (loadingSources) {
      repoCard.appendChild(el('div', 'row-item repo-loading', spinner({ size: 18 }), el('span', null, 'Loading your repositories…')));
      repoCard.appendChild(repolessSwitch.row);
      return;
    }

    if (sourcesError) {
      const isNetwork = sourcesError instanceof ApiError && sourcesError.isNetwork;
      repoCard.appendChild(
        el(
          'div',
          'row-item repo-error',
          el('span', 'repo-error-icon', icon('alert', { size: 18 })),
          el(
            'div',
            null,
            el('div', 'repo-error-title', isNetwork ? 'No connection' : 'Could not load repositories'),
            el('div', 'repo-error-text', (sourcesError && sourcesError.message) || '')
          )
        )
      );
      const retry = el('button', { class: 'btn btn--plain', type: 'button' }, 'Try again');
      retry.addEventListener('click', () => loadSources(true));
      repoCard.appendChild(el('div', 'row-item', retry));
      repoCard.appendChild(repolessSwitch.row);
      return;
    }

    if (!sources.length) {
      const info = el('div', 'row-item repo-connect');
      info.appendChild(el('div', 'repo-connect-title', 'No repositories connected yet'));
      info.appendChild(
        el(
          'p',
          'repo-connect-text',
          'Open ',
          externalLink(JULES_URL, 'jules.google.com'),
          ', connect your GitHub account and pick the repositories Jules may use. Then come back and tap Refresh.'
        )
      );
      const refresh = el('button', { class: 'btn btn--plain', type: 'button' }, 'Refresh');
      refresh.addEventListener('click', () => loadSources(true));
      info.appendChild(refresh);
      repoCard.appendChild(info);
      repoCard.appendChild(repolessSwitch.row);
      return;
    }

    if (selected) {
      clear(selectedCard);
      const chip = el('div', 'row-item repo-chosen');
      chip.appendChild(el('span', 'repo-row-icon', icon('repo', { size: 18 })));
      const body = el('div', 'repo-row-body');
      body.appendChild(el('span', 'repo-row-name', fullName(selected)));
      if (selected.isPrivate) body.appendChild(el('span', 'repo-row-branch', 'Private'));
      chip.appendChild(body);
      const change = el('button', { class: 'btn btn--link', type: 'button' }, 'Change');
      change.addEventListener('click', () => {
        selected = null;
        renderRepoSection();
        updateSubmitState();
        try {
          search.focus();
        } catch (_err) {
          /* best effort */
        }
      });
      chip.appendChild(change);
      selectedCard.appendChild(chip);

      repoCard.appendChild(selectedCard);
      renderBranches();
      repoCard.appendChild(branchWrap);
      repoCard.appendChild(repolessSwitch.row);
      return;
    }

    repoCard.appendChild(searchWrap);
    renderResults();
    repoCard.appendChild(repoResults);
    repoCard.appendChild(repolessSwitch.row);
  }

  search.addEventListener('input', () => {
    if (!repoless && !selected) renderResults();
  });

  /* ---------- prompt ---------- */

  const promptSection = el('section', 'form-section');
  promptSection.appendChild(el('h2', 'form-legend', 'What should Jules do?'));
  const promptTextarea = el('textarea', {
    class: 'input textarea prompt-input',
    rows: 5,
    placeholder: 'e.g. Add a dark mode toggle to the settings page and update the tests.',
    'aria-label': 'Task description',
  });
  promptSection.appendChild(el('div', 'card prompt-card', promptTextarea));
  promptSection.appendChild(
    el('p', 'form-help', 'Be specific about the outcome you want. Jules can ask follow-up questions once it starts.')
  );
  form.appendChild(promptSection);

  const growPrompt = autoGrow(promptTextarea, 400);
  promptTextarea.addEventListener('input', () => updateSubmitState());

  /* ---------- options ---------- */

  const optionsSection = el('section', 'form-section');
  optionsSection.appendChild(el('h2', 'form-legend', 'Options'));
  const optionsCard = el('div', 'card');

  const planSwitch = switchRow({
    label: 'Review plan before Jules starts',
    help: 'Jules will wait for your approval before making changes.',
    checked: true,
  });
  const prSwitch = switchRow({
    label: 'Automatically open a pull request',
    help: 'When Jules finishes, it opens a PR on GitHub instead of leaving the branch alone.',
    checked: false,
  });
  optionsCard.appendChild(planSwitch.row);
  optionsCard.appendChild(prSwitch.row);
  optionsSection.appendChild(optionsCard);
  form.appendChild(optionsSection);

  /* ---------- submit ---------- */

  const submitBtn = el('button', { class: 'btn btn--primary btn--wide', type: 'submit' }, 'Start task');
  const submitNote = el('p', 'form-help form-help--center', '');
  form.appendChild(el('div', 'form-submit', submitBtn, submitNote));

  function updateSubmitState() {
    const hasPrompt = String(promptTextarea.value || '').trim().length > 0;
    const repoReady = repoless || Boolean(selected);
    submitBtn.disabled = submitting || !hasPrompt || !repoReady;

    if (submitting) {
      submitNote.textContent = '';
    } else if (!hasPrompt) {
      submitNote.textContent = 'Describe the task to continue.';
    } else if (!repoReady) {
      submitNote.textContent = 'Pick a repository, or switch on “No repository”.';
    } else {
      submitNote.textContent = '';
    }
  }

  function setSubmitting(busy) {
    submitting = busy;
    clear(submitBtn);
    if (busy) {
      submitBtn.appendChild(spinner({ size: 18, label: 'Starting task' }));
      submitBtn.appendChild(document.createTextNode('Starting…'));
    } else {
      submitBtn.appendChild(document.createTextNode('Start task'));
    }
    updateSubmitState();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const prompt = String(promptTextarea.value || '').trim();
    if (!prompt) {
      updateSubmitState();
      try {
        promptTextarea.focus();
      } catch (_err) {
        /* best effort */
      }
      return;
    }
    if (!repoless && !selected) {
      updateSubmitState();
      return;
    }

    setSubmitting(true);
    try {
      const session = await api.createSession({
        prompt,
        sourceName: repoless ? null : selected.name,
        startingBranch: repoless ? null : branchSelect.value || null,
        requirePlanApproval: planSwitch.input.checked,
        autoCreatePr: prSwitch.input.checked,
        signal: abortController.signal,
      });
      if (destroyed) return;

      const id = session.id || sessionId(session.name);
      if (ctx && typeof ctx.sessionsChanged === 'function') ctx.sessionsChanged();
      if (id && ctx && ctx.navigate) {
        ctx.navigate('/session/' + encodeURIComponent(id), { replace: true });
      } else {
        toast('Task started.');
        if (ctx && ctx.navigate) ctx.navigate('/', { replace: true });
      }
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      setSubmitting(false);
      const message =
        err instanceof ApiError && err.isNetwork
          ? 'Could not reach Jules. Check your connection and try again.'
          : (err && err.message) || 'Could not start the task.';
      toast(message, { tone: 'error' });
    }
  }

  form.addEventListener('submit', onSubmit);

  /* ---------- sources ---------- */

  async function loadSources(force) {
    loadingSources = true;
    sourcesError = null;
    renderRepoSection();
    try {
      const list = await api.listAllSources({ force: Boolean(force), signal: abortController.signal });
      if (destroyed) return;
      sources = list;
      loadingSources = false;
      // A single repository is almost always the one they want.
      if (!selected && sources.length === 1) selected = repoOf(sources[0]);
      renderRepoSection();
      updateSubmitState();
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      loadingSources = false;
      sourcesError = err;
      renderRepoSection();
      updateSubmitState();
    }
  }

  renderRepoSection();
  updateSubmitState();
  growPrompt();
  loadSources(false);

  return function unmount() {
    destroyed = true;
    abortController.abort();
    form.removeEventListener('submit', onSubmit);
    if (pane.parentNode) pane.parentNode.removeChild(pane);
  };
}

export default { mount };
