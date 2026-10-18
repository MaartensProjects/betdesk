// The board: what needs you, the team's pipeline, and the graveyard.
import { e, page, header, warn, flash, postButton, csrfField } from './html.mjs';
import { attention, itemsFor, setupWarnings } from '../lib/attention.mjs';
import { cardState } from '../lib/cards.mjs';
import { shortDate } from '../lib/time.mjs';

const ORDER = [
  ['in validation', 'In validation'],
  ['ready for dev', 'Ready for dev'],
  ['in dev', 'In dev'],
  ['inbox', 'Inbox'],
  ['parked', 'Parked'],
  ['done', 'Done'],
];

// The forms behind each kind of button. Kill and Park open a form in place: the reason is required.
export function actionButton(kind, card, token) {
  const base = `/cards/${card.number}`;
  const closeForm = (action, label, field, hint) =>
    `<details class="kill"><summary class="btn ghost small">${label}</summary><form method="post" action="${base}/close" class="stack">${csrfField(token)}<input type="hidden" name="action" value="${action}"><label>${hint}</label><textarea name="reason" rows="2" maxlength="800" required></textarea>${action === 'kill' ? '<label>Revive only if <span class="opt">optional</span></label><input name="revive" maxlength="400">' : ''}<button class="btn small ${action === 'kill' ? 'danger' : ''}" type="submit">${label} it</button></form></details>`;
  switch (kind) {
    case 'record':
      return `<a class="btn small" href="${base}#result">Record result</a>`;
    case 'refine':
      return postButton(`${base}/refine`, 'Work on it with Claude', token, {}, 'btn ghost small');
    case 'retest':
      return postButton(`${base}/retest`, 'Retest as a new card', token, {}, 'btn ghost small');
    case 'kill':
      return closeForm('kill', 'Kill', 'reason', 'Why kill it? <span class="opt">required; later interviews read it</span>');
    case 'park':
      return closeForm('park', 'Park', 'reason', 'What brings it back? <span class="opt">required: a named trigger</span>');
    case 'handoff':
      return postButton(`${base}/handoff`, 'Hand off', token, {}, 'btn small');
    case 'handoff-jira':
      return postButton(`${base}/handoff`, 'Send to Jira instead', token, { force: 'jira' }, 'btn ghost small');
    case 'check':
      return postButton(`${base}/check`, 'Check now', token, {}, 'btn ghost small');
    case 'settings':
      return `<a class="btn small" href="/settings">Settings</a>`;
    case 'open':
      return `<a class="btn ghost small" href="${base}">Open the card</a>`;
    default:
      return '';
  }
}

export const cardLine = (c, { today, user, handoff, extra = '' }) => {
  const h = handoff && c.status === 'in dev' ? ` · <a href="${e(handoff.pr_url || handoff.url)}" rel="noreferrer">${e(handoff.route === 'agent' ? `${handoff.target}${handoff.external_key}` : handoff.external_key)}</a> ${e(handoff.state)}` : '';
  return `<li class="${c.owner_id === user.id ? 'mine' : ''}"><a class="row" href="/cards/${c.number}"><span class="title"><span class="ref">BD-${c.number}</span>${e(c.title)}</span></a><span class="meta">${e(c.owner_name || c.owner_email)} · ${e(cardState(c, today))}${c.system ? ` · ${e(c.system)}` : ''}${h}</span>${extra}</li>`;
};

export function renderBoard(ctx) {
  const { cfg, user, token, today, cards, handoffs, settings } = ctx;
  let body = header('Board', `${e(cfg.appName)} · ${shortDate(today)} · signed in as ${e(user.name || user.email)}`, `<a class="btn" href="/new">New idea</a>`);
  body += `<main>${flash(ctx.msg)}`;
  if (user.role === 'admin') for (const w of setupWarnings({ cfg, settings })) body += warn(e(w.text), '<a class="btn" href="/settings">Settings</a>');

  // Needs you
  const mine = [];
  for (const c of cards) {
    const items = itemsFor(attention(c, { today, handoff: handoffs.get(c.id), settings, cfg }), c, user);
    if (items.length) mine.push({ c, items });
  }
  body += '<section><h2>Needs you</h2>';
  if (!mine.length) body += `<p class="sub">Nothing waits for you. ${cards.some((c) => c.owner_id === user.id) ? '' : 'Start with an idea: Claude interviews you and writes the card.'}</p>`;
  else {
    body += '<ul class="cards">';
    for (const { c, items } of mine) {
      const extra = items.map((i) => `<p>${e(i.text)}</p><div class="actions row-actions">${i.buttons.map((b) => actionButton(b, c, token)).join('')}</div>`).join('');
      body += cardLine(c, { today, user, handoff: handoffs.get(c.id), extra }).replace('<li class="', '<li class="attention ');
    }
    body += '</ul>';
  }
  body += '</section>';

  // Team pipeline
  for (const [status, label] of ORDER) {
    let list = cards.filter((c) => c.status === status);
    if (!list.length) continue;
    if (status === 'done') list = list.slice(0, 10);
    body += `<section class="board-col"><h2>${label} (${list.length})</h2><ul class="cards">${list.map((c) => cardLine(c, { today, user, handoff: handoffs.get(c.id) })).join('')}</ul></section>`;
  }

  const killed = cards.filter((c) => c.status === 'killed');
  body += `<section><details><summary>Graveyard (${killed.length})</summary><ul class="cards">${killed
    .map((c) => cardLine(c, { today, user, extra: `<p class="meta">${e(c.body.verdict?.reason || '')}${c.body.verdict?.revive ? ` · revive: ${e(c.body.verdict.revive)}` : ''}</p>` }))
    .join('')}</ul></details></section>`;
  body += `</main><footer><p>Conversations are private to each person. Cards are visible to everyone signed in. Handoffs: ${settings.handoffMode === 'approval' ? 'an admin approves each one' : 'automatic when every rung before the build has passed'}.</p></footer>`;
  return page(`Board · ${cfg.appName}`, body, { nav: 'board', user, token, appName: cfg.appName, refresh: 300 });
}
