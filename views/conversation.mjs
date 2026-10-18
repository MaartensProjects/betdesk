// A private conversation: the messages, Claude's open question as tappable options, and the composer.
import { e, page, header, warn, flash, csrfField } from './html.mjs';
import { renderMarkdown } from '../public/md.mjs';
import { toolNote, canResume, WRITES } from '../lib/interview.mjs';
import { relative } from '../lib/time.mjs';

// Turns stored API content into what the person sees: their messages and answers, Claude's text, one line per tool.
// pendingId: the open question's tool call, shown as a form below instead of as a message.
export function displayItems(messages, pendingId = null) {
  const items = [];
  const asks = new Map(); // tool_use_id -> questions
  const results = new Map(); // tool_use_id -> tool_result, to word finished steps as done
  for (const m of messages) if (m.role === 'user') for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
  const declined = (r) => typeof r?.content === 'string' && r.content.startsWith('The person did not confirm');
  const done = (b) => {
    const r = results.get(b.id);
    const text = typeof r?.content === 'string' ? r.content : '';
    if (WRITES.has(b.name) && declined(r)) return `${toolNote(b.name, b.input)}; you chose Not yet`;
    if (b.name === 'save_bet_card' && r) return r.is_error ? 'The card needs fixes before it saves' : (text.match(/^Saved BD-\d+ \([^)]*\)/) || ['Saved the card'])[0];
    if (b.name === 'record_test_result' && r && !r.is_error) return `Recorded rung ${b.input?.rung} of BD-${b.input?.card_number}: ${b.input?.verdict}`;
    if (b.name === 'close_card' && r && !r.is_error) return text;
    return toolNote(b.name, b.input);
  };
  for (const m of messages) {
    for (const b of m.content) {
      if (m.role === 'assistant') {
        if (b.type === 'text' && b.text.trim()) items.push({ kind: 'claude', text: b.text });
        else if (b.type === 'tool_use' && b.name === 'ask_user') {
          asks.set(b.id, b.input?.questions || []);
          if (b.id === pendingId) continue;
          items.push({ kind: 'claude', text: (b.input?.questions || []).map((q) => `**${q.question}**\n${(q.options || []).map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n')}`).join('\n\n') });
        } else if (b.type === 'tool_use') items.push({ kind: 'tool', text: done(b) });
        else if (b.type === 'server_tool_use') items.push({ kind: 'tool', text: toolNote(b.name, b.input) });
        else if (b.type === 'fallback') items.push({ kind: 'note', text: 'Answered by a fallback model.' });
      } else {
        if (b.type === 'tool_result' && asks.has(b.tool_use_id)) items.push({ kind: 'you', text: typeof b.content === 'string' ? b.content : '' });
        else if (b.type === 'text' && !b.text.startsWith('<context>')) items.push({ kind: 'you', text: b.text });
      }
    }
  }
  // Consecutive tool lines become one list.
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === 'tool' && last?.kind === 'tools') last.list.push(it.text);
    else if (it.kind === 'tool') out.push({ kind: 'tools', list: [it.text] });
    else out.push(it);
  }
  return out;
}

function itemsHtml(items) {
  return items
    .map((it) => {
      if (it.kind === 'you') return `<div class="msg you">${renderMarkdown(it.text)}</div>`;
      if (it.kind === 'claude') return `<div class="msg claude">${renderMarkdown(it.text)}</div>`;
      if (it.kind === 'note') return `<div class="msg note">${e(it.text)}</div>`;
      const list = it.list.map((x) => `<li>${e(x)}</li>`).join('');
      return it.list.length > 3 ? `<details class="tools"><summary>${it.list.length} steps · ${e(it.list[it.list.length - 1])}</summary><ul>${list}</ul></details>` : `<ul class="tools">${list}</ul>`;
    })
    .join('\n');
}

// A change Claude proposed: exactly what would be written, written only when the person presses Confirm.
function confirmForm(conv, token) {
  const p = conv.pending;
  return `<section class="pending"><h2>Confirm the change</h2><p><b>${e(p.title)}</b></p><p class="confirm-summary">${e(p.summary)}</p>${p.detail ? `<details><summary>The whole card, as everyone signed in will see it</summary><pre class="doc">${e(p.detail)}</pre></details>` : ''}
<form method="post" action="/c/${conv.id}/send" class="stack composer-answer" data-stream>${csrfField(token)}<input type="hidden" name="pending" value="${e(p.tool_use_id)}"><label for="extra">Anything to add <span class="opt">optional</span></label><textarea id="extra" name="text" rows="2" maxlength="8000"></textarea>
<div class="actions"><button class="btn big" type="submit" name="decision" value="confirm">Confirm</button><button class="btn ghost big" type="submit" name="decision" value="decline">Not yet</button></div></form></section>`;
}

// Claude's open question: each option is tappable, and every question has a box for an answer of your own.
function questionForm(conv, token) {
  const qs = conv.pending.questions
    .map((q, i) => {
      const type = q.multi_select ? 'checkbox' : 'radio';
      const options = q.options
        .map((o) => `<label class="choice option"><input type="${type}" name="q${i}" value="${e(o.label)}"><span><b>${e(o.label)}</b>${o.description ? `<span class="opt">${e(o.description)}</span>` : ''}${o.preview ? `<span class="preview">${e(o.preview)}</span>` : ''}</span></label>`)
        .join('');
      return `<fieldset><legend>${e(q.header || `Question ${i + 1}`)}</legend><p>${e(q.question)}</p>${options}<label class="other">Or your own answer <span class="opt">optional</span><input name="q${i}_other" maxlength="2000"></label></fieldset>`;
    })
    .join('');
  return `<section class="pending"><h2>Claude asks</h2><form method="post" action="/c/${conv.id}/send" class="stack composer-answer" data-stream>${csrfField(token)}<input type="hidden" name="pending" value="${e(conv.pending.tool_use_id)}">${qs}<label for="extra">Anything to add <span class="opt">optional</span></label><textarea id="extra" name="text" rows="2" maxlength="8000"></textarea><button class="btn big" type="submit">Send answer</button></form></section>`;
}

export function renderConversation(ctx) {
  const { cfg, user, token, conv, messages, card, nowMs } = ctx;
  const running = conv.status === 'running' && conv.running_since && nowMs - new Date(conv.running_since).getTime() < cfg.staleSeconds * 1000;
  const cutOff = conv.status === 'running' && !running;
  const title = conv.title || (card ? `BD-${card.number}: ${card.title}` : 'New idea');
  const meta = `${card ? `<a href="/cards/${card.number}">BD-${card.number}</a> · ` : ''}started ${relative(new Date(conv.created_at).getTime(), nowMs, cfg.timeZone)}`;
  let body = header(title, meta);
  body += `<main class="chat" data-conv="${e(conv.id)}"${running ? ' data-running="1"' : ''}${ctx.autostart ? ' data-autostart="1"' : ''}>${flash(ctx.msg)}`;
  body += '<p class="privacy">Only you can see this conversation. The card it writes is visible to everyone signed in.</p>';
  body += itemsHtml(displayItems(messages, conv.status === 'waiting' ? conv.pending?.tool_use_id : null));
  body += '<div id="live"></div>';
  if (ctx.error) body += warn(e(ctx.error));
  if (running) body += '<p class="state-line" id="status">Claude is working. This page updates when the turn ends.</p>';
  else if (conv.status === 'waiting' && conv.pending) body += conv.pending.type === 'confirm' ? confirmForm(conv, token) : questionForm(conv, token);
  else {
    if (cutOff || (!ctx.blocked && canResume(messages, conv.pending) && messages.length)) {
      body += warn(cutOff ? 'The last turn was cut off before Claude finished.' : 'Claude stopped before it finished this turn.', `<form method="post" action="/c/${conv.id}/send" class="inline" data-stream>${csrfField(token)}<input type="hidden" name="resume" value="1"><button class="btn" type="submit">Continue</button></form>`);
    }
    if (ctx.blocked) body += warn(e(ctx.blocked), user.role === 'admin' ? '<a class="btn" href="/settings">Settings</a>' : '');
    else
      body += `<form method="post" action="/c/${conv.id}/send" class="stack composer" data-stream>${csrfField(token)}<label class="sr" for="text">Message</label><textarea id="text" name="text" rows="3" maxlength="8000" placeholder="${messages.length ? 'Reply to Claude' : 'Your idea, in a sentence or two'}" required>${e(ctx.prefill || '')}</textarea><button class="btn big" type="submit">Send</button></form>`;
  }
  body += '</main>';
  return page(title, body, { nav: 'ideas', user, token, appName: cfg.appName });
}

export function renderConversationList(ctx) {
  const { cfg, user, token, list, nowMs } = ctx;
  let body = header('My ideas', 'Your private conversations with Claude', '<a class="btn" href="/new">New</a>');
  body += `<main>${flash(ctx.msg)}`;
  if (!list.length) body += '<p class="sub">No conversations yet. Tap New and tell Claude your idea in a sentence.</p>';
  else
    body += `<ul class="sessions">${list
      .map((c) => `<li><a class="row" href="/c/${c.id}"><span class="title">${e(c.title || (c.card_number ? `BD-${c.card_number}: ${c.card_title}` : 'New idea'))}</span><span class="meta">${c.status === 'waiting' ? '<span class="state waiting">Waiting for you</span> ' : c.status === 'running' ? '<span class="state running">Claude is working</span> ' : ''}${e(c.kind)} · ${relative(new Date(c.updated_at).getTime(), nowMs, cfg.timeZone)}</span></a></li>`)
      .join('')}</ul>`;
  body += '</main>';
  return page('My ideas', body, { nav: 'ideas', user, token, appName: cfg.appName });
}

export function renderNew(ctx) {
  const { cfg, user, token } = ctx;
  let body = header('New idea', 'Claude interviews you and writes a bet card');
  body += `<main>${flash(ctx.msg)}`;
  if (ctx.blocked) body += warn(e(ctx.blocked), user.role === 'admin' ? '<a class="btn" href="/settings">Settings</a>' : '');
  body += `<p>Tell Claude your idea for the webshop or one of its systems, in a sentence or two. It checks the existing cards first, then asks one question at a time and sharpens each answer with you. You end with a card whose first test and pass bar are written down.</p>
<p class="privacy">Only you can see the conversation. The card is visible to everyone signed in.</p>
<form method="post" action="/new" class="stack" data-once>${csrfField(token)}<label for="idea">Your idea</label><textarea id="idea" name="idea" rows="4" maxlength="4000" placeholder="For example: customers abandon checkout when shipping costs appear late"></textarea><button class="btn big" type="submit"${ctx.blocked ? ' disabled' : ''}>Start</button></form></main>`;
  return page('New idea', body, { nav: 'new', user, token, appName: cfg.appName });
}
