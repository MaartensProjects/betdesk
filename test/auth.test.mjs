import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, admission, stillAllowed, csrfToken, csrfOk, originOk, startLogin, finishLogin, parseCookies } from '../lib/auth.mjs';
import { testConfig, fakeFetch } from './helpers.mjs';

const cfg = testConfig({ ALLOWED_EMAILS: 'contractor@gmail.com' });

test('a signed value verifies, a tampered or expired one does not', () => {
  const t = sign(cfg.sessionSecret, { uid: 'a', exp: Date.now() + 1000 });
  assert.equal(verify(cfg.sessionSecret, t).uid, 'a');
  const [body, mac] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'admin', exp: Date.now() + 1000 })).toString('base64url');
  assert.equal(verify(cfg.sessionSecret, `${forged}.${mac}`), null);
  assert.equal(verify('another-secret-another-secret-another', t), null);
  assert.equal(verify(cfg.sessionSecret, sign(cfg.sessionSecret, { uid: 'a', exp: Date.now() - 1 })), null);
  assert.equal(verify(cfg.sessionSecret, `${body}`), null);
});

test('admission: the Workspace domain, listed emails and admins get in; unverified and others do not', () => {
  assert.deepEqual(admission(cfg, { email: 'ann@shop.example', email_verified: true, hd: 'shop.example' }), { ok: true, email: 'ann@shop.example', domain: 'shop.example', role: 'member' });
  assert.equal(admission(cfg, { email: 'admin@shop.example', email_verified: true, hd: 'shop.example' }).role, 'admin');
  assert.equal(admission(cfg, { email: 'contractor@gmail.com', email_verified: true }).ok, true);
  // A personal account with a look-alike address is not the Workspace domain: no hd claim.
  assert.equal(admission(cfg, { email: 'ann@shop.example', email_verified: true }).ok, false);
  assert.equal(admission(cfg, { email: 'ann@shop.example', email_verified: false, hd: 'shop.example' }).ok, false);
  assert.equal(admission(cfg, { email: 'eve@other.example', email_verified: true, hd: 'other.example' }).ok, false);
});

test('access is re-checked on every request, so removing someone from the lists takes effect at once', () => {
  const user = { email: 'ann@shop.example', domain: 'shop.example', role: 'admin', disabled: false };
  assert.equal(stillAllowed(cfg, user).role, 'member'); // not in ADMIN_EMAILS any more
  assert.equal(stillAllowed(testConfig({ ALLOWED_DOMAINS: '' }), user), null);
  assert.equal(stillAllowed(cfg, { ...user, disabled: true }), null);
});

test('CSRF tokens are bound to the session', () => {
  const s1 = { uid: 'a', sid: 'one' };
  const s2 = { uid: 'a', sid: 'two' };
  assert.ok(csrfOk(cfg, s1, csrfToken(cfg, s1)));
  assert.equal(csrfOk(cfg, s2, csrfToken(cfg, s1)), false);
  assert.equal(csrfOk(cfg, s1, ''), false);
});

test('writes must come from this origin', () => {
  const req = (h) => new Request('https://betdesk.test/cards/1/close', { method: 'POST', headers: h });
  assert.ok(originOk(cfg, req({ origin: 'https://betdesk.test', 'sec-fetch-site': 'same-origin' })));
  assert.equal(originOk(cfg, req({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(originOk(cfg, req({ origin: 'https://evil.example' })), false);
  assert.equal(originOk(cfg, req({})), false);
});

test('Google sign-in: state, nonce and PKCE are checked', async () => {
  const start = startLogin(cfg, '/cards/3');
  const loc = new URL(start.location);
  assert.equal(loc.searchParams.get('hd'), 'shop.example');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://betdesk.test/auth/callback');
  const cookieValue = start.setCookie.split(';')[0];
  const saved = verify(cfg.sessionSecret, decodeURIComponent(cookieValue.split('=')[1]));
  const fetchFn = fakeFetch([[/oauth2\.googleapis\.com\/token/, { method: 'POST', reply: { body: { id_token: 'tok' } } }]]);
  const callback = (state, claims) =>
    finishLogin(cfg, new Request(`https://betdesk.test/auth/callback?code=abc&state=${state}`, { headers: { cookie: cookieValue } }), { fetchFn, verifyFn: async () => claims });

  const ok = await callback(saved.state, { email: 'ann@shop.example', email_verified: true, hd: 'shop.example', nonce: saved.nonce, name: 'Ann' });
  assert.equal(ok.ok, true);
  assert.equal(ok.next, '/cards/3');
  assert.match(fetchFn.requests[0].body, new RegExp(`code_verifier=${saved.verifier}`));

  assert.equal((await callback('wrong', { email: 'ann@shop.example', email_verified: true, hd: 'shop.example', nonce: saved.nonce })).ok, false);
  assert.equal((await callback(saved.state, { email: 'ann@shop.example', email_verified: true, hd: 'shop.example', nonce: 'other' })).ok, false);
  const outsider = await callback(saved.state, { email: 'eve@other.example', email_verified: true, hd: 'other.example', nonce: saved.nonce });
  assert.equal(outsider.ok, false);
  assert.match(outsider.reason, /not on the list/);
});

test('the sign-in never redirects off-site after login', () => {
  for (const next of ['//evil.example/x', 'https://evil.example', 'javascript:alert(1)', '/.//evil.example', '/%2e//evil.example', '/a/..//evil.example', '/\\evil.example']) {
    const start = startLogin(cfg, next);
    const saved = verify(cfg.sessionSecret, decodeURIComponent(start.setCookie.split(';')[0].split('=')[1]));
    assert.equal(saved.next, '/');
  }
  assert.deepEqual(parseCookies('a=1; b=x%3Dy'), { a: '1', b: 'x=y' });
});
