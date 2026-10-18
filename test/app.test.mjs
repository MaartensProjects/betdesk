import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, routeOf } from '../lib/app.mjs';
import { newSessionCookie, csrfToken, verify, parseCookies, sessionCookieName } from '../lib/auth.mjs';
import { pglite } from '../dev/pglite.mjs';
import { Store } from '../lib/store.mjs';
import { prepareSave } from '../lib/cards.mjs';
import { testConfig, fakeClaude, cardInput, SYSTEMS, fakeFetch, NO_EXISTING } from './helpers.mjs';

const ORIGIN = 'https://betdesk.test';

async function setup({ steps = [], fetchFn = fakeFetch([]), env = {} } = {}) {
  const cfg = testConfig(env);
  const db = await pglite();
  const client = fakeClaude(steps);
  const app = createApp({ cfg, getDb: async () => db, anthropic: client, fetchFn, waitUntil: () => {} });
  await app.fetch(new Request(`${ORIGIN}/healthz`)); // runs the migrations
  const store = new Store(db);
  const as = async (email, name) => {
    const user = await store.upsertUser({ email, name, role: cfg.access.admins.includes(email) ? 'admin' : 'member', domain: email.split('@')[1] });
    const cookie = newSessionCookie(cfg, user.id).split(';')[0];
    const session = verify(cfg.sessionSecret, decodeURIComponent(parseCookies(cookie)[sessionCookieName(cfg)]));
    const token = csrfToken(cfg, session);
    const get = (path) => app.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }));
    const post = (path, fields = {}, headers = {}) =>
      app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ csrf: token, ...fields }) }));
    return { user, get, post, token, cookie };
  };
  return { cfg, app, store, client, as, fetchFn };
}

test('Vercel rewrites: the original path comes in ?route=', () => {
  assert.equal(routeOf(new Request(`${ORIGIN}/api?route=cards/3`)).path, '/cards/3');
  assert.equal(routeOf(new Request(`${ORIGIN}/api?route=`)).path, '/');
  assert.equal(routeOf(new Request(`${ORIGIN}/cards/3/`)).path, '/cards/3');
  const { url } = routeOf(new Request(`${ORIGIN}/api?route=c/x&start=hi`));
  assert.equal(url.searchParams.get('start'), 'hi');
  assert.equal(url.searchParams.has('route'), false);
});

test('signed out: pages redirect to sign-in, writes are refused, static files are served', async () => {
  const { app } = await setup();
  const r = await app.fetch(new Request(`${ORIGIN}/cards/1`));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/login?next=%2Fcards%2F1');
  assert.equal((await app.fetch(new Request(`${ORIGIN}/new`, { method: 'POST' }))).status, 401);
  const login = await app.fetch(new Request(`${ORIGIN}/login`));
  assert.match(await login.text(), /Sign in with Google/);
  const css = await app.fetch(new Request(`${ORIGIN}/style.css`));
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const google = await app.fetch(new Request(`${ORIGIN}/auth/google?next=/c`));
  assert.match(google.headers.get('location'), /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(google.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Secure/);
});

test('a missing setup shows what to set instead of a sign-in button', async () => {
  const { app } = await setup({ env: { GOOGLE_CLIENT_ID: '' } });
  const r = await app.fetch(new Request(`${ORIGIN}/`));
  assert.equal(r.status, 503);
  assert.match(await r.text(), /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set/);
});

test('every write needs the session\'s CSRF token and this origin', async () => {
  const { as } = await setup();
  const ann = await as('ann@shop.example', 'Ann');
  assert.equal((await ann.post('/new', { csrf: 'forged' })).status, 403);
  assert.equal((await ann.post('/new', {}, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('conversations are private: another person gets a 404, not the conversation', async () => {
  const { as, store } = await setup();
  await store.setSetting('model', 'claude-opus-5-5', null);
  const ann = await as('ann@shop.example', 'Ann');
  const bob = await as('bob@shop.example', 'Bob');
  const created = await ann.post('/new', { idea: 'Free returns for members' });
  assert.equal(created.status, 303);
  const path = created.headers.get('location');
  assert.match(path, /^\/c\/[0-9a-f-]{36}$/, 'the idea is not in the URL');
  const mine = await ann.get(path);
  assert.equal(mine.status, 200);
  const page = await mine.text();
  assert.match(page, /data-autostart="1"/);
  assert.match(page, /<textarea id="text"[^>]*>Free returns for members<\/textarea>/);
  assert.equal((await bob.get(path)).status, 404);
  assert.equal((await bob.get(`${path}/state`)).status, 404);
  assert.equal((await bob.post(`${path}/send`, { text: 'hello' })).status, 404);
  assert.doesNotMatch(await (await bob.get('/c')).text(), /Free returns/);
});

test('no model chosen: conversations cannot start, and admins get the button to Settings', async () => {
  const { as } = await setup();
  const ann = await as('ann@shop.example', 'Ann');
  assert.equal((await ann.post('/new', { idea: 'x' })).status, 409);
  const admin = await as('admin@shop.example', 'Admin');
  const board = await (await admin.get('/')).text();
  assert.match(board, /No Claude model is chosen/);
  assert.match(board, /href="\/settings"/);
});

test('a turn streams as lines of JSON and is saved', async () => {
  const { as, store } = await setup({ steps: [{ content: [{ type: 'text', text: 'Who has the problem?' }] }] });
  await store.setSetting('model', 'claude-opus-5-5', null);
  const ann = await as('ann@shop.example', 'Ann');
  const path = (await ann.post('/new', { idea: 'x' })).headers.get('location').split('?')[0];
  const r = await ann.post(`${path}/send`, { text: 'Free returns' }, { accept: 'application/x-ndjson' });
  assert.match(r.headers.get('content-type'), /ndjson/);
  const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.type === 'text').map((l) => l.text), ['Who has the problem?']);
  assert.equal(lines[lines.length - 1].type, 'done');
  const page = await (await ann.get(path)).text();
  assert.match(page, /Who has the problem\?/);
  assert.doesNotMatch(page, /&lt;context&gt;/, 'the context block is never shown');
});

test('settings are for admins, and saving them validates the systems', async () => {
  const { as, store } = await setup();
  const ann = await as('ann@shop.example', 'Ann');
  assert.equal((await ann.get('/settings')).status, 403);
  assert.equal((await ann.post('/settings', { model: 'claude-opus-5-5' })).status, 403);
  const admin = await as('admin@shop.example', 'Admin');
  assert.equal((await admin.get('/settings')).status, 200);
  const bad = await admin.post('/settings', { model: 'claude-opus-5-5', effort: 'high', systemCount: '1', s0_key: 'web', s0_repo: 'not a repo' });
  assert.equal(bad.status, 400);
  const ok = await admin.post('/settings', { model: 'claude-opus-5-5', effort: 'xhigh', handoffMode: 'approval', wipLimit: '2', systemCount: '2', s0_key: 'web', s0_name: 'Storefront', s0_repo: 'shop/storefront', s0_jiraProject: 'web', s0_agent: '1', s1_key: '' });
  assert.equal(ok.status, 303);
  const s = await store.settings();
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.effort, 'xhigh');
  assert.equal(s.handoffMode, 'approval');
  assert.equal(s.wipLimit, 2);
  assert.deepEqual(s.systems, [{ key: 'web', name: 'Storefront', description: '', repo: 'shop/storefront', jiraProject: 'WEB', jiraIssueType: 'Story', agent: true }]);
});

test('card page: the owner records results; others can read but not change it; the last pass hands off', async () => {
  const fetchFn = fakeFetch([...NO_EXISTING, [/api\.github\.com\/repos\/shop\/storefront\/issues$/, { method: 'POST', reply: { status: 201, body: { number: 3, html_url: 'https://github.com/shop/storefront/issues/3' } } }]]);
  const { as, store } = await setup({ fetchFn });
  await store.setSetting('systems', SYSTEMS, null);
  const ann = await as('ann@shop.example', 'Ann');
  const bob = await as('bob@shop.example', 'Bob');
  const card = await store.createCard(ann.user.id, prepareSave(cardInput(), { existing: null, systems: SYSTEMS, today: '2026-10-19', actor: 'test' }).row);
  const page = await (await bob.get(`/cards/${card.number}`)).text();
  assert.match(page, /Show shipping costs on the product page/);
  assert.doesNotMatch(page, /Record the result/);
  assert.equal((await bob.post(`/cards/${card.number}/result`, { rung: '1', result: 'x', verdict: 'pass' })).status, 403);
  assert.equal((await bob.post(`/cards/${card.number}/close`, { action: 'kill', reason: 'x' })).status, 403);

  assert.equal((await ann.post(`/cards/${card.number}/result`, { rung: '2', result: 'x', verdict: 'pass' })).status, 400);
  let r = await ann.post(`/cards/${card.number}/result`, { rung: '1', result: '24% of drops on shipping', verdict: 'pass', source: 'GA', next_test_date: '2026-10-30' });
  assert.equal(r.headers.get('location'), `/cards/${card.number}?done=recorded`);
  r = await ann.post(`/cards/${card.number}/result`, { rung: '2', result: '4 of 5', verdict: 'pass', source: 'notes' });
  assert.equal(r.headers.get('location'), `/cards/${card.number}?done=handedoff`);
  const after = await store.card(card.id);
  assert.equal(after.status, 'in dev');
  const events = await store.events(card.id);
  assert.ok(events.some((e) => e.source === 'typed by Ann' && e.text.startsWith('Rung 1 (Desk check): pass')));
  assert.ok(events.some((e) => e.text.includes('Handed off to the coding agent: shop/storefront#3')));
});

test('kill needs a reason; the graveyard shows it', async () => {
  const { as, store } = await setup();
  const ann = await as('ann@shop.example', 'Ann');
  const card = await store.createCard(ann.user.id, prepareSave(cardInput({ status: 'inbox' }), { existing: null, systems: SYSTEMS, today: '2026-10-19', actor: 'test' }).row);
  assert.equal((await ann.post(`/cards/${card.number}/close`, { action: 'kill', reason: '  ' })).status, 400);
  assert.equal((await ann.post(`/cards/${card.number}/close`, { action: 'kill', reason: 'Competitor already does it for free', revive: 'They drop it' })).status, 303);
  const board = await (await ann.get('/')).text();
  assert.match(board, /Graveyard \(1\)/);
  assert.match(board, /Competitor already does it for free/);
});

test('the cron endpoint needs the secret', async () => {
  const { app } = await setup();
  assert.equal((await app.fetch(new Request(`${ORIGIN}/cron/sync`))).status, 401);
  assert.equal((await app.fetch(new Request(`${ORIGIN}/cron/sync`, { headers: { authorization: 'Bearer wrong' } }))).status, 401);
  const ok = await app.fetch(new Request(`${ORIGIN}/cron/sync`, { headers: { authorization: 'Bearer cron-secret' } }));
  assert.deepEqual(await ok.json(), { ok: true, checked: 0 });
});

test('a disabled person is signed out on the next request', async () => {
  const { as, store } = await setup();
  const ann = await as('ann@shop.example', 'Ann');
  assert.equal((await ann.get('/')).status, 200);
  await store.setDisabled(ann.user.id, true);
  const r = await ann.get('/');
  assert.equal(r.status, 303);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('pages carry a strict content security policy', async () => {
  const { as } = await setup();
  const ann = await as('ann@shop.example', 'Ann');
  const r = await ann.get('/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'; style-src 'self'; script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('the turn cap counts every turn a person starts, resume=1 or not', async () => {
  const { as, store } = await setup({ steps: [{ content: [{ type: 'text', text: 'one' }] }, { content: [{ type: 'text', text: 'two' }] }] });
  await store.setSetting('model', 'claude-opus-5-5', null);
  await store.setSetting('turnsPerUserPerDay', 1, null);
  const ann = await as('ann@shop.example', 'Ann');
  const path = (await ann.post('/new', {})).headers.get('location');
  assert.equal((await ann.post(`${path}/send`, { text: 'first' })).status, 303);
  assert.equal((await ann.post(`${path}/send`, { text: 'second', resume: '1' })).status, 429);
  assert.equal((await ann.post(`${path}/send`, { text: 'third' })).status, 429);
});

test('a turn cut off by the platform frees the conversation after the stale window, not 15 minutes', async () => {
  const { as, store } = await setup({ steps: [{ content: [{ type: 'text', text: 'back' }] }] });
  await store.setSetting('model', 'claude-opus-5-5', null);
  const ann = await as('ann@shop.example', 'Ann');
  const path = (await ann.post('/new', {})).headers.get('location');
  const id = path.split('/').pop();
  await store.db.query("UPDATE conversations SET status = 'running', running_since = now() - interval '200 seconds' WHERE id = $1", [id]);
  assert.equal((await ann.post(`${path}/send`, { text: 'hello' })).status, 409);
  await store.db.query("UPDATE conversations SET running_since = now() - interval '340 seconds' WHERE id = $1", [id]);
  assert.equal((await ann.post(`${path}/send`, { text: 'hello' })).status, 303);
});

test('out-of-range card numbers are a 404, a malformed foreign cookie breaks nothing, health hides details', async () => {
  const { as, app, cfg } = await setup();
  const ann = await as('ann@shop.example', 'Ann');
  assert.equal((await ann.get('/cards/99999999999')).status, 404);
  assert.equal((await ann.get('/cards/0')).status, 404);
  const r = await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie: `promo=50%off; ${ann.cookie}` } }));
  assert.equal(r.status, 200);
  const broken = createApp({ cfg, getDb: async () => ({ query: async () => { throw new Error('connect ECONNREFUSED db.internal:5432 user=secret'); }, exec: async () => {} }) });
  const h = await broken.fetch(new Request(`${ORIGIN}/healthz`));
  assert.equal(h.status, 503);
  assert.doesNotMatch(await h.text(), /db\.internal|secret/);
});

test('after sign-in the app never sends the browser to another site', async () => {
  const { app } = await setup();
  for (const next of ['/\\evil.example', '/\t/evil.example', '//evil.example']) {
    const r = await app.fetch(new Request(`${ORIGIN}/auth/google?next=${encodeURIComponent(next)}`));
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const { verify } = await import('../lib/auth.mjs');
    const saved = verify('x'.repeat(40), decodeURIComponent(cookie.split('=')[1]));
    assert.equal(saved.next, '/', next);
  }
});

test('a Confirm from an old page never confirms a newer change', async () => {
  const { as, store } = await setup();
  await store.setSetting('model', 'claude-opus-5-5', null);
  const ann = await as('ann@shop.example', 'Ann');
  const path = (await ann.post('/new', {})).headers.get('location');
  const id = path.split('/').pop();
  await store.updateConversation(ann.user.id, id, { status: 'waiting', pending: { type: 'confirm', tool_use_id: 'newer', tool: 'close_card', input: {}, title: 'Kill BD-1?', summary: 'x', detail: '', results: [] } });
  const r = await ann.post(`${path}/send`, { decision: 'confirm', pending: 'older' });
  assert.equal(r.status, 409);
  const conv = await store.conversation(ann.user.id, id);
  assert.equal(conv.status, 'waiting');
  assert.equal(conv.pending.tool_use_id, 'newer');
  const page = await (await ann.get(path)).text();
  assert.match(page, /name="pending" value="newer"/);
});
