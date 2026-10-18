import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, handOff, syncHandoff, afterReady } from '../lib/handoff.mjs';
import { prepareSave, prepareResult } from '../lib/cards.mjs';
import { Jira } from '../lib/jira.mjs';
import { GitHub } from '../lib/github.mjs';
import { DEFAULT_SETTINGS } from '../lib/store.mjs';
import { freshStore, testConfig, cardInput, SYSTEMS, fakeFetch, NO_EXISTING } from './helpers.mjs';

const settings = { ...DEFAULT_SETTINGS, model: 'claude-opus-5-5', systems: SYSTEMS };

// A card that has passed both pre-dev rungs.
async function readyCard(store, over = {}) {
  const owner = await store.upsertUser({ email: 'ann@shop.example', name: 'Ann', role: 'member', domain: 'shop.example' });
  const saved = prepareSave(cardInput(over), { existing: null, systems: SYSTEMS, today: '2026-10-19', actor: 'test' });
  let card = await store.createCard(owner.id, saved.row);
  for (const [rung, result] of [[1, '24% of drops'], [2, '4 of 5']]) {
    const r = prepareResult(card, { card_number: card.number, rung, result, verdict: 'pass', source: 'test', next_test_date: '' }, 'Ann');
    card = await store.updateCard(card.id, card.version, { ladder: r.ladder, status: r.status });
  }
  return { card, owner };
}

test('routing: agent when the system allows it, Jira otherwise, and a clear error with its fix', () => {
  const cfg = testConfig();
  const card = { number: 1, system: 'web', route: 'agent', body: { delivery: { acceptance_criteria: ['x'] } } };
  assert.equal(resolveRoute(cfg, settings, card).route, 'agent');
  assert.equal(resolveRoute(cfg, settings, card, { force: 'jira' }).route, 'jira');
  const erp = resolveRoute(cfg, settings, { ...card, system: 'erp' });
  assert.equal(erp.route, 'jira');
  assert.match(erp.note, /ERP has no repository/);
  const off = resolveRoute(cfg, { ...settings, systems: [{ ...SYSTEMS[0], agent: false }] }, card);
  assert.equal(off.route, 'jira');
  assert.match(off.note, /agent is switched off for Webshop front end/);
  assert.equal(resolveRoute(testConfig({ GITHUB_TOKEN: '' }), settings, card).route, 'jira');
  assert.equal(resolveRoute(cfg, settings, { ...card, system: '' }).fix, 'refine');
  assert.equal(resolveRoute(cfg, settings, { ...card, system: 'pim' }).fix, 'settings');
  assert.equal(resolveRoute(cfg, settings, { ...card, body: { delivery: { acceptance_criteria: [] } } }).fix, 'refine');
  assert.equal(resolveRoute(testConfig({ JIRA_BASE_URL: '' }), settings, { ...card, route: 'jira' }).fix, 'settings');
});

test('agent handoff: a labelled GitHub issue with the spec; the card goes in dev; never twice', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  const fetchFn = fakeFetch([...NO_EXISTING, [/api\.github\.com\/repos\/shop\/storefront\/issues$/, { method: 'POST', reply: { status: 201, body: { number: 42, html_url: 'https://github.com/shop/storefront/issues/42' } } }]]);
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store);
  const r = await handOff(ctx, card, { id: owner.id, label: 'typed by Ann' });
  assert.equal(r.ok, true);
  const posts = () => fetchFn.requests.filter((r) => r.method === 'POST');
  const sent = JSON.parse(posts()[0].body);
  assert.deepEqual(sent.labels, ['betdesk-agent']);
  assert.match(sent.title, /^BD-\d+: Show shipping costs/);
  assert.match(sent.body, /- \[ \] Shipping cost shows under the price/);
  assert.match(sent.body, /https:\/\/betdesk\.test\/cards\/\d+/);
  assert.match(sent.body, new RegExp(`<!-- betdesk:card=${card.id} -->`));
  assert.equal((await store.card(card.id)).status, 'in dev');
  // The stale copy of the card cannot hand off again.
  assert.match((await handOff(ctx, card, { id: owner.id, label: 'x' })).error, /changed in the meantime|not ready/);
  assert.equal(posts().length, 1);
});

test('Jira handoff sends the spec as ADF with labels; a failure puts the card back with the error', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  let fail = true;
  const fetchFn = fakeFetch([...NO_EXISTING, [/rest\/api\/3\/issue$/, { method: 'POST', reply: () => (fail ? { status: 400, body: { errors: { issuetype: 'Specify a valid issue type' } } } : { status: 201, body: { key: 'ERP-7' } }) }]]);
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store, { system: 'erp', delivery: { route: 'jira', reason: 'touches orders', acceptance_criteria: ['Stock syncs hourly'] } });
  const bad = await handOff(ctx, card, { id: owner.id, label: 'x' });
  assert.match(bad.error, /issuetype: Specify a valid issue type/);
  const back = await store.card(card.id);
  assert.equal(back.status, 'ready for dev');
  assert.equal((await store.latestHandoff(card.id)).state, 'failed');
  fail = false;
  const ok = await handOff(ctx, back, { id: owner.id, label: 'x' });
  assert.equal(ok.handoff.external_key, 'ERP-7');
  assert.equal(ok.handoff.url, 'https://shop.atlassian.net/browse/ERP-7');
  const body = JSON.parse(fetchFn.requests.filter((r) => r.method === 'POST')[1].body);
  assert.equal(body.fields.project.key, 'ERP');
  assert.equal(body.fields.issuetype.name, 'Task');
  assert.deepEqual(body.fields.labels, ['betdesk', `bd-${card.number}`]);
  assert.equal(body.fields.description.type, 'doc');
  assert.ok(JSON.stringify(body.fields.description).includes('Stock syncs hourly'));
});

test('approval mode waits for an admin', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  const fetchFn = fakeFetch([]);
  const { card, owner } = await readyCard(store);
  const r = await afterReady({ cfg, store, settings: { ...settings, handoffMode: 'approval' }, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) }, card, { id: owner.id, label: 'x' });
  assert.equal(r.waiting, true);
  assert.equal(fetchFn.requests.length, 0);
  assert.equal((await store.card(card.id)).status, 'ready for dev');
});

test('status sync: pull request open, then merged: the card is done', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  let merged = false;
  const fetchFn = fakeFetch([
    ...NO_EXISTING,
    [/issues$/, { method: 'POST', reply: { status: 201, body: { number: 42, html_url: 'https://github.com/shop/storefront/issues/42' } } }],
    [/pulls\?.*head=shop%3Abetdesk%2Fissue-42/, { reply: () => ({ body: [{ number: 43, html_url: 'https://github.com/shop/storefront/pull/43', state: merged ? 'closed' : 'open', merged_at: merged ? '2026-10-20T10:00:00Z' : null }] }) }],
    [/issues\/42$/, { reply: () => ({ body: { state: merged ? 'closed' : 'open', state_reason: merged ? 'completed' : null } }) }],
  ]);
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store);
  const { handoff } = await handOff(ctx, card, { id: owner.id, label: 'x' });
  const h1 = await syncHandoff(ctx, handoff);
  assert.equal(h1.state, 'pr open');
  assert.equal(h1.pr_url, 'https://github.com/shop/storefront/pull/43');
  merged = true;
  const h2 = await syncHandoff(ctx, h1);
  assert.equal(h2.state, 'done');
  assert.equal((await store.card(card.id)).status, 'done');
  assert.ok((await store.events(card.id)).some((e) => e.text.includes('Dev work done')));
});

test('status sync: the agent\'s issue closed without a merge sends the card back to ready for dev', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  const fetchFn = fakeFetch([
    ...NO_EXISTING,
    [/issues$/, { method: 'POST', reply: { status: 201, body: { number: 5, html_url: 'https://github.com/shop/storefront/issues/5' } } }],
    [/pulls\?/, { reply: { body: [] } }],
    [/issues\/5$/, { reply: { body: { state: 'closed', state_reason: 'not_planned' } } }],
  ]);
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store);
  const { handoff } = await handOff(ctx, card, { id: owner.id, label: 'x' });
  assert.equal((await syncHandoff(ctx, handoff)).state, 'closed');
  assert.equal((await store.card(card.id)).status, 'ready for dev');
});

test('status sync: a Jira ticket in the done category finishes the card', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  const fetchFn = fakeFetch([
    ...NO_EXISTING,
    [/rest\/api\/3\/issue$/, { method: 'POST', reply: { status: 201, body: { key: 'WEB-9' } } }],
    [/rest\/api\/3\/issue\/WEB-9/, { reply: { body: { fields: { status: { name: 'Released', statusCategory: { key: 'done' } }, resolution: { name: 'Done' } } } } }],
  ]);
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store, { delivery: { route: 'jira', reason: 'needs a dev', acceptance_criteria: ['x'] } });
  const { handoff } = await handOff(ctx, card, { id: owner.id, label: 'x' });
  const h = await syncHandoff(ctx, handoff);
  assert.equal(h.state, 'done');
  assert.equal(h.detail, 'Released, Done');
  assert.equal((await store.card(card.id)).status, 'done');
});

test('a merged pull request elsewhere that only mentions the issue does not finish the card', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  const fetchFn = fakeFetch([
    ...NO_EXISTING,
    [/issues$/, { method: 'POST', reply: { status: 201, body: { number: 7, html_url: 'https://github.com/shop/storefront/issues/7' } } }],
    // Only same-repository pull requests from the agent's branch are asked for; none exists yet.
    [/pulls\?.*head=shop%3Abetdesk%2Fissue-7/, { reply: { body: [] } }],
    [/issues\/7$/, { reply: { body: { state: 'open', state_reason: null } } }],
  ]);
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store);
  const { handoff } = await handOff(ctx, card, { id: owner.id, label: 'x' });
  assert.equal((await syncHandoff(ctx, handoff)).state, 'agent working');
  assert.equal((await store.card(card.id)).status, 'in dev');
  assert.ok(!fetchFn.requests.some((r) => r.url.includes('timeline')));
});

test('a handoff without a clear answer is not repeated: the status check finds the issue it created', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  let created = false;
  const fetchFn = fakeFetch([
    [/issues\?/, { reply: () => ({ body: created ? [{ number: 9, html_url: 'https://github.com/shop/storefront/issues/9', body: `spec\n<!-- betdesk:card=${cardId} -->` }] : [] }) }],
    [/issues$/, { method: 'POST', reply: () => { created = true; return { status: 502, body: { message: 'Bad gateway' } }; } }],
  ]);
  let cardId;
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store);
  cardId = card.id;
  const r = await handOff(ctx, card, { id: owner.id, label: 'x' });
  assert.equal(r.fix, 'check');
  assert.equal(r.handoff.state, 'unknown');
  assert.equal((await store.card(card.id)).status, 'in dev', 'not reverted: the issue may exist');
  const h = await syncHandoff(ctx, r.handoff);
  assert.equal(h.state, 'agent working');
  assert.equal(h.external_key, '#9');
  assert.equal(fetchFn.requests.filter((x) => x.method === 'POST').length, 1, 'created once');
});

test('a retry after an unclear failure reuses the issue instead of creating a second one', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  const fetchFn = fakeFetch([[/rest\/api\/3\/search\/jql/, { reply: { body: { issues: [{ key: 'WEB-4' }] } } }]]);
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store, { delivery: { route: 'jira', reason: 'needs a dev', acceptance_criteria: ['x'] } });
  const r = await handOff(ctx, card, { id: owner.id, label: 'x' });
  assert.equal(r.handoff.external_key, 'WEB-4');
  assert.equal(fetchFn.requests.filter((x) => x.method === 'POST').length, 0);
  assert.equal(new URL(fetchFn.requests[0].url).searchParams.get('jql'), 'project = "WEB" AND labels = "bd-1" AND statusCategory != Done ORDER BY created DESC');
  assert.ok((await store.events(card.id)).some((e) => e.text.includes('found from an earlier attempt')));
});

test('two status checks at once log a transition once', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  const fetchFn = fakeFetch([
    ...NO_EXISTING,
    [/rest\/api\/3\/issue$/, { method: 'POST', reply: { status: 201, body: { key: 'WEB-9' } } }],
    [/rest\/api\/3\/issue\/WEB-9/, { reply: { body: { fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } } }],
  ]);
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store, { delivery: { route: 'jira', reason: 'needs a dev', acceptance_criteria: ['x'] } });
  const { handoff } = await handOff(ctx, card, { id: owner.id, label: 'x' });
  await Promise.all([syncHandoff(ctx, handoff), syncHandoff(ctx, handoff)]);
  const done = (await store.events(card.id)).filter((e) => e.text.startsWith('Dev work done'));
  assert.equal(done.length, 1);
});

test('handing off again after the agent\'s issue was closed creates a new issue instead of reusing the closed one', async () => {
  const store = await freshStore();
  const cfg = testConfig();
  let n = 20;
  const fetchFn = fakeFetch([
    [/issues\?/, { reply: (u) => ({ body: new URL(u).searchParams.get('state') === 'open' ? [] : [{ number: 20, html_url: 'x', body: 'closed one' }] }) }],
    [/issues$/, { method: 'POST', reply: () => ({ status: 201, body: { number: ++n, html_url: `https://github.com/shop/storefront/issues/${n}` } }) }],
    [/pulls\?/, { reply: { body: [] } }],
    [/issues\/21$/, { reply: { body: { state: 'closed', state_reason: 'not_planned' } } }],
  ]);
  const ctx = { cfg, store, settings, jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) };
  const { card, owner } = await readyCard(store);
  const first = await handOff(ctx, card, { id: owner.id, label: 'x' });
  await syncHandoff(ctx, first.handoff); // closed without a merge: back to ready for dev
  const again = await handOff(ctx, await store.card(card.id), { id: owner.id, label: 'x' });
  assert.equal(again.handoff.external_key, '#22');
  assert.ok(fetchFn.requests.filter((r) => r.url.includes('issues?')).every((r) => new URL(r.url).searchParams.get('state') === 'open'));
});
