// views/newSession.js — start a task.
//
// Design notes:
//  * The repo picker is a filter-as-you-type list, not a <select>. A native
//    select with 200 repos is miserable on a touch screen.
//  * "Review plan before Jules starts" defaults ON. The API auto-approves plans
//    unless requirePlanApproval is true, and silently letting an agent push
//    changes is not a good default for a one-person app.

import { api, ApiError, sessionId } from '../api.js';
import { bitbucket } from '../bitbucket.js';
import { bridgePrompt, julesBranchName } from '../bridge.js';
import {
  getBitbucketCredential,
  getMirrorLink,
  getSetting,
  setSetting,
  setSessionOrigin,
} from '../storage.js';
import {
  el,
  icon,
  iconButton,
  spinner,
  switchRow,
  autoGrow,
  clear,
  toast,
  externalLink,
  emptyState,
  segmented,
} from '../ui.js';

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

  // Where the code lives. Jules itself only reads GitHub, so the Bitbucket
  // option routes through one of the two bridges (see js/bridge.js).
  let sourceKind = getSetting('lastSourceKind', 'github') === 'bitbucket' ? 'bitbucket' : 'github';
  const kindControl = segmented({
    ariaLabel: 'Where the code lives',
    value: sourceKind,
    options: [
      { label: 'GitHub', value: 'github' },
      { label: 'Bitbucket', value: 'bitbucket' },
    ],
    onChange: (value) => {
      sourceKind = value;
      setSetting('lastSourceKind', value);
      renderRepoSection();
      updateSubmitState();
      if (value === 'bitbucket') loadBitbucketWorkspaces();
      else if (loadingSources && !sources.length) loadSources(false);
    },
  });
  repoSection.appendChild(el('div', 'source-kind', kindControl.node));

  const repoCard = el('div', 'card repo-card');
  repoSection.appendChild(repoCard);
  form.appendChild(repoSection);

  /* ---------- Bitbucket state ---------- */

  let bbCredential = getBitbucketCredential();
  let bbWorkspaces = [];
  let bbRepos = [];
  let bbBranches = [];
  let bbWorkspace = getSetting('bitbucketWorkspace', '');
  let bbRepo = null;
  let bbBranch = '';
  let bbLoading = false;
  let bbMode = 'mirror'; // 'mirror' | 'direct'

  const bbCard = el('div', 'card repo-card');

  function bbMirrorLink() {
    if (!bbRepo) return null;
    return getMirrorLink(bbRepo.workspace || bbWorkspace, bbRepo.slug);
  }

  async function loadBitbucketWorkspaces() {
    bbCredential = getBitbucketCredential();
    if (!bbCredential || bbWorkspaces.length) return;
    bbLoading = true;
    renderRepoSection();
    try {
      const list = await bitbucket.listWorkspaces({ signal: abortController.signal });
      if (destroyed) return;
      bbWorkspaces = list;
      if (!bbWorkspace && bbWorkspaces.length) bbWorkspace = bbWorkspaces[0].slug;
      bbLoading = false;
      renderRepoSection();
      loadBitbucketRepos();
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      bbLoading = false;
      bbWorkspaces = [];
      renderRepoSection();
    }
  }

  async function loadBitbucketRepos() {
    if (!bbCredential || !bbWorkspace) return;
    bbLoading = true;
    renderRepoSection();
    try {
      const list = await bitbucket.listRepos(bbWorkspace, { signal: abortController.signal });
      if (destroyed) return;
      bbRepos = list;
      bbLoading = false;
      renderRepoSection();
      updateSubmitState();
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      bbLoading = false;
      bbRepos = [];
      renderRepoSection();
      toast((err && err.message) || 'Could not load Bitbucket repositories.', { tone: 'error' });
    }
  }

  async function loadBitbucketBranches() {
    if (!bbRepo) return;
    bbBranches = [];
    try {
      const list = await bitbucket.listBranches(bbRepo.workspace || bbWorkspace, bbRepo.slug, {
        signal: abortController.signal,
      });
      if (destroyed) return;
      bbBranches = list;
      if (!bbBranch || bbBranches.indexOf(bbBranch) === -1) {
        bbBranch = bbRepo.mainBranch && bbBranches.indexOf(bbRepo.mainBranch) !== -1 ? bbRepo.mainBranch : bbBranches[0] || '';
      }
      renderRepoSection();
      updateSubmitState();
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      renderRepoSection();
    }
  }

  function renderBitbucketSection() {
    clear(bbCard);

    if (!bbCredential) {
      const info = el('div', 'row-item repo-connect');
      info.appendChild(el('div', 'repo-connect-title', 'Bitbucket is not connected'));
      info.appendChild(
        el(
          'p',
          'repo-connect-text',
          'Connect your Bitbucket account once, and this app can list your repositories and open pull requests for you.'
        )
      );
      const connect = el('button', { class: 'btn btn--primary', type: 'button' }, 'Connect Bitbucket');
      connect.addEventListener('click', () => {
        if (ctx && ctx.navigate) ctx.navigate('/bitbucket');
      });
      info.appendChild(connect);
      bbCard.appendChild(info);
      return;
    }

    if (bbLoading && !bbRepos.length) {
      bbCard.appendChild(
        el('div', 'row-item repo-loading', spinner({ size: 18 }), el('span', null, 'Loading from Bitbucket…'))
      );
      return;
    }

    // Workspace
    const wsSelect = el('select', { class: 'select', 'aria-label': 'Bitbucket workspace' });
    if (!bbWorkspaces.length) {
      wsSelect.appendChild(el('option', { value: '' }, 'No workspaces found'));
      wsSelect.disabled = true;
    } else {
      for (const ws of bbWorkspaces) {
        const option = el('option', { value: ws.slug }, ws.name || ws.slug);
        if (ws.slug === bbWorkspace) option.selected = true;
        wsSelect.appendChild(option);
      }
      wsSelect.value = bbWorkspace;
    }
    wsSelect.addEventListener('change', () => {
      bbWorkspace = wsSelect.value;
      setSetting('bitbucketWorkspace', bbWorkspace);
      bbRepo = null;
      bbRepos = [];
      bbBranches = [];
      renderRepoSection();
      updateSubmitState();
      loadBitbucketRepos();
    });
    bbCard.appendChild(el('div', 'row-item', el('span', 'row-item-label', 'Workspace'), wsSelect));

    // Repository
    const repoSelect = el('select', { class: 'select', 'aria-label': 'Bitbucket repository' });
    repoSelect.appendChild(el('option', { value: '' }, bbRepos.length ? 'Choose a repository' : 'No repositories'));
    for (const repo of bbRepos) {
      const option = el('option', { value: repo.slug }, repo.slug);
      if (bbRepo && bbRepo.slug === repo.slug) option.selected = true;
      repoSelect.appendChild(option);
    }
    repoSelect.disabled = !bbRepos.length;
    if (bbRepo) repoSelect.value = bbRepo.slug;
    repoSelect.addEventListener('change', () => {
      bbRepo = bbRepos.find((r) => r.slug === repoSelect.value) || null;
      bbBranch = bbRepo && bbRepo.mainBranch ? bbRepo.mainBranch : '';
      renderRepoSection();
      updateSubmitState();
      if (bbRepo) loadBitbucketBranches();
    });
    bbCard.appendChild(el('div', 'row-item', el('span', 'row-item-label', 'Repository'), repoSelect));

    if (!bbRepo) return;

    // Branch
    const branchSel = el('select', { class: 'select branch-select', 'aria-label': 'Starting branch' });
    if (!bbBranches.length) {
      branchSel.appendChild(el('option', { value: bbBranch || '' }, bbBranch || 'Loading branches…'));
      branchSel.disabled = true;
    } else {
      for (const branch of bbBranches) {
        const option = el('option', { value: branch }, branch);
        if (branch === bbBranch) option.selected = true;
        branchSel.appendChild(option);
      }
      branchSel.value = bbBranch;
    }
    branchSel.addEventListener('change', () => {
      bbBranch = branchSel.value;
    });
    bbCard.appendChild(
      el(
        'div',
        'row-item branch-row',
        el('span', 'row-item-label', el('span', 'row-item-icon', icon('branch', { size: 18 })), 'Start from branch'),
        branchSel
      )
    );

    // How this reaches Jules
    const link = bbMirrorLink();
    if (!link && bbMode === 'mirror') bbMode = 'direct';

    const modeControl = segmented({
      ariaLabel: 'How Jules gets the code',
      value: bbMode,
      options: [
        { label: 'Via mirror', value: 'mirror' },
        { label: 'Direct', value: 'direct' },
      ],
      onChange: (value) => {
        bbMode = value;
        renderRepoSection();
        updateSubmitState();
      },
    });
    bbCard.appendChild(el('div', 'row-item stacked', el('span', 'row-item-label', 'How Jules gets the code'), modeControl.node));

    if (bbMode === 'mirror') {
      if (link) {
        bbCard.appendChild(
          el(
            'div',
            'row-item repo-note',
            'Jules will work on the linked GitHub mirror (' + (link.label || link.sourceName) + '). ' +
              'Push your latest changes to Bitbucket first so the mirror is up to date.'
          )
        );
      } else {
        const warn = el('div', 'row-item repo-connect');
        warn.appendChild(el('div', 'repo-connect-title', 'No mirror linked for this repository'));
        warn.appendChild(
          el(
            'p',
            'repo-connect-text',
            'Jules can only read GitHub repositories. Set up a private mirror once, and every task afterwards just works.'
          )
        );
        const go = el('button', { class: 'btn btn--plain', type: 'button' }, 'Set up mirroring');
        go.addEventListener('click', () => {
          if (ctx && ctx.navigate) ctx.navigate('/bitbucket');
        });
        warn.appendChild(go);
        bbCard.appendChild(warn);
      }
    } else {
      bbCard.appendChild(
        el(
          'div',
          'row-item repo-note repo-note--warn',
          'Experimental: Jules starts from a blank machine and clones Bitbucket itself. ' +
            'This only works if Jules’ sandbox can reach the internet — run the connectivity check on the Bitbucket screen first. ' +
            'Your Bitbucket token is included in the task text sent to Google.'
        )
      );
    }
  }

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
    // Swap the whole card depending on where the code lives.
    if (sourceKind === 'bitbucket') {
      if (repoCard.parentNode) repoCard.parentNode.removeChild(repoCard);
      if (!bbCard.parentNode) repoSection.appendChild(bbCard);
      renderBitbucketSection();
      return;
    }
    if (bbCard.parentNode) bbCard.parentNode.removeChild(bbCard);
    if (!repoCard.parentNode) repoSection.appendChild(repoCard);

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

  function bitbucketReady() {
    if (!bbCredential || !bbRepo) return false;
    // Mirror mode needs a linked GitHub repo — that is the only thing Jules can read.
    if (bbMode === 'mirror') return Boolean(bbMirrorLink());
    return true;
  }

  function updateSubmitState() {
    const hasPrompt = String(promptTextarea.value || '').trim().length > 0;
    const repoReady = sourceKind === 'bitbucket' ? bitbucketReady() : repoless || Boolean(selected);
    submitBtn.disabled = submitting || !hasPrompt || !repoReady;

    // The PR switch only means something for a native GitHub session; Jules
    // cannot open a Bitbucket PR itself, so the app offers that afterwards.
    prSwitch.row.style.display = sourceKind === 'bitbucket' && bbMode === 'direct' ? 'none' : '';

    if (submitting) {
      submitNote.textContent = '';
    } else if (!hasPrompt) {
      submitNote.textContent = 'Describe the task to continue.';
    } else if (!repoReady) {
      if (sourceKind === 'bitbucket') {
        if (!bbCredential) submitNote.textContent = 'Connect Bitbucket to continue.';
        else if (!bbRepo) submitNote.textContent = 'Pick a Bitbucket repository.';
        else submitNote.textContent = 'Link a GitHub mirror, or switch to Direct.';
      } else {
        submitNote.textContent = 'Pick a repository, or switch on “No repository”.';
      }
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
    if (sourceKind === 'bitbucket' ? !bitbucketReady() : !repoless && !selected) {
      updateSubmitState();
      return;
    }

    setSubmitting(true);
    try {
      let spec;
      let origin = null;

      if (sourceKind === 'bitbucket') {
        const workspace = bbRepo.workspace || bbWorkspace;
        if (bbMode === 'mirror') {
          // The mirror is an ordinary GitHub source as far as Jules is concerned.
          const link = bbMirrorLink();
          spec = {
            prompt,
            sourceName: link.sourceName,
            startingBranch: bbBranch || null,
            requirePlanApproval: planSwitch.input.checked,
            autoCreatePr: prSwitch.input.checked,
          };
          origin = { workspace, repo: bbRepo.slug, branch: bbBranch, mode: 'mirror', workBranch: '' };
        } else {
          // Direct: a repoless session that clones Bitbucket itself.
          const workBranch = julesBranchName(prompt);
          spec = {
            prompt: bridgePrompt({
              workspace,
              repo: bbRepo.slug,
              branch: bbBranch,
              task: prompt,
              token: bbCredential.token,
              mode: bbCredential.mode,
              branchName: workBranch,
            }),
            // Keep the readable task as the title — the prompt itself carries a token.
            title: prompt.split('\n')[0].slice(0, 80),
            requirePlanApproval: planSwitch.input.checked,
          };
          origin = { workspace, repo: bbRepo.slug, branch: bbBranch, mode: 'direct', workBranch };
        }
      } else {
        spec = {
          prompt,
          sourceName: repoless ? null : selected.name,
          startingBranch: repoless ? null : branchSelect.value || null,
          requirePlanApproval: planSwitch.input.checked,
          autoCreatePr: prSwitch.input.checked,
        };
      }

      spec.signal = abortController.signal;
      const session = await api.createSession(spec);
      if (destroyed) return;

      const id = session.id || sessionId(session.name);
      if (id && origin) setSessionOrigin(id, origin);
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
  if (sourceKind === 'bitbucket') loadBitbucketWorkspaces();
  else loadSources(false);

  return function unmount() {
    destroyed = true;
    abortController.abort();
    form.removeEventListener('submit', onSubmit);
    if (pane.parentNode) pane.parentNode.removeChild(pane);
  };
}

export default { mount };
