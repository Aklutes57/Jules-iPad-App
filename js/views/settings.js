// views/settings.js — key management, polling speed, and an escape hatch.

import { CONFIG, POLL_PRESETS, pollSpeed, apiBase, isPlausibleApiBase } from '../config.js';
import { getApiKey, clearApiKey, getSetting, setSetting, isPersistent } from '../storage.js';
import { clearSourcesCache } from '../api.js';
import { el, icon, iconButton, segmented, confirmSheet, toast, clear, externalLink } from '../ui.js';

/** first four + bullets + last four, so the user can tell two keys apart. */
function maskKey(key) {
  if (!key) return 'Not set';
  const text = String(key);
  if (text.length <= 10) return '•'.repeat(Math.max(text.length, 6));
  return text.slice(0, 4) + ' •••••••• ' + text.slice(-4);
}

const SPEED_OPTIONS = [
  { label: 'Fast · 3s', value: 'fast' },
  { label: 'Normal · 5s', value: 'normal' },
  { label: 'Relaxed · 10s', value: 'relaxed' },
];

/**
 * @param {HTMLElement} container
 * @param {Object} params
 * @param {Object} ctx
 * @returns {() => void} unmount
 */
export function mount(container, params, ctx) {
  let destroyed = false;

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
  header.appendChild(el('h1', 'app-title', 'Settings'));
  header.appendChild(el('div', 'header-actions'));

  const scroll = el('div', 'scroll form-scroll');
  const pane = el('div', 'pane-body settings', header, scroll);
  container.appendChild(pane);

  /* ---------- API key ---------- */

  const keySection = el('section', 'form-section');
  keySection.appendChild(el('h2', 'form-legend', 'API key'));

  const keyCard = el('div', 'card');
  const keyValue = el('span', 'row-item-value mono', maskKey(getApiKey()));
  keyCard.appendChild(
    el(
      'div',
      'row-item',
      el('span', 'row-item-label', el('span', 'row-item-icon', icon('key', { size: 18 })), 'Saved key'),
      keyValue
    )
  );

  const forgetBtn = el('button', { class: 'row-item row-item--button row-item--danger', type: 'button' }, 'Forget key on this iPad');
  forgetBtn.addEventListener('click', async () => {
    const confirmed = await confirmSheet(
      'The key will be removed from this iPad. Your Jules account and its sessions are untouched — you can paste the key again at any time.',
      { title: 'Forget this key?', confirmLabel: 'Forget key', destructive: true }
    );
    if (!confirmed || destroyed) return;
    clearApiKey();
    clearSourcesCache();
    if (ctx && typeof ctx.onKeyForgotten === 'function') ctx.onKeyForgotten();
    else if (ctx && ctx.navigate) ctx.navigate('/onboarding', { replace: true });
  });
  keyCard.appendChild(forgetBtn);
  keySection.appendChild(keyCard);

  const keyNote = isPersistent()
    ? 'Stored only in this browser’s local storage. It is never sent anywhere except Google’s Jules API.'
    : 'This browser is not saving data (Private Browsing?), so the key will be forgotten when you close the tab.';
  keySection.appendChild(el('p', 'form-help', keyNote));
  scroll.appendChild(keySection);

  /* ---------- polling ---------- */

  const pollSection = el('section', 'form-section');
  pollSection.appendChild(el('h2', 'form-legend', 'Update speed'));
  const pollCard = el('div', 'card');

  const speed = segmented({
    options: SPEED_OPTIONS,
    value: pollSpeed(),
    ariaLabel: 'How often to check for updates',
    onChange: (value) => {
      if (!Object.prototype.hasOwnProperty.call(POLL_PRESETS, value)) return;
      setSetting('pollSpeed', value);
      toast('Updates will now arrive every ' + Math.round(POLL_PRESETS[value] / 1000) + ' seconds.');
    },
  });
  pollCard.appendChild(el('div', 'row-item row-item--stack', speed.node));
  pollSection.appendChild(pollCard);
  pollSection.appendChild(
    el(
      'p',
      'form-help',
      'How often an open task checks Jules for new activity. Slower uses less battery and stays further from Jules’ rate limits. Checking pauses automatically when the app is in the background.'
    )
  );
  scroll.appendChild(pollSection);

  /* ---------- advanced ---------- */

  const advanced = el('details', 'card disclosure');
  advanced.appendChild(
    el(
      'summary',
      'disclosure-summary',
      el('span', null, 'Advanced'),
      el('span', 'disclosure-chevron', icon('chevron-down', { size: 18 }))
    )
  );

  const advBody = el('div', 'disclosure-body');
  advBody.appendChild(el('div', 'row-item-label', 'API base URL'));
  advBody.appendChild(
    el(
      'p',
      'form-help form-help--tight',
      'Only change this if you are testing against a local server. Whatever you put here will receive your API key.'
    )
  );

  const baseInput = el('input', {
    class: 'input mono',
    type: 'url',
    value: apiBase(),
    placeholder: CONFIG.API_BASE_DEFAULT,
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    'aria-label': 'API base URL',
  });
  advBody.appendChild(baseInput);

  const baseButtons = el('div', 'adv-actions');
  const saveBase = el('button', { class: 'btn btn--plain', type: 'button' }, 'Save');
  saveBase.addEventListener('click', () => {
    const value = String(baseInput.value || '').trim().replace(/\/+$/, '');
    if (!value || value === CONFIG.API_BASE_DEFAULT) {
      setSetting('apiBase', null);
      baseInput.value = CONFIG.API_BASE_DEFAULT;
      toast('Using the standard Jules API.');
      return;
    }
    if (!isPlausibleApiBase(value)) {
      toast('That does not look like an http(s) address.', { tone: 'error' });
      return;
    }
    setSetting('apiBase', value);
    clearSourcesCache();
    toast('API base saved. Reload to be sure everything picks it up.', {
      action: { label: 'Reload', onClick: () => window.location.reload() },
    });
  });

  const resetBase = el('button', { class: 'btn btn--plain', type: 'button' }, 'Reset to default');
  resetBase.addEventListener('click', () => {
    setSetting('apiBase', null);
    clearSourcesCache();
    baseInput.value = CONFIG.API_BASE_DEFAULT;
    toast('Back to the standard Jules API.');
  });

  baseButtons.appendChild(saveBase);
  baseButtons.appendChild(resetBase);
  advBody.appendChild(baseButtons);

  if (getSetting('apiBase', null)) {
    advBody.appendChild(
      el('p', 'form-help form-help--warn', 'A custom API base is active. Reset it if Jules stops responding.')
    );
  }

  advanced.appendChild(advBody);

  const advSection = el('section', 'form-section');
  advSection.appendChild(advanced);
  scroll.appendChild(advSection);

  /* ---------- about ---------- */

  const about = el('section', 'form-section about');
  about.appendChild(el('p', 'about-name', 'Jules for iPad'));
  about.appendChild(el('p', 'about-version', 'Version ' + CONFIG.APP_VERSION));
  about.appendChild(
    el(
      'p',
      'about-note',
      'An unofficial client for ',
      externalLink('https://jules.google.com', 'Google Jules'),
      '. Not affiliated with Google.'
    )
  );
  scroll.appendChild(about);

  return function unmount() {
    destroyed = true;
    if (pane.parentNode) pane.parentNode.removeChild(pane);
  };
}

export default { mount };
