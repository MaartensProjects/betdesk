// The bet card: its shape, the rules every save must pass, and the ladder logic that decides when a card is
// ready for dev work. Pure functions; lib/store.mjs does the database work. The rules are the ones the
// interview relies on (docs/ladder.md): a pass bar is written before its test, a rung with a result is locked,
// a changed pass bar needs a logged reason, and a failed rung ends the card (a retest is a new card).
import { z } from 'zod';
import { isDate } from './time.mjs';

export const STATUSES = ['inbox', 'in validation', 'ready for dev', 'in dev', 'done', 'parked', 'killed'];
export const OPEN_STATUSES = ['inbox', 'in validation', 'parked'];
export const RISKS = {
  desirability: 'customers want it',
  value: 'it moves the metric enough to be worth it',
  feasibility: 'we can build and run it in our systems',
  viability: 'it works for the business: margin, legal, operations',
};
export const FLAG_VALUES = ['yes', 'no', 'to check'];
export const VERDICTS = ['pass', 'fail', 'skipped'];

// The suggested ladder for a webshop change, cheapest rung first. The interview adapts it to the card.
export const DEFAULT_LADDER = [
  { name: 'Desk check', test: 'Two hours with what we already have (analytics, support tickets, reviews, competitors): try to disprove the idea.' },
  { name: 'Customer evidence', test: 'Five conversations, session recordings or a short survey with customers who have the problem.' },
  { name: 'Cheapest real test', test: 'A fake door, a manual workaround, a content or configuration change, or a clickable prototype in front of real customers.' },
  { name: 'Spec ready', test: 'Acceptance criteria, the systems touched, a rollout and a measurement plan, reviewed by the product owner.' },
  { name: 'Build', test: 'Dev work: the coding agent opens a pull request, or a developer picks up the Jira ticket.', build: true },
];

const text = (max) => z.string().max(max);
export const MAX_NUMBER = 2147483647; // card numbers are Postgres integers
const flag = z.enum(FLAG_VALUES);

// The input of the save_bet_card tool. Every field is required (empty strings allowed where noted), so the
// same schema works as the tool's JSON Schema and as the server-side check of what Claude sent.
export const CardInput = z.object({
  card_number: z.number().int().min(0).max(MAX_NUMBER).describe('0 for a new card; the card number (BD-<n>) when refining an existing card'),
  title: text(120).describe('Short name of the bet, in the stakeholder\'s words'),
  system: text(60).describe('Key of the system this changes, from the list in your instructions, or "unknown"'),
  problem: z.object({
    who: text(1000).describe('Who has the problem: customer segment or internal team, and who decides'),
    problem: text(2000).describe('The problem in their words'),
    why_now: text(1000).describe('Why now; empty if none was given'),
  }),
  outcome: z.object({
    metric: text(300).describe('The metric that proves it, e.g. checkout conversion on mobile'),
    target: text(300).describe('The target, with a number'),
    by_date: text(10).describe('YYYY-MM-DD, or empty if not decided'),
    measured_by: text(500).describe('Where the number comes from and who reads it'),
  }),
  value: z.object({
    estimate: text(500).describe('Expected value, e.g. euros a month of gross margin, with its basis'),
    cost: text(500).describe('Expected cost: build effort, running cost; labelled as an estimate'),
  }),
  riskiest_assumption: z.object({
    kind: z.enum(Object.keys(RISKS)),
    statement: text(1000).describe('One sentence a test can prove wrong'),
  }),
  ladder: z
    .array(
      z.object({
        rung: z.number().int().min(1).max(6),
        name: text(80),
        test: text(1500),
        pass_bar: text(800).describe('A number, and who judges it. Written before the test runs. Empty only for rungs further out'),
        judge: text(200).describe('Who judges the result against the pass bar'),
        time_box: text(200),
        budget: text(200),
        build: z.boolean().describe('true only for the last rung: the dev work'),
      }),
    )
    .min(2)
    .max(6),
  pass_bar_changes: z.array(z.object({ rung: z.number().int(), reason: text(800) })).describe('One entry for every rung whose existing pass bar this save changes; empty otherwise'),
  status: z.enum(['inbox', 'in validation']),
  next_test_date: text(10).describe('YYYY-MM-DD of the next test, or empty'),
  kill_date: text(10).describe('YYYY-MM-DD after which the card is killed if it has not passed, or empty'),
  limits: z.object({
    time: text(300),
    budget: text(300),
    kill_criterion: text(800),
    displaces: text(500),
  }),
  flags: z.object({
    personal_data: flag,
    payments: flag,
    legal: flag,
    notes: text(1000),
  }),
  delivery: z.object({
    route: z.enum(['agent', 'jira']).describe('agent: small, well-specified change a coding agent can make in the system\'s repository; jira: everything else'),
    reason: text(500),
    acceptance_criteria: z.array(text(500)).max(20),
  }),
  change_note: text(800).describe('For a refined card: what changed and why; empty for a new card'),
});

export const ResultInput = z.object({
  card_number: z.number().int().min(1).max(MAX_NUMBER),
  rung: z.number().int().min(1).max(6),
  result: text(2000).describe('What the test showed, with the numbers; for a skipped rung, why it is skipped'),
  verdict: z.enum(VERDICTS).describe('pass or fail against the pass bar written before the test; skipped needs a reason'),
  source: text(500).describe('Where the evidence is: a link, a dashboard, notes of the conversations'),
  next_test_date: text(10).describe('YYYY-MM-DD of the next rung\'s test, or empty'),
});

const trimAll = (v) => (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.map(trimAll) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimAll(x)])) : v);

export const preDev = (ladder) => ladder.filter((r) => !r.build);
export const nextRung = (ladder) => preDev(ladder).find((r) => !r.verdict) || null;
export const failedRung = (ladder) => ladder.find((r) => r.verdict === 'fail') || null;
export const isReady = (ladder) => preDev(ladder).length > 0 && preDev(ladder).every((r) => r.verdict === 'pass' || r.verdict === 'skipped');

function checkDates(input, errors, warnings, today) {
  for (const key of ['next_test_date', 'kill_date']) if (input[key] && !isDate(input[key])) errors.push(`${key} "${input[key]}" is not a date (YYYY-MM-DD).`);
  if (input.outcome.by_date && !isDate(input.outcome.by_date)) errors.push(`outcome.by_date "${input.outcome.by_date}" is not a date (YYYY-MM-DD).`);
  if (isDate(input.next_test_date) && isDate(input.kill_date) && input.next_test_date > input.kill_date) errors.push('next_test_date is after kill_date.');
  if (isDate(input.next_test_date) && today && input.next_test_date < today) warnings.push('next_test_date is in the past.');
  if (!input.outcome.by_date) warnings.push('The outcome has no date.');
}

function checkLadderShape(ladder, errors) {
  ladder.forEach((r, i) => {
    if (r.rung !== i + 1) errors.push(`Rungs must be numbered 1 to ${ladder.length} in order; found rung ${r.rung} at position ${i + 1}.`);
  });
  const builds = ladder.filter((r) => r.build);
  if (builds.length !== 1 || !ladder[ladder.length - 1].build) errors.push('Exactly one rung is the build rung, and it is the last one.');
  if (!preDev(ladder).length) errors.push('The ladder needs at least one rung before the build.');
  for (const r of ladder) if (!r.test) errors.push(`Rung ${r.rung} has no test.`);
}

// Validates a save from the interview against the stored card (null for a new card) and merges the ladder:
// rungs with a result keep it and are locked; new or changed pass bars get a timestamp and an author.
// ctx: { existing, systems: [{key}], today, actor, inValidationByOwner, wipLimit }
export function prepareSave(raw, ctx) {
  const parsed = CardInput.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`), warnings: [] };
  const input = trimAll(parsed.data);
  const { existing, systems = [], today, actor, wipLimit = 0, inValidationByOwner = 0 } = ctx;
  const errors = [];
  const warnings = [];
  const events = [];

  if (input.title.length < 3) errors.push('title is empty or too short.');
  if (!input.problem.who) errors.push('problem.who is empty: name who has the problem.');
  if (!input.problem.problem) errors.push('problem.problem is empty.');
  if (!input.outcome.metric || !input.outcome.target) errors.push('The outcome needs a metric and a target.');
  if (input.outcome.target && !/\d/.test(input.outcome.target)) warnings.push('The outcome target has no number. Is it measurable?');
  if (!input.riskiest_assumption.statement) errors.push('riskiest_assumption.statement is empty.');
  if (!input.delivery.reason) errors.push('delivery.reason is empty: say why this route.');
  if (!input.delivery.acceptance_criteria.filter(Boolean).length) warnings.push('No acceptance criteria yet; the handoff needs them.');
  const keys = systems.map((s) => s.key);
  if (input.system !== 'unknown' && keys.length && !keys.includes(input.system)) errors.push(`system "${input.system}" is not one of: ${keys.join(', ')}, or "unknown".`);
  if (input.system === 'unknown' || !keys.length) warnings.push('No system chosen; the handoff needs one.');
  checkDates(input, errors, warnings, today);
  checkLadderShape(input.ladder, errors);

  if (existing) {
    if (!OPEN_STATUSES.includes(existing.status) && existing.status !== 'ready for dev') errors.push(`BD-${existing.number} is ${existing.status}; it can no longer be refined.`);
    if (failedRung(existing.ladder)) errors.push(`BD-${existing.number} failed rung ${failedRung(existing.ladder).rung}. Kill or park it; a retest is a new card that argues why it beats this one.`);
  }

  // Merge the ladder with what is stored.
  const old = existing?.ladder || [];
  const changes = new Map(input.pass_bar_changes.map((c) => [c.rung, c.reason]));
  for (const o of old) {
    if (!o.verdict) continue;
    const n = input.ladder.find((r) => r.rung === o.rung);
    if (!n) errors.push(`Rung ${o.rung} has a result and cannot be removed.`);
    else if (n.test !== o.test || n.pass_bar !== o.pass_bar || n.build !== Boolean(o.build)) errors.push(`Rung ${o.rung} has a result; its test and pass bar are locked. Send them unchanged.`);
  }
  const ladder = input.ladder.map((r) => {
    const o = old.find((x) => x.rung === r.rung);
    if (o?.verdict) return { ...o };
    const rung = { rung: r.rung, name: r.name, test: r.test, pass_bar: r.pass_bar, judge: r.judge, time_box: r.time_box, budget: r.budget, build: r.build, pass_bar_at: o?.pass_bar_at || null, pass_bar_by: o?.pass_bar_by || '' };
    if (r.pass_bar && r.pass_bar !== (o?.pass_bar || '')) {
      if (o?.pass_bar) {
        const reason = changes.get(r.rung);
        if (!reason) errors.push(`Rung ${r.rung} already had the pass bar "${o.pass_bar}". Changing it needs an entry in pass_bar_changes with the reason; it is logged on the card.`);
        else events.push({ kind: 'pass bar changed', text: `Rung ${r.rung} pass bar changed from "${o.pass_bar}" to "${r.pass_bar}". Reason: ${reason}` });
      }
      rung.pass_bar_at = new Date().toISOString();
      rung.pass_bar_by = actor;
    } else if (!r.pass_bar && o?.pass_bar) {
      errors.push(`Rung ${r.rung} had the pass bar "${o.pass_bar}"; it cannot be emptied.`);
    }
    return rung;
  });

  const next = nextRung(ladder);
  if (next) {
    for (const r of preDev(ladder).filter((x) => !x.verdict && x.rung <= next.rung)) {
      if (!r.pass_bar) errors.push(`Rung ${r.rung} is the next test and has no pass bar; write it before the test runs.`);
      if (!r.judge) errors.push(`Rung ${r.rung} has no judge: who decides pass or fail?`);
    }
    if (next.pass_bar && !/\d/.test(next.pass_bar)) warnings.push(`The pass bar of rung ${next.rung} has no number. Is it measurable, and who judges it?`);
  }

  let status = input.status;
  if (isReady(ladder)) status = 'ready for dev';
  else if (existing?.status === 'parked' && input.status === 'inbox') status = 'inbox';
  if (status === 'in validation') {
    for (const key of ['next_test_date', 'kill_date']) if (!input[key]) errors.push(`A card in validation needs ${key}.`);
    const others = inValidationByOwner - (existing?.status === 'in validation' ? 1 : 0);
    if (wipLimit > 0 && existing?.status !== 'in validation' && others >= wipLimit) errors.push(`The team allows ${wipLimit} card${wipLimit > 1 ? 's' : ''} in validation per person, and this person has ${others}. Ask which one waits (park it), or save this one as inbox.`);
  }
  if (existing && !input.change_note) errors.push('change_note is empty: say what changed in this refinement.');

  if (errors.length) return { errors, warnings };
  const body = {
    problem: input.problem,
    outcome: input.outcome,
    value: input.value,
    riskiest_assumption: input.riskiest_assumption,
    limits: input.limits,
    flags: input.flags,
    delivery: input.delivery,
  };
  if (existing && existing.status !== status) events.push({ kind: 'status', text: `Status ${existing.status} to ${status}.` });
  events.push(existing ? { kind: 'refined', text: `Card refined: ${input.change_note}` } : { kind: 'created', text: 'Card created in an interview.' });
  return {
    errors: [],
    warnings,
    events,
    row: {
      title: input.title,
      status,
      system: input.system === 'unknown' ? '' : input.system,
      route: input.delivery.route,
      body,
      ladder,
      next_test_date: input.next_test_date || null,
      kill_date: input.kill_date || null,
    },
  };
}

// A test result on the next rung. Returns { error } or { ladder, status, event, ready, failed }.
export function prepareResult(card, raw, actor) {
  const parsed = ResultInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const f = trimAll(parsed.data);
  if (card.status !== 'in validation') return { error: `BD-${card.number} is ${card.status}; results are recorded while a card is in validation. Move it to validation first, with its next test date and kill date.` };
  if (failedRung(card.ladder)) return { error: `BD-${card.number} already failed rung ${failedRung(card.ladder).rung}.` };
  const next = nextRung(card.ladder);
  if (!next) return { error: `BD-${card.number} has no open rung before the build.` };
  if (f.rung !== next.rung) return { error: `The next test is rung ${next.rung}; results are recorded in order.` };
  if (!f.result) return { error: f.verdict === 'skipped' ? 'Skipping a rung needs a reason.' : 'Write what the test showed.' };
  if (f.verdict !== 'skipped' && !next.pass_bar) return { error: `Rung ${next.rung} has no pass bar. A pass bar is written before the test; a result without one cannot be judged.` };
  if (f.verdict !== 'skipped' && !next.judge) return { error: `Rung ${next.rung} has no judge. Name who judges the result against the pass bar first.` };
  if (f.next_test_date && !isDate(f.next_test_date)) return { error: `next_test_date "${f.next_test_date}" is not a date (YYYY-MM-DD).` };
  const at = new Date().toISOString();
  const ladder = card.ladder.map((r) => (r.rung === next.rung ? { ...r, result: f.result, verdict: f.verdict, verdict_at: at, verdict_by: actor, source: f.source } : r));
  const ready = isReady(ladder);
  const status = ready ? 'ready for dev' : 'in validation';
  // (a card reaches here only from "in validation", so its dates and the WIP limit were checked when it got there)
  const bar = next.pass_bar ? ` against the pass bar "${next.pass_bar}"${next.pass_bar_at ? `, written ${next.pass_bar_at.slice(0, 10)}` : ''}` : '';
  const event = { kind: 'result', text: `Rung ${next.rung} (${next.name}): ${f.verdict}${bar}. Result: ${f.result}${f.source ? ` · source: ${f.source}` : ''}` };
  return { ladder, status, event, ready, failed: f.verdict === 'fail', nextTestDate: ready ? null : f.next_test_date || null };
}

// A one-line state for lists and the board.
export function cardState(card, today) {
  const failed = failedRung(card.ladder);
  if (card.status === 'killed' || card.status === 'parked' || card.status === 'done') return card.status;
  if (failed) return `rung ${failed.rung} failed`;
  if (card.status === 'in validation') {
    const next = nextRung(card.ladder);
    if (!card.next_test_date) return `rung ${next?.rung} not dated`;
    if (card.next_test_date < today) return `rung ${next?.rung} overdue`;
    if (card.next_test_date === today) return `rung ${next?.rung} today`;
    return `rung ${next?.rung} on ${card.next_test_date}`;
  }
  return card.status;
}
