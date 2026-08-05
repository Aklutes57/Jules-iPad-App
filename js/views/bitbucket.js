// views/bitbucket.js — the Bitbucket hub: connect, then set up a path to Jules.
//
// This screen exists because of one hard fact: Jules only reads GitHub. So
// "Bitbucket to Jules" is always a bridge, and the honest thing to do is show
// the user both bridges, say which one is reliable, and let them test the
// experimental one themselves rather than take anyone's word for it.

import { bitbucket, BitbucketError, REQUIRED_SCOPES, TOKEN_CREATE_URL, repoWebUrl } from '../bitbucket.js';
import { api, ApiError, sessionId } from '../api.js';
import {
  getBitbucketCredential,
  setBitbucketCredential,
  clearBitbucketCredential,
  getMirrorLinks,
  setMirrorLink,
  getSetting,
  setSetting,
} from '../storage.js';
import { pipelinesYaml, backSyncYaml, selfTestPrompt, SELF_TEST_TITLE } from '../bridge.js';
import {
  el,
  icon,
  iconButton,
  spinner,
  clear,
  toast,
  externalLink,
  confirmSheet,
  segmented,
} from '../ui.js';

function maskToken(token) {
  const value = String(token || '');
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••••••' + value.slice(-4);
}

/** Copy button that degrades gracefully when the clipboard API is unavailable. */
function copyBlock(title, text, note) {
  const pre = el('pre', { class: 'code-block', tabindex: '0' }, el('code', null, text));
  const copyBtn = el('button', { class: 'btn btn--plain btn--small', type: 'button' }, 'Copy');

  copyBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        toast('Copied.');
        return;
      }
      throw new Error('no clipboard');
    } catch (_err) {
      // Selecting the text is the next best thing — the user can then use the
      // iPad's own Copy. (The clipboard API needs a secure context, which a
      // plain http:// local server is not.)
      try {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        toast('Selected — tap and choose Copy.');
      } catch (_e) {
        toast('Could not copy automatically. Select the text manually.', { tone: 'error' });
      }
    }
  });

  const head = el('div', 'code-head', el('span', 'code-title', title), copyBtn);
  return el('div', 'code-wrap', head, pre, note ? el('p', 'form-help', note) : null);
}

/**
 * @param {HTMLElement} container
 * @param {Object} params
 * @param {Object} ctx
 * @returns {() => void} unmount
 */
export function mount(container, params, ctx) {
  let destroyed = false;
  const abortController = new AbortController();

  let credential = getBitbucketCredential();
  let workspaces = [];
  let repos = [];
  let selectedWorkspace = getSetting('bitbucketWorkspace', '');
  let selectedRepo = null;
  let busy = false;
  let workspacesLoaded = false;

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
  header.appendChild(el('h1', 'app-title', 'Bitbucket'));
  header.appendChild(el('div', 'header-actions'));

  const scroll = el('div', 'scroll form-scroll');
  const body = el('div', 'form');
  scroll.appendChild(body);

  const pane = el('div', 'pane-body bitbucket-view');
  pane.appendChild(header);
  pane.appendChild(scroll);
  container.appendChild(pane);

  /* ------------------------------------------------------------------ */
  /* Connect                                                             */
  /* ------------------------------------------------------------------ */

  function renderConnect() {
    const section = el('section', 'form-section');
    section.appendChild(el('h2', 'form-legend', 'Connect Bitbucket'));

    const card = el('div', 'card');

    const intro = el('div', 'row-item stacked');
    intro.appendChild(
      el(
        'p',
        'form-help',
        'This app talks to Bitbucket directly from your iPad — nothing is sent through any server of ours. ' +
          'You need an Atlassian API token; Bitbucket app passwords were removed in July 2026.'
      )
    );
    card.appendChild(intro);

    const modeControl = segmented({
      ariaLabel: 'Credential type',
      value: 'basic',
      options: [
        { label: 'API token', value: 'basic' },
        { label: 'Repo token', value: 'bearer' },
      ],
      onChange: (value) => {
        emailRow.style.display = value === 'basic' ? '' : 'none';
        scopeNote.textContent =
          value === 'basic'
            ? 'When creating the token, tick these Bitbucket scopes:'
            : 'Create this in your repository: Repository settings > Access tokens. Give it Read and Write on repositories and pull requests.';
        renderScopes(value);
      },
    });
    card.appendChild(el('div', 'row-item stacked', el('span', 'row-item-label', 'Credential type'), modeControl.node));

    const emailInput = el('input', {
      class: 'input',
      type: 'email',
      placeholder: 'you@example.com',
      autocomplete: 'username',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      'aria-label': 'Atlassian account email',
    });
    const emailRow = el('div', 'row-item stacked', el('span', 'row-item-label', 'Atlassian account email'), emailInput);
    card.appendChild(emailRow);

    const tokenInput = el('input', {
      class: 'input',
      type: 'password',
      placeholder: 'Paste your token',
      autocomplete: 'off',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      'aria-label': 'Bitbucket token',
    });
    const reveal = el('button', { class: 'btn btn--link btn--small', type: 'button' }, 'Show');
    reveal.addEventListener('click', () => {
      const hidden = tokenInput.type === 'password';
      tokenInput.type = hidden ? 'text' : 'password';
      clear(reveal);
      reveal.appendChild(document.createTextNode(hidden ? 'Hide' : 'Show'));
    });
    card.appendChild(
      el(
        'div',
        'row-item stacked',
        el('span', 'row-item-label', 'Token', reveal),
        tokenInput
      )
    );

    const scopeNote = el('p', 'form-help', 'When creating the token, tick these Bitbucket scopes:');
    const scopeList = el('ul', 'scope-list');
    function renderScopes(mode) {
      clear(scopeList);
      if (mode === 'bearer') return;
      for (const scope of REQUIRED_SCOPES) {
        scopeList.appendChild(el('li', 'scope-item', el('code', null, scope)));
      }
    }
    renderScopes('basic');

    const help = el('div', 'row-item stacked');
    help.appendChild(
      el(
        'p',
        'form-help',
        'Create one at ',
        externalLink(TOKEN_CREATE_URL, 'id.atlassian.com'),
        ' → Security → API tokens → Create API token with scopes.'
      )
    );
    help.appendChild(scopeNote);
    help.appendChild(scopeList);
    card.appendChild(help);

    const connectBtn = el('button', { class: 'btn btn--primary btn--wide', type: 'button' }, 'Test & connect');
    const diagnostics = el('div', 'diagnostics');

    function showDiagnostic(err) {
      clear(diagnostics);
      let title = 'Could not connect';
      let explanation = (err && err.message) || 'Unknown error.';

      if (err instanceof BitbucketError && err.isNetwork) {
        title = "Couldn't reach Bitbucket";
        explanation = 'Check your internet connection and try again.';
      } else if (err instanceof BitbucketError && err.status === 401) {
        title = 'Bitbucket rejected this token';
        explanation =
          modeControl.getValue() === 'basic'
            ? 'Check that the email matches the Atlassian account the token belongs to, and that the token has not expired. Atlassian API tokens expire (1 day to 1 year).'
            : 'Check the token was copied completely and has not expired.';
      } else if (err instanceof BitbucketError && err.status === 403) {
        title = 'This token is missing a permission';
        explanation =
          'The token works, but it lacks a scope this app needs. Re-create it with the scopes listed above.';
      }

      const panel = el('div', 'diag');
      panel.appendChild(el('span', 'diag-icon', icon('alert', { size: 20 })));
      const panelBody = el('div', 'diag-body');
      panelBody.appendChild(el('div', 'diag-title', title));
      panelBody.appendChild(el('p', 'diag-text', explanation));

      const serverMessage = err && err.serverMessage ? err.serverMessage : '';
      if (serverMessage) {
        const details = el('details', 'diag-raw');
        details.appendChild(el('summary', 'diag-raw-summary', 'What Bitbucket said'));
        if (err && err.status) details.appendChild(el('div', 'diag-raw-meta', 'HTTP ' + err.status));
        details.appendChild(el('pre', 'diag-raw-text', serverMessage));
        if (err && err.detail) details.appendChild(el('pre', 'diag-raw-text', err.detail));
        panelBody.appendChild(details);
      }
      panel.appendChild(panelBody);
      diagnostics.appendChild(panel);
    }

    async function onConnect() {
      const mode = modeControl.getValue();
      const token = String(tokenInput.value || '').trim();
      const email = String(emailInput.value || '').trim();

      clear(diagnostics);
      if (!token) {
        showDiagnostic(new BitbucketError('Paste a token first.', { status: 400 }));
        return;
      }
      if (mode === 'basic' && !email) {
        showDiagnostic(new BitbucketError('Enter the email address of your Atlassian account.', { status: 400 }));
        return;
      }

      const candidate = { mode, email, token };
      clear(connectBtn);
      connectBtn.disabled = true;
      connectBtn.appendChild(spinner({ size: 18, label: 'Connecting' }));
      connectBtn.appendChild(document.createTextNode('Checking…'));

      try {
        const result = await bitbucket.testCredential(candidate, { signal: abortController.signal });
        if (destroyed) return;
        setBitbucketCredential(candidate);
        credential = candidate;
        workspaces = (result.workspaces || []).map((w) => ({
          slug: w && w.slug ? String(w.slug) : '',
          name: w && w.name ? String(w.name) : '',
        })).filter((w) => w.slug);
        workspacesLoaded = true;
        // Pick a workspace straight away, otherwise the repository list below
        // has nothing to load from and sits there disabled.
        if (workspaces.length && !workspaces.some((w) => w.slug === selectedWorkspace)) {
          selectedWorkspace = workspaces[0].slug;
          setSetting('bitbucketWorkspace', selectedWorkspace);
        }
        toast(
          workspaces.length
            ? 'Connected — found ' + workspaces.length + (workspaces.length === 1 ? ' workspace.' : ' workspaces.')
            : 'Connected to Bitbucket.'
        );
        render();
        if (selectedWorkspace) loadRepos();
      } catch (err) {
        if (destroyed || (err && err.name === 'AbortError')) return;
        clear(connectBtn);
        connectBtn.disabled = false;
        connectBtn.appendChild(document.createTextNode('Test & connect'));
        showDiagnostic(err);
      }
    }

    connectBtn.addEventListener('click', onConnect);
    section.appendChild(card);
    section.appendChild(el('div', 'form-submit', connectBtn));
    section.appendChild(diagnostics);
    return section;
  }

  /* ------------------------------------------------------------------ */
  /* Explainer                                                           */
  /* ------------------------------------------------------------------ */

  function renderExplainer() {
    const section = el('section', 'form-section');
    section.appendChild(el('h2', 'form-legend', 'How Bitbucket reaches Jules'));
    const card = el('div', 'card');

    card.appendChild(
      el(
        'div',
        'row-item stacked',
        el(
          'p',
          'form-help',
          'Jules can only read GitHub repositories — that is Google’s limitation, not this app’s. ' +
            'Your Bitbucket code gets to Jules one of two ways:'
        )
      )
    );

    const mirror = el('div', 'row-item stacked path-card');
    mirror.appendChild(
      el('div', 'path-title', el('span', 'path-badge path-badge--ok', 'Recommended'), 'Mirror to a private GitHub repo')
    );
    mirror.appendChild(
      el(
        'p',
        'form-help',
        'Bitbucket stays the source of truth and pushes a copy to a private GitHub repo that Jules is connected to. ' +
          'Everything Jules does works normally, and its branches come back to Bitbucket automatically. ' +
          'Set-up is two files, generated for you below.'
      )
    );
    card.appendChild(mirror);

    const direct = el('div', 'row-item stacked path-card');
    direct.appendChild(
      el('div', 'path-title', el('span', 'path-badge path-badge--warn', 'Experimental'), 'Let Jules clone Bitbucket directly')
    );
    direct.appendChild(
      el(
        'p',
        'form-help',
        'Jules works in a blank virtual machine and clones your Bitbucket repo itself, so GitHub is never involved. ' +
          'This depends on Jules’ sandbox being allowed to reach the internet, which Google does not document — ' +
          'run the check below to find out for your account. It also means your Bitbucket token travels inside the ' +
          'task text and is stored with the session on Google’s side, so use a repository token with a short expiry.'
      )
    );
    card.appendChild(direct);

    section.appendChild(card);
    return section;
  }

  /* ------------------------------------------------------------------ */
  /* Repository picker (shared by both paths)                            */
  /* ------------------------------------------------------------------ */

  function renderRepoPicker() {
    const section = el('section', 'form-section');
    section.appendChild(el('h2', 'form-legend', 'Repository'));
    const card = el('div', 'card');

    // Workspace
    const wsSelect = el('select', { class: 'select', 'aria-label': 'Workspace' });
    if (!workspaces.length) {
      // A repository-scoped token legitimately cannot list workspaces. Say so,
      // rather than leaving a disabled control that looks stuck loading.
      wsSelect.appendChild(
        el('option', { value: '' }, workspacesLoaded ? 'Not available for this token' : 'Loading…')
      );
      wsSelect.disabled = true;
    } else {
      wsSelect.disabled = false;
      for (const ws of workspaces) {
        const option = el('option', { value: ws.slug }, ws.name || ws.slug);
        if (ws.slug === selectedWorkspace) option.selected = true;
        wsSelect.appendChild(option);
      }
      if (selectedWorkspace) wsSelect.value = selectedWorkspace;
    }
    wsSelect.addEventListener('change', () => {
      selectedWorkspace = wsSelect.value;
      setSetting('bitbucketWorkspace', selectedWorkspace);
      selectedRepo = null;
      repos = [];
      render();
      loadRepos();
    });
    card.appendChild(
      el('div', 'row-item', el('span', 'row-item-label', 'Workspace'), wsSelect)
    );

    // Repository
    const repoSelect = el('select', { class: 'select', 'aria-label': 'Repository' });
    if (!repos.length) {
      repoSelect.appendChild(el('option', { value: '' }, selectedWorkspace ? 'Loading…' : 'Pick a workspace first'));
      repoSelect.disabled = true;
    } else {
      repoSelect.disabled = false;
      repoSelect.appendChild(el('option', { value: '' }, 'Choose a repository'));
      for (const repo of repos) {
        const option = el('option', { value: repo.slug }, repo.slug);
        if (selectedRepo && selectedRepo.slug === repo.slug) option.selected = true;
        repoSelect.appendChild(option);
      }
      if (selectedRepo) repoSelect.value = selectedRepo.slug;
    }
    repoSelect.addEventListener('change', () => {
      selectedRepo = repos.find((r) => r.slug === repoSelect.value) || null;
      render();
    });
    card.appendChild(el('div', 'row-item', el('span', 'row-item-label', 'Repository'), repoSelect));

    if (selectedRepo) {
      card.appendChild(
        el(
          'div',
          'row-item',
          el('span', 'row-item-label', 'Open in Bitbucket'),
          externalLink(repoWebUrl(selectedRepo.workspace || selectedWorkspace, selectedRepo.slug), selectedRepo.fullName || selectedRepo.slug)
        )
      );
    }

    section.appendChild(card);
    return section;
  }

  /* ------------------------------------------------------------------ */
  /* Mirror wizard                                                       */
  /* ------------------------------------------------------------------ */

  function renderMirrorWizard() {
    const section = el('section', 'form-section');
    section.appendChild(el('h2', 'form-legend', 'Set up the mirror'));

    if (!selectedRepo) {
      section.appendChild(
        el('div', 'card', el('div', 'row-item', el('p', 'form-help', 'Choose a repository above to generate the setup files.')))
      );
      return section;
    }

    const card = el('div', 'card');
    const ownerInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'your-github-username',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      value: getSetting('githubOwner', ''),
      'aria-label': 'GitHub username',
    });
    const repoInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: selectedRepo.slug + '-mirror',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      value: getSetting('githubMirrorRepo:' + selectedRepo.slug, selectedRepo.slug + '-mirror'),
      'aria-label': 'GitHub mirror repository name',
    });

    card.appendChild(
      el('div', 'row-item stacked', el('span', 'row-item-label', 'Your GitHub username'), ownerInput)
    );
    card.appendChild(
      el('div', 'row-item stacked', el('span', 'row-item-label', 'Private mirror repository name'), repoInput)
    );

    const steps = el('ol', 'steps');
    steps.appendChild(el('li', null, 'On GitHub, create a new ', el('strong', null, 'private'), ' repository with the name above. Leave it empty.'));
    steps.appendChild(el('li', null, 'In Bitbucket: Repository settings → Pipelines → Settings → Enable Pipelines.'));
    steps.appendChild(el('li', null, 'Repository settings → Pipelines → SSH keys → Generate keys. Under Known hosts, enter github.com and press Fetch.'));
    steps.appendChild(el('li', null, 'Copy that public key into GitHub: your mirror repo → Settings → Deploy keys → Add deploy key, and tick ', el('strong', null, 'Allow write access'), '.'));
    steps.appendChild(el('li', null, 'Add the first file below to the root of your Bitbucket repository, and the second to the mirror repo on GitHub.'));
    steps.appendChild(el('li', null, 'At jules.google.com, connect Jules to the mirror repository.'));
    steps.appendChild(el('li', null, 'Come back here and link the mirror so this app knows they belong together.'));
    card.appendChild(el('div', 'row-item stacked', steps));

    const filesWrap = el('div', 'row-item stacked');
    function renderFiles() {
      clear(filesWrap);
      const owner = String(ownerInput.value || '').trim();
      const mirrorRepo = String(repoInput.value || '').trim();
      filesWrap.appendChild(
        copyBlock(
          'bitbucket-pipelines.yml',
          pipelinesYaml({ owner, repo: mirrorRepo }),
          'Goes in the root of your Bitbucket repository. Every push mirrors to GitHub.'
        )
      );
      filesWrap.appendChild(
        copyBlock(
          '.github/workflows/sync-jules-to-bitbucket.yml',
          backSyncYaml({ workspace: selectedRepo.workspace || selectedWorkspace, repo: selectedRepo.slug }),
          'Goes in the GitHub mirror. It pushes branches Jules creates back to Bitbucket.'
        )
      );
    }
    const scheduleRenderFiles = () => {
      if (renderFilesTimer) clearTimeout(renderFilesTimer);
      renderFilesTimer = setTimeout(() => {
        renderFilesTimer = null;
        if (destroyed || !selectedRepo) return;
        setSetting('githubOwner', String(ownerInput.value || '').trim());
        setSetting('githubMirrorRepo:' + selectedRepo.slug, String(repoInput.value || '').trim());
        renderFiles();
      }, 300);
    };
    ownerInput.addEventListener('input', scheduleRenderFiles);
    repoInput.addEventListener('input', scheduleRenderFiles);
    renderFiles();
    card.appendChild(filesWrap);

    section.appendChild(card);
    section.appendChild(renderMirrorLink());
    return section;
  }

  /** Link the Bitbucket repo to the GitHub source Jules already knows about. */
  function renderMirrorLink() {
    const wrap = el('div', 'card link-card');
    const key = (selectedRepo.workspace || selectedWorkspace) + '/' + selectedRepo.slug;
    const existing = getMirrorLinks()[key];

    const select = el('select', { class: 'select', 'aria-label': 'GitHub mirror repository' });
    select.appendChild(el('option', { value: '' }, 'Not linked yet'));
    select.disabled = true;

    const status = el('p', 'form-help', 'Loading the repositories Jules can see…');

    api
      .listAllSources({ signal: abortController.signal })
      .then((sources) => {
        if (destroyed) return;
        clear(select);
        select.appendChild(el('option', { value: '' }, 'Not linked'));
        if (!sources.length) {
          clear(status);
          status.appendChild(
            document.createTextNode('Jules has no repositories connected yet. Connect the mirror at jules.google.com first.')
          );
          return;
        }
        select.disabled = false;
        for (const source of sources) {
          const gh = source.githubRepo || {};
          const label = gh.owner && gh.repo ? gh.owner + '/' + gh.repo : source.name;
          const option = el('option', { value: source.name }, label);
          if (existing && existing.sourceName === source.name) option.selected = true;
          select.appendChild(option);
        }
        if (existing) select.value = existing.sourceName;
        clear(status);
        status.appendChild(
          document.createTextNode(
            existing
              ? 'Linked. New tasks for this Bitbucket repo will run against the mirror.'
              : 'Pick the GitHub repository that mirrors this Bitbucket repo.'
          )
        );
      })
      .catch((err) => {
        if (destroyed || (err && err.name === 'AbortError')) return;
        clear(status);
        status.appendChild(document.createTextNode((err && err.message) || 'Could not load repositories from Jules.'));
      });

    select.addEventListener('change', () => {
      const sourceName = select.value;
      const label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : '';
      setMirrorLink(selectedRepo.workspace || selectedWorkspace, selectedRepo.slug, sourceName ? { sourceName, label } : null);
      toast(sourceName ? 'Linked to ' + label + '.' : 'Link removed.');
      clear(status);
      status.appendChild(
        document.createTextNode(
          sourceName
            ? 'Linked. New tasks for this Bitbucket repo will run against the mirror.'
            : 'Pick the GitHub repository that mirrors this Bitbucket repo.'
        )
      );
    });

    wrap.appendChild(el('div', 'row-item', el('span', 'row-item-label', 'Mirror on GitHub'), select));
    wrap.appendChild(el('div', 'row-item stacked', status));
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* Direct path + connectivity self-test                                */
  /* ------------------------------------------------------------------ */

  function renderSelfTest() {
    const section = el('section', 'form-section');
    section.appendChild(el('h2', 'form-legend', 'Direct path (experimental)'));
    const card = el('div', 'card');

    card.appendChild(
      el(
        'div',
        'row-item stacked',
        el(
          'p',
          'form-help',
          'This check starts a tiny Jules task that tries to reach your Bitbucket repository and reports what happened. ' +
            'It changes nothing. It answers the one thing nobody documents: whether Jules’ sandbox has internet access.'
        )
      )
    );

    const runBtn = el('button', { class: 'btn btn--plain btn--wide', type: 'button' }, 'Run connectivity check');
    runBtn.disabled = !selectedRepo || busy;
    if (!selectedRepo) {
      card.appendChild(el('div', 'row-item', el('p', 'form-help', 'Choose a repository above first.')));
    }

    runBtn.addEventListener('click', async () => {
      if (!selectedRepo || busy) return;
      const ok = await confirmSheet(
        'This starts a real Jules task (it counts against your daily limit) and sends your Bitbucket token to Google as part of the task text. Continue?',
        { confirmLabel: 'Run check', title: 'Run connectivity check' }
      );
      if (!ok || destroyed) return;

      busy = true;
      clear(runBtn);
      runBtn.disabled = true;
      runBtn.appendChild(spinner({ size: 18, label: 'Starting' }));
      runBtn.appendChild(document.createTextNode('Starting…'));

      try {
        const session = await api.createSession({
          prompt: selfTestPrompt({
            workspace: selectedRepo.workspace || selectedWorkspace,
            repo: selectedRepo.slug,
            token: credential.token,
            mode: credential.mode,
          }),
          title: SELF_TEST_TITLE,
          requirePlanApproval: false,
          signal: abortController.signal,
        });
        if (destroyed) return;
        const id = session.id || sessionId(session.name);
        if (ctx && typeof ctx.sessionsChanged === 'function') ctx.sessionsChanged();
        toast('Check started — watch the activity feed for the result.');
        if (id && ctx && ctx.navigate) ctx.navigate('/session/' + encodeURIComponent(id));
      } catch (err) {
        if (destroyed || (err && err.name === 'AbortError')) return;
        busy = false;
        clear(runBtn);
        runBtn.disabled = false;
        runBtn.appendChild(document.createTextNode('Run connectivity check'));
        const message =
          err instanceof ApiError && err.isNetwork
            ? 'Could not reach Jules. Check your connection.'
            : (err && err.message) || 'Could not start the check.';
        toast(message, { tone: 'error' });
      }
    });

    card.appendChild(el('div', 'row-item', runBtn));
    section.appendChild(card);
    return section;
  }

  /* ------------------------------------------------------------------ */
  /* Connection status                                                   */
  /* ------------------------------------------------------------------ */

  function renderStatus() {
    const section = el('section', 'form-section');
    const card = el('div', 'card');

    card.appendChild(
      el(
        'div',
        'row-item',
        el('span', 'row-item-label', el('span', 'row-item-icon', icon('check', { size: 18 })), 'Connected'),
        el('span', 'row-item-value', maskToken(credential.token))
      )
    );
    if (credential.mode === 'basic' && credential.email) {
      card.appendChild(el('div', 'row-item', el('span', 'row-item-label', 'Account'), el('span', 'row-item-value', credential.email)));
    }

    const disconnect = el('button', { class: 'btn btn--danger btn--plain', type: 'button' }, 'Disconnect Bitbucket');
    disconnect.addEventListener('click', async () => {
      const ok = await confirmSheet('Remove the Bitbucket token from this device?', {
        confirmLabel: 'Disconnect',
        destructive: true,
        title: 'Disconnect Bitbucket',
      });
      if (!ok || destroyed) return;
      clearBitbucketCredential();
      credential = null;
      workspaces = [];
      repos = [];
      selectedRepo = null;
      toast('Bitbucket disconnected.');
      render();
    });
    card.appendChild(el('div', 'row-item', disconnect));

    section.appendChild(card);
    return section;
  }

  /* ------------------------------------------------------------------ */
  /* Loading                                                             */
  /* ------------------------------------------------------------------ */

  async function loadWorkspaces() {
    if (!credential) return;
    try {
      const list = await bitbucket.listWorkspaces({ signal: abortController.signal });
      if (destroyed) return;
      workspaces = list;
      workspacesLoaded = true;
      if (!selectedWorkspace && workspaces.length) selectedWorkspace = workspaces[0].slug;
      render();
      loadRepos();
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      // A repo-scoped token cannot list workspaces; that is expected, not an error.
      workspaces = [];
      workspacesLoaded = true;
      render();
    }
  }

  async function loadRepos() {
    if (!credential || !selectedWorkspace) return;
    try {
      const list = await bitbucket.listRepos(selectedWorkspace, { signal: abortController.signal });
      if (destroyed) return;
      repos = list;
      render();
    } catch (err) {
      if (destroyed || (err && err.name === 'AbortError')) return;
      repos = [];
      render();
      toast((err && err.message) || 'Could not load repositories.', { tone: 'error' });
    }
  }

  /* ------------------------------------------------------------------ */

  function render() {
    clear(body);
    if (!credential) {
      body.appendChild(renderConnect());
      body.appendChild(renderExplainer());
      return;
    }
    body.appendChild(renderStatus());
    body.appendChild(renderExplainer());
    body.appendChild(renderRepoPicker());
    body.appendChild(renderMirrorWizard());
    body.appendChild(renderSelfTest());
  }

  render();
  if (credential) loadWorkspaces();

  return function unmount() {
    destroyed = true;
    abortController.abort();
    if (pane.parentNode) pane.parentNode.removeChild(pane);
  };
}

export default { mount };
