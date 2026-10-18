// The whole app as one fetch handler: (Request) => Response. Vercel runs it as a single function (api/index.mjs);
// dev/server.mjs runs the same handler on a local port. No framework.
import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { configProblems } from './config.mjs';
import { migrate } from './db.mjs';
import { Store } from './store.mjs';
import { sessionFromRequest, startLogin, finishLogin, newSessionCookie, clearSessionCookie, csrfToken, csrfOk, originOk, stillAllowed } from './auth.mjs';
import { prepareResult } from './cards.mjs';
import { runTurn, closeCard } from './interview.mjs';
import { handOff, afterReady, syncHandoff, syncAll, handoffOpen } from './handoff.mjs';
import { Jira } from './jira.mjs';
import { GitHub } from './github.mjs';
import { localDate } from './time.mjs';
import { renderBoard } from '../views/board.mjs';
import { renderCard } from '../views/card.mjs';
import { renderConversation, renderConversationList, renderNew } from '../views/conversation.mjs';
import { renderSettings, parseSettingsForm } from '../views/settings.mjs';
import { renderLogin, renderError } from '../views/login.mjs';

const STATIC = {
  '/style.css': 'text/css; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/md.mjs': 'text/javascript; charset=utf-8',
  '/manifest.webmanifest': 'application/manifest+json',
  '/icon-180.png': 'image/png',
  '/icon-512.png': 'image/png',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
};

const DONE = {
  saved: 'Settings saved.',
  recorded: 'Result recorded.',
  failed: 'Result recorded: the rung failed. Kill the card with the reason, or park it on a trigger.',
  ready: 'Result recorded. Every rung before the build has passed.',
  handedoff: 'Handed off.',
  waiting: 'Ready for dev; an admin hands it off.',
  killed: 'Card killed. It is in the graveyard with your reason.',
  parked: 'Card parked.',
  unparked: 'Card back in the inbox.',
  checked: 'Status checked.',
  user: 'Saved.',
};

const html = (body, status = 200, extra = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS } });
const redirect = (location, extra = {}) => new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra } });
const text = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });

// On Vercel every path is rewritten to /api with the original path in ?route= (vercel.json).
export function routeOf(request) {
  const url = new URL(request.url);
  let path = url.pathname;
  if ((path === '/api' || path === '/api/index' || path === '/api/index.mjs') && url.searchParams.has('route')) path = `/${url.searchParams.get('route') || ''}`;
  url.searchParams.delete('route');
  return { path: path.replace(/\/+$/, '') || '/', url };
}

// deps: { cfg, getDb: async () => db, anthropic?, fetchFn?, deadline?: () => Date|undefined, waitUntil?: (p) => void }
export function createApp(deps) {
  const { cfg } = deps;
  const fetchFn = deps.fetchFn || fetch;
  const waitUntil = deps.waitUntil || ((p) => p.catch((e) => console.error(e)));
  let ready = null;
  let anthropic = deps.anthropic || null;
  let modelCache = { at: 0, list: [] };

  const getStore = async () => {
    if (!ready) ready = (async () => {
      const db = await deps.getDb();
      await migrate(db);
      return new Store(db);
    })().catch((e) => {
      ready = null;
      throw e;
    });
    return ready;
  };
  const client = () => (anthropic ||= new Anthropic({ apiKey: cfg.anthropicApiKey }));
  const integrations = () => ({ jira: new Jira(cfg, fetchFn), github: new GitHub(cfg, fetchFn) });
  const handoffCtx = (store, settings) => ({ cfg, store, settings, ...integrations() });
  const today = () => localDate(Date.now(), cfg.timeZone);

  async function models() {
    if (Date.now() - modelCache.at < 3600_000 && modelCache.list.length) return modelCache.list;
    try {
      const list = [];
      for await (const m of client().models.list()) list.push({ id: m.id, name: m.display_name || m.id });
      modelCache = { at: Date.now(), list };
    } catch (e) {
      console.error('model list failed:', e.message);
    }
    return modelCache.list;
  }

  async function serveStatic(path) {
    try {
      const body = await readFile(new URL(`../public${path}`, import.meta.url));
      return new Response(body, { headers: { 'Content-Type': STATIC[path], 'Cache-Control': 'public, max-age=300', ...SECURITY_HEADERS } });
    } catch {
      return text('Not found', 404);
    }
  }

  async function readForm(request) {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > 200_000) throw Object.assign(new Error('The request is too large.'), { status: 413 });
    return new URLSearchParams(await request.text());
  }

  async function handle(request) {
    const { path, url } = routeOf(request);
    const method = request.method;
    if (method === 'GET' && STATIC[path]) return serveStatic(path);
    if (path === '/healthz') {
      try {
        await (await getStore()).db.query('SELECT 1');
        return json({ ok: true });
      } catch (e) {
        console.error('health check failed:', e.message); // the detail stays in the logs: it can name hosts and users
        return json({ ok: false, error: 'The database is not reachable. See the function logs.' }, 503);
      }
    }
    const problems = configProblems(cfg);
    if (problems.some((p) => /DATABASE_URL|SESSION_SECRET|GOOGLE_CLIENT/.test(p))) return html(renderLogin({ cfg, problems }), 503);
    const store = await getStore();

    // The daily cron (vercel.json) checks the open handoffs. Vercel sends CRON_SECRET as a bearer token.
    if (path === '/cron/sync') {
      if (!cfg.cronSecret || request.headers.get('authorization') !== `Bearer ${cfg.cronSecret}`) return text('Unauthorized', 401);
      const checked = await syncAll(handoffCtx(store, await store.settings()), { budgetMs: 50_000 });
      return json({ ok: true, checked });
    }

    // ---------- sign-in ----------
    if (path === '/login') return html(renderLogin({ cfg, next: url.searchParams.get('next') || '/' }));
    if (path === '/auth/google') {
      const { location, setCookie } = startLogin(cfg, url.searchParams.get('next') || '/');
      return redirect(location, { 'Set-Cookie': setCookie });
    }
    if (path === '/auth/callback') {
      const r = await finishLogin(cfg, request, { fetchFn, verifyFn: deps.verifyIdToken });
      if (!r.ok) return html(renderLogin({ cfg, reason: r.reason }), 403);
      const user = await store.upsertUser({ email: r.email, name: r.name, role: r.role, domain: r.domain });
      if (user.disabled) return html(renderLogin({ cfg, reason: 'Your account is disabled in this app. Ask an admin.' }), 403);
      const headers = new Headers({ Location: r.next || '/', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      headers.append('Set-Cookie', newSessionCookie(cfg, user.id));
      headers.append('Set-Cookie', r.clearOauth);
      return new Response(null, { status: 303, headers });
    }

    // Local development only: dev/server.mjs passes devLogin when DEV_LOGIN_EMAIL is set; api/index.mjs never does.
    if (path === '/dev/login' && deps.devLogin) {
      const email = deps.devLogin.toLowerCase();
      const user = await store.upsertUser({ email, name: email.split('@')[0], role: cfg.access.admins.includes(email) ? 'admin' : 'member', domain: email.split('@')[1] });
      return redirect('/', { 'Set-Cookie': newSessionCookie(cfg, user.id) });
    }

    const session = sessionFromRequest(cfg, request);
    const user = session && stillAllowed(cfg, await store.getUser(session.uid));
    if (!user) {
      if (method === 'GET') return redirect(`/login?next=${encodeURIComponent(path + url.search)}`, session ? { 'Set-Cookie': clearSessionCookie(cfg) } : {});
      return text('Sign in first.', 401);
    }
    const token = csrfToken(cfg, session);
    let form = null;
    if (method === 'POST') {
      form = await readForm(request);
      if (!originOk(cfg, request) || !csrfOk(cfg, session, form.get('csrf'))) return text('This form expired or came from another site. Reload the page and try again.', 403);
    }
    if (path === '/logout' && method === 'POST') return redirect('/login', { 'Set-Cookie': clearSessionCookie(cfg) });

    const settings = await store.settings();
    const base = { cfg, user, token, settings, today: today(), nowMs: Date.now(), msg: DONE[url.searchParams.get('done')] || '' };
    const notFound = () => html(renderError({ cfg, user, token, status: 404, message: 'That page does not exist, or it is not yours.' }), 404);
    const blockedReason = () => (!settings.model ? 'No Claude model is chosen yet. An admin picks one in Settings; it decides the cost of each conversation.' : !cfg.anthropicApiKey ? 'ANTHROPIC_API_KEY is not set, so Claude cannot be reached. An admin must add it.' : '');

    // ---------- board ----------
    if (path === '/' && method === 'GET') {
      const cards = await store.cards();
      const handoffs = await store.latestHandoffs();
      const open = await store.openHandoffs(1);
      if (open.length && (!open[0].checked_at || Date.now() - new Date(open[0].checked_at).getTime() > 10 * 60_000)) waitUntil(syncAll(handoffCtx(store, settings), { budgetMs: 15_000 }));
      return html(renderBoard({ ...base, cards, handoffs }));
    }

    // ---------- conversations ----------
    if (path === '/c' && method === 'GET') return html(renderConversationList({ ...base, list: await store.conversations(user.id) }));
    if (path === '/new' && method === 'GET') return html(renderNew({ ...base, blocked: blockedReason() }));
    if (path === '/new' && method === 'POST') {
      if (blockedReason()) return html(renderNew({ ...base, blocked: blockedReason() }), 409);
      // The idea stays on the server as the conversation's draft; a URL would put it in browser history and logs.
      const conv = await store.createConversation(user.id, { kind: 'new', model: settings.model, effort: settings.effort, draft: String(form.get('idea') || '').trim().slice(0, 4000) });
      return redirect(`/c/${conv.id}`);
    }
    let m = path.match(/^\/c\/([0-9a-f-]{36})(\/send|\/state)?$/i);
    if (m) {
      const conv = await store.conversation(user.id, m[1]);
      if (!conv) return notFound();
      if (!m[2] && method === 'GET') {
        const card = conv.card_id ? await store.card(conv.card_id) : conv.ref_card_id ? await store.card(conv.ref_card_id) : null;
        const messages = await store.messages(conv.id);
        const autostart = !messages.length && conv.draft ? conv.draft : '';
        return html(renderConversation({ ...base, conv, messages, card, autostart, prefill: autostart, blocked: blockedReason() }));
      }
      if (m[2] === '/state') return json({ status: conv.status, pending: Boolean(conv.pending) });
      if (m[2] === '/send' && method === 'POST') return sendTurn(request, { store, user, token, settings, conv, form });
    }

    // ---------- cards ----------
    m = path.match(/^\/cards\/([1-9]\d{0,8})(\/[a-z]+)?$/);
    if (m) {
      const card = await store.cardByNumber(Number(m[1]));
      if (!card) return notFound();
      const action = m[2] || '';
      const owner = card.owner_id === user.id || user.role === 'admin';
      const actor = { id: user.id, label: `typed by ${user.name || user.email}` };
      const back = (done) => redirect(`/cards/${card.number}${done ? `?done=${done}` : ''}`);
      const refused = (message, status = 403) => html(renderError({ cfg, user, token, status, message }), status);
      if (!action && method === 'GET') return html(renderCard({ ...base, card, events: await store.events(card.id), handoff: await store.latestHandoff(card.id) }));
      if (method !== 'POST') return notFound();
      if (action === '/refine') {
        // Owner only: Claude writes only to the person's own cards, so a refine conversation on someone else's card
        // could not save. Admins change other people's cards on the card page.
        if (card.owner_id !== user.id) return refused(`BD-${card.number} belongs to ${card.owner_name}; only its owner refines it with Claude. Start a retest instead.`);
        const existing = await store.conversationForCard(user.id, card.id);
        if (existing) return redirect(`/c/${existing.id}`);
        if (blockedReason()) return refused(blockedReason(), 409);
        const conv = await store.createConversation(user.id, { kind: 'refine', cardId: card.id, refCardId: card.id, title: `BD-${card.number}: ${card.title}`, model: settings.model, effort: settings.effort, draft: `Let's work on BD-${card.number}.` });
        return redirect(`/c/${conv.id}`);
      }
      if (action === '/retest') {
        if (blockedReason()) return refused(blockedReason(), 409);
        const conv = await store.createConversation(user.id, { kind: 'retest', refCardId: card.id, title: `Retest of BD-${card.number}`, model: settings.model, effort: settings.effort, draft: `I want to retest BD-${card.number}.` });
        return redirect(`/c/${conv.id}`);
      }
      if (action === '/result') {
        if (!owner) return refused('Only the card\'s owner or an admin records its results.');
        const r = prepareResult(card, { card_number: card.number, rung: Number(form.get('rung')), result: form.get('result') || '', verdict: form.get('verdict') || '', source: form.get('source') || '', next_test_date: form.get('next_test_date') || '' }, actor.label);
        if (r.error) return refused(r.error, 400);
        const updated = await store.updateCard(card.id, card.version, { ladder: r.ladder, status: r.status, next_test_date: r.nextTestDate });
        if (!updated) return refused('The card changed in the meantime. Reload and try again.', 409);
        await store.addEvent(card.id, { actorId: user.id, source: actor.label, kind: 'result', text: r.event.text });
        if (r.ready) {
          const h = await afterReady(handoffCtx(store, settings), updated, actor);
          return back(h.waiting ? 'waiting' : h.ok ? 'handedoff' : 'ready');
        }
        return back(r.failed ? 'failed' : 'recorded');
      }
      if (action === '/close') {
        if (!owner) return refused('Only the card\'s owner or an admin closes it.');
        const kind = form.get('action') === 'park' ? 'park' : 'kill';
        const r = await closeCard(store, card, { action: kind, reason: form.get('reason'), revive: form.get('revive'), actor });
        if (r.error) return refused(r.error, 400);
        return back(kind === 'kill' ? 'killed' : 'parked');
      }
      if (action === '/unpark') {
        if (!owner) return refused('Only the card\'s owner or an admin moves it.');
        if (card.status !== 'parked') return back();
        const updated = await store.updateCard(card.id, card.version, { status: 'inbox' });
        if (updated) await store.addEvent(card.id, { actorId: user.id, source: actor.label, kind: 'status', text: 'Status parked to inbox.' });
        return back('unparked');
      }
      if (action === '/handoff') {
        const force = form.get('force') === 'jira' ? 'jira' : null;
        if (!(user.role === 'admin' || (owner && settings.handoffMode === 'auto' && !force))) return refused('An admin hands this card off.');
        const r = await handOff(handoffCtx(store, settings), card, actor, { force });
        if (r.error) return refused(r.error, 400);
        return back('handedoff');
      }
      if (action === '/check') {
        const h = await store.latestHandoff(card.id);
        if (handoffOpen(h)) await syncHandoff(handoffCtx(store, settings), h);
        return back('checked');
      }
      return notFound();
    }

    // ---------- settings (admins) ----------
    if (path.startsWith('/settings')) {
      if (user.role !== 'admin') return html(renderError({ cfg, user, token, status: 403, message: 'Settings are for admins (ADMIN_EMAILS).' }), 403);
      const view = async (extra = {}) => html(renderSettings({ ...base, settings: await store.settings(), models: cfg.anthropicApiKey ? await models() : [], usage: await store.usageSince(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()), users: await store.listUsers(), ...extra }), extra.error ? 400 : 200);
      if (path === '/settings' && method === 'GET') return view();
      if (path === '/settings' && method === 'POST') {
        const r = parseSettingsForm(form, settings);
        if (r.error) return view({ error: r.error });
        for (const [k, v] of Object.entries(r.settings)) await store.setSetting(k, v, user.id);
        return redirect('/settings?done=saved');
      }
      if (path === '/settings/test-jira' && method === 'POST') {
        try {
          const me = await integrations().jira.myself();
          return view({ checks: { jira: `Signed in to Jira as ${me.name}.` } });
        } catch (e) {
          return view({ checks: { jira: e.message } });
        }
      }
      if (path === '/settings/test-github' && method === 'POST') {
        try {
          const a = await integrations().github.repoAccess(String(form.get('repo') || ''));
          return view({ checks: { github: `${a.fullName}: ${a.push ? 'the token can write issues and labels here' : 'the token can read but not write here; the handoff will fail'}.` } });
        } catch (e) {
          return view({ checks: { github: e.message } });
        }
      }
      if (path === '/settings/user' && method === 'POST') {
        const id = String(form.get('id') || '');
        if (id !== user.id && /^[0-9a-f-]{36}$/i.test(id)) await store.setDisabled(id, form.get('disabled') === '1');
        return redirect('/settings?done=user');
      }
    }
    return notFound();
  }

  // One turn of a conversation. With "Accept: application/x-ndjson" (the page script) the turn streams as lines of
  // JSON; without it (no script) the turn runs and the browser is sent back to the conversation.
  async function sendTurn(request, { store, user, token, settings, conv, form }) {
    const back = redirect(`/c/${conv.id}`);
    const streaming = (request.headers.get('accept') || '').includes('application/x-ndjson');
    const resume = form.get('resume') === '1';
    const textIn = String(form.get('text') || '').slice(0, 8000);
    const confirming = conv.pending?.type === 'confirm';
    const decision = ['confirm', 'decline'].includes(form.get('decision')) ? form.get('decision') : '';
    const answers = conv.pending && !confirming ? conv.pending.questions.map((q, i) => ({ choices: form.getAll(`q${i}`), other: form.get(`q${i}_other`) || '' })) : null;
    const err = (message, status = 409) => (streaming ? json({ error: message }, status) : html(renderError({ cfg, user, token, status, message }), status));
    if (!cfg.anthropicApiKey) return err('ANTHROPIC_API_KEY is not set, so Claude cannot be reached.');
    if (confirming && !decision) return err('Confirm the change, or choose Not yet.', 400);
    if (conv.pending && !confirming && !answers.some((a) => a.choices.length || a.other.trim()) && !textIn.trim()) return err('Answer the question, or type an answer of your own.', 400);
    if (!conv.pending && !textIn.trim() && !resume) return err('Type a message first.', 400);
    // The cap counts every turn the person starts: a message or an answer, with or without resume=1.
    const human = Boolean(textIn.trim() || conv.pending);
    if (settings.turnsPerUserPerDay > 0 && human) {
      const used = await store.turnsSince(user.id, new Date(Date.now() - 864e5).toISOString());
      if (used >= settings.turnsPerUserPerDay) return err(`You have used your ${settings.turnsPerUserPerDay} turns of the last 24 hours. An admin sets this limit in Settings.`, 429);
    }
    const claimed = await store.claimTurn(user.id, conv.id, cfg.staleSeconds);
    if (!claimed) return err('Claude is already working in this conversation. Wait for the turn to end.');
    // An answer or a Confirm belongs to the question or change the page showed. If another tab moved the conversation
    // on in the meantime, it must not answer or confirm something the person has not seen.
    if (claimed.pending && form.get('pending') !== claimed.pending.tool_use_id) {
      await store.updateConversation(user.id, conv.id, { status: 'waiting', running_since: null });
      return err('This question or change was already handled, or a newer one is waiting. Reload the page.', 409);
    }
    if (claimed.draft) await store.updateConversation(user.id, conv.id, { draft: '' });
    const refId = claimed.ref_card_id || claimed.card_id;
    const card = refId ? await store.card(refId) : null;
    // No new Claude call starts after deadlineMs; a call still running at hardDeadlineMs is aborted, so the turn
    // ends cleanly before the platform stops the function.
    const platformDeadline = deps.deadline?.();
    const endMs = platformDeadline ? platformDeadline.getTime() : Date.now() + cfg.turnSeconds * 1000;
    const deadlineMs = endMs - cfg.turnReserveSeconds * 1000;
    const hardDeadlineMs = endMs - 10_000;
    const turn = (emit) => runTurn({ store, cfg, settings, client: client(), user, conversation: claimed, card, input: { text: textIn, answers, decision, resume }, emit, deadlineMs, hardDeadlineMs, handoff: handoffCtx(store, settings) });
    if (!streaming) {
      await turn(() => {});
      return back;
    }
    let closed = false;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const emit = (ev) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`${JSON.stringify(ev)}\n`));
          } catch {
            closed = true;
          }
        };
        const done = turn(emit).then((r) => {
          emit({ type: 'done', status: r.status });
          if (!closed) controller.close();
        });
        waitUntil(done);
      },
      cancel() {
        closed = true; // the browser went away; the turn still finishes and is saved
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS } });
  }

  return {
    async fetch(request) {
      try {
        return await handle(request);
      } catch (e) {
        console.error('request failed:', e);
        return html(renderError({ cfg, status: e.status || 500, message: e.status === 413 ? e.message : 'The app hit an error. It is in the function logs.' }), e.status || 500);
      }
    },
  };
}
