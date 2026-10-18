// Google sign-in (OpenID Connect, authorization code flow with PKCE), signed session cookies and CSRF tokens.
// Who may sign in is decided by ALLOWED_DOMAINS (the Google Workspace "hd" claim), ALLOWED_EMAILS and ADMIN_EMAILS.
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const SESSION_DAYS = 14;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function sign(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const want = createHmac('sha256', secret).update(body).digest();
  let got;
  try {
    got = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

// Other cookies on the domain may not be valid percent-encoding; a bad one is kept raw instead of breaking the page.
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw;
    }
  }
  return out;
}

// Where to go after sign-in: a path on this site only. Resolving against a placeholder origin catches "//host",
// "/\\host", control characters and every other trick that makes a browser leave the site.
export function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || /[\\\u0000-\u001f]/.test(next)) return '/';
  try {
    const base = 'https://next.invalid';
    const u = new URL(next, base);
    const path = `${u.pathname}${u.search}`;
    // "/.//host" resolves to the path "//host", which a browser reads as another site.
    return u.origin === base && !path.startsWith('//') ? path : '/';
  } catch {
    return '/';
  }
}

// __Host- cookies need HTTPS; local development over http gets a plain name.
export const sessionCookieName = (cfg) => (cfg.secure ? '__Host-betdesk' : 'betdesk');
const oauthCookieName = (cfg) => (cfg.secure ? '__Host-betdesk-oauth' : 'betdesk-oauth');

export function cookie(cfg, name, value, maxAgeSeconds) {
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', cfg.secure ? 'Secure' : '', `Max-Age=${maxAgeSeconds}`].filter(Boolean).join('; ');
}

export function sessionFromRequest(cfg, request) {
  const cookies = parseCookies(request.headers.get('cookie'));
  return verify(cfg.sessionSecret, cookies[sessionCookieName(cfg)]);
}

export function newSessionCookie(cfg, userId) {
  const sid = b64url(randomBytes(16));
  return cookie(cfg, sessionCookieName(cfg), sign(cfg.sessionSecret, { uid: userId, sid, exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
}

export const clearSessionCookie = (cfg) => cookie(cfg, sessionCookieName(cfg), '', 0);

// The CSRF token is bound to the session, so a token from one session is useless in another.
export const csrfToken = (cfg, session) => createHmac('sha256', cfg.sessionSecret).update(`csrf:${session.uid}:${session.sid}`).digest('base64url');

export function csrfOk(cfg, session, token) {
  if (!session || !token) return false;
  const want = Buffer.from(csrfToken(cfg, session));
  const got = Buffer.from(String(token));
  return want.length === got.length && timingSafeEqual(want, got);
}

// A write must come from a page of this app: same origin, or the configured URL.
export function originOk(cfg, request) {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  if (!origin) return site === 'same-origin';
  const own = new URL(request.url).origin;
  return origin === own || origin === new URL(cfg.appUrl).origin;
}

// Step 1: send the browser to Google with state, nonce and a PKCE challenge kept in a short-lived signed cookie.
export function startLogin(cfg, next = '/') {
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: cfg.google.clientId,
    redirect_uri: `${cfg.appUrl}/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (cfg.access.domains.length === 1) params.set('hd', cfg.access.domains[0]);
  const value = sign(cfg.sessionSecret, { state, nonce, verifier, next: safeNext(next), exp: Date.now() + 10 * 60_000 });
  return { location: `${GOOGLE_AUTH}?${params}`, setCookie: cookie(cfg, oauthCookieName(cfg), value, 600) };
}

// Who may sign in. Returns { ok, role } or { ok: false, reason }.
export function admission(cfg, claims) {
  const email = String(claims.email || '').toLowerCase();
  if (!email || claims.email_verified !== true) return { ok: false, reason: 'Google did not confirm this email address.' };
  const admin = cfg.access.admins.includes(email);
  const domain = String(claims.hd || '').toLowerCase();
  const allowed = admin || cfg.access.emails.includes(email) || (domain && cfg.access.domains.includes(domain));
  if (!allowed) return { ok: false, reason: `${email} is not on the list of people who may use this app. Ask an admin to add your address or domain.` };
  return { ok: true, email, domain, role: admin ? 'admin' : 'member' };
}

// The same rule on every request, from what was stored at sign-in, so a change to the lists takes effect at once.
export function stillAllowed(cfg, user) {
  if (!user || user.disabled) return null;
  const email = String(user.email).toLowerCase();
  const admin = cfg.access.admins.includes(email);
  const ok = admin || cfg.access.emails.includes(email) || (user.domain && cfg.access.domains.includes(user.domain));
  return ok ? { ...user, role: admin ? 'admin' : 'member' } : null;
}

// Step 2: Google sends the browser back with a code. Exchange it, verify the ID token, check admission.
// fetchFn and verifyFn are injectable for tests.
export async function finishLogin(cfg, request, { fetchFn = fetch, verifyFn = null } = {}) {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('cookie'));
  const saved = verify(cfg.sessionSecret, cookies[oauthCookieName(cfg)]);
  if (url.searchParams.get('error')) return { ok: false, reason: `Google sign-in was cancelled (${url.searchParams.get('error')}).` };
  if (!saved || saved.state !== url.searchParams.get('state')) return { ok: false, reason: 'The sign-in took too long or came from another tab. Try again.' };
  const res = await fetchFn(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '',
      client_id: cfg.google.clientId,
      client_secret: cfg.google.clientSecret,
      redirect_uri: `${cfg.appUrl}/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) return { ok: false, reason: `Google refused the sign-in (HTTP ${res.status}).` };
  const { id_token: idToken } = await res.json();
  let claims;
  try {
    claims = verifyFn ? await verifyFn(idToken) : (await jwtVerify(idToken, GOOGLE_JWKS, { issuer: ISSUERS, audience: cfg.google.clientId })).payload;
  } catch (e) {
    return { ok: false, reason: `The sign-in token did not verify: ${e.message}` };
  }
  if (claims.nonce !== saved.nonce) return { ok: false, reason: 'The sign-in token does not belong to this attempt. Try again.' };
  const who = admission(cfg, claims);
  if (!who.ok) return who;
  return { ...who, name: String(claims.name || claims.email), next: safeNext(saved.next), clearOauth: cookie(cfg, oauthCookieName(cfg), '', 0) };
}
