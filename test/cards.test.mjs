import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSave, prepareResult, isReady, nextRung, cardState } from '../lib/cards.mjs';
import { cardInput, SYSTEMS } from './helpers.mjs';

const ctx = (over = {}) => ({ existing: null, systems: SYSTEMS, today: '2026-10-19', actor: 'Claude in Ann\'s conversation', wipLimit: 0, inValidationByOwner: 0, ...over });
const stored = (row, over = {}) => ({ id: 'c1', number: 7, owner_id: 'u1', version: 1, ...row, next_test_date: row.next_test_date || '', kill_date: row.kill_date || '', ...over });

test('a complete card saves, with the pass bars timestamped and their author recorded', () => {
  const r = prepareSave(cardInput(), ctx());
  assert.deepEqual(r.errors, []);
  assert.equal(r.row.status, 'in validation');
  assert.equal(r.row.system, 'web');
  assert.ok(r.row.ladder[0].pass_bar_at);
  assert.equal(r.row.ladder[0].pass_bar_by, "Claude in Ann's conversation");
  assert.equal(r.row.ladder[2].pass_bar_at, null);
});

test('the next rung needs its pass bar and judge before the test', () => {
  const input = cardInput();
  input.ladder[0].pass_bar = '';
  input.ladder[0].judge = '';
  const r = prepareSave(input, ctx());
  assert.ok(r.errors.some((e) => e.includes('Rung 1 is the next test and has no pass bar')));
  assert.ok(r.errors.some((e) => e.includes('Rung 1 has no judge')));
});

test('the ladder ends with exactly one build rung and has a rung before it', () => {
  const input = cardInput();
  input.ladder[1].build = true;
  assert.ok(prepareSave(input, ctx()).errors.some((e) => e.includes('Exactly one rung is the build rung')));
  const only = cardInput({ ladder: [{ ...cardInput().ladder[2], rung: 1 }, { ...cardInput().ladder[2], rung: 2 }] });
  assert.ok(prepareSave(only, ctx()).errors.length);
});

test('a card in validation needs a next test date and a kill date, in that order', () => {
  assert.ok(prepareSave(cardInput({ next_test_date: '' }), ctx()).errors.some((e) => e.includes('needs next_test_date')));
  assert.ok(prepareSave(cardInput({ next_test_date: '2027-02-01' }), ctx()).errors.some((e) => e.includes('after kill_date')));
  assert.deepEqual(prepareSave(cardInput({ status: 'inbox', next_test_date: '', kill_date: '' }), ctx()).errors, []);
});

test('an unknown system is refused; "unknown" is allowed with a warning', () => {
  assert.ok(prepareSave(cardInput({ system: 'pim' }), ctx()).errors.some((e) => e.includes('is not one of: web, erp')));
  const r = prepareSave(cardInput({ system: 'unknown' }), ctx());
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('No system chosen')));
  assert.equal(r.row.system, '');
});

test('changing a written pass bar needs a reason, which is logged', () => {
  const first = prepareSave(cardInput(), ctx());
  const existing = stored(first.row);
  const changed = cardInput({ card_number: 7, change_note: 'Sharper bar' });
  changed.ladder[0].pass_bar = 'At least 25% of drops happen on the shipping step';
  assert.ok(prepareSave(changed, ctx({ existing })).errors.some((e) => e.includes('Changing it needs an entry in pass_bar_changes')));
  changed.pass_bar_changes = [{ rung: 1, reason: 'The PO set a stricter bar' }];
  const ok = prepareSave(changed, ctx({ existing }));
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.events.some((e) => e.kind === 'pass bar changed' && e.text.includes('The PO set a stricter bar')));
});

test('a rung with a result is locked', () => {
  const first = prepareSave(cardInput(), ctx());
  const existing = stored(first.row);
  const res = prepareResult(existing, { card_number: 7, rung: 1, result: '24% of drops on shipping', verdict: 'pass', source: 'GA funnel', next_test_date: '' }, 'Ann');
  const after = stored({ ...first.row, ladder: res.ladder, status: res.status });
  const edit = cardInput({ card_number: 7, change_note: 'tweak' });
  edit.ladder[0].test = 'Something else';
  assert.ok(prepareSave(edit, ctx({ existing: after })).errors.some((e) => e.includes('Rung 1 has a result')));
});

test('results are recorded in order, need a pass bar, and the last pre-dev pass makes the card ready', () => {
  const first = prepareSave(cardInput(), ctx());
  let card = stored(first.row);
  assert.match(prepareResult(card, { card_number: 7, rung: 2, result: 'x', verdict: 'pass', source: '', next_test_date: '' }, 'Ann').error, /next test is rung 1/);
  let r = prepareResult(card, { card_number: 7, rung: 1, result: '24% of drops', verdict: 'pass', source: 'GA', next_test_date: '2026-10-30' }, 'Ann');
  assert.equal(r.ready, false);
  assert.equal(r.nextTestDate, '2026-10-30');
  assert.match(r.event.text, /against the pass bar "At least 20% of drops/);
  card = stored({ ...first.row, ladder: r.ladder, status: r.status });
  assert.equal(nextRung(card.ladder).rung, 2);
  r = prepareResult(card, { card_number: 7, rung: 2, result: '4 of 5', verdict: 'pass', source: 'call notes', next_test_date: '' }, 'Ann');
  assert.equal(r.ready, true);
  assert.equal(r.status, 'ready for dev');
  assert.ok(isReady(r.ladder));
});

test('a failed rung ends the card: no more results, no refinement', () => {
  const first = prepareSave(cardInput(), ctx());
  const r = prepareResult(stored(first.row), { card_number: 7, rung: 1, result: '5% of drops', verdict: 'fail', source: 'GA', next_test_date: '' }, 'Ann');
  assert.equal(r.failed, true);
  const card = stored({ ...first.row, ladder: r.ladder, status: r.status });
  assert.match(prepareResult(card, { card_number: 7, rung: 2, result: 'x', verdict: 'pass', source: '', next_test_date: '' }, 'Ann').error, /already failed rung 1/);
  assert.ok(prepareSave(cardInput({ card_number: 7, change_note: 'retry' }), ctx({ existing: card })).errors.some((e) => e.includes('a retest is a new card')));
  assert.equal(cardState(card, '2026-10-19'), 'rung 1 failed');
});

test('a skipped rung needs a reason and counts toward readiness', () => {
  const first = prepareSave(cardInput(), ctx());
  const card = stored(first.row);
  assert.match(prepareResult(card, { card_number: 7, rung: 1, result: '', verdict: 'skipped', source: '', next_test_date: '' }, 'Ann').error, /needs a reason/);
  const r = prepareResult(card, { card_number: 7, rung: 1, result: 'Data already in last month\'s report', verdict: 'skipped', source: '', next_test_date: '' }, 'Ann');
  assert.equal(r.ladder[0].verdict, 'skipped');
});

test('the WIP limit counts the owner\'s other cards in validation', () => {
  const r = prepareSave(cardInput(), ctx({ wipLimit: 1, inValidationByOwner: 1 }));
  assert.ok(r.errors.some((e) => e.includes('1 card in validation per person')));
  assert.deepEqual(prepareSave(cardInput({ status: 'inbox' }), ctx({ wipLimit: 1, inValidationByOwner: 1 })).errors, []);
});

test('the card state line', () => {
  const card = stored(prepareSave(cardInput(), ctx()).row);
  assert.equal(cardState(card, '2026-10-19'), 'rung 1 on 2026-10-23');
  assert.equal(cardState(card, '2026-10-23'), 'rung 1 today');
  assert.equal(cardState(card, '2026-10-24'), 'rung 1 overdue');
});

test('results are only recorded on a card in validation, and a pass or fail needs a judge', () => {
  const inbox = stored(prepareSave(cardInput({ status: 'inbox', next_test_date: '', kill_date: '' }), ctx()).row);
  assert.match(prepareResult(inbox, { card_number: 7, rung: 1, result: 'x', verdict: 'pass', source: '', next_test_date: '' }, 'Ann').error, /results are recorded while a card is in validation/);
  const card = stored(prepareSave(cardInput(), ctx()).row);
  card.ladder[0].judge = ''; // a stored card from before the rule, or edited elsewhere
  assert.match(prepareResult(card, { card_number: 7, rung: 1, result: 'x', verdict: 'pass', source: '', next_test_date: '' }, 'Ann').error, /no judge/);
  assert.equal(prepareResult(card, { card_number: 7, rung: 1, result: 'covered by last month\'s report', verdict: 'skipped', source: '', next_test_date: '' }, 'Ann').error, undefined);
});

test('card numbers stay within the database range', () => {
  assert.ok(prepareSave(cardInput({ card_number: 99999999999 }), ctx()).errors.some((e) => e.startsWith('card_number')));
});
