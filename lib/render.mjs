// A card as text: markdown for Claude, the card page and GitHub issues; Atlassian Document Format for Jira.
import { RISKS } from './cards.mjs';

const or = (v, dash = '–') => (v && String(v).trim() ? String(v).trim() : dash);

export const cardRef = (card) => (card.number ? `BD-${card.number}` : 'New card');
export const cardUrl = (cfg, card) => `${cfg.appUrl}/cards/${card.number}`;

function ladderRows(ladder) {
  return ladder.map((r) => {
    const verdict = r.verdict ? `${r.verdict}${r.verdict_at ? ` (${r.verdict_at.slice(0, 10)})` : ''}` : '';
    return { ...r, verdictText: verdict };
  });
}

// Markdown version of the whole card. events: the evidence log, oldest first.
export function cardMarkdown(card, { events = [], systemName = '' } = {}) {
  const b = card.body;
  const lines = [
    `# ${cardRef(card)}: ${card.title}`,
    '',
    `Status: ${card.status} · Owner: ${card.owner_name || card.owner_email || 'unknown'} · System: ${systemName || card.system || 'not chosen'} · Route: ${card.route || 'not chosen'}`,
    `Next test: ${or(card.next_test_date)} · Kill date: ${or(card.kill_date)}`,
    '',
    '## 1. Who has the problem',
    `${or(b.problem?.who)}`,
    '',
    `Problem: ${or(b.problem?.problem)}`,
    `Why now: ${or(b.problem?.why_now)}`,
    '',
    '## 2. Outcome that proves it',
    `${or(b.outcome?.metric)}: ${or(b.outcome?.target)} by ${or(b.outcome?.by_date, 'no date')}. Measured by: ${or(b.outcome?.measured_by)}`,
    '',
    '## 3. Value and cost',
    `Value: ${or(b.value?.estimate)}`,
    `Cost: ${or(b.value?.cost)}`,
    '',
    '## 4. Riskiest assumption',
    `${b.riskiest_assumption?.kind || '–'} (${RISKS[b.riskiest_assumption?.kind] || ''}): ${or(b.riskiest_assumption?.statement)}`,
    '',
    '## 5. Test ladder',
    'The pass bar is written before the test. A rung with a result is locked.',
    '',
    '| Rung | Test | Pass bar | Judge | Time box | Budget | Result | Verdict |',
    '|---|---|---|---|---|---|---|---|',
    ...ladderRows(card.ladder).map((r) => `| ${r.rung}${r.build ? ' (build)' : ''} ${r.name} | ${or(r.test)} | ${or(r.pass_bar)} | ${or(r.judge)} | ${or(r.time_box)} | ${or(r.budget)} | ${or(r.result)} | ${or(r.verdictText)} |`.replace(/\n/g, ' ')),
    '',
    '## 6. Limits',
    `Time: ${or(b.limits?.time)} · Budget: ${or(b.limits?.budget)}`,
    `Kill criterion: ${or(b.limits?.kill_criterion)}`,
    `Displaces: ${or(b.limits?.displaces)}`,
    '',
    '## 7. Flags',
    `Personal data: ${or(b.flags?.personal_data)} · Payments: ${or(b.flags?.payments)} · Legal: ${or(b.flags?.legal)}${b.flags?.notes ? ` · ${b.flags.notes}` : ''}`,
    '',
    '## 8. Delivery',
    `Route: ${or(b.delivery?.route)}. ${or(b.delivery?.reason, '')}`,
    'Acceptance criteria:',
    ...(b.delivery?.acceptance_criteria?.length ? b.delivery.acceptance_criteria.map((a) => `- ${a}`) : ['- none yet']),
    '',
    '## 9. Evidence log',
    ...(events.length ? events.map((e) => `- ${new Date(e.at).toISOString().slice(0, 10)} · ${e.text} · source: ${e.source}`) : ['- nothing yet']),
  ];
  return lines.join('\n');
}

// The spec a developer or the coding agent works from: the problem, the outcome, the acceptance criteria and the
// evidence that got it here. No conversation text, only what the card holds.
export function specMarkdown(cfg, card, { systemName = '' } = {}) {
  const b = card.body;
  const evidence = card.ladder.filter((r) => r.verdict).map((r) => `- Rung ${r.rung}, ${r.name}: ${r.verdict}. ${r.result || ''}${r.source ? ` (source: ${r.source})` : ''}`);
  return [
    `Bet card ${cardRef(card)}, passed its validation ladder in ${cfg.appName}: ${cardUrl(cfg, card)}`,
    '',
    '## Problem',
    `${or(b.problem?.who)}: ${or(b.problem?.problem)}`,
    '',
    '## Outcome that proves it',
    `${or(b.outcome?.metric)}: ${or(b.outcome?.target)} by ${or(b.outcome?.by_date, 'no date')}. Measured by: ${or(b.outcome?.measured_by)}`,
    '',
    '## Acceptance criteria',
    ...(b.delivery?.acceptance_criteria?.length ? b.delivery.acceptance_criteria.map((a) => `- [ ] ${a}`) : ['- none written']),
    '',
    '## Context',
    `System: ${systemName || card.system || 'not chosen'}. Riskiest assumption (${b.riskiest_assumption?.kind || '–'}): ${or(b.riskiest_assumption?.statement)}`,
    `Flags: personal data ${or(b.flags?.personal_data)}, payments ${or(b.flags?.payments)}, legal ${or(b.flags?.legal)}${b.flags?.notes ? `. ${b.flags.notes}` : ''}`,
    `Build rung: ${or(card.ladder.find((r) => r.build)?.test)}${card.ladder.find((r) => r.build)?.pass_bar ? ` Pass bar: ${card.ladder.find((r) => r.build).pass_bar}` : ''}`,
    '',
    '## Evidence so far',
    ...(evidence.length ? evidence : ['- none']),
    '',
    `Owner: ${card.owner_name || card.owner_email || 'unknown'}. Questions go to the owner; the card is the source of truth.`,
  ].join('\n');
}

// ---------- Atlassian Document Format (Jira Cloud REST API v3) ----------
const t = (s, marks) => ({ type: 'text', text: String(s), ...(marks ? { marks } : {}) });
const para = (...content) => ({ type: 'paragraph', content: content.filter((c) => c && c.text !== '') });
const heading = (s) => ({ type: 'heading', attrs: { level: 3 }, content: [t(s)] });
const bullets = (items) => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [para(t(i || '–'))] })) });

export function specAdf(cfg, card, { systemName = '' } = {}) {
  const b = card.body;
  const url = cardUrl(cfg, card);
  const evidence = card.ladder.filter((r) => r.verdict).map((r) => `Rung ${r.rung}, ${r.name}: ${r.verdict}. ${r.result || ''}${r.source ? ` (source: ${r.source})` : ''}`);
  return {
    type: 'doc',
    version: 1,
    content: [
      para(t(`Bet card ${cardRef(card)} passed its validation ladder in ${cfg.appName}: `), t(url, [{ type: 'link', attrs: { href: url } }])),
      heading('Problem'),
      para(t(`${or(b.problem?.who)}: ${or(b.problem?.problem)}`)),
      heading('Outcome that proves it'),
      para(t(`${or(b.outcome?.metric)}: ${or(b.outcome?.target)} by ${or(b.outcome?.by_date, 'no date')}. Measured by: ${or(b.outcome?.measured_by)}`)),
      heading('Acceptance criteria'),
      bullets(b.delivery?.acceptance_criteria?.length ? b.delivery.acceptance_criteria : ['none written']),
      heading('Context'),
      para(t(`System: ${systemName || card.system || 'not chosen'}. Riskiest assumption (${b.riskiest_assumption?.kind || '–'}): ${or(b.riskiest_assumption?.statement)}`)),
      para(t(`Flags: personal data ${or(b.flags?.personal_data)}, payments ${or(b.flags?.payments)}, legal ${or(b.flags?.legal)}${b.flags?.notes ? `. ${b.flags.notes}` : ''}`)),
      heading('Evidence so far'),
      bullets(evidence.length ? evidence : ['none']),
      para(t(`Owner: ${card.owner_name || card.owner_email || 'unknown'}.`)),
    ],
  };
}
