// views/onboarding.js — paste your API key.
//
// This is the first thing a new user sees, and also what they see if Safari has
// quietly evicted localStorage. The tone is deliberately plain: the person using
// this app is not expected to know what an API key is.

import { api, ApiError, clearSourcesCache } from '../api.js';
import { setApiKey, isPersistent } from '../storage.js';
import { el, icon, spinner, externalLink, clear } from '../ui.js';

const KEY_PAGE_URL = 'https://jules.google.com/settings#api';
const JULES_URL = 'https://jules.google.com';

/**
 * Turn an ApiError into something a non-expert can act on.
 * @param {ApiError} err
 * @returns {{title:string, body:string, hint?:string}}
 */
function diagnose(err) {
  if (!(err instanceof ApiError)) {
    return {
      title: 'Something went wrong',
      body: 'The key could not be checked. Please try again in a moment.',
    };
  }

  if (err.status === 0) {
    return {
      title: 'Couldn’t reach Jules',
      body: 'Check your internet connection and try again. Nothing was saved.',
    };
  }

  if (err.status === 401 || err.status === 403) {
    // Google returns this exact (very misleading) wording for a key that is
    // simply wrong. Saying so plainly saves a lot of confusion.
    if (/API keys are not supported by this API/i.test(err.serverMessage || '')) {
      return {
        title: 'Google rejected this key',
        body:
          'Usually this means it isn’t a Jules API key — those only come from the API ' +
          'section of your Jules settings — or the key has since been deleted. Google’s ' +
          'wording here is confusing, but it is not a problem with this app.',
        hint: 'Create a fresh key on the Jules settings page and paste that one.',
      };
    }
    return {
      title: 'Key rejected',
      body:
        'Jules would not accept this key. Check that you copied the whole thing with no ' +
        'extra spaces, and that the key still exists in your Jules settings.',
    };
  }

  if (err.status === 429) {
    return {
      title: 'Too many attempts',
      body: 'Jules is rate-limiting requests right now. Wait a minute and try again.',
    };
  }

  if (err.status >= 500) {
    return {
      title: 'Jules is having trouble',
      body: 'The Jules service returned an error. That is on their side — try again shortly.',
    };
  }

  return {
    title: 'Could not verify the key',
    body: 'Jules returned an unexpected response. The exact wording is below.',
  };
}

function stepRow(number, title, description) {
  return el(
    'li',
    'ob-step',
    el('span', 'ob-step-num', String(number)),
    el('div', 'ob-step-body', el('div', 'ob-step-title', title), description)
  );
}

/**
 * @param {HTMLElement} container
 * @param {{problem?:string}} params route query
 * @param {Object} ctx
 * @returns {() => void} unmount
 */
export function mount(container, params, ctx) {
  const keyProblem = Boolean(params && params.problem);
  let abortController = null;
  let destroyed = false;

  const pane = el('div', 'pane-body onboarding');
  const scroll = el('div', 'scroll onboarding-scroll');
  const card = el('div', 'card ob-card');

  /* ---------- heading ---------- */

  card.appendChild(el('div', 'ob-mark', icon('sparkle', { size: 30, stroke: 1.6 })));
  card.appendChild(
    el('h1', 'ob-heading', keyProblem ? 'There’s a problem with your saved key' : 'Welcome to Jules')
  );
  card.appendChild(
    el(
      'p',
      'ob-sub',
      keyProblem
        ? 'Jules stopped accepting the key saved on this iPad. Paste a working one below to carry on — the old key stays put until you replace it.'
        : 'This app talks straight to Google Jules. To get started it needs an API key from your Jules account.'
    )
  );

  /* ---------- steps ---------- */

  const steps = el('ol', 'ob-steps');
  steps.appendChild(
    stepRow(
      1,
      'Sign in to Jules',
      el('p', 'ob-step-desc', 'Open ', externalLink(JULES_URL, 'jules.google.com'), ' and sign in with your Google account.')
    )
  );
  steps.appendChild(
    stepRow(
      2,
      'Create an API key',
      el(
        'p',
        'ob-step-desc',
        'Go to ',
        externalLink(KEY_PAGE_URL, 'Settings → API'),
        ' and create a key, then copy it. You can have up to three.'
      )
    )
  );
  steps.appendChild(
    stepRow(
      3,
      'Paste it below',
      el('p', 'ob-step-desc', 'The key is kept on this iPad only, and is sent only to Google.')
    )
  );
  card.appendChild(steps);

  /* ---------- form ---------- */

  const input = el('input', {
    class: 'input ob-input',
    type: 'password',
    id: 'ob-key',
    name: 'julesApiKey',
    placeholder: 'Paste your Jules API key',
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    'aria-label': 'Jules API key',
  });

  let revealed = false;
  const revealBtn = el(
    'button',
    { class: 'icon-btn ob-reveal', type: 'button', 'aria-label': 'Show key', title: 'Show key' },
    icon('eye')
  );
  revealBtn.addEventListener('click', () => {
    revealed = !revealed;
    input.type = revealed ? 'text' : 'password';
    clear(revealBtn);
    revealBtn.appendChild(icon(revealed ? 'eye-off' : 'eye'));
    revealBtn.setAttribute('aria-label', revealed ? 'Hide key' : 'Show key');
    revealBtn.title = revealed ? 'Hide key' : 'Show key';
    try {
      input.focus();
    } catch (_err) {
      /* best effort */
    }
  });

  const field = el('div', 'ob-field', input, revealBtn);
  const submitBtn = el('button', { class: 'btn btn--primary ob-submit', type: 'submit' }, 'Test & save');
  const status = el('div', { class: 'ob-status', 'aria-live': 'polite' });
  const form = el('form', { class: 'ob-form' }, field, submitBtn, status);
  card.appendChild(form);

  /* ---------- footnotes ---------- */

  const notes = el('div', 'ob-notes');
  notes.appendChild(
    el(
      'p',
      'ob-note',
      'Your key never leaves this device except in requests to Google’s Jules API. It is not written into this app’s code, and there is no server behind this app.'
    )
  );
  notes.appendChild(
    el(
      'p',
      'ob-note',
      'Safari sometimes clears saved data for apps that haven’t been opened in a while. If you’re asked for the key again one day, nothing is broken — just paste it once more.'
    )
  );
  if (!isPersistent()) {
    notes.appendChild(
      el(
        'p',
        'ob-note ob-note--warn',
        'This browser isn’t letting the app save anything (Private Browsing?). Your key will work for this visit but will be forgotten when you close the tab.'
      )
    );
  }
  card.appendChild(notes);

  scroll.appendChild(card);
  pane.appendChild(scroll);
  container.appendChild(pane);

  /* ---------- behaviour ---------- */

  function setStatus(node) {
    clear(status);
    if (node) status.appendChild(node);
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    input.disabled = busy;
    submitBtn.classList.toggle('is-busy', busy);
    clear(submitBtn);
    if (busy) {
      submitBtn.appendChild(spinner({ size: 18, label: 'Checking key' }));
      submitBtn.appendChild(document.createTextNode('Checking…'));
    } else {
      submitBtn.appendChild(document.createTextNode('Test & save'));
    }
  }

  function showFailure(err) {
    const info = diagnose(err);
    const panel = el('div', 'diag');
    panel.appendChild(el('span', 'diag-icon', icon('alert', { size: 20 })));

    const body = el('div', 'diag-body');
    body.appendChild(el('div', 'diag-title', info.title));
    body.appendChild(el('p', 'diag-text', info.body));
    if (info.hint) body.appendChild(el('p', 'diag-hint', info.hint));

    const raw = (err && err.serverMessage) || (err && err.message) || '';
    if (raw) {
      const details = el('details', 'diag-raw');
      details.appendChild(el('summary', 'diag-raw-summary', 'What the server said'));
      const meta = [];
      if (err && err.status) meta.push('HTTP ' + err.status);
      if (err && err.googleStatus) meta.push(err.googleStatus);
      if (meta.length) details.appendChild(el('div', 'diag-raw-meta', meta.join(' · ')));
      details.appendChild(el('pre', 'diag-raw-text', raw));
      body.appendChild(details);
    }

    panel.appendChild(body);
    setStatus(panel);
  }

  async function showSuccess() {
    const panel = el('div', 'diag diag--ok');
    panel.appendChild(el('span', 'diag-icon', icon('check', { size: 20 })));
    const body = el('div', 'diag-body');
    const title = el('div', 'diag-title', 'Connected');
    body.appendChild(title);
    panel.appendChild(body);
    setStatus(panel);

    // A second, best-effort call so we can say something concrete about what
    // this key can see. A failure here is not a reason to reject the key.
    let count = null;
    try {
      const sources = await api.listAllSources({ force: true });
      count = sources.length;
    } catch (_err) {
      count = null;
    }
    if (destroyed) return;

    if (count === 0) {
      title.textContent = 'Connected — no repositories linked yet';
      body.appendChild(
        el(
          'p',
          'diag-text',
          'You can still start a task without a repository. To work on your code, connect GitHub to Jules on jules.google.com.'
        )
      );
    } else if (count !== null) {
      title.textContent = 'Connected — found ' + count + (count === 1 ? ' repository' : ' repositories');
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    const key = String(input.value || '').trim();

    if (!key) {
      setStatus(
        el(
          'div',
          'diag',
          el('span', 'diag-icon', icon('alert', { size: 20 })),
          el('div', 'diag-body', el('div', 'diag-title', 'Paste your key first'))
        )
      );
      try {
        input.focus();
      } catch (_err) {
        /* best effort */
      }
      return;
    }

    if (abortController) abortController.abort();
    abortController = new AbortController();

    setBusy(true);
    setStatus(el('div', 'ob-checking', spinner({ size: 18 }), el('span', null, 'Checking with Jules…')));

    try {
      await api.testKey(key, { signal: abortController.signal });
      if (destroyed) return;

      setApiKey(key);
      clearSourcesCache();
      setBusy(false);
      await showSuccess();
      if (destroyed) return;

      // A beat, so the confirmation is readable before the view changes.
      setTimeout(() => {
        if (destroyed) return;
        if (ctx && typeof ctx.onKeySaved === 'function') ctx.onKeySaved();
      }, 850);
    } catch (err) {
      if (destroyed) return;
      if (err && err.name === 'AbortError') return;
      setBusy(false);
      showFailure(err);
    }
  }

  form.addEventListener('submit', onSubmit);

  // Focus the field on wide screens only — an auto-popping keyboard on a narrow
  // layout hides the instructions the user still needs to read.
  if (window.matchMedia('(min-width: 900px)').matches) {
    requestAnimationFrame(() => {
      try {
        input.focus();
      } catch (_err) {
        /* best effort */
      }
    });
  }

  return function unmount() {
    destroyed = true;
    if (abortController) abortController.abort();
    form.removeEventListener('submit', onSubmit);
    if (pane.parentNode) pane.parentNode.removeChild(pane);
  };
}

export default { mount };
