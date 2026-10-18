// One card: its ladder, its sections, the result form for the next rung, the handoff, and the evidence log.
import { e, page, header, warn, flash, csrfField, postButton } from './html.mjs';
import { actionButton } from './board.mjs';
import { attention, itemsFor } from '../lib/attention.mjs';
import { nextRung, failedRung, RISKS, cardState } from '../lib/cards.mjs';
import { shortDate } from '../lib/time.mjs';
import { systemOf } from '../lib/handoff.mjs';

const or = (v) => (v && String(v).trim() ? e(v) : '<span class="opt">–</span>');

// The ladder as stacked blocks, one per rung: readable on a phone, where a five-column table is not.
function ladderTable(card) {
  const next = nextRung(card.ladder);
  return `<ol class="ladder">${card.ladder
    .map((r) => {
      const cls = [next && r.rung === next.rung ? 'next' : '', r.verdict ? `v-${r.verdict}` : ''].filter(Boolean).join(' ');
      const verdict = r.verdict ? `<span class="verdict">${e(r.verdict)}</span>` : next && r.rung === next.rung ? '<span class="verdict">next</span>' : r.build ? '<span class="verdict">build</span>' : '';
      const bar = r.pass_bar ? `<p><span class="label">Pass bar</span> ${e(r.pass_bar)}<span class="opt">${r.judge ? ` · judged by ${e(r.judge)}` : ''}${r.pass_bar_at ? ` · written ${e(r.pass_bar_at.slice(0, 10))}` : ''}</span></p>` : r.build ? '' : '<p><span class="label">Pass bar</span> <span class="opt">written before this rung runs</span></p>';
      const result = r.result ? `<p><span class="label">Result</span> ${e(r.result)}${r.source ? `<span class="opt"> · ${e(r.source)}</span>` : ''}</p>` : '';
      const box = [r.time_box, r.budget].filter(Boolean).join(' · ');
      return `<li class="${cls}"><div class="rung-head"><b>${r.rung}. ${e(r.name)}</b>${verdict}</div><p>${e(r.test)}${box ? `<span class="opt"> · ${e(box)}</span>` : ''}</p>${bar}${result}</li>`;
    })
    .join('')}</ol>`;
}

function resultForm(card, token, user) {
  const next = nextRung(card.ladder);
  if (!next || failedRung(card.ladder) || card.status !== 'in validation') return '';
  return `<section id="result"><h2>Record the result of rung ${next.rung}</h2>
<p class="sub">Pass bar, written before the test: <b>${next.pass_bar ? e(next.pass_bar) : 'not written yet'}</b>${next.judge ? `, judged by ${e(next.judge)}` : ''}.</p>
${next.pass_bar ? '' : warn(card.owner_id === user.id ? 'A result cannot be judged without a pass bar. Write it first.' : `A result cannot be judged without a pass bar; ${e(card.owner_name || 'the owner')} writes it with Claude.`, card.owner_id === user.id ? actionButton('refine', card, token) : actionButton('open', card, token))}
<form method="post" action="/cards/${card.number}/result" class="stack">${csrfField(token)}<input type="hidden" name="rung" value="${next.rung}">
<label for="r-result">What the test showed, with the numbers</label><textarea id="r-result" name="result" rows="3" maxlength="2000" required></textarea>
<label for="r-source">Where the evidence is <span class="opt">a link, a dashboard, notes</span></label><input id="r-source" name="source" maxlength="500">
<fieldset><legend>Verdict against the pass bar</legend>
<label class="choice"><input type="radio" name="verdict" value="pass" required> Pass</label>
<label class="choice"><input type="radio" name="verdict" value="fail"> Fail <span class="opt">ends the card: kill or park it next</span></label>
<label class="choice"><input type="radio" name="verdict" value="skipped"> Skipped <span class="opt">the result box holds the reason</span></label>
</fieldset>
<label for="r-next">Date of the next rung's test <span class="opt">optional</span></label><input id="r-next" type="date" name="next_test_date">
<button class="btn big" type="submit">Record</button></form>
<p class="fine">Or tell Claude the result in your conversation: it checks it against the pass bar with you before it records it.</p></section>`;
}

function handoffPanel(card, handoff, token, user) {
  if (!handoff) return '';
  const link = handoff.url ? `<a href="${e(handoff.url)}" rel="noreferrer">${e(handoff.route === 'agent' ? `${handoff.target}${handoff.external_key}` : handoff.external_key)}</a>` : '';
  const pr = handoff.pr_url ? ` · pull request <a href="${e(handoff.pr_url)}" rel="noreferrer">${e(handoff.pr_url.split('/').slice(-1)[0])}</a>` : '';
  return `<section><h2>Dev work</h2><p>${handoff.route === 'agent' ? 'Coding agent' : 'Jira'}: ${link} <b>${e(handoff.state)}</b>${handoff.detail ? ` · ${e(handoff.detail)}` : ''}${pr}</p>${handoff.checked_at ? `<p class="fine">Checked ${e(new Date(handoff.checked_at).toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>` : ''}${card.status === 'in dev' ? `<div class="actions">${postButton(`/cards/${card.number}/check`, 'Check now', token, {}, 'btn ghost small')}</div>` : ''}</section>`;
}

export function renderCard(ctx) {
  const { cfg, user, token, today, card, events, handoff, settings } = ctx;
  const b = card.body;
  const mine = card.owner_id === user.id || user.role === 'admin';
  const system = systemOf(settings, card);
  let body = header(`BD-${card.number}: ${card.title}`, `${e(card.owner_name || card.owner_email)} · ${e(cardState(card, today))}`);
  body += `<main>${flash(ctx.msg)}`;
  for (const i of itemsFor(attention(card, { today, handoff, settings, cfg }), card, user)) body += warn(e(i.text), i.buttons.map((k) => actionButton(k, card, token)).join(''));
  const actions = [];
  if (card.owner_id === user.id && ['inbox', 'in validation', 'parked', 'ready for dev'].includes(card.status) && !failedRung(card.ladder)) actions.push(actionButton('refine', card, token));
  if (mine && card.status === 'parked') actions.push(postButton(`/cards/${card.number}/unpark`, 'Back to the inbox', token, {}, 'btn ghost small'));
  actions.push(actionButton('retest', card, token));
  if (mine && ['inbox', 'in validation', 'ready for dev'].includes(card.status)) actions.push(actionButton('park', card, token));
  if (mine && ['inbox', 'in validation', 'ready for dev', 'parked'].includes(card.status)) actions.push(actionButton('kill', card, token));
  body += `<div class="actions">${actions.join('')}</div>`;

  body += `<section><dl class="facts">
<dt>Status</dt><dd>${e(card.status)}</dd>
<dt>System</dt><dd>${system ? e(system.name) : or(card.system)}</dd>
<dt>Route</dt><dd>${card.route === 'agent' ? 'coding agent' : card.route === 'jira' ? 'Jira' : '–'}${b.delivery?.reason ? ` · ${e(b.delivery.reason)}` : ''}</dd>
<dt>Next test</dt><dd>${card.next_test_date ? shortDate(card.next_test_date) : '–'}</dd>
<dt>Kill date</dt><dd>${card.kill_date ? shortDate(card.kill_date) : '–'}</dd>
</dl></section>`;
  if (b.verdict) body += `<section><h2>Verdict</h2><p><b>${e(b.verdict.status)}</b>: ${e(b.verdict.reason)}${b.verdict.revive ? ` · revive: ${e(b.verdict.revive)}` : ''}</p><p class="fine">${e(b.verdict.by)}, ${e(b.verdict.at.slice(0, 10))}</p></section>`;
  body += handoffPanel(card, handoff, token, user);
  body += `<section><h2>Who has the problem</h2><p>${or(b.problem?.who)}</p><p>${or(b.problem?.problem)}</p>${b.problem?.why_now ? `<p><span class="label">Why now</span> ${e(b.problem.why_now)}</p>` : ''}</section>`;
  body += `<section><h2>Outcome that proves it</h2><p><b>${or(b.outcome?.metric)}</b>: ${or(b.outcome?.target)} by ${b.outcome?.by_date ? shortDate(b.outcome.by_date) : 'no date'}</p><p class="sub">Measured by ${or(b.outcome?.measured_by)}</p></section>`;
  body += `<section><h2>Value and cost</h2><p><span class="label">Value</span> ${or(b.value?.estimate)}</p><p><span class="label">Cost</span> ${or(b.value?.cost)}</p></section>`;
  body += `<section><h2>Riskiest assumption</h2><p><b>${e(b.riskiest_assumption?.kind || '')}</b> <span class="opt">${e(RISKS[b.riskiest_assumption?.kind] || '')}</span></p><p>${or(b.riskiest_assumption?.statement)}</p></section>`;
  body += `<section><h2>Test ladder</h2><p class="fine">Each pass bar is written before its test. A rung with a result is locked; a changed pass bar is logged with its reason.</p>${ladderTable(card)}</section>`;
  if (mine) body += resultForm(card, token, user);
  body += `<section><h2>Acceptance criteria</h2>${b.delivery?.acceptance_criteria?.length ? `<ul>${b.delivery.acceptance_criteria.map((a) => `<li>${e(a)}</li>`).join('')}</ul>` : '<p class="sub">None yet; the handoff needs them.</p>'}</section>`;
  body += `<section><h2>Limits and flags</h2><dl class="facts"><dt>Time</dt><dd>${or(b.limits?.time)}</dd><dt>Budget</dt><dd>${or(b.limits?.budget)}</dd><dt>Kill criterion</dt><dd>${or(b.limits?.kill_criterion)}</dd><dt>Displaces</dt><dd>${or(b.limits?.displaces)}</dd><dt>Personal data</dt><dd>${or(b.flags?.personal_data)}</dd><dt>Payments</dt><dd>${or(b.flags?.payments)}</dd><dt>Legal</dt><dd>${or(b.flags?.legal)}</dd>${b.flags?.notes ? `<dt>Notes</dt><dd>${e(b.flags.notes)}</dd>` : ''}</dl></section>`;
  body += `<section><h2>Evidence log</h2><ul class="log">${events.map((ev) => `<li>${e(ev.text)}<span class="meta">${e(new Date(ev.at).toISOString().slice(0, 10))} · ${e(ev.source)}</span></li>`).join('') || '<li class="sub">Nothing yet.</li>'}</ul></section>`;
  body += '</main>';
  return page(`BD-${card.number} · ${card.title}`, body, { nav: 'board', user, token, appName: cfg.appName });
}
