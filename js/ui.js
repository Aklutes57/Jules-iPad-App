// ui.js — DOM builder and shared interface pieces.
//
// SECURITY NOTE, and the reason this file exists:
// every string that comes back from the Jules API (agent messages, session
// titles, diffs, bash output, failure reasons) is untrusted. `innerHTML` is
// never used anywhere in this app. `el()` puts text into the DOM as text nodes,
// which cannot become markup no matter what the server sends.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Attributes that must be set as JS properties rather than HTML attributes.
const PROPERTY_KEYS = new Set([
  'value',
  'checked',
  'selected',
  'indeterminate',
  'disabled',
  'readOnly',
  'textContent',
]);

function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
      continue;
    }
    if (child instanceof Node) {
      parent.appendChild(child);
      continue;
    }
    parent.appendChild(document.createTextNode(String(child)));
  }
}

function applyAttrs(node, attrs) {
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class' || key === 'className') {
      node.className = String(value);
      continue;
    }
    if (key === 'text') {
      node.appendChild(document.createTextNode(String(value)));
      continue;
    }
    if (key === 'for') {
      node.htmlFor = String(value);
      continue;
    }
    if (key === 'style' && typeof value === 'object') {
      for (const prop of Object.keys(value)) {
        if (value[prop] !== null && value[prop] !== undefined) node.style[prop] = value[prop];
      }
      continue;
    }
    if (key === 'dataset' && typeof value === 'object') {
      for (const prop of Object.keys(value)) {
        if (value[prop] !== null && value[prop] !== undefined) node.dataset[prop] = String(value[prop]);
      }
      continue;
    }
    if (key === 'on' && typeof value === 'object') {
      for (const eventName of Object.keys(value)) {
        if (typeof value[eventName] === 'function') node.addEventListener(eventName, value[eventName]);
      }
      continue;
    }
    if (key.length > 2 && key.slice(0, 2) === 'on' && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    if (PROPERTY_KEYS.has(key)) {
      node[key] = value;
      continue;
    }
    if (value === true) {
      node.setAttribute(key, '');
      continue;
    }
    node.setAttribute(key, String(value));
  }
}

/**
 * Build an element.
 *
 *   el('div', 'card', 'hello')
 *   el('button', { class: 'btn', on: { click: fn } }, 'Save')
 *   el('p', null, someUntrustedString)   // always a text node
 *
 * @param {string} tag
 * @param {Object|string|Node|Array|null} [attrsOrClassName]
 * @param {...*} children
 * @returns {HTMLElement}
 */
export function el(tag, attrsOrClassName, ...children) {
  const node = document.createElement(tag);
  let rest = children;

  if (typeof attrsOrClassName === 'string') {
    if (attrsOrClassName) node.className = attrsOrClassName;
  } else if (attrsOrClassName instanceof Node || Array.isArray(attrsOrClassName)) {
    rest = [attrsOrClassName].concat(children);
  } else if (attrsOrClassName && typeof attrsOrClassName === 'object') {
    applyAttrs(node, attrsOrClassName);
  }

  appendChildren(node, rest);
  return node;
}

/** Document fragment from a list of children. */
export function frag(...children) {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

/** Remove every child of a node. */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ------------------------------------------------------------------ */
/* Icons — built with createElementNS, never innerHTML                 */
/* ------------------------------------------------------------------ */

const ICONS = {
  'chevron-left': { paths: ['M15 5 L8 12 L15 19'] },
  'chevron-right': { paths: ['M9 5 L16 12 L9 19'] },
  'chevron-down': { paths: ['M5 9 L12 16 L19 9'] },
  plus: { paths: ['M12 5 V19', 'M5 12 H19'] },
  x: { paths: ['M6 6 L18 18', 'M18 6 L6 18'] },
  check: { paths: ['M5 13 L9.5 17.5 L19 6.5'] },
  sliders: {
    paths: ['M4 8 H7', 'M13 8 H20', 'M4 16 H11', 'M17 16 H20'],
    circles: [{ cx: 10, cy: 8, r: 3 }, { cx: 14, cy: 16, r: 3 }],
  },
  dots: {
    circles: [
      { cx: 5, cy: 12, r: 1.7, fill: true },
      { cx: 12, cy: 12, r: 1.7, fill: true },
      { cx: 19, cy: 12, r: 1.7, fill: true },
    ],
  },
  refresh: { paths: ['M4 12 a8 8 0 1 0 8 -8', 'M15.5 1.2 L12 4 L15.5 6.8'] },
  external: {
    paths: [
      'M14 4 H20 V10',
      'M20 4 L11.5 12.5',
      'M18 14 v5 a1 1 0 0 1 -1 1 H5 a1 1 0 0 1 -1 -1 V7 a1 1 0 0 1 1 -1 h5',
    ],
  },
  'arrow-up': { paths: ['M12 19 V5', 'M6 11 L12 5 L18 11'] },
  trash: {
    paths: ['M4 7 H20', 'M10 7 V4 h4 v3', 'M6 7 l1 13 a1 1 0 0 0 1 1 h8 a1 1 0 0 0 1 -1 l1 -13', 'M10 11 v6', 'M14 11 v6'],
  },
  archive: {
    paths: [
      'M4 4 h16 a1 1 0 0 1 1 1 v3 H3 V5 a1 1 0 0 1 1 -1 z',
      'M5 8 v11 a1 1 0 0 0 1 1 h12 a1 1 0 0 0 1 -1 V8',
      'M10 13 h4',
    ],
  },
  inbox: {
    paths: ['M3 13 h5 l1.5 3 h5 L16 13 h5', 'M5 5 h14 l2 8 v6 a1 1 0 0 1 -1 1 H4 a1 1 0 0 1 -1 -1 v-6 z'],
  },
  alert: { paths: ['M12 3 L22.5 20.5 H1.5 Z', 'M12 9.5 v5'], circles: [{ cx: 12, cy: 17.8, r: 1, fill: true }] },
  search: { paths: ['M15.6 15.6 L21 21'], circles: [{ cx: 10.5, cy: 10.5, r: 6 }] },
  eye: { paths: ['M2 12 s4 -7 10 -7 10 7 10 7 -4 7 -10 7 -10 -7 -10 -7 z'], circles: [{ cx: 12, cy: 12, r: 3 }] },
  'eye-off': {
    paths: ['M2 12 s4 -7 10 -7 10 7 10 7 -4 7 -10 7 -10 -7 -10 -7 z', 'M3.5 3.5 L20.5 20.5'],
    circles: [{ cx: 12, cy: 12, r: 3 }],
  },
  pr: {
    paths: ['M6 7.5 V16.5', 'M18 16.5 V9 a2 2 0 0 0 -2 -2 H11', 'M13.5 4.5 L11 7 L13.5 9.5'],
    circles: [{ cx: 6, cy: 5, r: 2.4 }, { cx: 6, cy: 19, r: 2.4 }, { cx: 18, cy: 19, r: 2.4 }],
  },
  repo: {
    paths: ['M6 3 h13 v18 H8 a2 2 0 0 1 -2 -2 V3 z', 'M6 17 h13', 'M10 3 v7 l2 -1.5 L14 10 V3'],
  },
  branch: {
    paths: ['M6 7.4 V16.6', 'M18 8.4 v1.6 a4 4 0 0 1 -4 4 h-4 a4 4 0 0 0 -4 4'],
    circles: [{ cx: 6, cy: 5, r: 2.4 }, { cx: 18, cy: 6, r: 2.4 }, { cx: 6, cy: 19, r: 2.4 }],
  },
  sparkle: {
    paths: ['M12 3 l1.9 5.6 L19.5 10.5 l-5.6 1.9 L12 18 l-1.9 -5.6 L4.5 10.5 l5.6 -1.9 z', 'M18.5 16 l.8 2.2 2.2 .8 -2.2 .8 -.8 2.2 -.8 -2.2 -2.2 -.8 2.2 -.8 z'],
  },
  key: {
    paths: ['M20.5 3.5 L12.5 11.5', 'M17.5 6.5 L19.5 8.5', 'M14.5 9.5 L16 11'],
    circles: [{ cx: 8, cy: 16, r: 4.5 }],
  },
  wifi: {
    paths: ['M2.5 9 A15 15 0 0 1 21.5 9', 'M6 12.6 A10 10 0 0 1 18 12.6', 'M9.5 16.2 A5 5 0 0 1 14.5 16.2'],
    circles: [{ cx: 12, cy: 20, r: 1.1, fill: true }],
  },
};

/**
 * @param {string} name key of ICONS
 * @param {{size?:number, stroke?:number, className?:string}} [options]
 * @returns {SVGElement}
 */
export function icon(name, options = {}) {
  const size = options.size || 22;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(options.stroke || 1.9));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'icon' + (options.className ? ' ' + options.className : ''));

  const spec = ICONS[name];
  if (spec) {
    for (const d of spec.paths || []) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    for (const c of spec.circles || []) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(c.cx));
      circle.setAttribute('cy', String(c.cy));
      circle.setAttribute('r', String(c.r));
      if (c.fill) {
        circle.setAttribute('fill', 'currentColor');
        circle.setAttribute('stroke', 'none');
      }
      svg.appendChild(circle);
    }
  }
  return svg;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * "3m ago", "yesterday"-ish. Falls back to a short date past a week.
 * @param {string} iso RFC3339 timestamp
 * @returns {string}
 */
export function timeAgo(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 0) return 'just now'; // device clock ahead of the server
  if (seconds < 10) return 'just now';
  if (seconds < 60) return seconds + 's ago';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';

  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';

  try {
    return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch (_err) {
    return new Date(then).toDateString();
  }
}

/** Absolute timestamp for tooltips / small print. */
export function formatTime(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  try {
    return new Date(then).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch (_err) {
    return new Date(then).toString();
  }
}

const STATE_LABELS = {
  QUEUED: 'Queued',
  PLANNING: 'Planning',
  AWAITING_PLAN_APPROVAL: 'Needs approval',
  AWAITING_USER_FEEDBACK: 'Needs reply',
  IN_PROGRESS: 'Working',
  PAUSED: 'Paused',
  COMPLETED: 'Done',
  FAILED: 'Failed',
};

const STATE_CLASSES = {
  QUEUED: 'queued',
  PLANNING: 'planning',
  AWAITING_PLAN_APPROVAL: 'awaiting',
  AWAITING_USER_FEEDBACK: 'awaiting',
  IN_PROGRESS: 'progress',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/** Human label for a session state, including states we've never seen. */
export function stateLabel(state) {
  if (!state) return 'Unknown';
  if (STATE_LABELS[state]) return STATE_LABELS[state];
  // Future-proofing: turn SOME_NEW_STATE into "Some new state".
  const words = String(state).toLowerCase().replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The coloured pill used in the list and the detail header.
 * @param {string} state
 * @param {{compact?:boolean}} [options]
 * @returns {HTMLElement}
 */
export function stateBadge(state, options = {}) {
  const variant = STATE_CLASSES[state] || 'unknown';
  const needsAttention = state === 'AWAITING_PLAN_APPROVAL' || state === 'AWAITING_USER_FEEDBACK';
  const busy = state === 'IN_PROGRESS' || state === 'PLANNING';

  const classes = ['badge', 'badge--' + variant];
  if (needsAttention) classes.push('badge--pulse');
  if (options.compact) classes.push('badge--compact');

  const badge = el('span', {
    class: classes.join(' '),
    role: 'status',
    'aria-label': 'Status: ' + stateLabel(state),
  });

  if (needsAttention || busy) badge.appendChild(el('span', 'badge-dot'));
  badge.appendChild(el('span', 'badge-text', stateLabel(state)));
  return badge;
}

/* ------------------------------------------------------------------ */
/* Spinner                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {{size?:number, label?:string}} [options]
 * @returns {HTMLElement}
 */
export function spinner(options = {}) {
  const size = options.size || 20;
  return el('span', {
    class: 'spinner',
    role: 'progressbar',
    'aria-label': options.label || 'Loading',
    style: { width: size + 'px', height: size + 'px' },
  });
}

/** A centred spinner with a caption, for whole-pane loading. */
export function loadingPane(message) {
  return el('div', 'pane-loading', spinner({ size: 28 }), message ? el('p', 'muted', message) : null);
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {{icon?:string, title:string, body?:string, action?:{label:string, onClick:Function}}} options
 * @returns {HTMLElement}
 */
export function emptyState(options = {}) {
  const wrap = el('div', 'empty');
  if (options.icon) {
    wrap.appendChild(el('div', 'empty-icon', icon(options.icon, { size: 34, stroke: 1.5 })));
  }
  if (options.title) wrap.appendChild(el('h2', 'empty-title', options.title));
  if (options.body) wrap.appendChild(el('p', 'empty-body', options.body));
  if (options.action && options.action.label) {
    wrap.appendChild(
      el(
        'button',
        { class: 'btn btn--primary empty-action', type: 'button', on: { click: options.action.onClick } },
        options.action.label
      )
    );
  }
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toastSlot() {
  let slot = document.getElementById('toast-slot');
  if (!slot) {
    slot = el('div', { id: 'toast-slot', class: 'toast-slot', 'aria-live': 'polite' });
    document.body.appendChild(slot);
  }
  return slot;
}

/**
 * @param {string} message
 * @param {{action?:{label:string, onClick:Function}, duration?:number, tone?:'default'|'error'|'success'}} [options]
 * @returns {{dismiss: () => void}}
 */
export function toast(message, options = {}) {
  const slot = toastSlot();
  const tone = options.tone || 'default';
  const duration = options.duration || (options.action ? 9000 : 4500);

  let timer = null;
  const node = el('div', 'toast toast--' + tone);
  node.appendChild(el('span', 'toast-text', String(message == null ? '' : message)));

  const dismiss = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!node.parentNode) return;
    node.classList.add('toast--leaving');
    setTimeout(() => {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 200);
  };

  if (options.action && options.action.label) {
    node.appendChild(
      el(
        'button',
        {
          class: 'toast-action',
          type: 'button',
          on: {
            click: () => {
              dismiss();
              if (typeof options.action.onClick === 'function') options.action.onClick();
            },
          },
        },
        options.action.label
      )
    );
  }

  slot.appendChild(node);
  // Keep at most three toasts stacked.
  while (slot.children.length > 3) slot.removeChild(slot.firstChild);

  timer = setTimeout(dismiss, duration);
  return { dismiss };
}

/* ------------------------------------------------------------------ */
/* Sheets (bottom sheet on narrow, centred card on wide)               */
/* ------------------------------------------------------------------ */

function sheetSlot() {
  let slot = document.getElementById('sheet-slot');
  if (!slot) {
    slot = el('div', { id: 'sheet-slot', class: 'sheet-slot' });
    document.body.appendChild(slot);
  }
  return slot;
}

/**
 * Core sheet presenter. `build(resolve)` returns the sheet's inner content.
 * @param {(resolve: (value:*) => void) => Node} build
 * @param {{dismissValue?:*, labelledBy?:string}} [options]
 * @returns {Promise<*>}
 */
function presentSheet(build, options = {}) {
  const slot = sheetSlot();
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      backdrop.classList.add('sheet-backdrop--leaving');
      setTimeout(() => {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      }, 200);
      resolve(value);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(options.dismissValue);
      }
    };

    const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
    sheet.appendChild(build(finish));

    const backdrop = el('div', {
      class: 'sheet-backdrop',
      on: {
        click: (event) => {
          if (event.target === backdrop) finish(options.dismissValue);
        },
      },
    });
    backdrop.appendChild(sheet);

    slot.appendChild(backdrop);
    document.addEventListener('keydown', onKeyDown, true);

    // Focus the primary control so a hardware keyboard can drive the sheet.
    const focusable = sheet.querySelector('button');
    if (focusable) {
      requestAnimationFrame(() => {
        try {
          focusable.focus();
        } catch (_err) {
          /* focus is best-effort */
        }
      });
    }
  });
}

/**
 * Replacement for window.confirm — that dialog looks wrong in a standalone PWA
 * and is blocked outright in some contexts.
 *
 * @param {string} message
 * @param {{title?:string, confirmLabel?:string, cancelLabel?:string, destructive?:boolean}} [options]
 * @returns {Promise<boolean>}
 */
export function confirmSheet(message, options = {}) {
  return presentSheet(
    (resolve) => {
      const body = el('div', 'sheet-body');
      if (options.title) body.appendChild(el('h2', 'sheet-title', options.title));
      body.appendChild(el('p', 'sheet-message', String(message == null ? '' : message)));

      const actions = el('div', 'sheet-actions');
      actions.appendChild(
        el(
          'button',
          {
            class: 'btn btn--plain',
            type: 'button',
            on: { click: () => resolve(false) },
          },
          options.cancelLabel || 'Cancel'
        )
      );
      actions.appendChild(
        el(
          'button',
          {
            class: 'btn ' + (options.destructive ? 'btn--danger' : 'btn--primary'),
            type: 'button',
            on: { click: () => resolve(true) },
          },
          options.confirmLabel || 'Confirm'
        )
      );

      return frag(body, actions);
    },
    { dismissValue: false }
  );
}

/**
 * iOS-style action sheet.
 * @param {Array<{label:string, value:*, destructive?:boolean, disabled?:boolean}>} items
 * @param {{title?:string, cancelLabel?:string}} [options]
 * @returns {Promise<*>} the chosen item's `value`, or null when dismissed.
 */
export function actionSheet(items, options = {}) {
  return presentSheet(
    (resolve) => {
      const body = el('div', 'sheet-body sheet-body--menu');
      if (options.title) body.appendChild(el('h2', 'sheet-title', options.title));

      const list = el('div', 'sheet-menu');
      for (const item of items || []) {
        if (!item) continue;
        list.appendChild(
          el(
            'button',
            {
              class: 'sheet-menu-item' + (item.destructive ? ' sheet-menu-item--danger' : ''),
              type: 'button',
              disabled: item.disabled ? true : undefined,
              on: { click: () => resolve(item.value) },
            },
            item.label
          )
        );
      }
      body.appendChild(list);

      const actions = el('div', 'sheet-actions sheet-actions--single');
      actions.appendChild(
        el(
          'button',
          { class: 'btn btn--plain', type: 'button', on: { click: () => resolve(null) } },
          options.cancelLabel || 'Cancel'
        )
      );

      return frag(body, actions);
    },
    { dismissValue: null }
  );
}

/* ------------------------------------------------------------------ */
/* Small composite controls                                            */
/* ------------------------------------------------------------------ */

/**
 * iOS-style toggle. Returns { row, input }.
 * @param {{label:string, help?:string, checked?:boolean, onChange?:(checked:boolean)=>void, id?:string}} options
 */
export function switchRow(options = {}) {
  const id = options.id || 'sw-' + Math.random().toString(36).slice(2, 9);
  const input = el('input', {
    type: 'checkbox',
    id,
    class: 'switch-input',
    checked: options.checked ? true : false,
  });
  if (typeof options.onChange === 'function') {
    input.addEventListener('change', () => options.onChange(input.checked));
  }

  const control = el('span', 'switch', input, el('span', 'switch-track', el('span', 'switch-knob')));

  const text = el(
    'span',
    'switch-text',
    el('span', 'switch-label', options.label),
    options.help ? el('span', 'switch-help', options.help) : null
  );

  const row = el('label', { class: 'row-item switch-row', for: id }, text, control);
  return { row, input };
}

/**
 * Segmented control.
 * @param {{options: Array<{label:string, value:string}>, value?:string,
 *          onChange?:(value:string)=>void, ariaLabel?:string}} config
 * @returns {{node:HTMLElement, setValue:(value:string)=>void, getValue:()=>string}}
 */
export function segmented(config = {}) {
  const items = config.options || [];
  let current = config.value != null ? config.value : (items[0] && items[0].value);

  const node = el('div', { class: 'seg', role: 'tablist', 'aria-label': config.ariaLabel || 'Filter' });
  const buttons = new Map();

  const setValue = (value, notify) => {
    current = value;
    buttons.forEach((button, key) => {
      const isSelected = key === value;
      button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      button.tabIndex = isSelected ? 0 : -1;
    });
    if (notify && typeof config.onChange === 'function') config.onChange(value);
  };

  for (const item of items) {
    const button = el(
      'button',
      {
        class: 'seg-btn',
        type: 'button',
        role: 'tab',
        'aria-selected': 'false',
        on: {
          click: () => {
            if (current === item.value) return;
            setValue(item.value, true);
          },
        },
      },
      item.label
    );
    buttons.set(item.value, button);
    node.appendChild(button);
  }

  setValue(current, false);
  return { node, setValue: (value) => setValue(value, false), getValue: () => current };
}

/**
 * Textarea that grows with its content, up to a cap.
 * @param {HTMLTextAreaElement} textarea
 * @param {number} [maxHeight]
 */
export function autoGrow(textarea, maxHeight = 180) {
  const resize = () => {
    textarea.style.height = 'auto';
    const next = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = next + 'px';
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };
  textarea.addEventListener('input', resize);
  requestAnimationFrame(resize);
  return resize;
}

/** A header button that is icon-only but still announces itself to VoiceOver. */
export function iconButton(iconName, label, onClick, extraClass) {
  return el(
    'button',
    {
      class: 'icon-btn' + (extraClass ? ' ' + extraClass : ''),
      type: 'button',
      'aria-label': label,
      title: label,
      on: { click: onClick },
    },
    icon(iconName)
  );
}

/** External link that can never become a tabnabbing vector. */
export function externalLink(href, label, extraClass) {
  return el(
    'a',
    {
      class: extraClass || 'link',
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
    },
    label
  );
}

/** Open a URL in a new tab safely (used by toolbar buttons). */
export function openExternal(url) {
  if (!url) return;
  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) opened.opener = null;
  } catch (_err) {
    toast('Could not open that link.');
  }
}
