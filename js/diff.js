// diff.js — render a unified diff (git patch) as touch-friendly DOM.
//
// The patch text is API-derived and therefore untrusted: every character goes
// in as a text node via el(). Nothing here ever touches innerHTML.

import { el } from './ui.js';

// Lines that describe the patch rather than the code.
const META_PREFIXES = [
  'diff --git ',
  'index ',
  'new file mode',
  'deleted file mode',
  'old mode ',
  'new mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
  '--- ',
  '+++ ',
  'GIT binary patch',
];

// Past this many rows a file is collapsed by default — a 5000-line patch must
// not lock up an iPad on first paint.
const COLLAPSE_THRESHOLD = 400;

function isMeta(line) {
  if (line === '---' || line === '+++') return true;
  for (const prefix of META_PREFIXES) {
    if (line.indexOf(prefix) === 0) return true;
  }
  return false;
}

function stripPrefix(path) {
  if (typeof path !== 'string') return '';
  let out = path.trim();
  // Git writes `a/src/x.js` and `b/src/x.js`.
  if (out.indexOf('a/') === 0 || out.indexOf('b/') === 0) out = out.slice(2);
  // A trailing tab introduces a timestamp in some diff dialects.
  const tab = out.indexOf('\t');
  if (tab >= 0) out = out.slice(0, tab);
  return out;
}

function splitIntoFiles(text) {
  const lines = text.split(/\r?\n/);
  const files = [];
  let current = null;

  for (const line of lines) {
    if (line.indexOf('diff --git ') === 0) {
      current = { header: line, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      // A bare patch with no `diff --git` header (a single-file diff).
      current = { header: '', lines: [] };
      files.push(current);
    }
    current.lines.push(line);
  }

  // Drop a leading empty pseudo-file created by a leading blank line.
  return files.filter((file) => file.header || file.lines.some((line) => line.trim() !== ''));
}

function describeFile(file) {
  let newPath = '';
  let oldPath = '';
  let binary = false;

  for (const line of file.lines) {
    if (line.indexOf('+++ ') === 0) newPath = stripPrefix(line.slice(4));
    else if (line.indexOf('--- ') === 0) oldPath = stripPrefix(line.slice(4));
    else if (line.indexOf('Binary files ') === 0 || line.indexOf('GIT binary patch') === 0) binary = true;
  }

  let path = '';
  if (newPath && newPath !== '/dev/null') path = newPath;
  else if (oldPath && oldPath !== '/dev/null') path = oldPath;

  if (!path && file.header) {
    // `diff --git a/one b/two` — take the destination side.
    const match = /^diff --git\s+(.+?)\s+(\S+)$/.exec(file.header);
    if (match) path = stripPrefix(match[2]);
  }

  let added = 0;
  let removed = 0;
  for (const line of file.lines) {
    if (line.indexOf('+++') === 0 || line.indexOf('---') === 0) continue;
    if (line.charAt(0) === '+') added += 1;
    else if (line.charAt(0) === '-') removed += 1;
  }

  const isNew = oldPath === '/dev/null';
  const isDeleted = newPath === '/dev/null';

  return {
    path: path || 'unknown file',
    added,
    removed,
    binary,
    isNew,
    isDeleted,
  };
}

function hunkStart(line) {
  // @@ -12,7 +12,9 @@ optional context
  const match = /^@@+\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
  if (!match) return null;
  return { oldNo: parseInt(match[1], 10), newNo: parseInt(match[3], 10) };
}

function codeRow(kind, oldNo, newNo, text) {
  return el(
    'div',
    'dl dl--' + kind,
    el('span', 'dl-num', oldNo === null || oldNo === undefined ? '' : String(oldNo)),
    el('span', 'dl-num', newNo === null || newNo === undefined ? '' : String(newNo)),
    el('span', 'dl-code', text)
  );
}

function renderBody(file) {
  const body = el('div', 'diff-body');
  let oldNo = null;
  let newNo = null;
  let rows = 0;

  for (const line of file.lines) {
    const hunk = hunkStart(line);
    if (hunk) {
      oldNo = hunk.oldNo;
      newNo = hunk.newNo;
      body.appendChild(el('div', 'dl dl--hunk', el('span', 'dl-code', line)));
      rows += 1;
      continue;
    }

    if (isMeta(line)) continue;

    if (line.indexOf('Binary files ') === 0) {
      body.appendChild(el('div', 'dl dl--note', el('span', 'dl-code', line)));
      rows += 1;
      continue;
    }

    if (line.charAt(0) === '\\') {
      // "\ No newline at end of file"
      body.appendChild(el('div', 'dl dl--note', el('span', 'dl-code', line)));
      rows += 1;
      continue;
    }

    const first = line.charAt(0);
    if (first === '+') {
      body.appendChild(codeRow('add', null, newNo, line.slice(1)));
      if (newNo !== null) newNo += 1;
      rows += 1;
    } else if (first === '-') {
      body.appendChild(codeRow('del', oldNo, null, line.slice(1)));
      if (oldNo !== null) oldNo += 1;
      rows += 1;
    } else if (oldNo !== null || newNo !== null) {
      // Context line (leading space, or an empty final line).
      const text = first === ' ' ? line.slice(1) : line;
      if (line === '' && rows === 0) continue;
      body.appendChild(codeRow('ctx', oldNo, newNo, text));
      if (oldNo !== null) oldNo += 1;
      if (newNo !== null) newNo += 1;
      rows += 1;
    }
  }

  return { body, rows };
}

function renderFile(file) {
  const info = describeFile(file);
  const rendered = renderBody(file);
  const collapsed = rendered.rows > COLLAPSE_THRESHOLD;

  const summary = el('summary', 'diff-summary');
  summary.appendChild(el('span', 'diff-path', info.path));

  const tags = el('span', 'diff-tags');
  if (info.isNew) tags.appendChild(el('span', 'diff-tag diff-tag--new', 'new'));
  if (info.isDeleted) tags.appendChild(el('span', 'diff-tag diff-tag--del', 'deleted'));
  if (info.binary) tags.appendChild(el('span', 'diff-tag', 'binary'));
  if (info.added) tags.appendChild(el('span', 'diff-count diff-count--add', '+' + info.added));
  if (info.removed) tags.appendChild(el('span', 'diff-count diff-count--del', '−' + info.removed));
  if (collapsed) tags.appendChild(el('span', 'diff-tag', 'large'));
  summary.appendChild(tags);

  const details = el('details', { class: 'diff-file', open: collapsed ? undefined : true });
  details.appendChild(summary);
  details.appendChild(rendered.body);
  return details;
}

/**
 * @param {string} patchText a unified diff / git patch
 * @returns {HTMLElement}
 */
export function renderUnidiff(patchText) {
  const text = typeof patchText === 'string' ? patchText : '';
  const root = el('div', 'diff');

  if (!text.trim()) {
    root.appendChild(el('div', 'diff-note', 'This change set did not include a patch.'));
    return root;
  }

  let files;
  try {
    files = splitIntoFiles(text);
  } catch (_err) {
    files = [];
  }

  if (!files.length) {
    root.appendChild(el('div', 'diff-note', 'Could not read this patch.'));
    return root;
  }

  for (const file of files) {
    root.appendChild(renderFile(file));
  }
  return root;
}

export default renderUnidiff;
