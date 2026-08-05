// activity.js — turn one Activity from the API into DOM.
//
// An Activity carries exactly one of these union fields:
//   agentMessaged {agentMessage} | userMessaged {userMessage}
//   planGenerated {plan:{id, steps:[{id,title,description,index}]}}
//   planApproved {planId} | progressUpdated {title, description}
//   sessionCompleted {} | sessionFailed {reason}
// ...plus an optional `artifacts` array (changeSet | media | bashOutput).
//
// Anything we don't recognise falls back to a plain row built from
// `description`, so a future API addition degrades instead of disappearing.

import { el, icon, formatTime, timeAgo } from './ui.js';
import { renderUnidiff } from './diff.js';

const IMAGE_MIME = /^image\/[a-z0-9][a-z0-9.+-]*$/i;
const BASE64_ONLY = /^[A-Za-z0-9+/=\s]*$/;

function timeStamp(activity) {
  if (!activity || !activity.createTime) return null;
  return el(
    'time',
    { class: 'act-time', datetime: activity.createTime, title: formatTime(activity.createTime) },
    timeAgo(activity.createTime)
  );
}

/* ------------------------------------------------------------------ */
/* Union field renderers                                               */
/* ------------------------------------------------------------------ */

function userBubble(activity) {
  const text = String(activity.userMessaged.userMessage || '');
  return el(
    'div',
    'act-line act-line--right',
    el('div', 'bubble-stack', el('div', 'bubble bubble--user', text || '(empty message)'), timeStamp(activity))
  );
}

function agentBubble(activity) {
  const text = String(activity.agentMessaged.agentMessage || '');
  return el(
    'div',
    'act-line act-line--left',
    el(
      'div',
      'bubble-stack',
      el('div', 'bubble bubble--agent', text || (activity.description ? String(activity.description) : '…')),
      timeStamp(activity)
    )
  );
}

function planCard(activity, sessionState, onApprove) {
  const plan = activity.planGenerated.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.slice() : [];
  steps.sort((a, b) => {
    const ai = typeof a.index === 'number' ? a.index : 0;
    const bi = typeof b.index === 'number' ? b.index : 0;
    return ai - bi;
  });

  const card = el('div', 'card plan-card');
  card.appendChild(
    el(
      'div',
      'plan-head',
      el('span', 'plan-head-icon', icon('sparkle', { size: 18 })),
      el('h3', 'plan-title', 'Jules made a plan'),
      timeStamp(activity)
    )
  );

  if (steps.length) {
    const list = el('ol', 'plan-steps');
    for (const step of steps) {
      const item = el('li', 'plan-step');
      item.appendChild(el('div', 'plan-step-title', String(step.title || 'Step')));
      if (step.description) {
        item.appendChild(el('div', 'plan-step-desc', String(step.description)));
      }
      list.appendChild(item);
    }
    card.appendChild(list);
  } else if (activity.description) {
    card.appendChild(el('p', 'plan-empty', String(activity.description)));
  } else {
    card.appendChild(el('p', 'plan-empty', 'The plan had no steps.'));
  }

  if (sessionState === 'AWAITING_PLAN_APPROVAL' && typeof onApprove === 'function') {
    const button = el(
      'button',
      { class: 'btn btn--primary plan-approve', type: 'button' },
      'Approve plan and start'
    );
    button.addEventListener('click', () => {
      // Guard against a double-tap firing two approvals.
      if (button.disabled) return;
      button.disabled = true;
      button.classList.add('is-busy');
      const originalText = button.textContent;
      button.textContent = 'Approving…';
      Promise.resolve(onApprove())
        .catch(() => {
          /* The caller surfaces the error; just restore the control. */
        })
        .then(() => {
          if (!button.isConnected) return;
          button.disabled = false;
          button.classList.remove('is-busy');
          button.textContent = originalText;
        });
    });
    card.appendChild(
      el(
        'div',
        'plan-actions',
        button,
        el('p', 'plan-hint', 'Nothing is changed in your repository until you approve.')
      )
    );
  }

  return card;
}

function systemLine(text, activity) {
  return el('div', 'act-system', el('span', 'act-system-text', text), timeStamp(activity));
}

function progressRow(activity) {
  const update = activity.progressUpdated || {};
  const row = el('div', 'progress-row');
  row.appendChild(el('span', 'progress-dot'));

  const body = el('div', 'progress-body');
  body.appendChild(el('div', 'progress-title', String(update.title || activity.description || 'Working…')));
  if (update.description) {
    body.appendChild(el('div', 'progress-desc', String(update.description)));
  }
  row.appendChild(body);
  row.appendChild(timeStamp(activity));
  return row;
}

function terminalBanner(kind, title, detail, activity) {
  const banner = el('div', 'terminal terminal--' + kind);
  banner.appendChild(el('span', 'terminal-icon', icon(kind === 'failed' ? 'alert' : 'check', { size: 20 })));

  const body = el('div', 'terminal-body');
  body.appendChild(el('div', 'terminal-title', title));
  if (detail) body.appendChild(el('div', 'terminal-detail', String(detail)));
  banner.appendChild(body);

  const stamp = timeStamp(activity);
  if (stamp) banner.appendChild(stamp);
  return banner;
}

function genericRow(activity) {
  const text = activity.description ? String(activity.description) : 'Jules recorded an update.';
  const row = el('div', 'act-generic');
  row.appendChild(el('span', 'act-generic-text', text));
  const stamp = timeStamp(activity);
  if (stamp) row.appendChild(stamp);
  return row;
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

function renderBashOutput(bash) {
  const block = el('div', 'card term');

  const head = el('div', 'term-head');
  head.appendChild(el('span', 'term-prompt', '$'));
  head.appendChild(el('span', 'term-command', String(bash.command || '')));
  block.appendChild(head);

  const output = String(bash.output == null ? '' : bash.output);
  if (output) {
    block.appendChild(el('div', 'term-output', output));
  } else {
    block.appendChild(el('div', 'term-output term-output--empty', '(no output)'));
  }

  const exitCode = bash.exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) {
    block.appendChild(el('div', 'term-exit term-exit--bad', 'exited with code ' + exitCode));
  }
  return block;
}

function renderChangeSet(changeSet) {
  const patch = changeSet.gitPatch || {};
  const block = el('div', 'card changeset');

  const head = el('div', 'changeset-head');
  head.appendChild(el('span', 'changeset-icon', icon('branch', { size: 18 })));
  head.appendChild(
    el('span', 'changeset-title', String(patch.suggestedCommitMessage || 'Code changes'))
  );
  block.appendChild(head);

  if (patch.baseCommitId) {
    block.appendChild(
      el('div', 'changeset-meta', 'based on ' + String(patch.baseCommitId).slice(0, 12))
    );
  }

  block.appendChild(renderUnidiff(patch.unidiffPatch));
  return block;
}

function renderMedia(media) {
  const mimeType = String(media.mimeType || '');
  const data = String(media.data || '');

  // Only images are rendered inline, and only when the mime type and payload
  // both look like what they claim to be — a `data:` URL built from arbitrary
  // server input is otherwise a script-execution vector.
  const safeImage = IMAGE_MIME.test(mimeType) && mimeType.toLowerCase() !== 'image/svg+xml' && BASE64_ONLY.test(data) && data.length > 0;

  if (safeImage) {
    return el(
      'div',
      'media',
      el('img', {
        class: 'media-img',
        src: 'data:' + mimeType + ';base64,' + data.replace(/\s+/g, ''),
        alt: 'Screenshot shared by Jules',
        loading: 'lazy',
        decoding: 'async',
      })
    );
  }

  return el(
    'div',
    'card media-note',
    el('span', 'media-note-icon', icon('alert', { size: 18 })),
    el('span', null, mimeType ? 'Jules attached a ' + mimeType + ' file that cannot be shown here.' : 'Jules attached a file that cannot be shown here.')
  );
}

function renderArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || !artifacts.length) return null;

  const wrap = el('div', 'artifacts');
  let rendered = 0;

  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') continue;
    let node = null;
    if (artifact.bashOutput) node = renderBashOutput(artifact.bashOutput);
    else if (artifact.changeSet) node = renderChangeSet(artifact.changeSet);
    else if (artifact.media) node = renderMedia(artifact.media);

    if (node) {
      wrap.appendChild(node);
      rendered += 1;
    }
  }

  return rendered ? wrap : null;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} activity one Activity resource
 * @param {{onApprove?: () => (Promise<void>|void), sessionState?: string}} [options]
 * @returns {HTMLElement}
 */
export function renderActivity(activity, options = {}) {
  const item = activity && typeof activity === 'object' ? activity : {};
  const sessionState = options.sessionState;
  const onApprove = options.onApprove;

  let kind = 'generic';
  let body;

  if (item.userMessaged) {
    kind = 'user';
    body = userBubble(item);
  } else if (item.agentMessaged) {
    kind = 'agent';
    body = agentBubble(item);
  } else if (item.planGenerated) {
    kind = 'plan';
    body = planCard(item, sessionState, onApprove);
  } else if (item.planApproved) {
    kind = 'system';
    body = systemLine('Plan approved — Jules is getting to work', item);
  } else if (item.progressUpdated) {
    kind = 'progress';
    body = progressRow(item);
  } else if (item.sessionCompleted) {
    kind = 'terminal';
    body = terminalBanner('done', 'Jules finished this task', item.description || '', item);
  } else if (item.sessionFailed) {
    kind = 'terminal';
    body = terminalBanner(
      'failed',
      'Jules stopped before finishing',
      item.sessionFailed.reason || item.description || '',
      item
    );
  } else {
    body = genericRow(item);
  }

  const wrap = el('div', 'act act--' + kind);
  if (item.name) wrap.dataset.name = String(item.name);
  if (item.originator) wrap.dataset.originator = String(item.originator);
  if (kind === 'plan') wrap.dataset.plan = '1';
  if (item.__optimistic) wrap.classList.add('act--pending');

  wrap.appendChild(body);

  const artifacts = renderArtifacts(item.artifacts);
  if (artifacts) wrap.appendChild(artifacts);

  return wrap;
}

export default renderActivity;
