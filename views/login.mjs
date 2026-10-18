// Sign-in page, and the page shown when the app is not set up yet.
import { e, page } from './html.mjs';

export function renderLogin({ cfg, reason = '', next = '/', problems = [] }) {
  const body = `<main class="login"><h1>${e(cfg.appName)}</h1>
<p class="sub">Ideas for the webshop become tested bets: Claude interviews you in private and writes the card; when its tests pass, it goes to the coding agent or to Jira.</p>
${reason ? `<div class="warn"><p>${e(reason)}</p></div>` : ''}
${problems.length ? `<div class="warn"><p>This app is not set up yet:</p><ul>${problems.map((p) => `<li>${e(p)}</li>`).join('')}</ul><p>See docs/INSTALL.md.</p></div>` : `<a class="btn big" href="/auth/google?next=${encodeURIComponent(next)}">Sign in with Google</a>`}
</main>`;
  return page(`Sign in · ${cfg.appName}`, body, { appName: cfg.appName });
}

export function renderError({ cfg, user, token, status, message }) {
  const body = `<header class="top"><div><h1>${status === 404 ? 'Not found' : 'Something went wrong'}</h1></div></header><main><div class="warn"><p>${e(message)}</p><div class="actions"><a class="btn" href="/">Board</a></div></div></main>`;
  return page(status === 404 ? 'Not found' : 'Error', body, { user, token, appName: cfg.appName });
}
